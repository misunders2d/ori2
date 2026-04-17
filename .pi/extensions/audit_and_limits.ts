import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getChannelLog } from "../../src/core/channelLog.js";
import { getRateLimiter } from "../../src/core/rateLimiter.js";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { currentOrigin } from "../../src/core/identity.js";

// =============================================================================
// audit_and_limits — wires the channel logger and rate limiter into the
// dispatcher hook chain, and exposes operator-facing slash commands.
//
// Hook ordering (dispatcher hook list is processed in registration order):
//   1. admin_gate pre-hook       — whitelist gate, /init handler, etc.
//      (registered first, in admin_gate.ts which loads earlier alphabetically)
//   2. credentials pre-hook      — chat-secret intercept
//   3. THIS pre-hook             — rate limit (skipped if previous hooks blocked)
//   4. dispatch                  — push to Pi
//   5. THIS post-hook            — log to channel_log with delivered=true
//
//   For BLOCKED messages we register a post-block hook. The dispatcher fires
//   it for EVERY block regardless of which pre-hook raised — whitelist miss,
//   blacklist, credentials intercept, rate limit, guardrail trip. Single
//   observation point → full audit trail of blocked traffic, not just the
//   rate-limit flavour we used to log explicitly.
// =============================================================================

const cl = getChannelLog();
const rl = getRateLimiter();
const dispatcher = getDispatcher();
const whitelist = getWhitelist();

// ---------- DISPATCHER WIRING (runs at module load) ----------

// Post-dispatch hook: message reached Pi → record delivered=true.
dispatcher.addPostDispatchHook((msg) => {
    cl.log({
        platform: msg.platform,
        channelId: msg.channelId,
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
        senderId: msg.senderId,
        senderDisplayName: msg.senderDisplayName,
        timestamp: msg.timestamp,
        text: msg.text,
        attachmentCount: msg.attachments?.length ?? 0,
        delivered: true,
    });
});

// Post-block hook: ANY pre-hook blocked the message → record delivered=false
// with the raised reason. Catches whitelist-miss, blacklist, credentials
// intercept, rate limit, guardrail trip — everything that returns {block:true}
// from a pre-hook — at a single observation point.
dispatcher.addPostBlockHook((msg, reason) => {
    cl.log({
        platform: msg.platform,
        channelId: msg.channelId,
        ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
        senderId: msg.senderId,
        senderDisplayName: msg.senderDisplayName,
        timestamp: msg.timestamp,
        text: msg.text,
        attachmentCount: msg.attachments?.length ?? 0,
        delivered: false,
        blockReason: reason,
    });
});

// Rate-limit pre-hook: runs after admin_gate (whitelist) and credentials
// (secret intercept). Both of those are blocking, so by the time this
// runs we know the user is whitelisted AND the message isn't a secret
// command. Apply rate limit. Block-logging is now unified via the
// post-block hook above.
dispatcher.addPreDispatchHook((msg) => {
    const r = rl.tryConsume(msg.platform, msg.senderId);
    if (r.allowed) return { block: false };
    return {
        block: true,
        reason: `Rate limit exceeded. Try again in ${Math.ceil(r.retryAfterMs / 1000)}s.`,
    };
});

// ---------- helpers ----------

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI fallback
    return whitelist.isAdmin(origin.platform, origin.senderId);
}

function fmtTime(ms: number): string {
    return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
    pi.registerCommand("log", {
        description: "Channel-log audit trail. Run /log help for full reference.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();
            const mutating = sub === "clear";
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /log " + sub + ".", "error");
                return;
            }
            switch (sub) {
                case "help":   return doLogHelp(ctx);
                case "recent": return doLogRecent(ctx, parts);
                case "search": return doLogSearch(ctx, args ?? "");
                case "stats":  return doLogStats(ctx);
                case "clear":  return doLogClear(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /log subcommand: ${sub}. Run /log help.`, "error");
            }
        },
    });

    pi.registerCommand("limits", {
        description: "Per-user rate limit status and reset. Run /limits help.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();
            const mutating = sub === "reset" || sub === "reset-all" || sub === "set-rpm";
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /limits " + sub + ".", "error");
                return;
            }
            switch (sub) {
                case "help":      return doLimitsHelp(ctx);
                case "status":    return doLimitsStatus(ctx);
                case "reset":     return doLimitsReset(ctx, parts);
                case "reset-all": return doLimitsResetAll(ctx);
                case "set-rpm":   return doLimitsSetRpm(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /limits subcommand: ${sub}. Run /limits help.`, "error");
            }
        },
    });
}

