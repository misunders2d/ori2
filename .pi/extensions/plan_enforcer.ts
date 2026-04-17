import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Plan Enforcer
//
// Enforces strict, sequential, no-skip execution of pre-defined plans.
// Built primarily for SCHEDULED, AUTONOMOUS runs (e.g. amazon-manager doing
// listing maintenance at 3am) where deviation is unacceptable. Also supports
// INTERACTIVE plans that a user can author and the agent can abandon.
//
// State is per-session: held in a closure variable, persisted as session
// `custom` entries via `pi.appendEntry`, and rebuilt from the branch on
// `session_start`. This makes it safe for multiple users / channels — each
// (chat user, channel) gets its own Pi session with its own plan.
//
// Cross-session admin override: each session also writes a heartbeat to
// `data/<BOT>/active-plans/<sessionId>.json` so an admin from any other
// running session can run `/plans` to enumerate live plans and
// `/plan-abort <sessionId> <reason>` to halt one cleanly.
// ---------------------------------------------------------------------------

// ---------- Public types (also imported by scheduler.ts and bus.ts) ----------

export type PlanStepStatus = "pending" | "in_progress" | "done" | "failed";
export type PlanStatus = "active" | "completed" | "failed" | "abandoned";
export type PlanMode = "interactive" | "scheduled";

export type PlanStep = {
    id: number;
    description: string;
    status: PlanStepStatus;
    result?: string;
};

export type OriginChannel = {
    platform: "slack" | "telegram" | "terminal" | string;
    channelId: string;
    threadId?: string;
    scheduleId?: string;
};

export type Plan = {
    id: string;
    title: string;
    mode: PlanMode;
    originChannel?: OriginChannel;
    steps: PlanStep[];
    status: PlanStatus;
    created_at: number;
    updated_at: number;
};

export type PlanReport = {
    kind: "completed" | "failed" | "abandoned" | "aborted";
    sessionId: string;
    plan: Plan;
    originChannel?: OriginChannel;
    reason?: string;
    timestamp: number;
};

export type AdminAction = {
    sessionId: string;
    action: "abort";
    reason: string;
    by: string;
};

const ENTRY_TYPE = "plan-enforcer";

type PlanStateEntry =
    | { kind: "set"; plan: Plan }
    | { kind: "advance"; stepId: number }
    | { kind: "complete"; stepId: number; result: string }
    | { kind: "fail"; stepId: number; reason: string }
    | { kind: "cancel"; reason: string }
    | { kind: "abort"; reason: string; by: string };

// ---------- Path helpers ----------

function botDir(): string {
    const botName = process.env["BOT_NAME"] ?? "ori2_agent";
    return path.resolve(process.cwd(), "data", botName);
}
function registryDir(): string { return path.join(botDir(), "active-plans"); }
function controlDir(): string { return path.join(botDir(), "plan-control"); }
function reportsDir(): string { return path.join(botDir(), "plan-reports"); }
function threadsDir(): string { return path.join(botDir(), "plan-threads"); }
function ensureDir(p: string) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

/**
 * Deterministic filename for the thread-map index. Collapses non-identifier
 * characters so a channelId containing '/' (Slack-style `C0123/threadTs`)
 * or a threadId containing ':' doesn't escape the target directory.
 */
function threadKey(platform: string, channelId: string, threadId: string | undefined): string {
    const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_");
    const t = threadId ? `-${safe(threadId)}` : "";
    return `${safe(platform)}-${safe(channelId)}${t}.json`;
}

// ---------- Thread→session map (Admin Override Option C support) ----------

/**
 * Associate a chat thread with an active scheduled plan so that an admin
 * replying "@bot abort" in that thread can be routed back to this session.
 * Called by scheduler.ts at plan-seed time (after seedPlan succeeds). The
 * dispatcher pre-hook in transport_bridge.ts reads this to detect admin
 * abort replies.
 *
 * Idempotent — overwrites any existing record for the same thread key.
 */
export function recordPlanThread(args: {
    platform: string;
    channelId: string;
    threadId?: string;
    sessionId: string;
    planId: string;
    scheduleId?: string;
}): void {
    ensureDir(threadsDir());
    const file = path.join(threadsDir(), threadKey(args.platform, args.channelId, args.threadId));
    fs.writeFileSync(file, JSON.stringify({
        platform: args.platform,
        channelId: args.channelId,
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        sessionId: args.sessionId,
        planId: args.planId,
        ...(args.scheduleId !== undefined ? { scheduleId: args.scheduleId } : {}),
        recordedAt: Date.now(),
    }, null, 2), { mode: 0o600 });
}

