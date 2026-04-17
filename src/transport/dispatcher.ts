import type { AdapterStatus, AgentResponse, Message, TransportAdapter } from "./types.js";
import { getOrCreate, setSingleton } from "../core/singletons.js";

/** Reserved platform name — see CliAdapter for the matching sentinel. */
export const CLI_RESERVED_NAME = "cli";

// =============================================================================
// TransportDispatcher — singleton hub between adapters and message handlers.
//
// Inbound flow (adapter → handler), branching on msg.addressedToBot + platform:
//   adapter.handler(msg)
//     └─► dispatcher.dispatch(msg)
//           │
//           ├─► runPreDispatchHooks(msg)     — whitelist, rate limit, guardrails.
//           │                                  "block" drops the message here.
//           │
//           ├─ (msg.platform === "cli")    → pushToPi(msg)
//           │                                  CLI inbound always goes to the
//           │                                  live Pi runtime (one AgentSession
//           │                                  owned by the TUI operator).
//           │
//           ├─ (addressedToBot === false)  → onPassiveContext(msg)
//           │                                  Group-chat line not directed at
//           │                                  us — append to the channel's
//           │                                  session as context, no response.
//           │                                  Wired by channelRouter.
//           │
//           └─ (addressedToBot === true)   → onActiveResponse(msg)
//                                              Non-CLI direct inbound — spawn
//                                              a subprocess agent against the
//                                              channel's own session and deliver
//                                              its output. Wired by channelRouter.
//
// Outbound flow (handler → adapter):
//   extension/router
//     └─► dispatcher.send(platform, channelId, response)
//           └─► adapter.send(channelId, response)
//
// CROSS-CUTTING HOOKS — explicitly empty arrays at baseline. Future sprints
// register hooks rather than modify dispatcher internals:
//   - preDispatch: invoked on each inbound msg before pushing to Pi
//   - postDispatch: invoked after successful push (for audit logging)
//
// PUSH-TO-PI WIRING:
//   The dispatcher is created in src/index.ts during bootstrap, BEFORE Pi
//   starts. At that moment there's no live Pi runtime to push to. The
//   transport_bridge extension calls dispatcher.setPushToPi(callback) on
//   session_start, providing a closure that uses pi.sendUserMessage.
//
//   Inbound messages received before push-to-pi is wired are BUFFERED.
//   On wire-up, the buffer is drained in order. Adapter authors don't need
//   to worry about this race.
// =============================================================================

export type PushToPi = (msg: Message) => Promise<void> | void;

/**
 * Handler for passive-context messages — messages that arrive in a multi-user
 * channel but aren't addressed to the bot. Wired by channelRouter to append to
 * the channel's session JSONL as a CustomMessageEntry (appears in LLM context
 * next time the bot IS addressed, but doesn't trigger a turn now).
 */
export type OnPassiveContext = (msg: Message) => Promise<void> | void;

/**
 * Handler for active-response messages on non-CLI platforms — messages that
 * ARE addressed to the bot and need an agent response. Wired by channelRouter
 * to spawn `pi -p --session <channel-session.jsonl>` against the channel's
 * own session and deliver stdout back via dispatcher.send().
 */
export type OnActiveResponse = (msg: Message) => Promise<void> | void;

export type PreDispatchHook = (
    msg: Message,
) => Promise<{ block: true; reason: string } | { block: false } | void> | { block: true; reason: string } | { block: false } | void;

export type PostDispatchHook = (msg: Message) => Promise<void> | void;

/**
 * Fires when a pre-dispatch hook blocks a message. Lets auxiliary modules
 * (audit logger, metrics) observe the block without having to re-implement
 * the block detection in every hook. `reason` is the free-form string the
 * blocking hook returned.
 */
export type PostBlockHook = (msg: Message, reason: string) => Promise<void> | void;

export class TransportDispatcher {
    private adapters = new Map<string, TransportAdapter>();
    private preHooks: PreDispatchHook[] = [];
    private postHooks: PostDispatchHook[] = [];
    private postBlockHooks: PostBlockHook[] = [];
    private pushToPi: PushToPi | null = null;
    private onPassiveContext: OnPassiveContext | null = null;
    private onActiveResponse: OnActiveResponse | null = null;
    private buffer: Message[] = [];

