import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager, createAgentSessionFromServices } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import schedule from "node-schedule";
import fs from "node:fs";
import path from "node:path";
import { botSubdir, ensureDir } from "../../src/core/paths.js";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { getKVCache } from "../../src/core/kvCache.js";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import { getSharedAgentServices, extractAssistantText } from "../../src/core/agentServices.js";
import { getChannelRuntime } from "../../src/transport/channelRuntime.js";
import { seedPlan, recordPlanThread, type OriginChannel } from "./plan_enforcer.js";
import { logError, logWarning } from "../../src/core/errorLog.js";

// =============================================================================
// scheduler — per-fire fresh-session model, IN-PROCESS.
//
// HISTORY:
//   - Sprint 4: cron callback captured ctx.sendUserMessage on registration.
//     Went stale after /new or restart.
//   - Sprint 7: per-fire FRESH SessionManager + seedPlan + spawn `npx pi -p`
//     subprocess. Fixed the stale-ctx bug but introduced a hang: extensions
//     with persistent timers kept the subprocess's event loop alive past
//     the agent's reply, so `proc.on("close")` never fired and deliverAndAppend
//     never ran. Same class f69bb81 fixed for the inbound path.
//   - THIS REWRITE: cron callback creates a FRESH SessionManager + seedPlan
//     + in-process AgentSession via createAgentSessionFromServices against
//     shared services. Subscribe to agent_end to capture the reply; deliver
//     via dispatcher.send. No subprocess, no stdout capture, no watchdog,
//     no hang window.
//
// Job persistence: data/<bot>/jobs/<job_id>.json. Format:
//   {
//     job_id, cron, task,
//     steps?: string[],                 // present → seedPlan injects them
//     originChannel?: OriginChannel,    // present → completion/failure routes back
//     created_at, created_by
//   }
//
// On extension load, we re-read all persisted jobs and reschedule them.
// This is what fixes the captured-ctx-goes-stale bug from the old impl.
//
// LLM tools (admin only via Sprint 5 ACL):
//   schedule_recurring_task(job_id, cron_expression, task_instruction, steps?, origin?)
//   schedule_reminder(minutes_from_now, reminder_message)
//   cancel_scheduled_task(job_id)
//   list_scheduled_tasks()       — user-visible (no secrets in jobs)
//   update_scheduled_task(...)
//   trigger_scheduled_task_now(job_id) — admin manual fire
// =============================================================================

/**
 * Explicit target for where a scheduled job's output should be delivered.
 * Independent of where the job was SCHEDULED from (that's origin_session_file +
 * originChannel). Lets the caller say "schedule from my DM, but deliver to
 * the #marketing Slack channel".
 */
interface DeliverTarget {
    platform: string;          // "cli" | "telegram" | "slack" | "a2a" | …
    channelId: string;
    threadId?: string;
    /** Optional — session file to append the delivered message to. Defaults
     * to origin_session_file so the SCHEDULING session's history gets the
     * reminder entry (preserving "watch this movie" → "thanks just watched it"
     * context). Set explicitly to route history-append to a different
     * per-chat session when that concept lands. */
    sessionFile?: string;
}

type JobType = "reminder" | "task" | "poll";

interface JobMeta {
    job_id: string;
    /**
     * "reminder" — fire-time LLM is told to DELIVER the reminder to the user,
     *              not execute it. No `steps` (would be ignored).
     * "task"     — fire-time LLM is told to EXECUTE the instruction.
     *              Optional `steps` enter plan-enforcement mode.
     * "poll"     — fire-time LLM RUNS THE CHECK and decides whether to
     *              terminate (mark_poll_done) or continue (next cron fire).
     *              `poll_max_attempts` caps runaway polls; `poll_attempts`
     *              tracks completed fires. Control-channel is kvCache
     *              namespace "poll-control" — subprocess's mark_poll_done
     *              writes `{done, result}` there; parent's next fire reads
     *              it, delivers, and cancels.
     * Default when missing on legacy job files: "task" (back-compat).
     */
    job_type: JobType;
    cron: string;
    task: string;
    steps?: string[];
    /** Where the scheduling request came from. Historical record. */
    originChannel?: OriginChannel;
    /** Where deliveries should go. Defaults to origin if unset. */
    deliverTarget?: DeliverTarget;
    /**
     * Absolute path to the session that scheduled the job. Used at fire time
     * to append the reminder/task-result message as a `scheduler-delivery`
     * custom entry, so when the user returns to that chat the event is in
     * conversation history (lets "thanks just watched it" resolve context).
     */
    origin_session_file?: string;
    /** Poll-only: give up after N fires. Defaults to 120 (1h at 30s cadence). */
    poll_max_attempts?: number;
    /** Poll-only: count of fires so far. Persisted so restarts don't reset. */
    poll_attempts?: number;
    created_at: number;
    created_by: string;
}

interface RuntimeJob {
    meta: JobMeta;
    job: schedule.Job;
}

const activeJobs = new Map<string, RuntimeJob>();

function jobsDir(): string {
    const dir = botSubdir("jobs");
    ensureDir(dir);
    return dir;
}

function jobFile(jobId: string): string {
    return path.join(jobsDir(), `${jobId}.json`);
}

function saveJobMeta(meta: JobMeta): void {
    fs.writeFileSync(jobFile(meta.job_id), JSON.stringify(meta, null, 2));
}

