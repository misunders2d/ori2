import fs from "node:fs";
import { spawn } from "node:child_process";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { getChannelSessions } from "../core/channelSessions.js";
import { getDispatcher } from "./dispatcher.js";
import type { Message } from "./types.js";
import { logError, logWarning } from "../core/errorLog.js";

// =============================================================================
// channelRouter — wires the dispatcher's non-CLI inbound handlers.
//
// Two paths:
//
//   PASSIVE (msg.addressedToBot === false):
//     Open the channel's session JSONL and append a CustomMessageEntry with
//     `display: false`. The entry DOES participate in LLM context
//     (pi-coding-agent/docs/session.md §CustomMessageEntry), so the next
//     time the bot is addressed in that channel, the agent sees the chain
//     of prior messages with per-speaker attribution.
//
//   ACTIVE (msg.addressedToBot === true, msg.platform !== "cli"):
//     Spawn `npx pi -p <kickoff> --session <channel-session-file>` against
//     the channel's own session. Pi loads the session (including prior
//     passive entries), adds the mention as the user turn, runs the agent,
//     and persists both the user message and assistant reply into the
//     session file. We capture stdout as the assistant text and deliver it
//     via dispatcher.send() back to the originating adapter.
//
// Per-channel serialization:
//   Two concurrent mentions on the same channel would otherwise race on the
//   session JSONL. We chain work through `channelLocks: Map<key, Promise>`.
//   Serialization is PER CHANNEL, not global — different channels still run
//   in parallel. Fire-and-forget: onActiveResponse returns immediately so
//   the adapter's poll loop isn't blocked waiting for the subprocess.
//
// Pi SDK behaviors verified before implementation:
//   - SessionManager.open(path) on a non-existent file starts a fresh
//     in-memory session (session-manager.js:478-482). Safe to call on
//     channel files that haven't had their first write yet.
//   - appendCustomMessageEntry(customType, content, display, details)
//     (session-manager.js:678). content can be string or content blocks.
//     display=false hides from the TUI (doesn't matter here — the TUI
//     never opens channel session files — but signals "not a user turn").
//   - `pi -p <kickoff> --session <file>` uses SessionManager.open for the
//     session and treats kickoff as the initial user message (main.js
//     parseArgs → createSessionManager → runPrintMode).
//   - CRITICAL: Pi's _persist() defers disk writes until an assistant message
//     exists in the session (session-manager.js:549-567). That's an
//     optimization to avoid empty "0-turn" files — but it means our passive
//     entries (which never trigger an assistant turn on their own) would
//     stay in-memory only and be lost when the next subprocess opens the
//     file fresh. We work around by force-rewriting the file after every
//     passive append — see `persistSessionNow` below.
// =============================================================================

/** What customType to stamp on passive entries. Namespaced for future greps. */
const PASSIVE_CUSTOM_TYPE = "chat-context";

/** Per-channel lock promises to serialize writes per channel. */
const channelLocks = new Map<string, Promise<void>>();

function channelKey(platform: string, channelId: string): string {
    return `${platform}:${channelId}`;
}

/**
 * Run `fn` after any currently-queued work on this channel finishes.
 * Returns immediately — the work happens fire-and-forget so the adapter's
 * poll loop isn't blocked behind the subprocess.
 */
function enqueueForChannel(platform: string, channelId: string, fn: () => Promise<void>): void {
    const key = channelKey(platform, channelId);
    const prev = channelLocks.get(key) ?? Promise.resolve();
    // .catch(() => {}) on the previous arm — a crash in one handler must not
    // wedge subsequent ones for the same channel.
    const mine = prev.catch(() => {}).then(fn);
    channelLocks.set(key, mine.catch(() => {}));
}

/**
 * Format a passive message as a short sender-attributed line the agent can
 * read naturally: `"Alice: Bob just said it was a good movie"`. Attachments
 * are hinted textually (images/documents not inlined in v1 — see module
 * docstring tradeoffs).
 */
function formatPassiveContent(msg: Message): string {
    const parts: string[] = [];
    parts.push(`${msg.senderDisplayName}: ${msg.text}`);
    if (msg.attachments && msg.attachments.length > 0) {
        for (const a of msg.attachments) {
            if (a.kind === "image") parts.push(`  [image: ${a.filename ?? a.mimeType}]`);
            else if (a.kind === "text") parts.push(`  [document: ${a.filename ?? a.mimeType}, ${a.text.length} chars]`);
            else parts.push(`  [file: ${a.filename ?? a.mimeType}, ${a.sizeBytes} bytes]`);
        }
    }
    return parts.join("\n");
}

/**
 * Build the kickoff text for an ACTIVE response. The channel session already
 * contains prior passive entries per speaker, so the kickoff is just the
 * current speaker's message with a minimal attribution header.
 */
function formatActiveKickoff(msg: Message): string {
    const header = `[${msg.platform} inbound | from: ${msg.senderDisplayName} (${msg.senderId}) | channel: ${msg.channelId}]`;
    const body = msg.text || "(no text)";
    const attach = (msg.attachments ?? []).map((a) => {
        if (a.kind === "image") return `[attached image: ${a.filename ?? a.mimeType}]`;
        if (a.kind === "text") return `[attached document: ${a.filename ?? a.mimeType}]\n${a.text}`;
        return `[attached file: ${a.filename ?? a.mimeType} @ ${a.localPath}]`;
    });
    return attach.length > 0 ? `${header}\n${body}\n\n${attach.join("\n")}` : `${header}\n${body}`;
}

