import { randomUUID } from "node:crypto";
import type { AgentExecutor, ExecutionEventBus, RequestContext } from "@a2a-js/sdk/server";
import type { Message } from "../transport/types.js";
import { A2A_PLATFORM, type A2AAdapter } from "./adapter.js";

// =============================================================================
// A2A AgentExecutor — bridges a single A2A request through ori2's dispatcher
// hook chain (whitelist, guardrails, admin gate, plan_enforcer, etc.) and
// publishes the agent's response as a Task event the SDK forwards to peers.
//
// On execute():
//   1. Extract text + reference task / context IDs from the SDK's RequestContext
//   2. Build an ori2 Message{platform:"a2a", channelId:`a2a:<task-id>`,
//      senderId:`a2a:<friend-name>`} — the friend name comes from the auth
//      middleware via the ServerCallContext.user (set in our UserBuilder).
//   3. Publish an initial Task in `working` state so polling peers see status.
//   4. Await dispatcher response via A2AAdapter.dispatchAndWait.
//   5. Publish the response as a Task with `completed` status + artifact.
//   6. eventBus.finished() — tells the SDK the task is done streaming events.
//
// Errors (timeout, dispatcher rejection, missing handler) become `failed`
// status events with the error message in the status.message field, so the
// peer sees a structured failure rather than an HTTP 500.
// =============================================================================

const RESPONSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes; configurable later via vault A2A_RESPONSE_TIMEOUT_MS

export class A2AAgentExecutor implements AgentExecutor {
    constructor(private readonly adapter: A2AAdapter) {}

    async execute(ctx: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
        const taskId = ctx.taskId;
        const contextId = ctx.contextId;
        const friendName = extractFriendName(ctx);

        const inboundText = extractText(ctx.userMessage);
        if (!inboundText.trim()) {
            this.publishFailed(eventBus, taskId, contextId, "empty inbound message");
            eventBus.finished();
            return;
        }

        // Tell the peer we've accepted the task and are working on it.
        eventBus.publish({
            kind: "task",
            id: taskId,
            contextId,
            status: { state: "working", timestamp: new Date().toISOString() },
        });

        const oriMsg: Message = {
            platform: A2A_PLATFORM,
            channelId: `a2a:${taskId}`,
            senderId: `a2a:${friendName}`,
            senderDisplayName: friendName,
            timestamp: Date.now(),
            text: inboundText,
        };

        try {
            const response = await this.adapter.dispatchAndWait(oriMsg, RESPONSE_TIMEOUT_MS);
            eventBus.publish({
                kind: "task",
                id: taskId,
                contextId,
                status: { state: "completed", timestamp: new Date().toISOString() },
                artifacts: [
                    {
                        artifactId: randomUUID(),
                        name: "response",
                        parts: [{ kind: "text", text: response.text ?? "" }],
                    },
                ],
            });
        } catch (e) {
            this.publishFailed(eventBus, taskId, contextId, e instanceof Error ? e.message : String(e));
        } finally {
            eventBus.finished();
        }
    }

    async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
        // Best-effort: we can't actually interrupt Pi mid-run yet. If the
        // adapter still has a pending resolver for this task, reject it so
        // any awaiter unwinds. Then publish a `canceled` status so polling
        // peers see the terminal state.
        const channelId = `a2a:${taskId}`;
        // Use the adapter's send() with an empty response to clear the pending
        // entry — but the executor's await will resolve, not reject, so it'd
        // emit a misleading completed event. Better: directly poke the
        // adapter's reset of just that channel via a public method. The
        // adapter doesn't expose that today; for now, just emit the canceled
        // status. Pi's actual run will continue but its eventual response
        // gets dropped (warned in adapter.send).
        eventBus.publish({
            kind: "task",
            id: taskId,
            contextId: channelId,
            status: { state: "canceled", timestamp: new Date().toISOString() },
        });
        eventBus.finished();
    }

    private publishFailed(
        eventBus: ExecutionEventBus,
        taskId: string,
        contextId: string,
        reason: string,
    ): void {
        eventBus.publish({
            kind: "task",
            id: taskId,
            contextId,
            status: {
                state: "failed",
                timestamp: new Date().toISOString(),
                message: {
                    kind: "message",
                    messageId: randomUUID(),
                    role: "agent",
                    parts: [{ kind: "text", text: reason }],
                },
            },
        });
    }
}

/**
 * Pull a plain text body out of an SDK Message. A2A messages are part-based;
 * we concatenate all `text` parts. Non-text parts (files, etc.) are ignored
 * for now — Phase 1 is text-only, matching the agent card's
 * defaultInputModes=["text/plain"].
 */
function extractText(msg: { parts: Array<{ kind: string; text?: string }> }): string {
    if (!msg?.parts || !Array.isArray(msg.parts)) return "";
    const texts: string[] = [];
    for (const p of msg.parts) {
        if (p.kind === "text" && typeof p.text === "string") texts.push(p.text);
    }
    return texts.join("\n").trim();
}

/**
 * Pull the authenticated friend name out of the request context. Our auth
 * middleware (server.ts) attaches it via `(req as any).a2aFriend` and the
 * UserBuilder threads it into the SDK's ServerCallContext.user.
 */
function extractFriendName(ctx: RequestContext): string {
    const ctxUser = ctx.context as unknown as { user?: { name?: string } } | undefined;
    return ctxUser?.user?.name ?? "unknown";
}
