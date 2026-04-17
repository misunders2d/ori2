import type {
    AdapterStatus,
    AgentResponse,
    Message,
    MessageHandler,
    TransportAdapter,
} from "../transport/types.js";

// =============================================================================
// A2A TransportAdapter — bridges async ori2 dispatcher (fire-and-forget +
// agent_end → adapter.send) with the synchronous request/response shape the
// A2A SDK's AgentExecutor expects.
//
// Per inbound A2A message we:
//   1. Build an ori2 Message with channelId = `a2a:<task-id>`
//   2. Register a Promise resolver in `pendingResponses[channelId]`
//   3. dispatcher.dispatch(msg) — this triggers Pi via transport_bridge
//   4. await the Promise — resolves when transport_bridge calls
//      dispatcher.send("a2a", channelId, response), which routes here
//   5. Return the AgentResponse to the AgentExecutor for publishing as a Task
//
// Timeout protection: each pending resolver has a wall-clock deadline. If
// Pi never produces a response (crash, infinite loop, deadlock), we reject
// the Promise so the A2A peer gets a `failed` task instead of hanging
// forever on poll. Default 5min — tune via vault A2A_RESPONSE_TIMEOUT_MS.
// =============================================================================

export const A2A_PLATFORM = "a2a";

interface PendingResponse {
    resolve: (resp: AgentResponse) => void;
    reject: (err: Error) => void;
    timeout: NodeJS.Timeout;
}

export class A2AAdapter implements TransportAdapter {
    readonly platform = A2A_PLATFORM;

    private state: AdapterStatus["state"] = "stopped";
    private connectedAt: number | undefined;
    private lastError: string | undefined;
    private handler: MessageHandler | null = null;
    private pendingResponses = new Map<string, PendingResponse>();
    /** External hook so server.ts can report bound port + base URL via /transports. */
    private boundPort: number | undefined;
    private baseUrl: string | undefined;

    setHandler(handler: MessageHandler): void {
        this.handler = handler;
    }

    async start(): Promise<void> {
        // Server lifecycle is managed by src/a2a/server.ts; the adapter just
        // tracks state for the /transports view. server.ts calls markRunning()
        // once it has a bound port + URL.
        this.state = "starting";
    }

    async stop(): Promise<void> {
        // Reject any in-flight responses so callers don't hang past shutdown.
        for (const [channelId, p] of this.pendingResponses) {
            clearTimeout(p.timeout);
            p.reject(new Error("a2a adapter stopping"));
            this.pendingResponses.delete(channelId);
        }
        this.state = "stopped";
        this.connectedAt = undefined;
    }

    async send(channelId: string, response: AgentResponse): Promise<void> {
        const pending = this.pendingResponses.get(channelId);
        if (!pending) {
            // Late or unmatched response. Could happen if the inbound timed
            // out before Pi finished — log and drop.
            console.warn(`[a2a] dispatcher.send for unknown channelId ${channelId} — dropped`);
            return;
        }
        clearTimeout(pending.timeout);
        this.pendingResponses.delete(channelId);
        pending.resolve(response);
    }

    status(): AdapterStatus {
        const status: AdapterStatus = {
            platform: this.platform,
            state: this.state,
            details: {
                pending_responses: this.pendingResponses.size,
                ...(this.boundPort !== undefined ? { bound_port: this.boundPort } : {}),
                ...(this.baseUrl !== undefined ? { base_url: this.baseUrl } : {}),
            },
        };
        if (this.lastError !== undefined) status.lastError = this.lastError;
        if (this.connectedAt !== undefined) status.connectedAt = this.connectedAt;
        return status;
    }

    // -------------------- bridge methods used by server.ts --------------------

    /**
     * Called by the AgentExecutor when an inbound A2A message arrives. The
     * adapter dispatches it through the dispatcher and returns a Promise that
     * resolves when the agent's response comes back via send().
     */
    dispatchAndWait(msg: Message, timeoutMs: number): Promise<AgentResponse> {
        if (msg.platform !== A2A_PLATFORM) {
            throw new Error(`[a2a] dispatchAndWait expected platform=a2a, got ${msg.platform}`);
        }
        if (!this.handler) {
            throw new Error("[a2a] adapter has no dispatcher handler installed yet");
        }
        return new Promise<AgentResponse>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingResponses.delete(msg.channelId);
                reject(new Error(`a2a response timeout after ${timeoutMs}ms (channelId=${msg.channelId})`));
            }, timeoutMs);
            this.pendingResponses.set(msg.channelId, { resolve, reject, timeout });
            // Fire the inbound — handler is the dispatcher.dispatch wrapper.
            this.handler!(msg).catch((e: unknown) => {
                const pending = this.pendingResponses.get(msg.channelId);
                if (pending) {
                    clearTimeout(pending.timeout);
                    this.pendingResponses.delete(msg.channelId);
                    pending.reject(e instanceof Error ? e : new Error(String(e)));
                }
            });
        });
    }

    /** Called by server.ts once the HTTP server has bound and the URL is known. */
    markRunning(boundPort: number, baseUrl: string | undefined): void {
        this.boundPort = boundPort;
        if (baseUrl !== undefined) this.baseUrl = baseUrl;
        this.state = "running";
        this.connectedAt = Date.now();
        this.lastError = undefined;
    }

    markError(err: string): void {
        this.state = "error";
        this.lastError = err;
    }

    /** Test-only — flush all pending responses and reset state. */
    reset(): void {
        for (const [channelId, p] of this.pendingResponses) {
            clearTimeout(p.timeout);
            p.reject(new Error("adapter reset"));
            this.pendingResponses.delete(channelId);
        }
        this.state = "stopped";
        this.connectedAt = undefined;
        this.lastError = undefined;
        this.boundPort = undefined;
        this.baseUrl = undefined;
        this.handler = null;
    }
}

import { getOrCreate } from "../core/singletons.js";

export function getA2AAdapter(): A2AAdapter {
    return getOrCreate("a2aAdapter", () => new A2AAdapter());
}
