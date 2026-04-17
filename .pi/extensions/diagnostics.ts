import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { getHealth, formatHealth } from "../../src/core/health.js";
import { recent as recentErrors, type ErrorSeverity } from "../../src/core/errorLog.js";
import { getChannelLog } from "../../src/core/channelLog.js";
import { getVault } from "../../src/core/vault.js";
import { getFriends } from "../../src/a2a/friends.js";
import { getA2AServerHandle } from "../../src/a2a/server.js";
import { botSubdir } from "../../src/core/paths.js";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";

// =============================================================================
// diagnostics — the "am I OK?" surface for Ori.
//
// Every capability here is exposed as BOTH an LLM tool (so the agent can
// self-diagnose in a turn — "I'll check my own status") AND a slash command
// (so the operator can drive it without a chat round-trip). This matches the
// project's minimal-technical-intervention principle: the operator should
// never need to SSH in to ask "how are you feeling?".
//
// Tools:
//   - health_report({deep?})           — overall status + warnings
//   - read_channel_log({...})          — inbound audit trail
//   - read_error_ledger({...})         — internal error events
//   - read_scheduler_jobs()            — list registered cron jobs
//   - check_telegram_connection()      — live getMe probe
//   - check_friend_reachability({name?}) — A2A peer /health probe
//   - inspect_env({redact?})           — env-var inventory (keys by default,
//                                        values only with explicit non-redact
//                                        opt-in AND admin caller)
//
// Slash commands: /health, /health deep, /errors, /probe telegram|friends
//
// Tool ACLs: read-only tools default to `user` (safe for any whitelisted user
// to call). inspect_env's unredacted mode is admin-only.
// =============================================================================

/**
 * Compact JSON-safe subset of a health report. Includes the human-readable
 * summary (produced by formatHealth) as `text` so the LLM has a single block
 * it can render directly to the user, plus the structured fields for further
 * reasoning.
 */
function healthContent(deep: boolean, text: string, structured: unknown) {
    return {
        content: [
            { type: "text" as const, text },
        ],
        details: {
            deep,
            report: structured as Record<string, unknown>,
        },
    };
}

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI implicit admin
    return getWhitelist().isAdmin(origin.platform, origin.senderId);
}

