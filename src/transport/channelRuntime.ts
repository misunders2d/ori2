import {
    SessionManager,
    createAgentSessionFromServices,
    createAgentSessionServices,
    type AgentSession,
    type AgentSessionServices,
} from "@mariozechner/pi-coding-agent";
import { getChannelSessions } from "../core/channelSessions.js";
import { getDispatcher } from "./dispatcher.js";
import { logError, logInfo, logWarning } from "../core/errorLog.js";
import { getOrCreate } from "../core/singletons.js";
import { writePendingHandoff } from "../core/handoffPending.js";
import type { Message } from "./types.js";

// =============================================================================
// channelRuntime — IN-PROCESS per-channel AgentSession orchestration.
//
// Replaces the prior subprocess-per-turn (`pi -p` spawn) model, which had
// a fundamental bug: extensions with persistent timers (attachments cron,
// node-schedule jobs, etc.) kept the subprocess's event loop alive past
// the agent's reply, so `pi -p` printed its output but never exited.
// Watchdog + per-extension subprocess-guards were bandaids.
//
// The new model matches what production Node agent frameworks (LiveKit
// agents-js, OpenCode) actually do: ONE process, per-channel AgentSession
// instances kept alive in memory, in-process delivery via Pi's event
// subscription API (no spawn, no stdout capture, no watchdog).
//
// Lifecycle:
//   - On first inbound from (platform, channelId), createAgentSessionFromServices
//     against the channel's JSONL session file. Cached in Map.
//   - Subscribe to agent_end events; on each turn end, extract assistant text
//     and deliver via dispatcher.send.
//   - Subsequent inbound for the same channel reuses the cached session.
//   - Idle eviction: if a channel has had no activity for IDLE_TTL_MS, dispose
//     to free memory + open file handles.
//
// Concurrency:
//   - Multiple channels run in parallel (Pi sessions are isolated).
//   - Within a single channel: serialized via Pi's own steer/followUp queue
//     (PromptOptions.streamingBehavior). New inbound during a turn is delivered
//     as `followUp` so it joins the queue rather than spawning a duplicate run.
//
// Services sharing:
//   - createAgentSessionServices is called ONCE per process; the resulting
//     services (model registry, settings, resource loader) are shared across
//     all per-channel sessions. Cheap session creation, no per-channel
//     extension reload cost.
// =============================================================================

const IDLE_TTL_MS = 15 * 60 * 1000;     // dispose channel sessions idle for 15 min
const SWEEP_INTERVAL_MS = 60 * 1000;    // check for idle sessions every minute
const MAX_TURN_TIMEOUT_MS = 300_000;    // 5 min max per turn — safety net only

interface ChannelEntry {
    session: AgentSession;
    /**
     * The per-channel SessionManager — load-bearing for transport-origin
     * tagging. Before every inbound turn we write a `transport-origin` custom
     * entry here so `currentOrigin(ctx.sessionManager)` resolves correctly
     * inside tool execute() calls. Without this, tools that use currentOrigin
     * (set_channel_model, reset_channel_session, reload_extensions,
     * hand_off_session, admin_gate's tool-ACL, memory attribution) all fail
     * with "cannot identify caller" on non-CLI channels.
     */
    sessionManager: SessionManager;
    sessionFile: string;
    lastActivity: number;
    /** Unsubscribe handle returned by session.subscribe(...) */
    unsubscribe: () => void;
    /** Active typing-indicator interval. One per channel max — restarted on
     *  agent_start, cleared on agent_end. Platform-generic — fires
     *  adapter.sendTyping?() if the adapter implements it; no-op otherwise. */
    typingTimer?: NodeJS.Timeout;
}

/** Custom-entry type for inbound-origin tagging. See `src/core/identity.ts`
 *  for the consumer-side `currentOrigin()` that walks the branch looking for
 *  entries with this type. Kept as a literal here (not a shared constant) to
 *  avoid an import cycle — identity.ts imports from multiple transport
 *  modules indirectly. */
const TRANSPORT_ORIGIN_TYPE = "transport-origin";

export class ChannelRuntime {
    private services: AgentSessionServices | null = null;
    private servicesPromise: Promise<AgentSessionServices> | null = null;
    private channels: Map<string, ChannelEntry> = new Map();
    private sweepTimer: NodeJS.Timeout | null = null;

    /**
     * Idempotent. Eagerly initializes services (so first inbound doesn't pay
     * the cost). Starts the idle-sweep timer.
     */
    async start(): Promise<void> {
        if (this.servicesPromise) return;
        this.servicesPromise = createAgentSessionServices({ cwd: process.cwd() });
        this.services = await this.servicesPromise;
        this.sweepTimer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
        this.sweepTimer.unref();
    }