/**
 * Reverse lookup: given the (platform, channelId, threadId) of an inbound
 * chat message, return the plan's sessionId if a scheduled plan is
 * associated with that thread. Null otherwise.
 *
 * Used by transport_bridge's admin-abort detector.
 */
export function findPlanSessionByThread(
    platform: string,
    channelId: string,
    threadId: string | undefined,
): { sessionId: string; planId: string } | null {
    const dir = threadsDir();
    if (!fs.existsSync(dir)) return null;
    const file = path.join(dir, threadKey(platform, channelId, threadId));
    if (!fs.existsSync(file)) {
        // Tolerate the case where the initial record was written without a
        // threadId (single-channel deployment) — try without threadId.
        if (threadId !== undefined) return findPlanSessionByThread(platform, channelId, undefined);
        return null;
    }
    try {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw) as { sessionId?: unknown; planId?: unknown };
        if (typeof parsed.sessionId !== "string" || typeof parsed.planId !== "string") return null;
        return { sessionId: parsed.sessionId, planId: parsed.planId };
    } catch { return null; }
}

/**
 * Drop an abort control file for the owning session to pick up. Same
 * mechanism as Option D (manual drop-file kill switch). Used by
 * transport_bridge's @bot-abort detector.
 */
export function writeAbortControlFile(sessionId: string, reason: string, by: string): void {
    ensureDir(controlDir());
    const file = path.join(controlDir(), `abort-${sessionId}.json`);
    fs.writeFileSync(file, JSON.stringify({ reason, by, issuedAt: Date.now() }, null, 2), { mode: 0o600 });
}

// ---------- Programmatic seed (called by scheduler.ts at fire time) ----------

/**
 * Seed a plan into a fresh session BEFORE the agent's first turn.
 *
 * This is the equivalent of the original ADK `seed_plan(session_id, task, steps)`.
 *
 * EXPECTED CALLER FLOW (scheduler.ts when a cron fires):
 *
 *     import { SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent";
 *     import { seedPlan } from "./plan_enforcer.js";
 *
 *     const sm = SessionManager.create(process.cwd());
 *     await seedPlan(sm.getSessionFile()!, {
 *         task: "Daily Amazon listing maintenance",
 *         steps: [
 *             "Pull current SKU inventory from BigQuery",
 *             "Identify low-stock and stale listings",
 *             "Apply pricing/title updates via Amazon SP-API",
 *             "Post completion summary to #amazon-ops",
 *         ],
 *         originChannel: {
 *             platform: "slack",
 *             channelId: "C0123456",
 *             threadId: "1700000000.000100",
 *             scheduleId: "amazon_daily_maintenance",
 *         },
 *     });
 *     // Then launch a non-interactive Pi run against this session — e.g.
 *     // createAgentSession({ sessionManager: sm, ... }) and trigger the first
 *     // turn with sm.appendMessage({ role: "user", content: [{ type: "text",
 *     // text: "[SCHEDULED] Begin executing the plan." }], timestamp: Date.now() })
 *
 * Marks the plan `mode: "scheduled"`, which:
 *   - Forbids the agent from calling `plan_cancel` (must complete or fail loud)
 *   - Causes completion / failure / abort to emit `plan:report` for delivery
 *     back to `originChannel`
 *
 * Throws if the session already contains a plan-enforcer entry — seedPlan is
 * intended for FRESH sessions only, so the agent has no opportunity to author
 * its own plan first.
 */
export async function seedPlan(
    sessionFile: string,
    opts: {
        task: string;
        steps: string[];
        originChannel: OriginChannel;
    },
): Promise<{ plan: Plan }> {
    if (!opts.steps || opts.steps.length === 0) {
        throw new Error("seedPlan requires at least one step.");
    }
    const sm = SessionManager.open(sessionFile);
    for (const entry of sm.getEntries()) {
        if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
            throw new Error(`Session ${sessionFile} already has a plan-enforcer entry; refusing to seed.`);
        }
    }
    const now = Date.now();
    const plan: Plan = {
        id: `plan-${now}-${Math.random().toString(36).slice(2, 8)}`,
        title: opts.task,
        mode: "scheduled",
        originChannel: opts.originChannel,
        steps: opts.steps.map((d, i) => ({ id: i, description: d, status: "pending" as const })),
        status: "active",
        created_at: now,
        updated_at: now,
    };
    const entry: PlanStateEntry = { kind: "set", plan };
    sm.appendCustomEntry(ENTRY_TYPE, entry);
    return { plan };
}