function loadAllJobMeta(): JobMeta[] {
    if (!fs.existsSync(jobsDir())) return [];
    const out: JobMeta[] = [];
    for (const f of fs.readdirSync(jobsDir())) {
        if (!f.endsWith(".json")) continue;
        try {
            const raw = fs.readFileSync(path.join(jobsDir(), f), "utf-8");
            const parsed = JSON.parse(raw) as Partial<JobMeta>;
            if (typeof parsed.job_id === "string" && typeof parsed.cron === "string" && typeof parsed.task === "string") {
                // Legacy job files didn't have job_type. A job id starting
                // with "reminder_" is the convention schedule_reminder uses;
                // everything else defaults to "task" (matches pre-Phase-7
                // behaviour).
                const job_type: JobType = parsed.job_type === "reminder"
                    ? "reminder"
                    : parsed.job_type === "task"
                        ? "task"
                        : parsed.job_type === "poll"
                            ? "poll"
                            : parsed.job_id.startsWith("reminder_")
                                ? "reminder"
                                : parsed.job_id.startsWith("poll_")
                                    ? "poll"
                                    : "task";
                out.push({
                    job_id: parsed.job_id,
                    job_type,
                    cron: parsed.cron,
                    task: parsed.task,
                    ...(Array.isArray(parsed.steps) ? { steps: parsed.steps } : {}),
                    ...(parsed.originChannel ? { originChannel: parsed.originChannel } : {}),
                    ...(parsed.deliverTarget ? { deliverTarget: parsed.deliverTarget } : {}),
                    ...(typeof parsed.origin_session_file === "string" ? { origin_session_file: parsed.origin_session_file } : {}),
                    ...(typeof parsed.poll_max_attempts === "number" ? { poll_max_attempts: parsed.poll_max_attempts } : {}),
                    ...(typeof parsed.poll_attempts === "number" ? { poll_attempts: parsed.poll_attempts } : {}),
                    created_at: typeof parsed.created_at === "number" ? parsed.created_at : Date.now(),
                    created_by: typeof parsed.created_by === "string" ? parsed.created_by : "unknown",
                });
            }
        } catch (e) {
            logWarning("scheduler", `corrupt job file ${f}`, { err: e instanceof Error ? e.message : String(e) });
        }
    }
    return out;
}

/**
 * Derive the session ID from its on-disk file path. Pi names session files
 * `<sessionId>.jsonl` — strip the extension to recover the ID the subprocess
 * will self-report via `ctx.sessionManager.getSessionId()`.
 */
function sessionFileToId(sessionFile: string): string {
    return path.basename(sessionFile).replace(/\.jsonl?$/i, "");
}

function deleteJobMeta(jobId: string): void {
    const f = jobFile(jobId);
    if (fs.existsSync(f)) fs.unlinkSync(f);
}

function makeRunsDir(): string {
    const dir = botSubdir("scheduled-runs");
    ensureDir(dir);
    return dir;
}

// ----- History-append after delivery -----
//
// For reminders/tasks scheduled FROM the TUI or a chat channel, we persist
// the delivery as a `scheduler-delivery` CustomMessageEntry on the scheduling
// session's JSONL file. That MAKES IT AVAILABLE IN CONTEXT on the next LLM
// turn — "thanks, just watched it" resolves because the reminder event is in
// the session transcript.
//
// It does NOT appear as a live-rendered bubble in the TUI at fire time —
// Pi's InteractiveMode binds its render pipeline to the AgentSession event
// stream, and a cron-fired append from an extension callback doesn't flow
// through AgentSession. Tradeoff explicitly accepted: TUI operators see
// reminders next turn, not real-time; chat platforms see them live via
// dispatcher.send → adapter.send.
//
// Lookup precedence in deliverAndAppend: target.sessionFile > origin_session_file.
// Both are captured at schedule time (ctx.sessionManager.getSessionFile()),
// so we no longer need a live-session fallback — that was leftover from
// the subprocess model where cron fires ran in a child process and couldn't
// see the parent's live sm.

// ----- Kickoff prompts differ by job type -----
//
// Reminder: the fresh subprocess LLM is told to DELIVER, not execute. This
// fixes the bug where "remind me to drink coffee" produced "Done, I've had
// my coffee" — the fresh session took the task literally.
//
// Task: unchanged from pre-Phase-7 behaviour — execute the instruction and
// report.

function buildKickoff(meta: JobMeta): string {
    if (meta.job_type === "reminder") {
        const scheduledAt = new Date(meta.created_at).toISOString().replace("T", " ").slice(0, 16);
        return [
            `[SCHEDULED REMINDER — ${meta.job_id}]`,
            `At ${scheduledAt} UTC, the user asked to be reminded of the following:`,
            ``,
            `  ${meta.task}`,
            ``,
            "Your job is to DELIVER the reminder, not execute it.",
            "Compose a short (1–3 sentences) conversational reminder message",
            "addressed to the user. Include enough context so it's self-contained",
            "and they can pick up the thread. Start with a gentle prefix like",
            `"⏰" or "📌".`,
            "",
            "Respond with ONLY the reminder text. No meta-commentary, no",
            `"I'll remind you now:", no tool calls unless the task demands it.`,
        ].join("\n");
    }
    if (meta.job_type === "poll") {
        const attempt = (meta.poll_attempts ?? 0) + 1;
        const max = meta.poll_max_attempts ?? 120;
        return [
            `[SCHEDULED POLL — ${meta.job_id}, attempt ${attempt} of ${max}]`,
            `Check task:`,
            ``,
            `  ${meta.task}`,
            ``,
            `Instructions:`,
            `- Run the check.`,
            `- If the condition is MET, call mark_poll_done("${meta.job_id}", "<concise final result>") THEN exit. The user will receive your final result.`,
            `- If the condition has DEFINITIVELY FAILED (error, not-found, invalid), call mark_poll_done("${meta.job_id}", "FAILED: <reason>") and exit — don't keep polling.`,
            `- If the condition is STILL PENDING (not done yet, "in progress", etc.), just exit quietly. You will be invoked again automatically. DO NOT call mark_poll_done in this case.`,
            ``,
            `Keep the final result short (1–3 sentences) — it becomes the user-facing message.`,
        ].join("\n");
    }
    if (meta.steps && meta.steps.length > 0) {
        return `[SCHEDULED ${meta.job_id}] Begin executing the seeded plan ("${meta.task}"). Report results when complete.`;
    }
    return `[SCHEDULED ${meta.job_id}] Task: ${meta.task}\n\nExecute and report when done.`;
}