export default function (pi: ExtensionAPI) {
    // -------------------------- LLM tools --------------------------

    pi.registerTool({
        name: "health_report",
        label: "Bot Health Report",
        description:
            "Snapshot of the bot's current health — adapter state, heartbeats, memory/vault/oauth/channel-log/a2a/errors counts, any warnings. " +
            "Pass deep=true for live probes (Telegram getMe, A2A friend /health pings, disk walk) — slower, use sparingly. " +
            "Call this when the user asks 'how are you', 'are you ok', 'what's your status', or after reporting a suspected problem.",
        parameters: Type.Object({
            deep: Type.Optional(Type.Boolean({ description: "Include live network probes + disk walk. Default false (local-only)." })),
        }),
        async execute(_id, params) {
            const r = await getHealth({ deep: params.deep === true });
            return healthContent(params.deep === true, formatHealth(r), r);
        },
    });

    pi.registerTool({
        name: "read_error_ledger",
        label: "Read Internal Error Ledger",
        description:
            "Recent internal error / warning events from data/<bot>/errors.jsonl — Telegram poll failures, cloudflared crashes, scheduler " +
            "exceptions, guardrail init issues, etc. NOT user chat history (use read_channel_log for that). Newest first.",
        parameters: Type.Object({
            limit: Type.Optional(Type.Integer({ description: "Max entries to return (default 20, cap 500)." })),
            subsystem: Type.Optional(Type.String({ description: "Filter to one subsystem name (e.g. 'telegram', 'a2a-tunnel', 'scheduler')." })),
            severity: Type.Optional(Type.Union([Type.Literal("error"), Type.Literal("warning"), Type.Literal("info")])),
            since_minutes: Type.Optional(Type.Integer({ description: "Only return entries within the last N minutes." })),
        }),
        async execute(_id, params) {
            const opts: Parameters<typeof recentErrors>[0] = {
                limit: params.limit ?? 20,
            };
            if (params.subsystem !== undefined) opts.subsystem = params.subsystem;
            if (params.severity !== undefined) opts.severity = params.severity as ErrorSeverity;
            if (params.since_minutes !== undefined) opts.sinceMinutes = params.since_minutes;
            const entries = recentErrors(opts);
            if (entries.length === 0) {
                return { content: [{ type: "text", text: "No matching ledger entries." }], details: { count: 0 } };
            }
            const lines: string[] = [`Error ledger — ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (newest first):`, ""];
            for (const e of entries) {
                const ts = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
                const d = e.details ? " " + JSON.stringify(e.details) : "";
                lines.push(`[${ts}] ${e.severity.toUpperCase().padEnd(7)} ${e.subsystem}: ${e.message}${d}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: entries.length, entries } };
        },
    });

    pi.registerTool({
        name: "read_channel_log",
        label: "Read Channel Audit Log",
        description:
            "Recent inbound chat messages (delivered + blocked) from channel_log.db. Use for 'who said what?' questions and abuse triage. " +
            "Secret patterns are redacted at write time. Newest first.",
        parameters: Type.Object({
            limit: Type.Optional(Type.Integer({ description: "Max entries (default 30, cap 200)." })),
            platform: Type.Optional(Type.String({ description: "Filter by platform (telegram, a2a, etc.)." })),
            sender: Type.Optional(Type.String({ description: "Filter by senderId." })),
            delivered_only: Type.Optional(Type.Boolean({ description: "Exclude blocked messages." })),
        }),
        async execute(_id, params) {
            const cl = getChannelLog();
            const limit = Math.min(Math.max(1, params.limit ?? 30), 200);
            const opts: { limit: number; platform?: string; senderId?: string } = { limit };
            if (params.platform !== undefined) opts.platform = params.platform;
            if (params.sender !== undefined) opts.senderId = params.sender;
            let entries = cl.recent(opts);
            if (params.delivered_only) entries = entries.filter((e) => e.delivered);
            if (entries.length === 0) {
                return { content: [{ type: "text", text: "No matching channel-log entries." }], details: { count: 0 } };
            }
            const lines: string[] = [`Channel log — ${entries.length} entr${entries.length === 1 ? "y" : "ies"}:`, ""];
            for (const e of entries) {
                const ts = new Date(e.timestamp).toISOString().replace("T", " ").slice(0, 19);
                const verdict = e.delivered ? "✓" : `✗[${e.block_reason ?? "blocked"}]`;
                const txt = e.text.length > 120 ? e.text.slice(0, 120) + "…" : e.text;
                lines.push(`[${ts}] ${verdict} ${e.platform}:${e.sender_id} (${e.sender_display_name}): ${txt}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: entries.length } };
        },
    });

    pi.registerTool({
        name: "read_scheduler_jobs",
        label: "List Scheduled Jobs",
        description:
            "List registered scheduled (cron) jobs with their task, cron expression, and whether they carry a seeded plan. " +
            "This is the job REGISTRY, not a fire-history log (per-fire history isn't currently persisted).",
        parameters: Type.Object({}),
        async execute() {
            const dir = botSubdir("jobs");
            if (!fs.existsSync(dir)) {
                return { content: [{ type: "text", text: "No scheduled jobs registered." }], details: { count: 0, jobs: [] } };
            }
            const jobs: Array<{ job_id: string; cron: string; task: string; has_steps: boolean; has_origin: boolean }> = [];
            for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
                try {
                    const raw = fs.readFileSync(path.join(dir, f), "utf-8");
                    const parsed = JSON.parse(raw) as { job_id?: unknown; cron?: unknown; task?: unknown; steps?: unknown; originChannel?: unknown };
                    if (typeof parsed.job_id !== "string" || typeof parsed.cron !== "string" || typeof parsed.task !== "string") continue;
                    jobs.push({
                        job_id: parsed.job_id,
                        cron: parsed.cron,
                        task: parsed.task,
                        has_steps: Array.isArray(parsed.steps) && parsed.steps.length > 0,
                        has_origin: !!parsed.originChannel,
                    });
                } catch { /* corrupt — skip; the scheduler extension logs these via logWarning */ }
            }
            if (jobs.length === 0) {
                return { content: [{ type: "text", text: "No scheduled jobs registered." }], details: { count: 0, jobs: [] } };
            }
            const lines: string[] = [`Scheduled jobs (${jobs.length}):`, ""];
            for (const j of jobs) {
                const markers = [
                    j.has_steps ? "plan" : "adhoc",
                    j.has_origin ? "reports-back" : "silent",
                ].join(",");
                const taskSummary = j.task.length > 80 ? j.task.slice(0, 80) + "…" : j.task;
                lines.push(`  ${j.job_id.padEnd(20)} [${j.cron}]  (${markers})  ${taskSummary}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: jobs.length, jobs } };
        },
    });

    pi.registerTool({
        name: "check_telegram_connection",
        label: "Check Telegram Connection (live)",
        description:
            "Live-probe the Telegram API with getMe to confirm the stored bot token still works. " +
            "Returns bot identity on success, error detail on failure. Use when suspecting token revocation / API outage.",
        parameters: Type.Object({}),
        async execute() {
            const token = getVault().get("TELEGRAM_BOT_TOKEN");
            if (!token) {
                return { content: [{ type: "text", text: "No TELEGRAM_BOT_TOKEN in vault — Telegram not configured." }], details: { configured: false } };
            }
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 5000);
                const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: ctrl.signal });
                clearTimeout(t);
                const body = await res.json() as { ok: boolean; description?: string; result?: { id: number; username?: string; first_name: string } };
                if (!res.ok || !body.ok) {
                    return {
                        content: [{ type: "text", text: `❌ Telegram getMe FAILED — HTTP ${res.status}. ${body.description ?? ""}`.trim() }],
                        details: { configured: true, ok: false, http_status: res.status, description: body.description },
                    };
                }
                const me = body.result!;
                return {
                    content: [{ type: "text", text: `✅ Telegram OK — bot ${me.username ? "@" + me.username : me.first_name} (id=${me.id})` }],
                    details: { configured: true, ok: true, id: me.id, ...(me.username ? { username: me.username } : {}), first_name: me.first_name },
                };
            } catch (e) {
                return {
                    content: [{ type: "text", text: `❌ Telegram probe failed: ${e instanceof Error ? e.message : String(e)}` }],
                    details: { configured: true, ok: false, err: e instanceof Error ? e.message : String(e) },
                };
            }
        },
    });

    pi.registerTool({
        name: "check_friend_reachability",
        label: "Probe A2A Friend /health",
        description:
            "Ping one or all registered A2A friends' /health endpoint and report reachable/unreachable. Probe has a 3s timeout per friend. " +
            "If `name` is omitted, probes up to 10 friends in parallel. This does NOT require friends to have exchanged bearer keys — " +
            "/health is a public endpoint — so it tests raw network reachability, not trust.",
        parameters: Type.Object({
            name: Type.Optional(Type.String({ description: "Specific friend name; omit to probe all." })),
        }),
        async execute(_id, params) {
            const friends = getFriends().list();
            if (friends.length === 0) {
                return { content: [{ type: "text", text: "No A2A friends registered." }], details: { count: 0, results: [] } };
            }
            const targets = params.name
                ? friends.filter((f) => f.name === params.name)
                : friends.slice(0, 10);
            if (targets.length === 0) {
                return { content: [{ type: "text", text: `No friend named "${params.name}".` }], details: { count: 0, results: [] } };
            }
            const results = await Promise.all(targets.map(async (f) => {
                const url = `${f.base_url.replace(/\/+$/, "")}/health`;
                try {
                    const ctrl = new AbortController();
                    const t = setTimeout(() => ctrl.abort(), 3000);
                    const res = await fetch(url, { signal: ctrl.signal });
                    clearTimeout(t);
                    if (res.ok) {
                        const body = await res.json() as { status?: string; bot_name?: string; uptime_s?: number };
                        return { name: f.name, ok: true, detail: `${body.bot_name ?? "?"} up ${body.uptime_s ?? "?"}s` };
                    }
                    return { name: f.name, ok: false, detail: `HTTP ${res.status}` };
                } catch (e) {
                    return { name: f.name, ok: false, detail: e instanceof Error ? e.message : String(e) };
                }
            }));
            const okCount = results.filter((r) => r.ok).length;
            const lines: string[] = [`A2A friend probes (${okCount}/${results.length} reachable):`, ""];
            for (const r of results) {
                lines.push(`  ${r.name.padEnd(20)} ${r.ok ? "✅" : "❌"}  ${r.detail}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: results.length, reachable: okCount, results } };
        },
    });

    pi.registerTool({
        name: "inspect_env",
        label: "Inspect Environment Variables",
        description:
            "List process.env keys relevant to ori2. Values are REDACTED by default (shown as '[REDACTED]'). " +
            "Pass redact=false to see values — admin caller only, and only for debugging. The vault (`/vault` surface) is the source " +
            "of truth for secrets; this tool is for troubleshooting runtime env hydration.",
        parameters: Type.Object({
            redact: Type.Optional(Type.Boolean({ description: "Default true. Setting false requires admin." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const redact = params.redact !== false;
            if (!redact && !isAdminCaller(ctx)) {
                return {
                    content: [{ type: "text", text: "inspect_env with redact=false requires admin." }],
                    details: { refused: true },
                };
            }
            const RELEVANT_PREFIXES = [
                "BOT_NAME", "ORI2_", "PRIMARY_PROVIDER", "REQUIRE_2FA",
                "ADMIN_USER_IDS",
                "ANTHROPIC_", "OPENAI_", "GOOGLE_", "GEMINI_", "VERTEX_",
                "TELEGRAM_",
                "A2A_",
                "AGENT_RPM", "GUARDRAIL_",
                "PI_CODING_AGENT_DIR",
                "FASTEMBED_",
            ];
            const lines: string[] = ["Environment variables (ori2-relevant):"];
            const env = process.env;
            const keys = Object.keys(env)
                .filter((k) => RELEVANT_PREFIXES.some((p) => k === p || k.startsWith(p)))
                .sort();
            if (keys.length === 0) {
                return { content: [{ type: "text", text: "No ori2-relevant env vars set." }], details: { count: 0 } };
            }
            for (const k of keys) {
                const v = env[k] ?? "";
                const display = redact ? "[REDACTED]" : v;
                lines.push(`  ${k}=${display}`);
            }
            return { content: [{ type: "text", text: lines.join("\n") }], details: { count: keys.length, redacted: redact } };
        },
    });

    // -------------------------- slash command --------------------------

    pi.registerCommand("health", {
        description: "Aggregate health report. `/health`, `/health deep`, `/health errors [N]`, `/health probe telegram|friends [name]`, `/health env [--values]`.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "").toLowerCase();

            if (sub === "" || sub === "status") {
                const r = await getHealth();
                ctx.ui.notify(formatHealth(r), r.status === "healthy" ? "info" : "warning");
                return;
            }
            if (sub === "deep") {
                const r = await getHealth({ deep: true });
                ctx.ui.notify(formatHealth(r), r.status === "healthy" ? "info" : "warning");
                return;
            }
            if (sub === "errors") {
                const n = Number(parts[1]) || 20;
                const entries = recentErrors({ limit: n });
                if (entries.length === 0) { ctx.ui.notify("No error-ledger entries.", "info"); return; }
                const lines: string[] = [`Error ledger (${entries.length} entries, newest first):`, ""];
                for (const e of entries) {
                    const ts = new Date(e.at).toISOString().replace("T", " ").slice(0, 19);
                    lines.push(`[${ts}] ${e.severity.toUpperCase().padEnd(7)} ${e.subsystem}: ${e.message}${e.details ? " " + JSON.stringify(e.details) : ""}`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }
            if (sub === "probe") {
                const target = parts[1];
                if (target === "telegram") {
                    const token = getVault().get("TELEGRAM_BOT_TOKEN");
                    if (!token) { ctx.ui.notify("Telegram not configured (no TELEGRAM_BOT_TOKEN).", "warning"); return; }
                    try {
                        const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
                        const body = await res.json() as { ok: boolean; result?: { username?: string; first_name: string } };
                        ctx.ui.notify(body.ok ? `✅ Telegram OK — ${body.result?.username ? "@" + body.result.username : body.result?.first_name}` : `❌ Telegram getMe failed`, body.ok ? "info" : "error");
                    } catch (e) {
                        ctx.ui.notify(`❌ Telegram probe failed: ${e instanceof Error ? e.message : String(e)}`, "error");
                    }
                    return;
                }
                if (target === "friends") {
                    const specific = parts[2];
                    const friends = getFriends().list();
                    const targets = specific ? friends.filter((f) => f.name === specific) : friends.slice(0, 10);
                    if (targets.length === 0) { ctx.ui.notify(specific ? `No friend named "${specific}".` : "No friends registered.", "info"); return; }
                    const out: string[] = ["Friend probes:", ""];
                    for (const f of targets) {
                        const url = `${f.base_url.replace(/\/+$/, "")}/health`;
                        try {
                            const ctrl = new AbortController();
                            const t = setTimeout(() => ctrl.abort(), 3000);
                            const res = await fetch(url, { signal: ctrl.signal });
                            clearTimeout(t);
                            out.push(`  ${f.name.padEnd(20)} ${res.ok ? "✅" : `❌ HTTP ${res.status}`}`);
                        } catch (e) {
                            out.push(`  ${f.name.padEnd(20)} ❌ ${e instanceof Error ? e.message : String(e)}`);
                        }
                    }
                    ctx.ui.notify(out.join("\n"), "info");
                    return;
                }
                ctx.ui.notify("Usage: /health probe telegram   OR   /health probe friends [name]", "error");
                return;
            }
            if (sub === "env") {
                const wantValues = parts.includes("--values") || parts.includes("--show");
                if (wantValues && !isAdminCaller(ctx)) { ctx.ui.notify("`--values` requires admin.", "error"); return; }
                const keys = Object.keys(process.env)
                    .filter((k) => /^(BOT_NAME|ORI2_|PRIMARY_PROVIDER|REQUIRE_2FA|ADMIN_USER_IDS|ANTHROPIC_|OPENAI_|GOOGLE_|GEMINI_|VERTEX_|TELEGRAM_|A2A_|AGENT_RPM|GUARDRAIL_|PI_CODING_AGENT_DIR|FASTEMBED_)/.test(k))
                    .sort();
                if (keys.length === 0) { ctx.ui.notify("No ori2-relevant env vars set.", "info"); return; }
                const lines = ["Env vars (ori2-relevant):", ""];
                for (const k of keys) lines.push(`  ${k}=${wantValues ? process.env[k] ?? "" : "[REDACTED]"}`);
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }
            if (sub === "a2a") {
                const handle = getA2AServerHandle();
                if (!handle) { ctx.ui.notify("A2A server not running.", "warning"); return; }
                ctx.ui.notify(`A2A: bound=${handle.boundPort} url=${handle.baseUrl} friends=${getFriends().list().length}`, "info");
                return;
            }
            ctx.ui.notify(
                "Usage: /health [status|deep|errors [N]|probe telegram|probe friends [name]|env [--values]]",
                "error",
            );
        },
    });
}