    /** Idempotent. Stops the sweep + disposes all channel sessions. */
    async stop(): Promise<void> {
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.sweepTimer = null;
        for (const key of Array.from(this.channels.keys())) {
            await this.dispose(key);
        }
        this.servicesPromise = null;
        this.services = null;
    }

    /**
     * Process a single inbound message: route it to the (lazily-created)
     * per-channel AgentSession. The reply is delivered asynchronously via
     * the agent_end event subscription, which calls dispatcher.send.
     */
    async handleActiveInbound(msg: Message): Promise<void> {
        const key = channelKey(msg.platform, msg.channelId);
        const entry = await this.getOrCreate(msg.platform, msg.channelId);
        entry.lastActivity = Date.now();

        // CRITICAL — write transport-origin BEFORE prompt. Downstream tools
        // run inside the turn's execution and read origin via
        // currentOrigin(ctx.sessionManager). If origin lands after prompt
        // starts, the branch is empty when tools look up, and they fail
        // with "cannot identify caller". Pre-f69bb81, this was written by
        // transport_bridge's setPushToPi callback — but that callback is
        // CLI-only; non-CLI (Telegram/Slack/A2A) goes through this method
        // directly and skips pushToPi entirely. ChannelRuntime is the only
        // choke-point that sees every non-CLI inbound.
        //
        // The entry is in-memory-immediately on the SessionManager (Pi's
        // _appendEntry pushes to fileEntries + byId + leafId synchronously,
        // then triggers lazy _persist). getBranch() traversal sees it
        // without waiting for the disk flush.
        entry.sessionManager.appendCustomEntry(TRANSPORT_ORIGIN_TYPE, {
            platform: msg.platform,
            channelId: msg.channelId,
            ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName ?? msg.senderId,
            timestamp: msg.timestamp,
        });

        // Pi's `prompt(text)` runs ONE agent turn. If a turn is already
        // running for this channel, we use Pi's queue: enqueue the new
        // input as a follow-up so it joins after the current turn settles.
        // This mirrors the prior subprocess model's "interrupt-replace"
        // semantics — but BETTER, because the user's prior message gets
        // its reply instead of being dropped on abort.
        const text = formatActiveKickoff(msg);
        try {
            await entry.session.prompt(text, {
                streamingBehavior: "followUp",
            });
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            logError("channelRuntime", "session.prompt threw — surfacing failure to user", {
                platform: msg.platform,
                channelId: msg.channelId,
                key,
                err,
            });
            try {
                await getDispatcher().send(msg.platform, msg.channelId, {
                    text: `⚠️  Internal error processing your message: ${err.slice(0, 200)}. Operator can check errors.jsonl.`,
                    ...(msg.threadId ? { replyToMessageId: msg.threadId } : {}),
                });
            } catch { /* best effort */ }
        }
    }

    /**
     * Test/internal: list active channel keys for assertions / /channels command.
     */
    listKeys(): string[] {
        return Array.from(this.channels.keys()).sort();
    }

    /**
     * Hand off a channel to a FRESH session seeded with a summary of the current
     * one. Chat-native equivalent of "save context + /new + paste summary".
     *
     * Safety contract: compaction runs BEFORE any destructive step. If compact
     * fails, the entire operation aborts and the old session is left intact.
     * Old session JSONL stays on disk (same convention as reset_channel_session).
     *
     * Flow (all deferred post-turn via setImmediate):
     *   1. session.compact() → CompactionResult { summary, ... }
     *   2. writePendingHandoff(...) — side-channel file picked up by the
     *      session_handoff extension's before_agent_start hook on the next
     *      inbound. Written BEFORE destructive steps so a crash mid-hand-off
     *      leaves both old session + pending summary intact.
     *   3. Remove in-memory ChannelRuntime entry + unsubscribe
     *   4. channelSessions.remove() — drop the binding so the next inbound
     *      lazy-creates a fresh session.
     *
     * Returns { queued: true } when an active session exists, { queued: false }
     * otherwise. Never throws — all errors land in the ledger. If compact
     * fails, nothing else runs — old session intact.
     */
    async handOffChannel(
        platform: string,
        channelId: string,
    ): Promise<{ queued: boolean; reason?: string }> {
        const key = channelKey(platform, channelId);
        const entry = this.channels.get(key);
        if (!entry) {
            return { queued: false, reason: "no active session for this channel" };
        }
        setImmediate(() => {
            void this.runHandOff(platform, channelId, entry, key).catch((err: unknown) => {
                logError("channelRuntime", "deferred hand-off failed", {
                    platform,
                    channelId,
                    key,
                    err: err instanceof Error ? err.message : String(err),
                });
            });
        });
        entry.lastActivity = Date.now();
        return { queued: true };
    }