// ----- Delivery + history-append after the subprocess exits -----

async function deliverAndAppend(meta: JobMeta, responseText: string): Promise<void> {
    if (!responseText.trim()) return;

    // 1) Deliver via the target's adapter. CLI gets skipped because the CLI
    //    adapter's send() prints to stderr — irrelevant for a user who is
    //    watching Pi's TUI; the session-append below is what they see.
    //    Other platforms (telegram, slack, a2a) deliver via dispatcher.
    const target = meta.deliverTarget ?? originChannelToTarget(meta.originChannel);
    if (target && target.platform !== "cli") {
        try {
            const resp: { text: string; replyToMessageId?: string } = { text: responseText };
            if (target.threadId) resp.replyToMessageId = target.threadId;
            await getDispatcher().send(target.platform, target.channelId, resp);
        } catch (e) {
            logError("scheduler", `delivery to ${target.platform}:${target.channelId} failed`, {
                err: e instanceof Error ? e.message : String(e),
                job_id: meta.job_id,
            });
        }
    }

    // 2) Append the delivery as a `scheduler-delivery` custom entry on the
    //    session where the user will follow up. Single append, target-preferred
    //    (mirrors amazon_manager's `_inject_into_session`).
    //
    //    CRITICAL PATH SELECTION:
    //      (a) target is a real chat channel (telegram/slack/a2a/…) →
    //          route through ChannelRuntime.appendCustomMessageToChannel.
    //          That method uses the CACHED SessionManager when the channel
    //          has an active AgentSession (so the in-memory state sees the
    //          entry and the next prompt's getBranch() picks it up). Falls
    //          through to disk when no cached session exists; the next
    //          lazy-create reads the JSONL and picks it up. Writing a
    //          fresh SessionManager directly to the same JSONL file does
    //          NOT work when the channel has a cached session — Pi doesn't
    //          re-read JSONL between turns.
    //      (b) target is cli / scheduler / undefined →
    //          fall back to origin_session_file via direct disk write. The
    //          TUI is owned by Pi's InteractiveMode (not ChannelRuntime)
    //          and has its own live SessionManager we can't reach into;
    //          disk write is best-effort (next-turn context may or may not
    //          see it — historical TUI-rendering caveat unchanged).
    const entryMetadata = {
        job_id: meta.job_id,
        job_type: meta.job_type,
        fired_at: Date.now(),
        target: target ?? null,
    };
    if (target && target.platform !== "cli" && target.platform !== "scheduler") {
        // Target is a real chat channel — use ChannelRuntime so the cached
        // AgentSession's in-memory state gets the entry. Follow-ups in THAT
        // channel will see the delivered reminder/digest in context.
        const result = await getChannelRuntime().appendCustomMessageToChannel(
            target.platform,
            target.channelId,
            "scheduler-delivery",
            responseText,
            true,
            entryMetadata,
        );
        if (!result.appended) {
            logError("scheduler", `failed to append scheduler-delivery to ${target.platform}:${target.channelId}`, {
                job_id: meta.job_id,
                reason: result.reason,
            });
        }
        return;
    }
    // Fallback path: CLI/TUI-scheduled with no chat target. Best-effort disk
    // write to the scheduling session's JSONL.
    const originFile = target?.sessionFile ?? meta.origin_session_file;
    if (originFile && fs.existsSync(originFile)) {
        appendSchedulerDeliveryEntry(originFile, meta, responseText, target);
    }
}

function appendSchedulerDeliveryEntry(
    sessionFile: string,
    meta: JobMeta,
    responseText: string,
    target: DeliverTarget | undefined,
): void {
    try {
        const sm = SessionManager.open(sessionFile);
        sm.appendCustomMessageEntry(
            "scheduler-delivery",
            responseText,
            true,
            {
                job_id: meta.job_id,
                job_type: meta.job_type,
                fired_at: Date.now(),
                target: target ?? null,
            },
        );
    } catch (e) {
        logError("scheduler", "session append failed", {
            err: e instanceof Error ? e.message : String(e),
            job_id: meta.job_id,
            sessionFile,
        });
    }
}

function originChannelToTarget(origin: OriginChannel | undefined): DeliverTarget | undefined {
    if (!origin) return undefined;
    const t: DeliverTarget = { platform: origin.platform, channelId: origin.channelId };
    if (origin.threadId) t.threadId = origin.threadId;
    return t;
}

// ----- Poll control (kvCache-backed) -----
//
// Polls terminate via a done-flag in kvCache, written by the subprocess's
// mark_poll_done tool. The parent reads it at the start of each fire AND
// after each subprocess exit — whichever sees the flag first delivers +
// cancels. Cross-process visibility works because kvCache is backed by a
// SQLite DB file with WAL mode; multiple processes opening the same file
// observe each other's committed writes.

const POLL_CONTROL_NS = "poll-control";
const POLL_CONTROL_TTL_SEC = 3600; // 1 hour — parent reads within seconds.

interface PollDoneSignal {
    done: true;
    result: string;
    markedAt: number;
}

function readPollDone(jobId: string): PollDoneSignal | undefined {
    return getKVCache().get<PollDoneSignal>(POLL_CONTROL_NS, jobId);
}

function clearPollControl(jobId: string): void {
    getKVCache().delete(POLL_CONTROL_NS, jobId);
}

/** Internal — called from mark_poll_done tool inside the subprocess. */
function writePollDone(jobId: string, result: string): void {
    getKVCache().set<PollDoneSignal>(
        POLL_CONTROL_NS,
        jobId,
        { done: true, result, markedAt: Date.now() },
        POLL_CONTROL_TTL_SEC,
    );
}

