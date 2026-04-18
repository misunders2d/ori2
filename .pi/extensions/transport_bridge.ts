import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import type { Message } from "../../src/transport/types.js";
import { getVault } from "../../src/core/vault.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { logError } from "../../src/core/errorLog.js";
import { findPlanSessionByThread, writeAbortControlFile } from "./plan_enforcer.js";

// =============================================================================
// transport_bridge — CLI glue + admin plumbing for the transport abstraction.
//
// SCOPE (post multi-chat refactor):
//   Dispatcher routes non-CLI inbound to channelRouter (subprocess-per-mention
//   for active, SessionManager.open+appendCustomMessageEntry for passive).
//   This bridge now only handles CLI messages — the TUI operator's session.
//
// Responsibilities in this file:
//
//   1. pushToPi(msg) for CLI messages. Turns a CLI inbound Message into
//      `pi.sendUserMessage(body, { deliverAs: "followUp" })`. The body
//      includes a metadata header so the agent knows who is speaking even
//      when the CLI has multiple OS-users SSHed in. Only called for
//      msg.platform === "cli" (dispatcher enforces this — see
//      src/transport/dispatcher.ts routing comment).
//
//   2. transport-origin CustomEntry tagging for the CLI session. On each
//      CLI inbound we append `{platform, channelId, senderId, ...}` via
//      pi.appendEntry — src/core/identity.ts reads these to answer
//      "who is talking right now?" for tool ACL and audit.
//
//   3. agent_end → dispatcher.send routing. When the CLI session finishes
//      a turn, the TUI already rendered the response; we deliberately
//      skip re-sending via the CliAdapter to avoid double-render. For
//      non-CLI lastOrigin this branch is now dead (non-CLI never reaches
//      pushToPi), kept as defensive skip.
//
//   4. abortDetectorHook — pre-dispatch hook catching admin "@bot abort"
//      replies in plan threads. Runs for ALL inbound (including Telegram
//      groups), BEFORE the routing branch, so a group-mention abort from
//      an admin is intercepted and doesn't spawn a subprocess.
//
//   5. /transports and /connect-telegram slash commands.
// =============================================================================

const ENTRY_TYPE = "transport-origin";

interface OriginEntry {
    platform: string;
    channelId: string;
    threadId?: string;
    senderId: string;
    senderDisplayName: string;
    timestamp: number;
}

function formatMetadataHeader(msg: Message): string {
    const parts: string[] = [`platform: ${msg.platform}`];
    if (msg.senderDisplayName) parts.push(`from: ${msg.senderDisplayName}`);
    parts.push(`sender_id: ${msg.senderId}`);
    parts.push(`channel: ${msg.channelId}`);
    if (msg.threadId) parts.push(`thread: ${msg.threadId}`);
    parts.push(`time: ${new Date(msg.timestamp).toISOString()}`);
    return `[Inbound | ${parts.join(" | ")}]`;
}

function formatAttachmentsForPi(msg: Message): string {
    if (!msg.attachments || msg.attachments.length === 0) return "";
    const lines: string[] = ["", "[Attachments]"];
    for (const a of msg.attachments) {
        if (a.kind === "text") {
            lines.push(`--- ${a.filename ?? a.mimeType} (${a.sourceBytes ?? "?"} bytes) ---`);
            lines.push(a.text);
            lines.push("---");
        } else if (a.kind === "image") {
            // Pi natively handles images via ImageContent in a multipart message.
            // For Sprint 3 we only handle text + reference; image inlining
            // is deferred to Sprint 4 where the Telegram adapter will surface
            // them via `pi.sendUserMessage` content array.
            lines.push(`[Image attachment: ${a.filename ?? a.mimeType} — base64 ${a.data.length} chars]`);
        } else {
            lines.push(`[Binary attachment: ${a.filename ?? a.mimeType} (${a.sizeBytes} bytes) at ${a.localPath}]`);
        }
    }
    return lines.join("\n");
}

// ---------- Admin Override Option C — plan-abort detector ----------
//
// Matches a STRUCTURAL command prefix only. Previously also matched "@bot
// abort" in natural language, but that assumed English speakers — see
// memory/feedback_no_english_only_intent_regex.md. Admins now must use the
// explicit `!plan-abort` (or `!plan_abort`) command, which is language-
// neutral by design (it's a command keyword, not a conversational phrase).
//
// Matches (case-insensitive, prefix anchored):
//     !plan-abort [<optional reason>]
//     !plan_abort [<optional reason>]
const ABORT_PATTERN = /^\s*!plan[_-]abort(?:\s+(.+))?\s*$/i;

