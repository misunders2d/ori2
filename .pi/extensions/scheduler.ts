import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import schedule from "node-schedule";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { botSubdir, ensureDir } from "../../src/core/paths.js";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { seedPlan, type OriginChannel } from "./plan_enforcer.js";

// =============================================================================
// scheduler — per-fire fresh-session model.
//
// REWRITE NOTES (vs Sprint 4-era version):
//   - OLD: cron callback called ctx.sendUserMessage(...), injecting the task
//     into whichever Pi session was active at registration time. Captured ctx
//     went stale after /new or restart.
//   - NEW: cron callback creates a FRESH SessionManager + optionally calls
//     seedPlan() (for jobs with explicit step lists) + spawns a subprocess
//     (scripts/scheduled-run.ts) to run the agent against that session.
//     The parent process keeps polling Telegram (inbound undisturbed) while
//     the subprocess runs the scheduled task.
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

interface JobMeta {
    job_id: string;
    cron: string;
    task: string;
    steps?: string[];
    originChannel?: OriginChannel;
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
                out.push({
                    job_id: parsed.job_id,
                    cron: parsed.cron,
                    task: parsed.task,
                    ...(Array.isArray(parsed.steps) ? { steps: parsed.steps } : {}),
                    ...(parsed.originChannel ? { originChannel: parsed.originChannel } : {}),
                    created_at: typeof parsed.created_at === "number" ? parsed.created_at : Date.now(),
                    created_by: typeof parsed.created_by === "string" ? parsed.created_by : "unknown",
                });
            }
        } catch (e) {
            console.error(`[scheduler] corrupt job file ${f}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    return out;
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

// ----- Cron fire handler -----

async function fireJob(meta: JobMeta, manualTrigger = false): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const trigger = manualTrigger ? "manual" : "cron";
    console.log(`[scheduler] [${trigger}] fire ${meta.job_id} at ${stamp}`);

    let sm: SessionManager;
    try {
        sm = SessionManager.create(makeRunsDir());
    } catch (e) {
        console.error(`[scheduler] failed to create session for ${meta.job_id}: ${e instanceof Error ? e.message : String(e)}`);
        return;
    }
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) {
        console.error(`[scheduler] SessionManager.create() returned no file path for ${meta.job_id}`);
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
            await seedPlan(sessionFile, {
                task: meta.task,
                steps: meta.steps,
                originChannel: origin,
            });
            console.log(`[scheduler] seeded plan for ${meta.job_id}: ${meta.steps.length} step(s)`);
        } catch (e) {
            console.error(`[scheduler] seedPlan failed for ${meta.job_id}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
    }

    // Build kickoff message — include the task description so the agent
    // sees it even when no plan was seeded.
    const kickoff = meta.steps && meta.steps.length > 0
        ? `[SCHEDULED ${meta.job_id}] Begin executing the seeded plan ("${meta.task}"). Report results when complete.`
        : `[SCHEDULED ${meta.job_id}] Task: ${meta.task}\n\nExecute and report when done.`;

    // Spawn the runner subprocess.
    const proc = spawn(
        "npx",
        ["tsx", "scripts/scheduled-run.ts", sessionFile, kickoff],
        {
            cwd: process.cwd(),
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        },
    );
    proc.stdout.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n")) {
            if (line.trim()) console.log(`[scheduler:${meta.job_id}] ${line}`);
        }
    });
    proc.stderr.on("data", (d: Buffer) => {
        for (const line of d.toString().split("\n")) {
            if (line.trim()) console.error(`[scheduler:${meta.job_id}:stderr] ${line}`);
        }
    });
    proc.on("close", (code) => {
        console.log(`[scheduler] [${trigger}] ${meta.job_id} subprocess exit code=${code} session=${sessionFile}`);
    });
    proc.on("error", (e) => {
        console.error(`[scheduler] [${trigger}] ${meta.job_id} subprocess error: ${e.message}`);
    });
}

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
    // On load: rehydrate persisted jobs. Replaces the stale-ctx bug from the
    // old version (jobs survive /new and process restart).
    pi.on("session_start", async () => {
        if (activeJobs.size > 0) return; // already loaded — don't double-register
        const all = loadAllJobMeta();
        for (const meta of all) {
            const job = scheduleJob(meta);
            if (job) {
                console.log(`[scheduler] rehydrated ${meta.job_id} (cron="${meta.cron}", next=${job.nextInvocation()?.toString() ?? "n/a"})`);
            } else {
                console.error(`[scheduler] failed to rehydrate ${meta.job_id} — invalid cron "${meta.cron}"?`);
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
            "Schedule a recurring autonomous task with a cron expression. Each fire spawns " +
            "a fresh session (no context pollution). If `steps` is provided, the plan is " +
            "seeded into that session via plan_enforcer's seedPlan, and the agent runs in " +
            "Plan Enforcement Mode (no skipping, no hallucinating steps). Without `steps` " +
            "the agent sees the task instruction as a kickoff message.",
        parameters: Type.Object({
            job_id: Type.String({ description: "Unique identifier (e.g. 'daily_inventory')" }),
            cron_expression: Type.String({ description: "Cron expression (e.g. '0 9 * * *' for 9 AM daily)" }),
            task_instruction: Type.String({ description: "Description of what the task accomplishes" }),
            steps: Type.Optional(Type.Array(Type.String(), { description: "Explicit ordered steps for plan-enforcement mode (optional but recommended for high-stakes tasks)" })),
            origin_platform: Type.Optional(Type.String({ description: "Platform to report results to (e.g. 'telegram')" })),
            origin_channel_id: Type.Optional(Type.String({ description: "Channel id to report results to" })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            if (activeJobs.has(params.job_id)) {
                throw new Error(`Job '${params.job_id}' already exists. Cancel it first.`);
            }
            const origin = currentOrigin(ctx.sessionManager);
            const meta: JobMeta = {
                job_id: params.job_id,
                cron: params.cron_expression,
                task: params.task_instruction,
                created_at: Date.now(),
                created_by: origin ? `${origin.platform}:${origin.senderId}` : "cli",
            };
            if (params.steps && params.steps.length > 0) meta.steps = params.steps;
            if (params.origin_platform && params.origin_channel_id) {
                meta.originChannel = {
                    platform: params.origin_platform,
                    channelId: params.origin_channel_id,
                    scheduleId: params.job_id,
                };
            } else if (origin && origin.platform !== "cli") {
                meta.originChannel = {
                    platform: origin.platform,
                    channelId: origin.channelId,
                    scheduleId: params.job_id,
                };
            }
            const job = scheduleJob(meta);
            if (!job) throw new Error(`Invalid cron expression: "${params.cron_expression}"`);
            saveJobMeta(meta);
            const next = job.nextInvocation()?.toString() ?? "(no future invocations)";
            return {
                content: [{ type: "text", text: `Scheduled '${params.job_id}'. Next run: ${next}.` }],
                details: { job_id: params.job_id, next_run: next, has_steps: !!meta.steps },
            };
        },
    });

    pi.registerTool({
        name: "schedule_reminder",
        label: "Schedule One-Off Reminder",
        description: "Schedule a one-time reminder N minutes from now. Spawns a fresh session like recurring tasks.",
        parameters: Type.Object({
            minutes_from_now: Type.Number({ description: "Delay in minutes" }),
            reminder_message: Type.String({ description: "What to do at the reminder time" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const delayMs = Math.max(0, params.minutes_from_now * 60 * 1000);
            const fireAt = new Date(Date.now() + delayMs);
            const origin = currentOrigin(ctx.sessionManager);
            const meta: JobMeta = {
                job_id: `reminder_${Date.now()}`,
                cron: fireAt.toISOString(), // node-schedule accepts Date too — store ISO for replay
                task: params.reminder_message,
                created_at: Date.now(),
                created_by: origin ? `${origin.platform}:${origin.senderId}` : "cli",
            };
            if (origin && origin.platform !== "cli") {
                meta.originChannel = {
                    platform: origin.platform,
                    channelId: origin.channelId,
                    scheduleId: meta.job_id,
                };
            }
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
                details: { job_id: meta.job_id, fire_at: fireAt.toISOString() },
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