/** Finalize a completed poll: deliver, cancel its schedule, clean up state. */
async function finalizePoll(meta: JobMeta, finalText: string, reason: "done" | "timeout"): Promise<void> {
    const prefix = reason === "timeout" ? "[Poll timed out] " : "";
    await deliverAndAppend(meta, prefix + finalText);
    const rj = activeJobs.get(meta.job_id);
    if (rj) {
        rj.job.cancel();
        activeJobs.delete(meta.job_id);
    }
    deleteJobMeta(meta.job_id);
    clearPollControl(meta.job_id);
}

// ----- Cron fire handler -----

async function fireJob(meta: JobMeta, manualTrigger = false): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trigger = manualTrigger ? "manual" : "cron";
    console.log(`[scheduler] [${trigger}] fire ${meta.job_id} at ${stamp}`);

    // Poll pre-check: done-flag already set → finalize without spawning.
    if (meta.job_type === "poll") {
        const doneSignal = readPollDone(meta.job_id);
        if (doneSignal) {
            await finalizePoll(meta, doneSignal.result, "done");
            return;
        }
        // Attempt cap: give up without spawning if we've already hit the limit.
        const attempts = meta.poll_attempts ?? 0;
        const max = meta.poll_max_attempts ?? 120;
        if (attempts >= max) {
            await finalizePoll(
                meta,
                `Exhausted ${max} poll attempt${max === 1 ? "" : "s"} for "${meta.task}" without the check signalling completion.`,
                "timeout",
            );
            return;
        }
        // Increment attempts and persist BEFORE spawning so a crash leaves
        // the counter accurate for next boot.
        meta.poll_attempts = attempts + 1;
        saveJobMeta(meta);
    }

    let sm: SessionManager;
    try {
        sm = SessionManager.create(makeRunsDir());
    } catch (e) {
        logError("scheduler", `failed to create session for ${meta.job_id}`, { err: e instanceof Error ? e.message : String(e), job_id: meta.job_id });
        return;
    }
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) {
        logError("scheduler", `SessionManager.create() returned no file path`, { job_id: meta.job_id });
        return;
    }

    // If the job carries explicit steps, seedPlan before spawning. The
    // subprocess's plan_enforcer extension will see the seeded plan on
    // session_start and the agent's first turn enters Plan Enforcement Mode.
    if (meta.steps && meta.steps.length > 0) {
        const origin: OriginChannel = meta.originChannel ?? {
            platform: "scheduler",
            channelId: meta.job_id,
            scheduleId: meta.job_id,
        };
        try {
            const { plan } = await seedPlan(sessionFile, {
                task: meta.task,
                steps: meta.steps,
                originChannel: origin,
            });
            console.log(`[scheduler] seeded plan for ${meta.job_id}: ${meta.steps.length} step(s)`);
            // Record the thread→session map so admin @bot-abort replies in
            // this origin channel get routed back to THIS subprocess's
            // session. sessionId is the session's filename sans extension.
            const sessionId = sessionFileToId(sessionFile);
            recordPlanThread({
                platform: origin.platform,
                channelId: origin.channelId,
                ...(origin.threadId !== undefined ? { threadId: origin.threadId } : {}),
                sessionId,
                planId: plan.id,
                ...(origin.scheduleId !== undefined ? { scheduleId: origin.scheduleId } : {}),
            });
        } catch (e) {
            logError("scheduler", `seedPlan failed for ${meta.job_id}`, { err: e instanceof Error ? e.message : String(e), job_id: meta.job_id });
            return;
        }
    }

    // Kickoff depends on job type — reminders tell the LLM to DELIVER a
    // message to the user; tasks tell it to EXECUTE the instruction.
    const kickoff = buildKickoff(meta);

    // In-process AgentSession against the fresh session file. Shared services
    // (one instance per process, shared with channelRuntime) keep extension
    // parse cost amortized. prompt() awaits the turn — when it resolves the
    // agent_end subscription has captured the reply. No subprocess, no stdout
    // capture, no watchdog. Matches the f69bb81 inbound pattern.
    let capturedReply = "";
    let session;
    try {
        const services = await getSharedAgentServices();
        const result = await createAgentSessionFromServices({
            services,
            sessionManager: sm,
        });
        session = result.session;
    } catch (e) {
        logError("scheduler", `${meta.job_id} failed to create in-process agent session`, {
            err: e instanceof Error ? e.message : String(e),
            job_id: meta.job_id,
            trigger,
        });
        return;
    }
    const unsubscribe = session.subscribe((event) => {
        if (event.type === "agent_end") {
            capturedReply = extractAssistantText(event.messages);
        }
    });
    try {
        await Promise.race([
            session.prompt(kickoff),
            new Promise<never>((_, reject) => {
                const t = setTimeout(
                    () => reject(new Error(`turn exceeded ${MAX_FIRE_TURN_MS}ms — aborting`)),
                    MAX_FIRE_TURN_MS,
                );
                t.unref();
            }),
        ]);
    } catch (e) {
        logError("scheduler", `${meta.job_id} agent turn failed (${trigger})`, {
            err: e instanceof Error ? e.message : String(e),
            job_id: meta.job_id,
            trigger,
        });
        try { await session.abort(); } catch { /* best effort on timeout */ }
        // Fall through — still attempt delivery if a partial reply landed
        // before the failure.
    } finally {
        try { unsubscribe(); } catch { /* best effort */ }
    }
    console.log(`[scheduler] [${trigger}] ${meta.job_id} turn complete session=${sessionFile} reply_chars=${capturedReply.length}`);

    // Polls use a different delivery model: mark_poll_done writes to kvCache
    // from inside the fire turn. The agent's assistant text is NOT delivered
    // to the user — it's just status chatter ("still pending..."). Delivery
    // happens only when the done-flag is set, either by THIS fire's
    // mark_poll_done call or by a prior fire that's caught up asynchronously.
    // Check immediately after the turn so the user gets their result without
    // waiting for the next cron tick.
    if (meta.job_type === "poll") {
        const signal = readPollDone(meta.job_id);
        if (signal) {
            void finalizePoll(meta, signal.result, "done");
        }
        // If no done-flag: silent. The fire turn told the user's future self
        // "still pending" via its assistant text (which we ignore). Next cron
        // fire will try again.
        return;
    }

    if (!capturedReply) {
        logWarning("scheduler", `${meta.job_id} produced no agent response`, { job_id: meta.job_id });
        return;
    }
    void deliverAndAppend(meta, capturedReply);
}