    private async runHandOff(
        platform: string,
        channelId: string,
        entry: ChannelEntry,
        key: string,
    ): Promise<void> {
        // Step 1: compact. Non-destructive. If this fails we bail and the
        // user's session is untouched — no data loss, no split-brain.
        let summary: string;
        try {
            const result = await entry.session.compact();
            summary = result.summary;
        } catch (err) {
            logError("channelRuntime", "hand-off aborted: compact failed — session unchanged", {
                platform,
                channelId,
                key,
                err: err instanceof Error ? err.message : String(err),
            });
            return;
        }

        // Step 2: persist the summary to the side-channel BEFORE any
        // destructive step. If the process crashes between here and the
        // binding swap, the next restart finds an orphan pending file with
        // the old binding still intact — worst-case the operator sees a
        // duplicate summary on first inbound after restart. Much better than
        // losing the summary to a mid-flight crash.
        writePendingHandoff(platform, channelId, summary, entry.sessionFile);

        // Step 3: dispose the in-memory entry. stopTyping in case a typing
        // loop was mid-fire. unsubscribe detaches the agent_end handler so
        // Pi doesn't dispatch replies against a session we're tearing down.
        this.stopTyping(entry);
        this.channels.delete(key);
        try {
            entry.unsubscribe();
        } catch { /* best effort — next line proceeds regardless */ }

        // Step 4: drop the channelSessions binding. Next inbound for this
        // (platform, channelId) will lazy-create a fresh AgentSession against
        // a new JSONL; the session_handoff extension's before_agent_start
        // hook will pick up the pending file and inject the summary as a
        // display=true custom message, then delete the pending file.
        // Old JSONL stays on disk — operator-recoverable.
        getChannelSessions().remove(platform, channelId);

        logInfo("channelRuntime", "hand-off staged", {
            platform,
            channelId,
            key,
            previousSessionFile: entry.sessionFile,
            summaryChars: summary.length,
        });
    }

    /**
     * Reload extensions/skills/prompts for a channel's AgentSession — chat-native
     * equivalent of Pi's TUI `/reload` slash command. Deferred via setImmediate
     * so the current in-flight turn (typically the tool call that invoked this)
     * finishes cleanly before Pi emits session_shutdown + rebuilds the runtime.
     * New tools / skills become callable on the NEXT message in this channel.
     *
     * Returns { queued: true } if an active session exists (reload is scheduled
     * post-turn), { queued: false, reason } otherwise. Never throws — errors
     * during the deferred reload land in the error ledger.
     */
    async reloadChannel(
        platform: string,
        channelId: string,
    ): Promise<{ queued: boolean; reason?: string }> {
        const key = channelKey(platform, channelId);
        const entry = this.channels.get(key);
        if (!entry) {
            return { queued: false, reason: "no active session for this channel" };
        }
        setImmediate(() => {
            void entry.session.reload().catch((err: unknown) => {
                logError("channelRuntime", "deferred reload failed", {
                    platform,
                    channelId,
                    key,
                    err: err instanceof Error ? err.message : String(err),
                });
            });
        });
        entry.lastActivity = Date.now();
        return { queued: true };
    }

    /** Test-only — clear in-memory state. Caller must call stop() first. */
    reset(): void {
        this.channels.clear();
        this.services = null;
        this.servicesPromise = null;
    }

    private async getOrCreate(platform: string, channelId: string): Promise<ChannelEntry> {
        const key = channelKey(platform, channelId);
        const existing = this.channels.get(key);
        if (existing) return existing;

        if (!this.servicesPromise) {
            // start() was never called (test path or early inbound). Lazy-init.
            await this.start();
        }
        const services = this.services ?? (await this.servicesPromise!);

        const sessionFile = getChannelSessions().getOrCreateSessionFile(platform, channelId);
        const sm = SessionManager.open(sessionFile);

        // Per-channel AgentSession. Shares services with all other channels +
        // the parent (TUI / daemon) — extension code, model registry, settings,
        // and resource loader are reused.
        const result = await createAgentSessionFromServices({
            services,
            sessionManager: sm,
        });
        const session = result.session;

        // Subscribe to events:
        //   - agent_start → kick off typing indicator (every 4s) so the user
        //     sees the bot is alive across slow model calls. Platform-generic:
        //     adapter.sendTyping?() — Telegram implements it, others can.
        //   - agent_end → stop typing + deliver the assistant's text reply
        //     via dispatcher.send.
        // Session lives across many turns; this subscription does too.
        const entry: ChannelEntry = {
            session,
            sessionManager: sm,
            sessionFile,
            lastActivity: Date.now(),
            // unsubscribe assigned below — TS needs the entry first.
            unsubscribe: () => {},
        };
        const unsubscribe = session.subscribe((event) => {
            if (event.type === "agent_start") {
                this.startTyping(platform, channelId, entry);
                return;
            }
            if (event.type === "agent_end") {
                this.stopTyping(entry);
                void this.deliverAgentEnd(platform, channelId, event);
                return;
            }
        });
        entry.unsubscribe = unsubscribe;
        this.channels.set(key, entry);
        return entry;
    }

