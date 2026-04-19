import type { Message } from "./types.js";

// =============================================================================
// Shared inbound-header format.
//
// Every non-CLI inbound that reaches the agent is prefixed with a one-line
// metadata header so the agent knows who's talking, where, and when:
//
//   [Inbound | platform: telegram | from: Alice | sender_id: 12345 | channel: -100abc | time: 2026-04-19T09:00:00Z]
//
//   <actual message body>
//
// Two consumers need to agree on the format:
//
//   - Writers (transport_bridge.pushToPi for CLI, channelRuntime for every
//     other platform) prepend this to the prompt so the LLM sees it.
//   - Readers (admin_gate's input hook) strip it so user-typed commands
//     like `Approve ACT-ABC123` or `/init <passcode>` are matched at the
//     body's start, not at an offset after the header.
//
// Before this module existed the two diverged: channelRuntime produced
// `[telegram inbound | ...]\n<body>` (lowercase, single newline) while
// admin_gate's stripMetadataHeader only matched `[Inbound | ...]\n\n<body>`
// (capital I, double newline). The result: approvals and /init typed from
// Telegram were silently ignored because the regex never fired. Keep both
// sides here so the contract is explicit and has a test.
// =============================================================================

/**
 * Build the `[Inbound | ...]` header for a Message. Callers then join it
 * with the body using `\n\n` (see formatInboundPrompt below if you just
 * want both at once).
 */
export function formatInboundHeader(msg: Message): string {
    const parts: string[] = [`platform: ${msg.platform}`];
    if (msg.senderDisplayName) parts.push(`from: ${msg.senderDisplayName}`);
    parts.push(`sender_id: ${msg.senderId}`);
    parts.push(`channel: ${msg.channelId}`);
    if (msg.threadId) parts.push(`thread: ${msg.threadId}`);
    parts.push(`time: ${new Date(msg.timestamp).toISOString()}`);
    return `[Inbound | ${parts.join(" | ")}]`;
}

/**
 * Convenience: `formatInboundHeader(msg) + "\n\n" + body`. The double
 * newline is load-bearing — stripInboundHeader expects it.
 */
export function formatInboundPrompt(msg: Message, body: string): string {
    return `${formatInboundHeader(msg)}\n\n${body}`;
}

/**
 * Strip the `[Inbound | ...]` header off the start of `text` if present,
 * returning the body. If the header isn't found (CLI prompts, test
 * harnesses, etc.), returns the input unchanged.
 *
 * Must stay in lockstep with formatInboundHeader — the tests enforce this
 * (src/transport/inboundHeader.test.ts).
 */
export function stripInboundHeader(text: string): string {
    // Header ends at the first `]`; body starts after `\s*\n\n` (allows
    // trailing spaces before the newlines, which some chat clients insert).
    const m = text.match(/^\[Inbound \|[^\]]*\]\s*\n\n([\s\S]*)$/);
    return m ? m[1]! : text;
}
