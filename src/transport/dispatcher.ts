import type { AdapterStatus, AgentResponse, Message, TransportAdapter } from "./types.js";
import { getOrCreate, setSingleton } from "../core/singletons.js";

/** Reserved platform name — see CliAdapter for the matching sentinel. */
export const CLI_RESERVED_NAME = "cli";

// =============================================================================
// TransportDispatcher — singleton hub between adapters and the Pi runtime.
//
// Inbound flow (adapter → Pi):
//   adapter.handler(msg)                         — adapter calls this on
//     │                                            receipt
//     └─► dispatcher.dispatch(msg)
//           │
//           ├─► runPreDispatchHooks(msg)        — Sprint 5 inserts whitelist
//           │                                     check; Sprint 8 inserts
//           │                                     channel logger; Sprint 8
//           │                                     inserts rate limiter
//           │     (if any hook returns "block",
//           │      message is dropped here)
//           │
//           └─► pushToPi(msg)                   — wired by transport_bridge
//                                                 extension to call
//                                                 pi.sendUserMessage(...)
//
// Outbound flow (Pi → adapter):
//   transport_bridge extension on agent_end
//     │
//     └─► dispatcher.send(platform, channelId, response)
//           │
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
     * Wire the dispatcher to Pi. Called by the transport_bridge extension on
     * session_start. Drains any messages that arrived before wiring.
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

        // 2. Push to Pi (or buffer until wired).
        if (!this.pushToPi) {
            this.buffer.push(msg);
            if (this.buffer.length === 1) {
                console.log("[transport] message received before Pi runtime wired — buffering");
            }
            return;
        }
        await this.pushToPi(msg);

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
