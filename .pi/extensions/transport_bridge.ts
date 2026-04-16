import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import type { Message } from "../../src/transport/types.js";

// =============================================================================
// transport_bridge — Pi-side glue for the transport abstraction.
//
// The dispatcher (src/transport/dispatcher.ts) is created during bootstrap
// BEFORE Pi starts. It needs two Pi-only capabilities:
//
//   1. pushToPi(msg) — turn an inbound Message into something Pi will run.
//      Done with `pi.sendUserMessage(text, { deliverAs: "followUp" })`.
//      We embed sender/platform/timestamp metadata as a header so the agent
//      knows who is talking even in single-session multi-user scenarios.
//
//   2. originating-platform tracking — when an inbound message arrives from
//      Telegram, the agent's response should go back to Telegram, not to
//      the CLI. We tag the session with the originating (platform, channelId)
//      via a custom session entry on each inbound, then on `agent_end` send
//      the response back to the right adapter.
//
// SCOPE FOR SPRINT 3:
//   - pushToPi: implemented. Uses a metadata-header convention.
//   - originating-platform tracking: implemented as a closure variable
//     (last-inbound-wins). This works because the CLI is the only inbound
//     today and it always re-tags. Sprint 4 (Telegram + multi-session)
//     will replace this with proper per-session tracking.
//   - /transports slash command: implemented for admin visibility.
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

export default function (pi: ExtensionAPI) {
    const dispatcher = getDispatcher();

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

    pi.on("agent_end", async (event, _ctx) => {
        if (!lastOrigin) return;
        if (lastOrigin.platform === "cli") {
            // CLI adapter would just echo to stderr — but the TUI already
            // rendered the response. Skip to avoid double-render.
            return;
        }
        // Extract the assistant's text reply from the agent_end event messages.
        const assistantText = extractAssistantText(event.messages);
        if (!assistantText) return;
        try {
            await dispatcher.send(lastOrigin.platform, lastOrigin.channelId, {
                text: assistantText,
                ...(lastOrigin.threadId !== undefined ? { replyToMessageId: lastOrigin.threadId } : {}),
            });
        } catch (e) {
            console.error(`[transport_bridge] failed to send response back to ${lastOrigin.platform}:`, e);
        }
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
