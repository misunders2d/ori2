import {
    SessionManager,
    createAgentSessionFromServices,
    createAgentSessionServices,
    type AgentSession,
    type AgentSessionServices,
} from "@mariozechner/pi-coding-agent";
import type { ImageContent, Model } from "@mariozechner/pi-ai";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { getChannelSessions } from "../core/channelSessions.js";
import { getChannelModels, type ChannelModelBinding } from "../core/channelModels.js";
import { getDispatcher } from "./dispatcher.js";
import { logError, logInfo, logWarning } from "../core/errorLog.js";
import { getOrCreate } from "../core/singletons.js";
import type { Message } from "./types.js";
import { formatInboundHeader } from "./inboundHeader.js";

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

export interface ChannelEntry {
    session: AgentSession;
    sessionFile: string;
    lastActivity: number;
    /** Unsubscribe handle returned by session.subscribe(...) */
    unsubscribe: () => void;
    /** Active typing-indicator interval. One per channel max — restarted on
     *  agent_start, cleared on agent_end. Platform-generic — fires
     *  adapter.sendTyping?() if the adapter implements it; no-op otherwise. */
    typingTimer?: NodeJS.Timeout;
    /** The model this session fell back to when no channel binding was set.
     *  Captured at session-create time before any binding is applied. Used to
     *  revert when a binding is later cleared — without it we'd be stuck on
     *  whatever override was last applied. */
    defaultModel?: Model<any>;
    /** Thread id of the last inbound message for this channel. Carried across
     *  the async gap between prompt() and agent_end so the reply can be
     *  routed back as a reply-to / thread-reply on platforms that support it
     *  (Telegram topic threads, Slack threads, etc.). */
    lastThreadId?: string;
}

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
        // Remember the thread so deliverAgentEnd can reply-to it on
        // platforms that thread (Telegram topics, Slack thread_ts, etc.).
        if (msg.threadId !== undefined) {
            entry.lastThreadId = msg.threadId;
        } else {
            delete entry.lastThreadId;
        }

        // Seed a transport-origin custom entry on the channel session BEFORE
        // prompt() so tools that call currentOrigin(ctx.sessionManager)
        // (admin_gate.tool_call, agent_introspection.resolveTargetAndAdmin,
        // memory_save, schedule_reminder, ...) learn who's actually driving
        // this turn. Without this, identity.ts walks the branch, finds no
        // matching entries, returns null, and callers fall back to
        // inferOriginFromCli() — i.e. the CLI OS user, who is implicit
        // admin. That silently upgrades every chat user to admin for
        // tool_call ACL checks and breaks admin-only tools from chat
        // (resolveTargetAndAdmin throws "cannot identify caller").
        //
        // The old subprocess-per-turn router seeded this before spawn
        // (src/transport/channelRouter.ts@f69bb81^:406). The in-process
        // refactor dropped it.
        seedTransportOrigin(entry.session, msg);

        // Hot-swap the model if the channel's binding changed since the last
        // turn (or since session creation). Must happen BEFORE prompt() — Pi's
        // setModel updates agent state and session JSONL synchronously, so
        // the next turn runs on the new model. Without this, set_channel_model
        // would only take effect the next time the channel session is
        // recreated (15-min idle eviction), which the user correctly flagged
        // as broken "on-the-fly" model switching.
        await this.applyChannelModelBinding(entry, msg.platform, msg.channelId);

        // Build prompt (text + images) from the inbound Message. Attachments
        // that the current model CAN'T ingest natively (binaries; images
        // against a text-only model) get demoted to textual references so
        // the LLM knows they exist without the API rejecting the payload.
        // This is what kept the conversation moving when someone drops a
        // pptx into Telegram: we describe it instead of uploading it.
        const { text, images } = buildPromptFromMessage(msg, entry.session.model);

        // Diagnostic: when users report "the bot doesn't see my image",
        // the first question is always "did the attachment even arrive?".
        // Log a single-line summary per inbound so the operator can grep
        // errors.jsonl / stdout for attachment flow without enabling a
        // verbose mode. No payload bytes — just kind counts.
        if (msg.attachments && msg.attachments.length > 0) {
            const kinds = msg.attachments.reduce<Record<string, number>>((acc, a) => {
                acc[a.kind] = (acc[a.kind] ?? 0) + 1;
                return acc;
            }, {});
            const modelAcceptsImages = !!entry.session.model
                && Array.isArray(entry.session.model.input)
                && entry.session.model.input.includes("image");
            logInfo("channelRuntime", "inbound attachments", {
                platform: msg.platform,
                channelId: msg.channelId,
                kinds,
                modelAcceptsImages,
                imagesForwarded: images.length,
                modelId: entry.session.model?.id,
            });
        }

        // Pi's `prompt(text)` runs ONE agent turn. If a turn is already
        // running for this channel, we use Pi's queue: enqueue the new
        // input as a follow-up so it joins after the current turn settles.
        // This mirrors the prior subprocess model's "interrupt-replace"
        // semantics — but BETTER, because the user's prior message gets
        // its reply instead of being dropped on abort.
        try {
            await entry.session.prompt(text, {
                streamingBehavior: "followUp",
                ...(images.length > 0 ? { images } : {}),
            });
        } catch (e) {
            const err = e instanceof Error ? e.message : String(e);
            logError("channelRuntime", "session.prompt threw — surfacing failure to user", {
                platform: msg.platform,
                channelId: msg.channelId,
                key,
                err,
            });
            // Pi's prompt throws on transport/API errors (provider rate-limit,
            // network, model-rejected payload, etc). The session state is
            // left idle — subsequent prompts work — so we just tell the user
            // what happened and invite them to try again. Do NOT recreate
            // the session here; we'd lose conversation history for what's
            // likely a transient failure.
            await this.safeSend(msg.platform, msg.channelId, entry.lastThreadId, {
                text: userFacingError(err),
            });
        }
    }

    /**
     * Thin wrapper around dispatcher.send that never throws — delivery
     * failures log + move on. All outbound paths (agent_end reply,
     * prompt-error warning, agent_end error warning) go through this.
     */
    private async safeSend(
        platform: string,
        channelId: string,
        threadId: string | undefined,
        response: { text: string },
    ): Promise<void> {
        try {
            await getDispatcher().send(platform, channelId, {
                text: response.text,
                ...(threadId ? { replyToMessageId: threadId } : {}),
            });
        } catch (e) {
            logError("channelRuntime", "delivery failed", {
                platform,
                channelId,
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    /**
     * Test/internal: list active channel keys for assertions / /channels command.
     */
    listKeys(): string[] {
        return Array.from(this.channels.keys()).sort();
    }

    /**
     * Hard-abort any in-flight turn for this channel. Returns true if an
     * abort was actually issued (there was something to abort), false if
     * the channel was idle or absent. Used by the /stop | /cancel | /abort
     * pre-dispatch hook so a user can kill a runaway turn without waiting
     * for it to settle through the followUp queue. Matches the old ori
     * Python behavior (telegram_poller.py:731-756 — referenced in
     * channelRouter.ts@f69bb81^:72-91) which killed the prior subprocess
     * whenever new input arrived; we make it opt-in so a chatty user
     * doesn't accidentally drop their own reply.
     *
     * Never throws — abort failures log and return false. Caller decides
     * the user-facing message.
     */
    async abort(platform: string, channelId: string): Promise<boolean> {
        const entry = this.channels.get(channelKey(platform, channelId));
        if (!entry) return false;
        if (!entry.session.isStreaming) return false;
        try {
            await entry.session.abort();
            this.stopTyping(entry);
            return true;
        } catch (e) {
            logError("channelRuntime", "session.abort threw", {
                platform,
                channelId,
                err: e instanceof Error ? e.message : String(e),
            });
            return false;
        }
    }

    /** Test-only — clear in-memory state. Caller must call stop() first. */
    reset(): void {
        this.channels.clear();
        this.services = null;
        this.servicesPromise = null;
    }

    /**
     * Test-only: inject a pre-built ChannelEntry so tests can drive
     * handleActiveInbound without touching Pi's real AgentSession factory.
     * The test provides a minimal AgentSession stub and asserts what
     * handleActiveInbound calls on it (session.prompt with images etc).
     */
    __injectChannelEntryForTests(platform: string, channelId: string, entry: ChannelEntry): void {
        this.channels.set(channelKey(platform, channelId), entry);
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

        // If the channel has a model binding, resolve it BEFORE session
        // creation so turn 1 runs on the right model. If the binding resolves
        // (model exists + auth configured), pass it to createAgentSession so
        // the session boots on it; otherwise we fall back to the default and
        // applyChannelModelBinding() on the next inbound will retry.
        const initialBinding = resolveBinding(services, platform, channelId);

        // Per-channel AgentSession. Shares services with all other channels +
        // the parent (TUI / daemon) — extension code, model registry, settings,
        // and resource loader are reused.
        const result = await createAgentSessionFromServices({
            services,
            sessionManager: sm,
            ...(initialBinding?.model ? { model: initialBinding.model } : {}),
            ...(initialBinding?.thinkingLevel ? { thinkingLevel: initialBinding.thinkingLevel } : {}),
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
            sessionFile,
            lastActivity: Date.now(),
            // When we seeded the session with a binding, the "default" is the
            // model Pi would have chosen in the absence of any override —
            // i.e. not what session.model currently is. We don't have easy
            // access to that, so only capture defaultModel when we booted
            // WITHOUT a binding. Clearing a binding set before first inbound
            // won't auto-revert; that's an acceptable edge.
            ...(!initialBinding && session.model ? { defaultModel: session.model } : {}),
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

    /**
     * Reconcile the live session's model with the channel's model binding.
     * Called on every inbound before prompt(). Handles three cases:
     *   - binding exists and matches session.model → no-op
     *   - binding exists and differs → setModel + setThinkingLevel
     *   - binding absent but session was overridden → revert to defaultModel
     *
     * Failures (unknown model, no auth, setModel throws) are logged and
     * dropped — the turn still runs on whatever model the session had.
     * Better to answer on the "wrong" model than refuse the user outright.
     */
    private async applyChannelModelBinding(
        entry: ChannelEntry,
        platform: string,
        channelId: string,
    ): Promise<void> {
        const services = this.services;
        if (!services) return;

        const resolved = resolveBinding(services, platform, channelId);

        // Pick the target. No binding + defaultModel captured → revert.
        // No binding + no defaultModel → nothing to do (session was born with
        // the binding already applied; clearing it mid-life can't recover the
        // original default without a full session restart).
        let targetModel: Model<any> | undefined;
        let targetThinking: ThinkingLevel | undefined;
        if (resolved?.model) {
            targetModel = resolved.model;
            targetThinking = resolved.thinkingLevel;
        } else if (!resolved && entry.defaultModel) {
            targetModel = entry.defaultModel;
        }
        if (!targetModel) return;

        const current = entry.session.model;
        const needsModel = !current
            || current.provider !== targetModel.provider
            || current.id !== targetModel.id;
        if (needsModel) {
            try {
                await entry.session.setModel(targetModel);
            } catch (e) {
                logError("channelRuntime", "setModel failed — staying on current model", {
                    platform,
                    channelId,
                    targetProvider: targetModel.provider,
                    targetModelId: targetModel.id,
                    err: e instanceof Error ? e.message : String(e),
                });
                return;
            }
        }
        if (targetThinking !== undefined) {
            try {
                entry.session.setThinkingLevel(targetThinking);
            } catch (e) {
                logWarning("channelRuntime", "setThinkingLevel failed", {
                    platform,
                    channelId,
                    level: targetThinking,
                    err: e instanceof Error ? e.message : String(e),
                });
            }
        }
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
        const entry = this.channels.get(channelKey(platform, channelId));
        const threadId = entry?.lastThreadId;

        // Inspect the turn's final assistant message for an error stop reason.
        // Pi sets stopReason="error" (or "aborted") with an optional
        // errorMessage when the provider/API rejected the payload mid-turn
        // (unsupported media type, content filter, quota, transient 5xx).
        // prompt() doesn't throw in that case — the turn settles with an
        // error-carrying message. Surface it to the user so they know the
        // turn failed and can retry; the session itself is fine.
        const errorInfo = extractAssistantError(event.messages);
        const text = extractAssistantText(event.messages);

        if (text) {
            await this.safeSend(platform, channelId, threadId, { text });
            return;
        }
        if (errorInfo) {
            await this.safeSend(platform, channelId, threadId, {
                text: userFacingError(errorInfo, { reason: errorInfo.reason }),
            });
            return;
        }
        // No text, no error — silent turn. Shouldn't normally happen; log
        // for operator visibility but don't bother the user.
        logWarning("channelRuntime", "agent_end with no assistant text and no error — nothing to deliver", {
            platform, channelId,
        });
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

/**
 * Load the channel's ChannelModelBinding and resolve it against the live
 * ModelRegistry. Returns undefined when no binding is set. Returns
 * `{ model: undefined }` when a binding exists but is unusable (unknown
 * model, missing auth) — callers treat that as "ignore" rather than
 * "no binding" so a misconfigured binding doesn't auto-revert.
 */
function resolveBinding(
    services: AgentSessionServices,
    platform: string,
    channelId: string,
): { binding: ChannelModelBinding; model: Model<any> | undefined; thinkingLevel: ThinkingLevel | undefined } | undefined {
    const binding = getChannelModels().get(platform, channelId);
    if (!binding) return undefined;
    const model = services.modelRegistry.find(binding.provider, binding.modelId);
    if (!model) {
        logWarning("channelRuntime", "channel model binding references unknown model — ignoring", {
            platform,
            channelId,
            provider: binding.provider,
            modelId: binding.modelId,
        });
        return { binding, model: undefined, thinkingLevel: undefined };
    }
    if (!services.modelRegistry.hasConfiguredAuth(model)) {
        logWarning("channelRuntime", "channel model binding has no configured auth — ignoring", {
            platform,
            channelId,
            provider: binding.provider,
            modelId: binding.modelId,
        });
        return { binding, model: undefined, thinkingLevel: undefined };
    }
    const thinkingLevel = binding.thinkingLevel as ThinkingLevel | undefined;
    return { binding, model, thinkingLevel };
}

/**
 * Append a `transport-origin` custom entry to the channel session so
 * currentOrigin(sm) can return the actual inbound speaker for this turn.
 * Best-effort: failures are logged and swallowed so a corrupted session
 * file doesn't block an answer. (Old router had the same best-effort
 * policy — see src/transport/channelRouter.ts@f69bb81^:397-421.)
 */
function seedTransportOrigin(session: AgentSession, msg: Message): void {
    try {
        session.sessionManager.appendCustomEntry("transport-origin", {
            platform: msg.platform,
            channelId: msg.channelId,
            ...(msg.threadId !== undefined ? { threadId: msg.threadId } : {}),
            senderId: msg.senderId,
            senderDisplayName: msg.senderDisplayName,
            timestamp: msg.timestamp,
        });
    } catch (e) {
        logWarning("channelRuntime", "transport-origin seed failed — proceeding without it", {
            platform: msg.platform,
            channelId: msg.channelId,
            senderId: msg.senderId,
            err: e instanceof Error ? e.message : String(e),
        });
    }
}

/** Header + newline pair that prefixes the prompt body. Uses the shared
 *  inboundHeader helper so admin_gate's stripInboundHeader can reliably
 *  peel it off before matching user-typed commands like /init or
 *  `Approve ACT-XYZ`. The `\n\n` separator is load-bearing — don't change
 *  it without updating src/transport/inboundHeader.ts in lockstep. */
function formatActiveKickoff(msg: Message): string {
    return `${formatInboundHeader(msg)}\n\n${msg.text}`;
}

/**
 * Build what we send to Pi's prompt(): the text body (kickoff header +
 * message text + textual attachment summaries) and the image array for
 * vision-capable models. Non-ingestible attachments (binaries, images
 * against a text-only model) become text references so the LLM at least
 * knows they exist — critical for "I sent you a pptx" style messages
 * where the model would otherwise have no idea anything was attached.
 *
 * The old subprocess router did a similar thing pre-spawn (kickoff text
 * only, no images — images were just referenced). Passing vision
 * content as real ImageContent is a capability gain over the old path.
 */
// Exported for tests. Production code calls via handleActiveInbound only.
export function buildPromptFromMessage(
    msg: Message,
    model: Model<any> | undefined,
): { text: string; images: ImageContent[] } {
    const modelAcceptsImages = !!model && Array.isArray(model.input) && model.input.includes("image");

    const lines: string[] = [formatActiveKickoff(msg)];
    const images: ImageContent[] = [];

    const atts = msg.attachments ?? [];
    if (atts.length > 0) {
        lines.push("", "[Attachments]");
        for (const a of atts) {
            if (a.kind === "text") {
                // Adapter already extracted the text (PDFs, CSVs, .txt etc.).
                // Inline it so the LLM can read it as plain context.
                lines.push(`--- ${a.filename ?? a.mimeType} (${a.sourceBytes ?? "?"} bytes) ---`);
                lines.push(a.text);
                lines.push("---");
            } else if (a.kind === "image") {
                if (modelAcceptsImages) {
                    images.push({ type: "image", mimeType: a.mimeType, data: a.data });
                    lines.push(`[Image: ${a.filename ?? a.mimeType} — sent to the vision model]`);
                } else {
                    // Current model is text-only. Describe rather than send
                    // so the provider doesn't reject the call; the LLM can
                    // still acknowledge the image or ask the user to
                    // switch channel model.
                    lines.push(`[Image attachment: ${a.filename ?? a.mimeType} — current model has no vision; ask the user to switch channel model if needed]`);
                }
            } else {
                // Binary — pptx, xlsx, zip, etc. Path reference only; the
                // agent can choose to invoke a tool (e.g. bash unzip) to
                // process it, but Pi's prompt() won't try to upload it.
                lines.push(`[Binary attachment: ${a.filename ?? a.mimeType} (${a.sizeBytes} bytes) at ${a.localPath}]`);
            }
        }
    }
    return { text: lines.join("\n"), images };
}

/**
 * If the final assistant message settled with stopReason="error" or
 * "aborted", extract its errorMessage + reason so we can surface it to
 * the user. Pi doesn't throw from prompt() in this case — it just lands
 * an error-marked AssistantMessage in the turn. Without this, the user
 * saw nothing when the provider rejected their payload.
 */
interface AssistantErrorInfo { reason: "error" | "aborted"; errorMessage?: string }
function extractAssistantError(messages: ReadonlyArray<unknown>): AssistantErrorInfo | null {
    // Inspect from the end — the ERROR-causing message is the last one in
    // the turn on Pi's model (partial earlier messages are legit output).
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m || typeof m !== "object") continue;
        const am = m as { role?: string; stopReason?: string; errorMessage?: string };
        if (am.role !== "assistant") continue;
        if (am.stopReason === "error" || am.stopReason === "aborted") {
            return {
                reason: am.stopReason,
                ...(typeof am.errorMessage === "string" && am.errorMessage.length > 0 ? { errorMessage: am.errorMessage } : {}),
            };
        }
        return null; // most recent assistant message is fine — no error
    }
    return null;
}

/**
 * Turn an error (from a prompt() throw OR an agent_end error-stopped
 * message) into a one-liner the user sees in chat. Keep the surface
 * small: "something went wrong, try again" + the raw reason truncated.
 * The point is the user can keep talking — not a full stack trace.
 */
function userFacingError(
    err: string | AssistantErrorInfo,
    opts: { reason?: "error" | "aborted" } = {},
): string {
    if (typeof err === "string") {
        const short = err.length > 200 ? err.slice(0, 200) + "…" : err;
        return `⚠️ I hit an error processing that: ${short}\n\nYou can just try again — the conversation is still alive. Operator can check errors.jsonl.`;
    }
    const label = opts.reason === "aborted" ? "The turn was aborted" : "The model call failed";
    const detail = err.errorMessage ? `: ${err.errorMessage.slice(0, 200)}` : "";
    return `⚠️ ${label}${detail}.\n\nYou can just try again — the conversation is still alive.`;
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