    static instance(): TransportDispatcher {
        // Shared via globalThis so jiti-loaded extensions see the same
        // instance as tsx-loaded main program. See src/core/singletons.ts.
        return getOrCreate("transportDispatcher", () => new TransportDispatcher());
    }

    /** Register an adapter. The dispatcher installs its inbound handler. */
    register(adapter: TransportAdapter): void {
        if (this.adapters.has(adapter.platform)) {
            throw new Error(
                `[transport] adapter for platform "${adapter.platform}" already registered`,
            );
        }

        // SECURITY: reserve "cli" for the bundled CliAdapter only. Any other
        // adapter trying to claim platform="cli" would inherit the
        // implicit-admin status (Whitelist.isAdmin returns true for cli)
        // and bypass all gates. The CliAdapter constructor sets a sentinel;
        // we check the prototype chain rather than an instanceof check (which
        // would create a circular dep at the dispatcher).
        if (adapter.platform === CLI_RESERVED_NAME) {
            const looksLikeCli = (adapter as { __isOriCliAdapter?: boolean }).__isOriCliAdapter === true;
            if (!looksLikeCli) {
                throw new Error(
                    `[transport] platform "${CLI_RESERVED_NAME}" is reserved for the built-in CliAdapter — refusing to register a different adapter under this name`,
                );
            }
        }

        // SECURITY: verify the adapter's hardcoded platform matches the
        // platform field on every Message it dispatches. A buggy or
        // malicious adapter could otherwise spoof the platform field
        // (e.g. set msg.platform = "cli" while its own .platform = "telegram")
        // to inherit implicit-admin status. Refuse such messages loudly.
        adapter.setHandler((msg) => {
            if (msg.platform !== adapter.platform) {
                console.error(
                    `[transport] SECURITY: adapter "${adapter.platform}" attempted to dispatch a message with platform="${msg.platform}" — refusing`,
                );
                return Promise.resolve();
            }
            return this.dispatch(msg);
        });
        this.adapters.set(adapter.platform, adapter);
    }

    /** Look up an adapter by platform. */
    getAdapter(platform: string): TransportAdapter | undefined {
        return this.adapters.get(platform);
    }

    /** All registered adapters. */
    listAdapters(): TransportAdapter[] {
        return Array.from(this.adapters.values());
    }

    /** Aggregate status snapshot for /transports admin command. */
    statusReport(): AdapterStatus[] {
        return this.listAdapters().map((a) => a.status());
    }

    /** Start every registered adapter. Errors are reported per-adapter, not bubbled. */
    async startAll(): Promise<{ started: string[]; failed: { platform: string; error: string }[] }> {
        const started: string[] = [];
        const failed: { platform: string; error: string }[] = [];
        for (const a of this.adapters.values()) {
            try {
                await a.start();
                started.push(a.platform);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                failed.push({ platform: a.platform, error: msg });
            }
        }
        return { started, failed };
    }

    /** Stop every registered adapter. Best-effort — collects errors but doesn't throw. */
    async stopAll(): Promise<void> {
        for (const a of this.adapters.values()) {
            try {
                await a.stop();
            } catch (e) {
                console.error(`[transport] error stopping ${a.platform}:`, e);
            }
        }
    }

    /** Add a hook that runs on every inbound message before it reaches Pi. */
    addPreDispatchHook(hook: PreDispatchHook): void {
        this.preHooks.push(hook);
    }

    /** Add a hook that runs after a message has been pushed to Pi. */
    addPostDispatchHook(hook: PostDispatchHook): void {
        this.postHooks.push(hook);
    }

    /**
     * Add a hook that runs when an inbound message is blocked by a pre-dispatch
     * hook. Useful for audit logging of blocked traffic (whitelist-miss,
     * rate-limit, guardrail trip, etc.) at a single observation point instead
     * of teaching every blocking hook about the logger.
     */
    addPostBlockHook(hook: PostBlockHook): void {
        this.postBlockHooks.push(hook);
    }

    /**
     * Wire the dispatcher to the live Pi runtime. Called by transport_bridge
     * extension on session_start. Only invoked for CLI inbound (the TUI
     * operator's conversation). Non-CLI messages never reach the live runtime
     * — they go through onPassiveContext / onActiveResponse instead.
     *
     * Drains any CLI messages that arrived before wiring.
     */
    setPushToPi(push: PushToPi): void {
        this.pushToPi = push;
        if (this.buffer.length > 0) {
            const drain = this.buffer;
            this.buffer = [];
            // Fire-and-forget — drains in order but doesn't block setPushToPi.
            void (async () => {
                for (const msg of drain) {
                    try {
                        await push(msg);
                    } catch (e) {
                        console.error(`[transport] failed to drain buffered msg:`, e);
                    }
                }
            })();
        }
    }