// Safety net on a runaway turn. 5 min matches channelRuntime's MAX_TURN_TIMEOUT_MS.
// Real fires settle in <30s for reminders, <60s for task executions. If this
// fires, something is genuinely stuck — session.abort() releases the turn.
const MAX_FIRE_TURN_MS = 300_000;

function scheduleJob(meta: JobMeta): schedule.Job | null {
    const job = schedule.scheduleJob(meta.cron, () => { void fireJob(meta); });
    if (!job) return null;
    activeJobs.set(meta.job_id, { meta, job });
    return job;
}

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true;
    return getWhitelist().isAdmin(origin.platform, origin.senderId);
}

// =============================================================================
// Extension entry
// =============================================================================

export default function (pi: ExtensionAPI) {
    // On session_start: rehydrate persisted jobs. Skipped on any fresh
    // scheduled-run session (activeJobs already populated by the parent's
    // first-ever session_start). The old ORI2_SCHEDULER_SUBPROCESS env guard
    // is gone — fires are now in-process, and `activeJobs.size > 0` is the
    // single correct condition to prevent double-registration.
    pi.on("session_start", async () => {
        if (activeJobs.size > 0) return; // already loaded — don't double-register
        const all = loadAllJobMeta();
        for (const meta of all) {
            const job = scheduleJob(meta);
            if (job) {
                console.log(`[scheduler] rehydrated ${meta.job_id} (cron="${meta.cron}", next=${job.nextInvocation()?.toString() ?? "n/a"})`);
            } else {
                logWarning("scheduler", `failed to rehydrate job — invalid cron?`, { job_id: meta.job_id, cron: meta.cron });
            }
        }
        if (all.length > 0) {
            console.log(`[scheduler] rehydrated ${all.length} job${all.length === 1 ? "" : "s"} from ${jobsDir()}`);
        }
    });

    // ----- LLM tools -----

    pi.registerTool({
        name: "schedule_recurring_task",
        label: "Schedule Recurring Task",
        description:
            "Schedule a recurring autonomous TASK with a cron expression. Each fire spawns " +
            "a fresh session (no context pollution). The fresh-session agent EXECUTES the " +
            "task_instruction and reports. If `steps` is provided, plan-enforcement mode " +
            "activates (no skipping, no hallucinating steps). " +
            "For gentle reminders that should NOT execute (e.g. 'remind me to drink coffee') " +
            "use `schedule_reminder` instead — that path tells the fire-time agent to deliver " +
            "a message rather than do the thing. " +
            "\n\n" +
            "DELIVERY: set `deliver_to` explicitly for recurring tasks whose output is " +
            "user-facing (weekly reports, daily standups). If omitted and the user is in " +
            "the CLI/TUI, the task runs but results only surface in session history on " +
            "the NEXT message. ASK THE USER where they want recurring output delivered " +
            "before scheduling (Telegram? Slack? an A2A peer? the same chat they're in now?). " +
            "\n\n" +
            "**CRITICAL — channel IDs.** Before populating `deliver_to.channelId`, call " +
            "`list_known_channels` and pick the exact `channelId` from its output. NEVER " +
            "invent IDs (plausible-looking numbers like '-1001234567890' cause silent " +
            "Telegram 'chat not found' failures). If the channel the user means isn't in " +
            "the list, ASK them to paste the exact chat ID — don't guess.",
        parameters: Type.Object({
            job_id: Type.String({ description: "Unique identifier (e.g. 'daily_inventory')" }),
            cron_expression: Type.String({ description: "Cron expression (e.g. '0 9 * * *' for 9 AM daily)" }),
            task_instruction: Type.String({ description: "Description of what the task accomplishes. Write it as an instruction for your future self. Include enough context that an agent with no chat history can execute it correctly." }),
            steps: Type.Optional(Type.Array(Type.String(), { description: "Explicit ordered steps for plan-enforcement mode (recommended for high-stakes tasks)" })),
            deliver_to: Type.Optional(Type.Object({
                platform: Type.String({ description: "Adapter platform to deliver to: 'telegram', 'slack', 'a2a', … Must match a registered adapter at fire time or delivery is skipped (history still appends)." }),
                channelId: Type.String({ description: "Platform-specific channel id. MUST come from `list_known_channels` output — never invented. If the target isn't listed, ASK the user to paste it." }),
                threadId: Type.Optional(Type.String({ description: "Optional reply-to / thread id. Telegram: message id to reply to. Slack: thread_ts." })),
            }, { description: "Optional override for WHERE output is delivered. Defaults to the chat that scheduled the job. Use this to route a recurring job to a different channel (e.g. schedule from DM, post to a team channel). ALWAYS call `list_known_channels` first to resolve channelId." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            if (activeJobs.has(params.job_id)) {
                throw new Error(`Job '${params.job_id}' already exists. Cancel it first.`);
            }
            const origin = currentOrigin(ctx.sessionManager);
            const meta: JobMeta = {
                job_id: params.job_id,
                job_type: "task",
                cron: params.cron_expression,
                task: params.task_instruction,
                created_at: Date.now(),
                created_by: origin ? `${origin.platform}:${origin.senderId}` : "cli",
            };
            if (params.steps && params.steps.length > 0) meta.steps = params.steps;
            if (params.deliver_to) {
                meta.deliverTarget = {
                    platform: params.deliver_to.platform,
                    channelId: params.deliver_to.channelId,
                    ...(params.deliver_to.threadId !== undefined ? { threadId: params.deliver_to.threadId } : {}),
                };
            }
            if (origin && origin.platform !== "cli") {
                meta.originChannel = {
                    platform: origin.platform,
                    channelId: origin.channelId,
                    scheduleId: params.job_id,
                };
            }
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile) meta.origin_session_file = sessionFile;
            const job = scheduleJob(meta);
            if (!job) throw new Error(`Invalid cron expression: "${params.cron_expression}"`);
            saveJobMeta(meta);
            const next = job.nextInvocation()?.toString() ?? "(no future invocations)";
            return {
                content: [{ type: "text", text: `Scheduled task '${params.job_id}'. Next run: ${next}.` }],
                details: { job_id: params.job_id, next_run: next, has_steps: !!meta.steps, deliver_to: meta.deliverTarget ?? null },
            };
        },
    });

    pi.registerTool({
        name: "schedule_reminder",
        label: "Schedule One-Off Reminder",
        description:
            "Schedule a one-off REMINDER N minutes from now. At fire time a fresh-session agent " +
            "is told to DELIVER the reminder (not execute it) and the delivered text is appended " +
            "to the scheduling session's history so future references like 'thanks, just watched " +
            "it' can resolve context. Use this for 'remind me to …' requests. For jobs the agent " +
            "should actually DO, use `schedule_recurring_task`. " +
            "\n\n" +
            "WHERE DOES THE REMINDER APPEAR? " +
            "If `deliver_to` is set, the reminder is pushed to that chat platform as a real " +
            "message (Telegram bubble, Slack DM, etc.) when it fires. " +
            "If `deliver_to` is omitted AND the user is talking to you via a chat platform " +
            "(telegram, slack, a2a), it auto-routes back to that chat. " +
            "If `deliver_to` is omitted AND the user is in the CLI/TUI (you can see by checking " +
            "currentOrigin or transport-origin), the reminder IS scheduled and fires correctly, " +
            "but WILL NOT appear as a live bubble in the TUI — it only appears in conversation " +
            "history on the NEXT message. In that case, ASK THE USER where they want the " +
            "reminder sent ('via Telegram? Slack? or just kept in session history?') and pass " +
            "their choice via `deliver_to`. " +
            "\n\n" +
            "**CRITICAL — channel IDs.** Before populating `deliver_to.channelId`, call " +
            "`list_known_channels` and pick the exact `channelId` from its output. NEVER " +
            "invent IDs. If the user says 'my Telegram' and the tool returns a telegram DM row " +
            "that matches them (e.g. `telegram:330959414 name=\"you\"`), use THAT channelId. " +
            "If nothing matches, ASK the user to paste the exact chat ID — don't guess. " +
            "Hallucinated IDs like '-1001234567890' silently fail at Telegram with 'chat not found'. " +
            "\n\n" +
            "When writing `reminder_message`, include the context the user currently has in chat " +
            "— the fire-time agent has no conversation history, so 'remind me to watch this movie' " +
            "needs to become 'remind user to watch Oppenheimer (they mentioned it in chat today)'. " +
            "Write the reminder as an instruction for your future self.",
        parameters: Type.Object({
            minutes_from_now: Type.Number({ description: "Delay in minutes from now" }),
            reminder_message: Type.String({ description: "Self-contained reminder text — include enough context that an agent with NO chat history can deliver a useful reminder." }),
            deliver_to: Type.Optional(Type.Object({
                platform: Type.String({ description: "Adapter platform to deliver to: 'telegram', 'slack', 'a2a', … Must match a registered adapter at fire time." }),
                channelId: Type.String({ description: "Platform-specific channel id. MUST come from `list_known_channels` output — never invented. If the target isn't listed, ASK the user to paste it." }),
                threadId: Type.Optional(Type.String({ description: "Optional reply-to / thread id." })),
            }, { description: "Optional override. Defaults to the chat that scheduled the reminder. Use to remind someone in a different chat (e.g. schedule from DM, deliver to a group). ALWAYS call `list_known_channels` first to resolve channelId." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const delayMs = Math.max(0, params.minutes_from_now * 60 * 1000);
            const fireAt = new Date(Date.now() + delayMs);
            const origin = currentOrigin(ctx.sessionManager);
            const meta: JobMeta = {
                job_id: `reminder_${Date.now()}`,
                job_type: "reminder",
                cron: fireAt.toISOString(), // node-schedule accepts Date too — store ISO for replay
                task: params.reminder_message,
                created_at: Date.now(),
                created_by: origin ? `${origin.platform}:${origin.senderId}` : "cli",
            };
            if (params.deliver_to) {
                meta.deliverTarget = {
                    platform: params.deliver_to.platform,
                    channelId: params.deliver_to.channelId,
                    ...(params.deliver_to.threadId !== undefined ? { threadId: params.deliver_to.threadId } : {}),
                };
            }
            if (origin && origin.platform !== "cli") {
                meta.originChannel = {
                    platform: origin.platform,
                    channelId: origin.channelId,
                    scheduleId: meta.job_id,
                };
            }
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile) meta.origin_session_file = sessionFile;

            const job = schedule.scheduleJob(fireAt, () => {
                void fireJob(meta).then(() => {
                    deleteJobMeta(meta.job_id);
                    activeJobs.delete(meta.job_id);
                });
            });
            if (!job) throw new Error("Failed to schedule reminder");
            activeJobs.set(meta.job_id, { meta, job });
            saveJobMeta(meta);
            return {
                content: [{ type: "text", text: `Reminder ${meta.job_id} set. Will fire at ${fireAt.toISOString()}.` }],
                details: { job_id: meta.job_id, fire_at: fireAt.toISOString(), deliver_to: meta.deliverTarget ?? null },
            };
        },
    });

    pi.registerTool({
        name: "schedule_poll",
        label: "Schedule Poll",
        description:
            "Schedule a RECURRING CHECK that terminates when a condition is met. Each fire " +
            "spawns a fresh subprocess that runs `check_instruction`; that subprocess's agent " +
            "decides whether the condition is met and calls `mark_poll_done` to stop the poll " +
            "and deliver the final result. " +
            "\n\n" +
            "DELIVERY: when the poll finishes (via mark_poll_done or timeout), the final result " +
            "is delivered to `deliver_to` if set, otherwise back to the origin chat. " +
            "For polls kicked off from the TUI, the final result appears in session history " +
            "(next message) but not live in the TUI — ASK THE USER where the completion notice " +
            "should be sent before scheduling. " +
            "\n\n" +
            "**CRITICAL — channel IDs.** Before populating `deliver_to.channelId`, call " +
            "`list_known_channels` and pick the exact `channelId` from its output. NEVER " +
            "invent IDs. If nothing matches, ASK the user to paste the exact chat ID. " +
            "\n\n" +
            "Use for async external work the user shouldn't have to watch manually — SP-API " +
            "report jobs, 'ping me when this PR is green', 'notify me when the listing becomes " +
            "active'. Different from schedule_recurring_task because polls self-terminate; " +
            "different from schedule_reminder because the fire-time agent ACTIVELY runs the " +
            "check, it's not just a delivery. " +
            "\n\n" +
            "Write `check_instruction` as a self-contained instruction for the fire-time agent " +
            "(no prior conversation context — include every detail the check needs: ASINs, " +
            "report ids, URLs, expected states). The final delivered message is whatever text " +
            "the agent passes to mark_poll_done.",
        parameters: Type.Object({
            poll_id: Type.String({ description: "Unique id for this poll. Used by mark_poll_done to terminate. Convention: 'poll_<domain>_<timestamp>'." }),
            every_seconds: Type.Integer({
                description: "How often to re-run the check, in seconds. Min 10 (avoid tight loops), max 3600 (1h).",
                minimum: 10,
                maximum: 3600,
            }),
            check_instruction: Type.String({ description: "What the fire-time agent should check. Self-contained — no conversation context available." }),
            max_attempts: Type.Optional(Type.Integer({
                description: "Give up after N fires. Default 120 (= 1 hour at 30s cadence). Hard cap to prevent runaway polls.",
                minimum: 1,
                maximum: 10000,
            })),
            deliver_to: Type.Optional(Type.Object({
                platform: Type.String({ description: "Platform: 'telegram', 'slack', 'a2a', 'cli'." }),
                channelId: Type.String({ description: "Platform-specific channel id. MUST come from `list_known_channels` output — never invented. If the target isn't listed, ASK the user to paste it." }),
                threadId: Type.Optional(Type.String({ description: "Optional reply-to / thread id." })),
            }, { description: "Optional override for WHERE the final result is delivered. Defaults to the chat that scheduled the poll. ALWAYS call `list_known_channels` first to resolve channelId." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            if (activeJobs.has(params.poll_id)) {
                throw new Error(`Poll '${params.poll_id}' already active. Cancel it first or use a different id.`);
            }
            // node-schedule supports 6-field cron with seconds in the first
            // position. "*/<n> * * * * *" fires every n seconds.
            const cron = `*/${params.every_seconds} * * * * *`;
            const origin = currentOrigin(ctx.sessionManager);
            const meta: JobMeta = {
                job_id: params.poll_id,
                job_type: "poll",
                cron,
                task: params.check_instruction,
                poll_max_attempts: params.max_attempts ?? 120,
                poll_attempts: 0,
                created_at: Date.now(),
                created_by: origin ? `${origin.platform}:${origin.senderId}` : "cli",
            };
            if (params.deliver_to) {
                meta.deliverTarget = {
                    platform: params.deliver_to.platform,
                    channelId: params.deliver_to.channelId,
                    ...(params.deliver_to.threadId !== undefined ? { threadId: params.deliver_to.threadId } : {}),
                };
            }
            if (origin && origin.platform !== "cli") {
                meta.originChannel = {
                    platform: origin.platform,
                    channelId: origin.channelId,
                    scheduleId: params.poll_id,
                };
            }
            const sessionFile = ctx.sessionManager.getSessionFile();
            if (sessionFile) meta.origin_session_file = sessionFile;

            const job = scheduleJob(meta);
            if (!job) throw new Error(`Invalid cron expression derived from every_seconds=${params.every_seconds}: "${cron}"`);
            saveJobMeta(meta);
            const next = job.nextInvocation()?.toString() ?? "(no future invocations)";
            return {
                content: [{ type: "text", text: `Poll '${params.poll_id}' scheduled. First check: ${next}. Max ${meta.poll_max_attempts} attempts at ${params.every_seconds}s cadence (= ~${Math.round((meta.poll_max_attempts! * params.every_seconds) / 60)} min). Will terminate when the fire-time agent calls mark_poll_done.` }],
                details: { poll_id: params.poll_id, cron, every_seconds: params.every_seconds, max_attempts: meta.poll_max_attempts, next_check: next, deliver_to: meta.deliverTarget ?? null },
            };
        },
    });

    pi.registerTool({
        name: "mark_poll_done",
        label: "Mark Poll Done",
        description:
            "Call this FROM WITHIN a scheduled poll fire when the check's condition is met " +
            "(or definitively failed). Writes a termination signal the parent scheduler reads " +
            "on its next tick (usually within seconds). The `final_result` text becomes the " +
            "user-facing delivered message. " +
            "\n\n" +
            "You should ONLY call this during a scheduled poll execution — you'll know because " +
            "the kickoff message starts with '[SCHEDULED POLL — <poll_id>]'. Calling outside a " +
            "poll context has no effect beyond writing a stale entry that gets swept.",
        parameters: Type.Object({
            poll_id: Type.String({ description: "Exact poll_id from the [SCHEDULED POLL — X] header in your kickoff." }),
            final_result: Type.String({ description: "The message the user will receive. 1-3 sentences. Concise." }),
        }),
        async execute(_id, params) {
            writePollDone(params.poll_id, params.final_result);
            return {
                content: [{ type: "text", text: `Poll ${params.poll_id} marked done. Parent scheduler will deliver "${params.final_result.slice(0, 80)}${params.final_result.length > 80 ? "..." : ""}" and cancel the schedule on its next tick.` }],
                details: { poll_id: params.poll_id },
            };
        },
    });

    pi.registerTool({
        name: "cancel_scheduled_task",
        label: "Cancel Task",
        description: "Cancel an active scheduled job by id.",
        parameters: Type.Object({
            job_id: Type.String(),
        }),
        async execute(_id, params) {
            const job = activeJobs.get(params.job_id);
            if (!job) {
                return {
                    content: [{ type: "text", text: `Job '${params.job_id}' not found.` }],
                    details: { job_id: params.job_id, cancelled: false },
                };
            }
            job.job.cancel();
            activeJobs.delete(params.job_id);
            deleteJobMeta(params.job_id);
            return {
                content: [{ type: "text", text: `Cancelled '${params.job_id}'.` }],
                details: { job_id: params.job_id, cancelled: true },
            };
        },
    });

    pi.registerTool({
        name: "list_scheduled_tasks",
        label: "List Scheduled Tasks",
        description: "View all active scheduled jobs with their cron expressions, next run times, and seeded steps if any.",
        parameters: Type.Object({}),
        async execute() {
            if (activeJobs.size === 0) {
                return {
                    content: [{ type: "text", text: "No active scheduled tasks." }],
                    details: { jobs: [] },
                };
            }
            const lines = ["ACTIVE SCHEDULED TASKS:", ""];
            const jobs: Array<{ job_id: string; cron: string; task: string; next_run: string; has_steps: boolean }> = [];
            for (const [id, rj] of activeJobs.entries()) {
                const next = rj.job.nextInvocation()?.toString() ?? "n/a";
                const stepsTag = rj.meta.steps && rj.meta.steps.length > 0 ? ` [${rj.meta.steps.length} seeded steps]` : "";
                lines.push(`- [${id}] cron="${rj.meta.cron}" next=${next}${stepsTag}`);
                lines.push(`    Task: ${rj.meta.task}`);
                jobs.push({ job_id: id, cron: rj.meta.cron, task: rj.meta.task, next_run: next, has_steps: !!rj.meta.steps });
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { jobs },
            };
        },
    });

    pi.registerTool({
        name: "update_scheduled_task",
        label: "Update Task",
        description: "Modify cron and/or task of an existing scheduled job. Steps and origin retained unless explicitly overridden.",
        parameters: Type.Object({
            job_id: Type.String(),
            new_cron_expression: Type.Optional(Type.String()),
            new_task_instruction: Type.Optional(Type.String()),
        }),
        async execute(_id, params) {
            const rj = activeJobs.get(params.job_id);
            if (!rj) throw new Error(`Job '${params.job_id}' not found.`);
            const newMeta: JobMeta = {
                ...rj.meta,
                cron: params.new_cron_expression ?? rj.meta.cron,
                task: params.new_task_instruction ?? rj.meta.task,
            };
            rj.job.cancel();
            activeJobs.delete(params.job_id);
            const newJob = scheduleJob(newMeta);
            if (!newJob) throw new Error(`Invalid cron expression: "${newMeta.cron}"`);
            saveJobMeta(newMeta);
            const next = newJob.nextInvocation()?.toString() ?? "n/a";
            return {
                content: [{ type: "text", text: `Updated '${params.job_id}'. Next run: ${next}.` }],
                details: { job_id: params.job_id, cron: newMeta.cron, next_run: next },
            };
        },
    });

    pi.registerTool({
        name: "trigger_scheduled_task_now",
        label: "Trigger Now",
        description: "Manually fire a scheduled task immediately (without waiting for cron). Useful for testing or one-off catch-up runs.",
        parameters: Type.Object({
            job_id: Type.String(),
        }),
        async execute(_id, params) {
            const rj = activeJobs.get(params.job_id);
            if (!rj) throw new Error(`Job '${params.job_id}' not found.`);
            // Don't await — let it run in background.
            void fireJob(rj.meta, true);
            return {
                content: [{ type: "text", text: `Triggered '${params.job_id}' manually. Fresh session is running in a subprocess.` }],
                details: { job_id: params.job_id, triggered: true },
            };
        },
    });

    // Slash command for inspection (read-only — uses tool ACL for the LLM tool variants).
    pi.registerCommand("schedule", {
        description: "Inspect scheduled jobs. Run /schedule for the list.",
        handler: async (_args, ctx) => {
            void isAdminCaller; // silence unused warning if not yet referenced
            if (activeJobs.size === 0) {
                ctx.ui.notify("No active scheduled jobs.", "info");
                return;
            }
            const lines = ["Active scheduled jobs:", ""];
            for (const [id, rj] of activeJobs.entries()) {
                const next = rj.job.nextInvocation()?.toString() ?? "n/a";
                const steps = rj.meta.steps ? `${rj.meta.steps.length} steps` : "no plan";
                const origin = rj.meta.originChannel ? `→ ${rj.meta.originChannel.platform}:${rj.meta.originChannel.channelId}` : "(no report channel)";
                lines.push(`  [${id.padEnd(20)}] cron="${rj.meta.cron}"  next=${next}`);
                lines.push(`    task: ${rj.meta.task}`);
                lines.push(`    ${steps}, ${origin}, created by ${rj.meta.created_by}`);
            }
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
}