/**
 * PASSIVE path: append to the channel session as a CustomMessageEntry. The
 * entry appears in LLM context on next active run in this channel but does
 * not trigger anything now.
 */
async function doPassiveContext(msg: Message): Promise<void> {
    const sessionFile = getChannelSessions().getOrCreateSessionFile(msg.platform, msg.channelId);
    try {
        const sm = SessionManager.open(sessionFile);
        sm.appendCustomMessageEntry(
            PASSIVE_CUSTOM_TYPE,
            formatPassiveContent(msg),
            false, // display=false: not a TUI-visible entry; still included in LLM context
            {
                platform: msg.platform,
                channelId: msg.channelId,
                senderId: msg.senderId,
                senderDisplayName: msg.senderDisplayName,
                timestamp: msg.timestamp,
            },
        );
        persistSessionNow(sm, sessionFile);
    } catch (e) {
        logError("channelRouter", "passive append failed", {
            err: e instanceof Error ? e.message : String(e),
            platform: msg.platform,
            channelId: msg.channelId,
            sessionFile,
        });
    }
}

/**
 * Force a session's in-memory entries to disk, bypassing Pi's hasAssistant
 * gating (session-manager.js:549-567). Called after every passive append so
 * subprocesses see the full context, not just entries Pi decided were worth
 * persisting.
 *
 * TypeScript `private` is compile-only; `fileEntries` is accessible at
 * runtime. Verified at session-manager.js:436 (`fileEntries = []`).
 *
 * Cost: O(N) per passive append. Pi's own format (`_rewriteFile` at
 * session-manager.js:528-532) is line-per-entry JSONL with trailing newline;
 * we replicate that exactly so a subsequent Pi load doesn't need migration.
 */
function persistSessionNow(sm: SessionManager, sessionFile: string): void {
    const entries = (sm as unknown as { fileEntries: unknown[] }).fileEntries;
    const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(sessionFile, jsonl);
}

/**
 * ACTIVE path: spawn `npx pi -p <kickoff> --session <file>`, capture stdout,
 * deliver via dispatcher.send().
 *
 * Exported for test injection — tests provide a fake `spawnFn` to avoid
 * actually invoking the pi binary.
 */
export interface SpawnResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
}

export type SpawnPiPrint = (kickoff: string, sessionFile: string) => Promise<SpawnResult>;

const realSpawnPiPrint: SpawnPiPrint = (kickoff, sessionFile) =>
    new Promise<SpawnResult>((resolve) => {
        const proc = spawn(
            "npx",
            ["pi", "-p", kickoff, "--session", sessionFile],
            {
                cwd: process.cwd(),
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
                detached: false,
            },
        );
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
        proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
        proc.on("close", (code) => resolve({ stdout, stderr, exitCode: code }));
        proc.on("error", (e) => resolve({ stdout, stderr: `${stderr}\nspawn error: ${e.message}`, exitCode: null }));
    });

async function doActiveResponse(msg: Message, spawnFn: SpawnPiPrint): Promise<void> {
    const sessionFile = getChannelSessions().getOrCreateSessionFile(msg.platform, msg.channelId);
    const kickoff = formatActiveKickoff(msg);

    const result = await spawnFn(kickoff, sessionFile);
    if (result.exitCode !== 0) {
        logWarning("channelRouter", "subprocess non-zero exit — no delivery", {
            platform: msg.platform,
            channelId: msg.channelId,
            exitCode: result.exitCode,
            stderr_tail: result.stderr.slice(-500),
        });
        return;
    }
    const text = result.stdout.trim();
    if (!text) {
        logWarning("channelRouter", "subprocess produced no stdout", {
            platform: msg.platform,
            channelId: msg.channelId,
        });
        return;
    }
    try {
        const resp: { text: string; replyToMessageId?: string } = { text };
        if (msg.threadId) resp.replyToMessageId = msg.threadId;
        await getDispatcher().send(msg.platform, msg.channelId, resp);
    } catch (e) {
        logError("channelRouter", "delivery failed", {
            err: e instanceof Error ? e.message : String(e),
            platform: msg.platform,
            channelId: msg.channelId,
        });
    }
}

/**
 * Wire the channel router into the dispatcher. Call once during bootstrap
 * AFTER adapters are registered (so dispatcher.send() has the target
 * adapter) and AFTER channelSessions is available.
 *
 * `spawnFn` is test-injectable; production callers pass no arg and get the
 * real `npx pi -p` spawn.
 */
export function installChannelRouter(spawnFn: SpawnPiPrint = realSpawnPiPrint): void {
    const d = getDispatcher();
    d.setOnPassiveContext((msg) => {
        enqueueForChannel(msg.platform, msg.channelId, () => doPassiveContext(msg));
    });
    d.setOnActiveResponse((msg) => {
        enqueueForChannel(msg.platform, msg.channelId, () => doActiveResponse(msg, spawnFn));
    });
}

/**
 * Test-only: wait for all currently queued per-channel work to drain. Lets
 * tests assert on post-enqueue state without busy-polling.
 */
export async function __drainChannelLocksForTests(): Promise<void> {
    // Snapshot — channelLocks may be reassigned during drain as new work
    // enqueues behind existing promises.
    const all = Array.from(channelLocks.values());
    await Promise.allSettled(all);
}

/** Test-only: clear the per-channel lock state. */
export function __resetChannelLocksForTests(): void {
    channelLocks.clear();
}