    /**
     * Wire the passive-context handler. Called by channelRouter during boot.
     * Subsequent (addressedToBot === false) inbound messages on non-CLI
     * platforms invoke this instead of pushToPi.
     */
    setOnPassiveContext(fn: OnPassiveContext): void {
        this.onPassiveContext = fn;
    }

    /**
     * Wire the active-response handler. Called by channelRouter during boot.
     * Subsequent (addressedToBot === true && platform !== "cli") inbound
     * messages invoke this instead of pushToPi.
     */
    setOnActiveResponse(fn: OnActiveResponse): void {
        this.onActiveResponse = fn;
    }

    /** Inbound entry point — adapters call this on receipt (via the registered handler). */
    async dispatch(msg: Message): Promise<void> {
        // 1. Cross-cutting pre-hooks (whitelist, rate limit, etc.).
        for (const hook of this.preHooks) {
            const result = await hook(msg);
            if (result && "block" in result && result.block) {
                console.log(`[transport] msg blocked by hook: ${result.reason}`);
                // Tell the adapter to surface the block to the user.
                const adapter = this.adapters.get(msg.platform);
                if (adapter) {
                    try {
                        await adapter.send(msg.channelId, { text: `🚫 ${result.reason}` });
                    } catch { /* best effort */ }
                }
                // Fire post-block hooks so observers (audit log) see the block.
                // Exceptions in observers must not mask the original block.
                for (const postBlock of this.postBlockHooks) {
                    try {
                        await postBlock(msg, result.reason);
                    } catch (e) {
                        console.error(`[transport] post-block hook failed:`, e);
                    }
                }
                return;
            }
        }

        // 2. Route based on platform + addressedToBot.
        //
        //    - CLI: always push to the live Pi runtime (operator's TUI).
        //    - Non-CLI, addressedToBot=false: passive context ingest.
        //    - Non-CLI, addressedToBot=true:  active subprocess response.
        //
        //    If a handler isn't wired yet (boot race), buffer CLI messages
        //    (preserves prior behavior) and drop non-CLI ones with a log —
        //    non-CLI inbound rarely arrives before channelRouter boots, but
        //    when it does we'd rather lose one message than invisibly stash
        //    unbounded buffers keyed on handler types that may never be
        //    wired in this process (e.g. scheduler subprocesses).
        if (msg.platform === "cli") {
            if (!this.pushToPi) {
                this.buffer.push(msg);
                if (this.buffer.length === 1) {
                    console.log("[transport] CLI message received before Pi runtime wired — buffering");
                }
                return;
            }
            await this.pushToPi(msg);
        } else if (msg.addressedToBot) {
            if (!this.onActiveResponse) {
                console.warn(`[transport] active response for ${msg.platform}:${msg.channelId} dropped — onActiveResponse not wired`);
                return;
            }
            await this.onActiveResponse(msg);
        } else {
            if (!this.onPassiveContext) {
                console.warn(`[transport] passive context for ${msg.platform}:${msg.channelId} dropped — onPassiveContext not wired`);
                return;
            }
            await this.onPassiveContext(msg);
        }

        // 3. Post-hooks (audit log, metrics).
        for (const hook of this.postHooks) {
            try {
                await hook(msg);
            } catch (e) {
                console.error(`[transport] post-dispatch hook failed:`, e);
            }
        }
    }

    /** Outbound entry point — extensions call this to send a response via the adapter. */
    async send(platform: string, channelId: string, response: AgentResponse): Promise<void> {
        const adapter = this.adapters.get(platform);
        if (!adapter) {
            throw new Error(
                `[transport] cannot send: no adapter registered for platform "${platform}"`,
            );
        }
        await adapter.send(channelId, response);
    }

    /** Reset internal state. Tests only. */
    static __resetForTests(): void {
        setSingleton("transportDispatcher", null);
    }
}

/** Convenience accessor matching the project's `getX()` style. */
export function getDispatcher(): TransportDispatcher {
    return TransportDispatcher.instance();
}