// ---------- /log handlers ----------

function doLogHelp(ctx: ExtensionContext): void {
    const lines = [
        "═════════════════════════════════════════════════════════════",
        "  /log — channel audit log",
        "═════════════════════════════════════════════════════════════",
        "",
        "WHAT THIS DOES",
        "  Records every inbound message that passed through the",
        "  dispatcher: who, when, what, delivered or blocked. Backing",
        "  store: SQLite at data/<BOT>/channel_log.db.",
        "",
        "  Coverage:",
        "    ✓ ALL network adapters (Telegram, future Slack/Synapse)",
        "    ✗ CLI input (operator owns the process — logging is redundant)",
        "    ✗ Credential commands (intercepted UPSTREAM by the credentials",
        "      pre-hook, secret never reaches this layer; defense-in-depth",
        "      redaction is also applied here)",
        "",
        "  Coverage: DELIVERED messages + every BLOCKED message (whitelist-miss,",
        "  blacklist, credentials intercept, rate limit, guardrail trip, and any",
        "  other pre-dispatch hook that blocks) — single observation point via",
        "  the dispatcher's post-block hook.",
        "",
        "ALL SUBCOMMANDS",
        "  /log help                                           — this message",
        "  /log recent [--limit N] [--platform P] [--sender S] — recent entries",
        "  /log search <query>                                 — substring text search",
        "  /log stats                                          — counts, top senders, top blocks",
        "  /log clear --confirm                                — admin: wipe the log",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

function doLogRecent(ctx: ExtensionContext, parts: string[]): void {
    let limit = 30;
    let platform: string | undefined;
    let sender: string | undefined;
    for (let i = 1; i < parts.length; i++) {
        if (parts[i] === "--limit" && i + 1 < parts.length) { limit = Math.max(1, Number(parts[i + 1]) || 30); i++; }
        else if (parts[i] === "--platform" && i + 1 < parts.length) { platform = parts[i + 1]; i++; }
        else if (parts[i] === "--sender" && i + 1 < parts.length) { sender = parts[i + 1]; i++; }
    }
    const opts: { limit: number; platform?: string; senderId?: string } = { limit };
    if (platform !== undefined) opts.platform = platform;
    if (sender !== undefined) opts.senderId = sender;
    const entries = cl.recent(opts);
    if (entries.length === 0) { ctx.ui.notify("No matching log entries.", "info"); return; }
    const lines = [`Recent (${entries.length} entries):`, ""];
    for (const e of entries) {
        const verdict = e.delivered ? "✓" : `✗ ${e.block_reason ?? ""}`;
        const att = e.attachment_count > 0 ? ` (${e.attachment_count} attachment${e.attachment_count === 1 ? "" : "s"})` : "";
        lines.push(`  ${fmtTime(e.timestamp)}  ${verdict.padEnd(20)} ${e.platform}:${e.sender_id} (${e.sender_display_name})${att}`);
        lines.push(`    ${truncate(e.text, 100)}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doLogSearch(ctx: ExtensionContext, args: string): void {
    const q = args.replace(/^\s*search\s+/i, "").trim();
    if (!q) { ctx.ui.notify("Usage: /log search <query>", "error"); return; }
    const entries = cl.search(q, { limit: 30 });
    if (entries.length === 0) { ctx.ui.notify(`No matches for "${truncate(q, 60)}".`, "info"); return; }
    const lines = [`Search results for "${truncate(q, 60)}":`, ""];
    for (const e of entries) {
        const verdict = e.delivered ? "✓" : "✗";
        lines.push(`  ${fmtTime(e.timestamp)}  ${verdict} ${e.platform}:${e.sender_id} — ${truncate(e.text, 120)}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doLogStats(ctx: ExtensionContext): void {
    const s = cl.stats();
    const lines = [
        `Channel log stats:`,
        `  total entries:  ${s.total}`,
        `  delivered:      ${s.delivered}`,
        `  blocked:        ${s.blocked}`,
        `  db size:        ${fmtBytes(s.db_size_bytes)}`,
    ];
    if (s.oldest_ms) lines.push(`  oldest:         ${fmtTime(s.oldest_ms)}`);
    if (s.newest_ms) lines.push(`  newest:         ${fmtTime(s.newest_ms)}`);
    if (s.platforms.length > 0) {
        lines.push("", "  Per-platform:");
        for (const p of s.platforms) lines.push(`    ${p.platform.padEnd(12)} ${p.count}`);
    }
    if (s.top_senders.length > 0) {
        lines.push("", "  Top senders:");
        for (const t of s.top_senders) lines.push(`    ${t.platform}:${t.sender_id.padEnd(20)} ${t.count}`);
    }
    if (s.top_block_reasons.length > 0) {
        lines.push("", "  Top block reasons:");
        for (const t of s.top_block_reasons) lines.push(`    ${truncate(t.reason, 50).padEnd(52)} ${t.count}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doLogClear(ctx: ExtensionContext, parts: string[]): void {
    if (parts[1] !== "--confirm") {
        ctx.ui.notify("Wipes ALL channel log entries. Run /log clear --confirm to proceed.", "warning");
        return;
    }
    const n = cl.clear();
    ctx.ui.notify(`Cleared ${n} log entries.`, "info");
}

// ---------- /limits handlers ----------

function doLimitsHelp(ctx: ExtensionContext): void {
    const lines = [
        "═════════════════════════════════════════════════════════════",
        "  /limits — per-user rate limiting",
        "═════════════════════════════════════════════════════════════",
        "",
        "WHAT THIS DOES",
        "  Token-bucket rate limit per (platform, senderId). Default rate:",
        "  AGENT_RPM (vault setting, default 30 requests/minute, with burst",
        "  capacity = full bucket). Buckets are in-memory and reset on",
        "  restart.",
        "",
        "EXEMPTIONS",
        "  - CLI: operator owns the process.",
        "  - Admins: full access (no rate-limit on incident response).",
        "",
        "ALL SUBCOMMANDS",
        "  /limits help                                — this message",
        "  /limits status                              — per-bucket snapshot",
        "  /limits reset <platform> <senderId>         — admin: clear one bucket",
        "  /limits reset-all                           — admin: clear all buckets",
        "  /limits set-rpm <number>                    — admin: change RPM (writes vault)",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

function doLimitsStatus(ctx: ExtensionContext): void {
    const s = rl.stats();
    if (s.length === 0) { ctx.ui.notify("No active rate-limit buckets.", "info"); return; }
    const lines = ["Per-user rate limits:", ""];
    for (const b of s) {
        lines.push(`  ${b.platform}:${b.senderId.padEnd(20)} tokens=${b.tokens}/${b.capacity}  used=${b.consumed}  blocked=${b.blocked}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doLimitsReset(ctx: ExtensionContext, parts: string[]): void {
    const platform = parts[1];
    const senderId = parts[2];
    if (!platform || !senderId) { ctx.ui.notify("Usage: /limits reset <platform> <senderId>", "error"); return; }
    const ok = rl.reset(platform, senderId);
    ctx.ui.notify(ok ? `Reset bucket for ${platform}:${senderId}.` : `No bucket for ${platform}:${senderId}.`, "info");
}

function doLimitsResetAll(ctx: ExtensionContext): void {
    const n = rl.resetAll();
    ctx.ui.notify(`Cleared ${n} bucket${n === 1 ? "" : "s"}.`, "info");
}

function doLimitsSetRpm(ctx: ExtensionContext, parts: string[]): void {
    const n = Number(parts[1]);
    if (!Number.isFinite(n) || n <= 0) { ctx.ui.notify("Usage: /limits set-rpm <positive_number>", "error"); return; }
    // Lazy require to avoid circular deps.
    const { getVault } = require("../../src/core/vault.js") as typeof import("../../src/core/vault.js");
    getVault().set("AGENT_RPM", String(Math.floor(n)));
    rl.reloadConfig();
    rl.resetAll();
    ctx.ui.notify(`Set AGENT_RPM=${Math.floor(n)} in vault. All existing buckets reset to new capacity.`, "info");
}