    /** Start the per-channel "typing…" loop. Platform-generic: dispatches to
     *  whatever adapter is registered for `platform`; no-op when the adapter
     *  has no sendTyping (CLI, A2A, future ones can opt in by implementing). */
    private startTyping(platform: string, channelId: string, entry: ChannelEntry): void {
        this.stopTyping(entry); // never stack
        const adapter = getDispatcher().getAdapter(platform);
        if (!adapter?.sendTyping) return;
        const fire = () => { void adapter.sendTyping!(channelId).catch(() => {}); };
        fire(); // immediate first ping (otherwise user waits 4s for the indicator)
        entry.typingTimer = setInterval(fire, 4_000);
        entry.typingTimer.unref();
    }

    private stopTyping(entry: ChannelEntry): void {
        if (entry.typingTimer) {
            clearInterval(entry.typingTimer);
            delete entry.typingTimer;
        }
    }

    private async deliverAgentEnd(
        platform: string,
        channelId: string,
        event: { type: "agent_end"; messages: ReadonlyArray<unknown> },
    ): Promise<void> {
        const text = extractAssistantText(event.messages);
        if (!text) {
            logWarning("channelRuntime", "agent_end with no assistant text — nothing to deliver", {
                platform, channelId,
            });
            return;
        }
        try {
            await getDispatcher().send(platform, channelId, { text });
        } catch (e) {
            logError("channelRuntime", "delivery failed", {
                platform, channelId,
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    private sweep(): void {
        const now = Date.now();
        for (const [key, entry] of this.channels.entries()) {
            if (now - entry.lastActivity > IDLE_TTL_MS) {
                void this.dispose(key);
            }
        }
    }

    private async dispose(key: string): Promise<void> {
        const entry = this.channels.get(key);
        if (!entry) return;
        this.channels.delete(key);
        try {
            entry.unsubscribe();
        } catch { /* best effort */ }
        // Pi's AgentSession doesn't expose a disposal method publicly; the
        // session goes out of scope and gets GC'd. The SessionManager keeps
        // its file handle until that happens. Acceptable — channel sessions
        // are cheap to lose and recreate (re-reads JSONL on next inbound).
    }
}

function channelKey(platform: string, channelId: string): string {
    return `${platform}:${channelId}`;
}

/** Format the inbound message into the agent's prompt text. Mirrors the
 *  format the old channelRouter subprocess kickoff used so session JSONL
 *  history stays consistent. */
function formatActiveKickoff(msg: Message): string {
    const sender = msg.senderDisplayName || msg.senderId;
    return `[${msg.platform} inbound | from: ${sender} (${msg.senderId}) | channel: ${msg.channelId}]\n${msg.text}`;
}

/** Pull the assistant's textual reply out of the agent_end event's messages.
 *  Pi's AgentMessage shape has `content: Array<{type: "text", text: string} | …>`
 *  — concat all text content blocks across the assistant messages. */
function extractAssistantText(messages: ReadonlyArray<unknown>): string {
    const parts: string[] = [];
    for (const m of messages) {
        if (!m || typeof m !== "object") continue;
        const msg = m as { role?: string; content?: unknown };
        if (msg.role !== "assistant") continue;
        const content = msg.content;
        if (typeof content === "string") {
            parts.push(content);
            continue;
        }
        if (!Array.isArray(content)) continue;
        for (const c of content) {
            if (!c || typeof c !== "object") continue;
            const block = c as { type?: string; text?: string };
            if (block.type === "text" && typeof block.text === "string") {
                parts.push(block.text);
            }
        }
    }
    return parts.join("\n").trim();
}

void MAX_TURN_TIMEOUT_MS;

export function getChannelRuntime(): ChannelRuntime {
    return getOrCreate("channelRuntime", () => new ChannelRuntime());
}