// ---------- Extension entry point ----------

export default function (pi: ExtensionAPI) {
    let activePlan: Plan | null = null;
    let aborted: { reason: string; by: string } | null = null;
    let currentSessionId: string | null = null;

    function applyEntry(data: PlanStateEntry) {
        if (data.kind === "set") {
            activePlan = JSON.parse(JSON.stringify(data.plan)) as Plan;
            return;
        }
        if (!activePlan) return;
        if (data.kind === "advance") {
            const step = activePlan.steps.find((s) => s.id === data.stepId);
            if (step) step.status = "in_progress";
        } else if (data.kind === "complete") {
            const step = activePlan.steps.find((s) => s.id === data.stepId);
            if (step) { step.status = "done"; step.result = data.result; }
            if (activePlan.steps.every((s) => s.status === "done")) {
                activePlan.status = "completed";
            }
        } else if (data.kind === "fail") {
            const step = activePlan.steps.find((s) => s.id === data.stepId);
            if (step) { step.status = "failed"; step.result = data.reason; }
            activePlan.status = "failed";
        } else if (data.kind === "cancel") {
            activePlan.status = "abandoned";
        } else if (data.kind === "abort") {
            activePlan.status = "abandoned";
            aborted = { reason: data.reason, by: data.by };
        }
        activePlan.updated_at = Date.now();
    }

    function rebuildFromBranch(ctx: ExtensionContext) {
        activePlan = null;
        aborted = null;
        currentSessionId = ctx.sessionManager.getSessionId() ?? null;
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
            applyEntry(entry.data as PlanStateEntry);
        }
        // Discard terminal plans on session restore — they're audit, not state.
        // Cast required: TS flow-narrowed `activePlan` to `null` from the
        // assignment at the top of this function and doesn't re-widen across
        // the closure-mutating applyEntry() call above.
        const after = activePlan as Plan | null;
        if (after && after.status !== "active") activePlan = null;
        writeRegistry();
    }

    function persist(data: PlanStateEntry) {
        applyEntry(data);
        pi.appendEntry(ENTRY_TYPE, data);
        writeRegistry();
    }

    // ---------- Cross-session registry (Admin Override Option B) ----------
    /**
     * Heartbeat the current session's plan to a shared directory so an admin
     * in any other running Pi session can enumerate live plans via /plans
     * and target one with /plan-abort. The registry file is removed on
     * session shutdown OR when the plan reaches a terminal state.
     */
    function writeRegistry() {
        if (!currentSessionId) return;
        ensureDir(registryDir());
        const file = path.join(registryDir(), `${currentSessionId}.json`);
        if (!activePlan || activePlan.status !== "active") {
            try { fs.unlinkSync(file); } catch {}
            return;
        }
        const payload = {
            sessionId: currentSessionId,
            pid: process.pid,
            startedAt: activePlan.created_at,
            updatedAt: activePlan.updated_at,
            plan: activePlan,
        };
        fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    }

    function clearRegistry() {
        if (!currentSessionId) return;
        try { fs.unlinkSync(path.join(registryDir(), `${currentSessionId}.json`)); } catch {}
    }

    // ---------- Abort signal pickup ----------
    /**
     * Returns true and applies an `abort` entry if a control file exists for
     * this session. Called from before_agent_start, plan_get_next_step,
     * plan_complete_step, and tool_call so we react to admin aborts within at
     * most one tool boundary.
     */
    function checkAbortSignal(): boolean {
        if (!currentSessionId) return false;
        if (aborted) return true;
        const ctrlFile = path.join(controlDir(), `abort-${currentSessionId}.json`);
        if (!fs.existsSync(ctrlFile)) return false;
        try {
            const ctrl = JSON.parse(fs.readFileSync(ctrlFile, "utf-8")) as { reason?: string; by?: string };
            const reason = ctrl.reason ?? "Admin abort";
            const by = ctrl.by ?? "admin";
            persist({ kind: "abort", reason, by });
            try { fs.unlinkSync(ctrlFile); } catch {}
            emitReport("aborted", reason);
            return true;
        } catch {
            return false;
        }
    }

    // ---------- Report transport ----------
    /**
     * Emits `plan:report` on the Pi event bus AND writes the report to disk
     * as a hard fallback so nothing is lost even if no transport is wired.
     *
     * FUTURE WIRING — the inbound chat bridge (Slack / Telegram / etc.,
     * implemented as adapters under `src/transport/` registering with the
     * dispatcher) MUST do the following on receiving a `plan:report` event:
     *
     *   1. If `report.originChannel` is set and the channel still exists:
     *        - Format the plan summary (title, mode, per-step results,
     *          failure reason if any) and post to that channel/thread.
     *   2. If the channel is gone or delivery fails, DM each admin in
     *      ADMIN_USER_IDS via any platform the bridge has credentials for.
     *   3. If no transports are available at all, the disk fallback at
     *      data/<BOT>/plan-reports/<timestamp>-<sessionId>.json is the
     *      source of truth — `revise-CLAUDE.md`-style follow-up logic
     *      should drain that directory on next bridge startup.
     */
    function emitReport(kind: PlanReport["kind"], reason?: string) {
        if (!activePlan || !currentSessionId) return;
        const report: PlanReport = {
            kind,
            sessionId: currentSessionId,
            plan: JSON.parse(JSON.stringify(activePlan)) as Plan,
            ...(activePlan.originChannel ? { originChannel: activePlan.originChannel } : {}),
            ...(reason !== undefined ? { reason } : {}),
            timestamp: Date.now(),
        };
        try { pi.events.emit("plan:report", report); } catch {}
        ensureDir(reportsDir());
        const file = path.join(
            reportsDir(),
            `${new Date(report.timestamp).toISOString().replace(/[:.]/g, "-")}-${currentSessionId}.json`,
        );
        fs.writeFileSync(file, JSON.stringify(report, null, 2));
    }

    // ---------- Lifecycle hooks ----------

    pi.on("session_start", async (_event, ctx) => { rebuildFromBranch(ctx); });
    pi.on("session_shutdown", async () => { clearRegistry(); });

    pi.on("before_agent_start", async (event) => {
        if (checkAbortSignal()) return;
        if (!activePlan || activePlan.status !== "active") return;

        const inProgress = activePlan.steps.find((s) => s.status === "in_progress");
        const nextPending = activePlan.steps.find((s) => s.status === "pending");
        const completed = activePlan.steps.filter((s) => s.status === "done").length;
        const total = activePlan.steps.length;

        const lines: string[] = [
            `[🚨 PLAN ENFORCEMENT MODE ACTIVE 🚨]`,
            `Plan: "${activePlan.title}" (mode: ${activePlan.mode})`,
            `Progress: ${completed}/${total}`,
            ``,
        ];
        if (inProgress) {
            lines.push(
                `CURRENT STEP (in progress): #${inProgress.id} "${inProgress.description}"`,
                ``,
                `When the step is fully done, call plan_complete_step with a result summary.`,
                `If the step CANNOT be completed, call plan_fail_step with the exact reason. The plan will halt.`,
            );
        } else if (nextPending) {
            lines.push(
                `NEXT STEP (pending): #${nextPending.id} "${nextPending.description}"`,
                ``,
                `Call plan_get_next_step to begin. Do NOT start any work before calling it.`,
            );
        }
        lines.push(``, `STRICT RULES:`);
        lines.push(`- You MAY NOT skip steps or work on future steps.`);
        lines.push(`- You MAY NOT declare success without calling plan_complete_step.`);
        if (activePlan.mode === "scheduled") {
            lines.push(
                `- This plan was injected by the scheduler. plan_cancel is FORBIDDEN.`,
                `  On unrecoverable error, call plan_fail_step with the precise reason.`,
            );
        }
        return { systemPrompt: `${lines.join("\n")}\n\n---\n\n${event.systemPrompt}` };
    });

    // Block all tool calls if this session has been aborted. For scheduled
    // sessions this is correct (the whole session exists for the plan). For
    // interactive sessions, an aborted plan implies the user / admin wanted
    // everything stopped — they can /new or /reload to restart clean.
    pi.on("tool_call", async () => {
        if (checkAbortSignal()) {
            return { block: true, reason: `Plan aborted by ${aborted!.by}: ${aborted!.reason}` };
        }
        return undefined;
    });

    // ---------- Tools ----------

    pi.registerTool({
        name: "plan_create",
        label: "Create Plan",
        description:
            "Create a strict sequential plan for this session (interactive). Scheduler-injected plans must be created via the programmatic seedPlan() API — agents cannot create scheduled plans themselves.",
        parameters: Type.Object({
            title: Type.String({ description: "Overall goal of the plan" }),
            steps: Type.Array(Type.String(), { description: "Ordered step descriptions", minItems: 1 }),
        }),
        async execute(_id, params) {
            if (activePlan && activePlan.status === "active") {
                throw new Error(
                    `Plan already active in this session: "${activePlan.title}". Cancel it first with plan_cancel.`,
                );
            }
            const now = Date.now();
            const plan: Plan = {
                id: `plan-${now}-${Math.random().toString(36).slice(2, 8)}`,
                title: params.title,
                mode: "interactive",
                steps: params.steps.map((d, i) => ({ id: i, description: d, status: "pending" as const })),
                status: "active",
                created_at: now,
                updated_at: now,
            };
            persist({ kind: "set", plan });
            return {
                content: [{ type: "text", text: `Plan locked. ${params.steps.length} steps. Call plan_get_next_step to begin.` }],
                details: { plan },
            };
        },
    });

    pi.registerTool({
        name: "plan_get_next_step",
        label: "Get Next Plan Step",
        description: "Pull the next pending step. Marks it in_progress. You MUST call this before starting any step's work.",
        parameters: Type.Object({}),
        async execute() {
            if (checkAbortSignal()) throw new Error("Plan was aborted by admin.");
            if (!activePlan || activePlan.status !== "active") throw new Error("No active plan in this session.");
            const inProgress = activePlan.steps.find((s) => s.status === "in_progress");
            if (inProgress) {
                throw new Error(
                    `Step #${inProgress.id} "${inProgress.description}" is already in_progress. Complete or fail it first.`,
                );
            }
            const next = activePlan.steps.find((s) => s.status === "pending");
            if (!next) throw new Error("No pending steps remain. Call plan_get_status to inspect.");
            persist({ kind: "advance", stepId: next.id });
            const completed = activePlan.steps.filter((s) => s.status === "done").length;
            const total = activePlan.steps.length;
            return {
                content: [{
                    type: "text",
                    text: `Step #${next.id} (${completed + 1}/${total}): ${next.description}\n\nExecute ONLY this step. When done, call plan_complete_step with a brief result summary. If you cannot complete it, call plan_fail_step.`,
                }],
                details: { step_id: next.id, description: next.description, progress: `${completed + 1}/${total}` },
            };
        },
    });

    pi.registerTool({
        name: "plan_complete_step",
        label: "Complete Current Plan Step",
        description: "Mark the in_progress step as done with a result summary. Advances the plan.",
        parameters: Type.Object({
            result: Type.String({ description: "Brief summary of what this step accomplished" }),
        }),
        async execute(_id, params) {
            if (checkAbortSignal()) throw new Error("Plan was aborted by admin.");
            if (!activePlan || activePlan.status !== "active") throw new Error("No active plan in this session.");
            const current = activePlan.steps.find((s) => s.status === "in_progress");
            if (!current) throw new Error("No step is in_progress. Call plan_get_next_step first.");

            persist({ kind: "complete", stepId: current.id, result: params.result });

            type CompleteDetails = {
                completed_step_id: number;
                plan_completed: boolean;
                next_step_id: number | null;
                total_steps: number;
            };

            // Re-read activePlan via cast — persist() mutated it through a side effect
            // that TS flow analysis doesn't follow.
            const after = activePlan as Plan | null;
            if (after && after.status === "completed") {
                emitReport("completed");
                const summary = after.steps.map((s) => `[x] #${s.id} ${s.description} — ${s.result ?? ""}`).join("\n");
                const details: CompleteDetails = {
                    completed_step_id: current.id,
                    plan_completed: true,
                    next_step_id: null,
                    total_steps: after.steps.length,
                };
                return {
                    content: [{ type: "text", text: `PLAN COMPLETE — "${after.title}".\n\n${summary}\n\nFinal report has been emitted.` }],
                    details,
                };
            }

            const nextPending = after!.steps.find((s) => s.status === "pending")!;
            const details: CompleteDetails = {
                completed_step_id: current.id,
                plan_completed: false,
                next_step_id: nextPending.id,
                total_steps: after!.steps.length,
            };
            return {
                content: [{
                    type: "text",
                    text: `Step #${current.id} done. Next pending: #${nextPending.id} "${nextPending.description}". Call plan_get_next_step to begin.`,
                }],
                details,
            };
        },
    });

    pi.registerTool({
        name: "plan_fail_step",
        label: "Fail Current Plan Step",
        description:
            "Mark the in_progress step as failed and HALT the plan. Use whenever the step cannot be completed (API error, missing data, contradicting business rules, etc.). Triggers an immediate failure report to the originating channel.",
        parameters: Type.Object({
            reason: Type.String({ description: "Exact reason for failure (will be reported verbatim)" }),
        }),
        async execute(_id, params) {
            if (!activePlan || activePlan.status !== "active") throw new Error("No active plan in this session.");
            const current = activePlan.steps.find((s) => s.status === "in_progress");
            if (!current) throw new Error("No step is in_progress. plan_fail_step requires a step that has been started.");
            persist({ kind: "fail", stepId: current.id, reason: params.reason });
            emitReport("failed", params.reason);
            return {
                content: [{ type: "text", text: `PLAN HALTED. Step #${current.id} failed: ${params.reason}. Failure report emitted.` }],
                details: { failed_step_id: current.id, reason: params.reason },
            };
        },
    });

    pi.registerTool({
        name: "plan_get_status",
        label: "Get Plan Status",
        description: "Show the full current plan with per-step status and recorded results.",
        parameters: Type.Object({}),
        async execute() {
            type StatusDetails = { has_plan: boolean; plan: Plan | null };
            if (!activePlan) {
                const details: StatusDetails = { has_plan: false, plan: null };
                return { content: [{ type: "text", text: "No active plan." }], details };
            }
            const lines = [`Plan: "${activePlan.title}" (mode: ${activePlan.mode}, status: ${activePlan.status})`];
            for (const s of activePlan.steps) {
                const marker =
                    s.status === "done" ? "[x]" :
                    s.status === "in_progress" ? "[>]" :
                    s.status === "failed" ? "[!]" : "[ ]";
                const tail = s.result ? ` — ${s.result}` : "";
                lines.push(`  ${marker} #${s.id} ${s.description}${tail}`);
            }
            const details: StatusDetails = { has_plan: true, plan: activePlan };
            return { content: [{ type: "text", text: lines.join("\n") }], details };
        },
    });

    pi.registerTool({
        name: "plan_cancel",
        label: "Cancel Plan",
        description: "Abandon the current plan (interactive plans only). Scheduler-injected plans cannot be cancelled — call plan_fail_step instead.",
        parameters: Type.Object({
            reason: Type.String({ description: "Reason for cancellation" }),
        }),
        async execute(_id, params) {
            type CancelDetails = { cancelled: boolean; title: string | null; reason: string };
            if (!activePlan || activePlan.status !== "active") {
                const details: CancelDetails = { cancelled: false, title: null, reason: params.reason };
                return { content: [{ type: "text", text: "No active plan to cancel." }], details };
            }
            if (activePlan.mode === "scheduled") {
                throw new Error(
                    "This plan was injected by the scheduler and cannot be cancelled. Use plan_fail_step to halt with a documented reason.",
                );
            }
            const title = activePlan.title;
            persist({ kind: "cancel", reason: params.reason });
            emitReport("abandoned", params.reason);
            const details: CancelDetails = { cancelled: true, title, reason: params.reason };
            return {
                content: [{ type: "text", text: `Plan "${title}" abandoned: ${params.reason}.` }],
                details,
            };
        },
    });

    // ---------- Admin Override Option B: cross-session slash commands ----------

    pi.registerCommand("plans", {
        description: "List all active plans across all running sessions",
        handler: async (_args, ctx) => {
            ensureDir(registryDir());
            const files = fs.readdirSync(registryDir()).filter((f) => f.endsWith(".json"));
            if (files.length === 0) {
                ctx.ui.notify("No active plans in any session.", "info");
                return;
            }
            const lines: string[] = [];
            for (const f of files) {
                try {
                    const raw = fs.readFileSync(path.join(registryDir(), f), "utf-8");
                    const data = JSON.parse(raw) as { sessionId: string; pid: number; plan: Plan };
                    const completed = data.plan.steps.filter((s) => s.status === "done").length;
                    const total = data.plan.steps.length;
                    let alive: string;
                    try { process.kill(data.pid, 0); alive = "alive"; }
                    catch { alive = "STALE"; }
                    lines.push(`[${data.sessionId}] (${alive}) ${data.plan.title} — ${data.plan.mode} — ${completed}/${total}`);
                } catch (e: unknown) {
                    const msg = e instanceof Error ? e.message : String(e);
                    lines.push(`[${f}] (corrupt: ${msg})`);
                }
            }
            ctx.ui.notify(`Active plans:\n${lines.join("\n")}`, "info");
        },
    });

    pi.registerCommand("plan-abort", {
        description: "Abort a live plan in another session (admin). Args: <sessionId> <reason>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sessionId = parts[0];
            const reason = parts.slice(1).join(" ") || "no reason given";
            if (!sessionId) {
                ctx.ui.notify("Usage: /plan-abort <sessionId> <reason>", "error");
                return;
            }
            ensureDir(controlDir());
            fs.writeFileSync(
                path.join(controlDir(), `abort-${sessionId}.json`),
                JSON.stringify({ reason, by: process.env["USER"] ?? "admin", issuedAt: Date.now() }, null, 2),
            );
            ctx.ui.notify(
                `Abort signal written for session ${sessionId}. The owning session will halt at its next plan tool call or turn boundary.`,
                "info",
            );
        },
    });

    pi.registerCommand("plan-status", {
        description: "Show this session's active plan",
        handler: async (_args, ctx) => {
            if (!activePlan) {
                ctx.ui.notify("No active plan in this session.", "info");
                return;
            }
            const lines = [`Plan: "${activePlan.title}" (mode: ${activePlan.mode}, status: ${activePlan.status})`];
            for (const s of activePlan.steps) {
                const marker = s.status === "done" ? "✓" : s.status === "in_progress" ? "▶" : s.status === "failed" ? "✗" : " ";
                const tail = s.result ? ` — ${s.result}` : "";
                lines.push(`  ${marker} #${s.id} ${s.description}${tail}`);
            }
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });

    pi.registerCommand("plan-clear", {
        description: "Force-clear this session's interactive plan (recovery). Scheduled plans must be /plan-abort'd from another session.",
        handler: async (_args, ctx) => {
            if (!activePlan) { ctx.ui.notify("No active plan to clear.", "info"); return; }
            if (activePlan.mode === "scheduled") {
                ctx.ui.notify(
                    "Scheduled plan — use /plan-abort <sessionId> from another admin session so the failure is reported to the originating channel.",
                    "warning",
                );
                return;
            }
            const title = activePlan.title;
            persist({ kind: "cancel", reason: "manual /plan-clear" });
            emitReport("abandoned", "manual /plan-clear");
            ctx.ui.notify(`Cleared plan: ${title}`, "info");
        },
    });

    // ---------- Admin Override Option C: reply-in-channel ----------
    //
    // The inbound chat bridge (transport_bridge.ts) detects "@bot abort" or
    // "!plan-abort" in admin replies to a thread mapped to an active
    // scheduled plan (via recordPlanThread at plan-seed time, looked up via
    // findPlanSessionByThread) and writes data/<BOT>/plan-control/abort-<sessionId>.json
    // directly (shared mechanism with Option D's drop-file kill switch). The
    // owning session picks up the abort at its next plan tool call or turn
    // boundary via checkAbortSignal().
    //
    // The pi.events listener below remains available for in-process admin
    // actions (e.g. future Option A, an A2A peer admin command that ends up
    // in the same Pi process). Subprocess-spawned scheduled plans can only
    // be signaled via the control file, so the file path is the source of
    // truth regardless.

    pi.events.on("plan:admin-action", (data: unknown) => {
        const msg = data as Partial<AdminAction>;
        if (!msg || msg.action !== "abort" || !msg.sessionId) return;
        writeAbortControlFile(msg.sessionId, msg.reason ?? "", msg.by ?? "admin");
    });

    // ---------- Admin Override Option D: drop-file kill switch (documented) ----------
    //
    // Emergency: when no command surface is reachable, an operator can drop
    // data/<BOT>/plan-control/abort-<sessionId>.json with {reason, by} by
    // hand and the owning session picks it up. checkAbortSignal() scans
    // controlDir() — no extra code needed here beyond the shared file format.
}
