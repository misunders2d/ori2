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

/**
 * Active subprocess state per channel. Populated when a `doActiveResponse`
 * starts its spawn, cleared on subprocess exit. Used by the next active
 * arrival to kill the prior in-flight subprocess (ori/-style mid-flight
 * interrupt — see telegram_poller.py:731-756).
 */
interface ActiveState {
    controller: AbortController;
    /** The incoming Message that kicked off this subprocess. Saved as a
     *  passive context entry if interrupted, so the agent sees what was
     *  being asked when it got cut off. */
    kickoffMsg: Message;
}
const activeSubprocesses = new Map<string, ActiveState>();

// NOTE: We deliberately do NOT do pre-dispatch cancel-word detection
// ("cancel"/"stop"/etc). Language-dependent regex would exclude every
// non-English speaker. Instead, every active mention:
//   (1) kills the prior subprocess for this channel (if any),
//   (2) saves the prior mention as a passive context entry,
//   (3) spawns a FRESH subprocess with the new mention.
// The new subprocess's LLM sees the interrupted prior mention + the new
// text and interprets intent (including "cancel" in any language) — that's
// what the LLM is good at. Cost: one short LLM turn for what could have
// been a regex short-circuit. Benefit: works for every language the model
// understands.

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
 * Force the entry we JUST appended (via sm.appendX) to disk, bypassing Pi's
 * hasAssistant gating (session-manager.js:549-567). Append-only (O(1) per
 * call) so it NEVER overwrites work a concurrent subprocess is doing on the
 * same JSONL — critical because our active subprocess runs in parallel with
 * passive ingests for the same channel.
 *
 * TypeScript `private` is compile-only; `fileEntries` is accessible at
 * runtime. Verified at session-manager.js:436 (`fileEntries = []`).
 *
 * For a fresh session file (doesn't exist yet) we write header + entries
 * with writeFileSync — safe because if the file doesn't exist, nothing else
 * is writing to it either.
 */
function persistSessionNow(sm: SessionManager, sessionFile: string): void {
    const entries = (sm as unknown as { fileEntries: unknown[] }).fileEntries;
    if (entries.length === 0) return;
    if (fs.existsSync(sessionFile)) {
        // File exists — someone (or a prior run) has already written at
        // least the header. Append only the new entry.
        const last = entries[entries.length - 1];
        fs.appendFileSync(sessionFile, JSON.stringify(last) + "\n");
    } else {
        // Fresh file — write everything (header + the one entry we just added).
        const jsonl = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
        fs.writeFileSync(sessionFile, jsonl);
    }
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

/**
 * Spawn contract: given kickoff text + session file + an AbortSignal, run the
 * pi -p subprocess and resolve when it exits. If `signal.abort()` fires
 * mid-run, the implementation MUST terminate the child (SIGTERM) and resolve
 * with whatever has been captured (exitCode may be null on signal-kill).
 * The promise should NOT reject on abort — callers distinguish outcomes via
 * the returned SpawnResult, not via throws.
 */
export type SpawnPiPrint = (
    kickoff: string,
    sessionFile: string,
    signal: AbortSignal,
) => Promise<SpawnResult>;

const realSpawnPiPrint: SpawnPiPrint = (kickoff, sessionFile, signal) =>
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

        const onAbort = () => {
            // SIGTERM gives the process a chance to flush. Pi's SessionManager
            // writes on each entry via appendFileSync, so partial state is on
            // disk regardless — SIGKILL would only risk a torn JSONL line.
            try { proc.kill("SIGTERM"); } catch { /* already dead */ }
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
    });

async function doActiveResponse(msg: Message, spawnFn: SpawnPiPrint): Promise<void> {
    const key = channelKey(msg.platform, msg.channelId);
    const sessionFile = getChannelSessions().getOrCreateSessionFile(msg.platform, msg.channelId);

    // ---------------- Mid-flight interrupt (ori/-style) ----------------
    //
    // If a subprocess is already running for this channel, cut it off:
    // save the prior kickoff as a passive context entry (so the agent later
    // sees what the user had been asking when interrupted), then abort the
    // AbortController to SIGTERM the child. The serialization enqueue
    // pattern would otherwise make us wait 5+ seconds for the prior turn
    // to complete — fine for scheduled work, awful for chat UX.
    //
    // Pattern port reference: ori/interfaces/telegram_poller.py:731-756.
    const prev = activeSubprocesses.get(key);
    if (prev) {
        try {
            const psm = SessionManager.open(sessionFile);
            psm.appendCustomMessageEntry(
                PASSIVE_CUSTOM_TYPE,
                `${prev.kickoffMsg.senderDisplayName} (interrupted): ${prev.kickoffMsg.text}`,
                false,
                {
                    platform: prev.kickoffMsg.platform,
                    channelId: prev.kickoffMsg.channelId,
                    senderId: prev.kickoffMsg.senderId,
                    senderDisplayName: prev.kickoffMsg.senderDisplayName,
                    timestamp: prev.kickoffMsg.timestamp,
                    interrupted: true,
                },
            );
            persistSessionNow(psm, sessionFile);
        } catch (e) {
            logWarning("channelRouter", "failed to save interrupted kickoff as context", {
                err: e instanceof Error ? e.message : String(e),
                platform: msg.platform,
                channelId: msg.channelId,
            });
        }
        prev.controller.abort();
        activeSubprocesses.delete(key);
    }

    // Seed a transport-origin CustomEntry before spawning so that tools in
    // the subprocess can call currentOrigin() and learn who this active turn
    // came from (e.g. schedule_reminder needs deliverTarget; admin_gate
    // checks msg origin against the whitelist). Without this, the channel
    // session has only `chat-context` CustomMessageEntries with embedded
    // sender attribution in text — not machine-readable, and not at the
    // type the identity helper looks for (see src/core/identity.ts).
    try {
        const sm = SessionManager.open(sessionFile);
        sm.appendCustomEntry("transport-origin", {
            platform: msg.platform,
            channelId: msg.channelId,
            ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp,
        });
        persistSessionNow(sm, sessionFile);
    } catch (e) {
        // Seeding origin is best-effort — spawn proceeds even if it fails.
        // Worst case: subprocess tools fall back to CLI origin, which still
        // works for the common summarization path (no tools that need the
        // per-message origin are invoked).
        logWarning("channelRouter", "transport-origin seed failed — proceeding", {
            err: e instanceof Error ? e.message : String(e),
            platform: msg.platform,
            channelId: msg.channelId,
        });
    }

    const kickoff = formatActiveKickoff(msg);

    const controller = new AbortController();
    activeSubprocesses.set(key, { controller, kickoffMsg: msg });
    let result: SpawnResult;
    try {
        result = await spawnFn(kickoff, sessionFile, controller.signal);
    } finally {
        // Only clear if we're still the registered controller — a later
        // interrupt may have replaced us with a fresh one.
        const current = activeSubprocesses.get(key);
        if (current && current.controller === controller) {
            activeSubprocesses.delete(key);
        }
    }

    // If we were aborted, the subprocess was killed — DON'T deliver its
    // truncated stdout. The next active response (already enqueued by the
    // same interrupt that killed us) will produce the real answer.
    if (controller.signal.aborted) return;
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
    // Passive ingests serialize per channel so concurrent passives on the
    // same channel don't interleave (quick, never blocks the adapter).
    d.setOnPassiveContext((msg) => {
        enqueueForChannel(msg.platform, msg.channelId, () => doPassiveContext(msg));
    });
    // Active responses DO NOT serialize. A new mention on a channel that's
    // already running a subprocess must interrupt it — queueing behind would
    // mean the user waits 5s+ for their "never mind" / "actually something
    // else" to even start being processed. doActiveResponse handles the
    // kill-prior + spawn-new pattern inline (see its body).
    d.setOnActiveResponse((msg) => {
        void doActiveResponse(msg, spawnFn);
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