/**
 * Pre-dispatch hook that catches admin "@bot abort" / "!plan-abort" replies
 * in a thread mapped to an active scheduled plan, writes the abort control
 * file for the owning subprocess session to pick up, and blocks the message
 * so it doesn't also flow to the LLM. Non-admin senders, non-matching text,
 * or messages in threads without a mapped plan fall through untouched.
 */
function abortDetectorHook(msg: Message): { block: true; reason: string } | { block: false } {
    const match = (msg.text ?? "").match(ABORT_PATTERN);
    if (!match) return { block: false };
    if (!getWhitelist().isAdmin(msg.platform, msg.senderId)) return { block: false };
    const target = findPlanSessionByThread(msg.platform, msg.channelId, msg.threadId);
    if (!target) return { block: false };
    const reason = (match[1] ?? "").trim() || "admin chat abort";
    const by = `${msg.platform}:${msg.senderId}`;
    writeAbortControlFile(target.sessionId, reason, by);
    return {
        block: true,
        reason:
            `✅ Abort signal sent to plan ${target.planId} (session ${target.sessionId}). ` +
            `The scheduled run will halt at its next plan tool call or turn boundary.`,
    };
}

export default function (pi: ExtensionAPI) {
    const dispatcher = getDispatcher();

    // Run the abort detector FIRST — it must fire before rate-limit or other
    // side-effecting hooks. Messages that don't target an active plan fall
    // through unchanged.
    dispatcher.addPreDispatchHook(abortDetectorHook);

    // Track the originating platform/channel of the most recent inbound message
    // so that on agent_end we know where to send the response. Sprint 4
    // replaces this with per-session tracking via custom session entries.
    let lastOrigin: OriginEntry | null = null;

    pi.on("session_start", async (_event, ctx) => {
        // Wire pushToPi — dispatcher will drain any buffered inbound messages.
        dispatcher.setPushToPi(async (msg) => {
            lastOrigin = {
                platform: msg.platform,
                channelId: msg.channelId,
                ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
                senderId: msg.senderId,
                senderDisplayName: msg.senderDisplayName,
                timestamp: msg.timestamp,
            };
            // Persist as a session entry so the response handler on agent_end
            // can recover origin even after a /reload or branch navigation.
            // (Defensive — covered by closure variable too.)
            pi.appendEntry(ENTRY_TYPE, lastOrigin);

            const header = formatMetadataHeader(msg);
            const attach = formatAttachmentsForPi(msg);
            const body = `${header}\n\n${msg.text}${attach}`;
            // Use followUp so the message is queued and triggers a turn.
            pi.sendUserMessage(body, { deliverAs: "followUp" });
        });

        // Restore lastOrigin from the most recent persisted entry, if any.
        // This lets agent_end on a resumed session still route correctly.
        for (const entry of ctx.sessionManager.getBranch()) {
            if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
                lastOrigin = entry.data as OriginEntry;
            }
        }
    });

    pi.on("agent_end", async (_event, _ctx) => {
        // No-op by design — historical (Sprint 4) routing-back path that
        // is now obsolete. Delivery to the originating adapter is handled
        // entirely outside this hook:
        //   - CLI: pi-tui renders the assistant reply directly in the TUI;
        //     transport_bridge has nothing to add (would just double-render).
        //   - non-CLI (Telegram, A2A, future Slack, etc.): the PARENT
        //     process spawns a subprocess against the channel's session
        //     (src/transport/channelRouter.ts), captures the subprocess's
        //     stdout, and the parent calls dispatcher.send. The parent is
        //     where the adapters are registered.
        //
        // Why this used to fire (and spam the error ledger) before the
        // fix: the subprocess loads transport_bridge too. On session_start
        // it restored lastOrigin from a persisted "transport-origin"
        // entry the parent wrote. On agent_end it then attempted
        // dispatcher.send back to telegram — but the SUBPROCESS dispatcher
        // has no adapters registered (only the parent does), so every
        // turn produced a "no adapter registered for platform telegram"
        // error in the ledger.
        //
        // The lastOrigin tracking + persisted "transport-origin" entry
        // are still load-bearing for OTHER consumers (admin_gate uses
        // identity.currentOrigin to learn who's driving a turn for ACL +
        // audit). Just the send-back path here is dead.
        void lastOrigin; // keeps the closure variable warning at bay
        void extractAssistantText; // ditto for the import
    });

    pi.registerCommand("transports", {
        description: "List registered transport adapters and their status",
        handler: async (_args, ctx) => {
            const adapters = dispatcher.statusReport();
            if (adapters.length === 0) {
                ctx.ui.notify("No transport adapters registered.", "warning");
                return;
            }
            const lines: string[] = ["Registered transport adapters:", ""];
            for (const a of adapters) {
                lines.push(`  ${a.platform.padEnd(12)} state=${a.state}`);
                if (a.connectedAt) {
                    const ago = Math.round((Date.now() - a.connectedAt) / 1000);
                    lines.push(`    connected ${ago}s ago`);
                }
                if (a.details) {
                    for (const [k, v] of Object.entries(a.details)) {
                        lines.push(`    ${k}: ${v}`);
                    }
                }
                if (a.lastError) lines.push(`    last_error: ${a.lastError}`);
            }
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });

    pi.registerCommand("connect-telegram", {
        description: "Validate a Telegram bot token, store it in the vault, and (re)start the Telegram adapter. Args: <bot_token>",
        handler: async (args, ctx) => {
            const token = (args ?? "").trim();
            if (!token) {
                ctx.ui.notify("Usage: /connect-telegram <bot_token>\nGet a token from @BotFather on Telegram.", "error");
                return;
            }
            // Validate by calling getMe.
            ctx.ui.notify("Validating token via Telegram getMe...", "info");
            type BotInfo = { id: number; username?: string; first_name: string };
            let me: BotInfo | null = null;
            try {
                const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
                const json = (await res.json()) as { ok: boolean; result?: BotInfo; description?: string; error_code?: number };
                if (!json.ok || !json.result) {
                    // Disambiguate the most common cause: Telegram returns
                    // `"description":"Not Found"` (bare, no context) when the
                    // token doesn't match any bot. Operators read that as
                    // "vault not found" — actually it means BotFather doesn't
                    // recognize this token.
                    const desc = (json.description ?? "").trim();
                    let msg: string;
                    if (json.error_code === 401 || /unauthorized/i.test(desc)) {
                        msg = `Telegram says the token is unauthorized. Likely revoked — get a fresh one from @BotFather.`;
                    } else if (json.error_code === 404 || /^not found$/i.test(desc)) {
                        msg = `Telegram says no bot exists for this token. Causes: (1) copy-paste truncated the token, (2) wrong bot selected in @BotFather, (3) token revoked. The token format is "<digits>:<letters/digits/dashes>" e.g. 123456789:AAH-token-here.`;
                    } else {
                        msg = `Telegram rejected the token (HTTP ${json.error_code ?? "?"}): ${desc || "no description"}.`;
                    }
                    ctx.ui.notify(msg, "error");
                    return;
                }
                me = json.result;
            } catch (e) {
                ctx.ui.notify(`Failed to reach Telegram API (network problem, not a token problem): ${e instanceof Error ? e.message : String(e)}`, "error");
                return;
            }
            // TS flow-narrows `me` to its initialised type — re-typed local escapes.
            const validatedMe = me as BotInfo | null;

            // Store in vault.
            getVault().set("TELEGRAM_BOT_TOKEN", token);

            // Restart the Telegram adapter so it picks up the new token.
            const adapter = dispatcher.getAdapter("telegram");
            if (!adapter) {
                ctx.ui.notify(
                    `Token saved to vault. Telegram adapter is not registered yet — restart the bot to enable it.`,
                    "warning",
                );
                return;
            }
            await adapter.stop();
            await adapter.start();
            const status = adapter.status();
            const username = validatedMe?.username ? `@${validatedMe.username}` : validatedMe?.first_name ?? "(unknown)";
            if (status.state === "running") {
                ctx.ui.notify(
                    `✅ Telegram bot ${username} connected.\n` +
                    `Next steps:\n` +
                    `  1. DM the bot from your Telegram account. The message will be blocked\n` +
                    `     and your user_id will be logged. Check the bot logs for a line:\n` +
                    `       [admin_gate] BLOCKED unlisted inbound from telegram:<your_id> ...\n` +
                    `  2. If you haven't claimed admin yet, run at the terminal:\n` +
                    `       /init-status   (shows your one-time passcode if still live)\n` +
                    `     Then DM the bot:  /init <passcode>\n` +
                    `  3. Or, if already admin at the terminal, run:\n` +
                    `       /whitelist add telegram <your_id> admin\n`,
                    "info",
                );
            } else {
                ctx.ui.notify(
                    `Token saved but adapter state=${status.state}: ${status.lastError ?? "(no error reason)"}`,
                    "warning",
                );
            }
        },
    });
}

function extractAssistantText(messages: ReadonlyArray<unknown>): string {
    // messages is a slice of AgentMessage union — we want the last assistant
    // message's text content. Guard everything because the type surface is wide.
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as { role?: string; content?: unknown };
        if (m && m.role === "assistant" && Array.isArray(m.content)) {
            const text = m.content
                .filter((c: unknown): c is { type: string; text: string } =>
                    typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text" && typeof (c as { text?: unknown }).text === "string",
                )
                .map((c) => c.text)
                .join("\n");
            if (text) return text;
        }
    }
    return "";
}
