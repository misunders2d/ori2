import { getOrCreate } from "./singletons.js";

// =============================================================================
// pendingAttachments — per-channel queue of file paths the LLM has scheduled
// for delivery via the transport adapter.
//
// Shape of the outbound contract (baseline):
//   1. The LLM calls the `attach_file(paths: string[])` tool. That tool
//      resolves the caller's transport origin (currentOrigin) and pushes
//      the paths onto this queue.
//   2. The LLM produces its text reply as usual.
//   3. On `agent_end` for the channel's session, channelRuntime drains the
//      queue, loads the files into MediaPayload[], and hands the response
//      (text + attachments) to dispatcher.send() → adapter.send().
//
// Why a queue (and not inline-in-tool-result): the tool call may happen
// mid-turn (e.g. after a generator tool wrote a file). The file can't be
// sent until the agent finishes the turn — otherwise the user would get
// the attachment BEFORE the accompanying text, out of order.
//
// Single-process scope. No disk persistence. If the process crashes with
// pending attachments, they're lost — same as an in-flight agent turn.
// The files on disk (producers put them under data/<bot>/outgoing/ or
// similar) are preserved; only the "please send these" intent is lost.
// =============================================================================

interface Store {
    // key = `${platform}:${channelId}`
    queues: Map<string, string[]>;
}

function key(platform: string, channelId: string): string {
    return `${platform}:${channelId}`;
}

function store(): Store {
    return getOrCreate<Store>("pendingAttachments", () => ({ queues: new Map() }));
}

/** Queue paths for delivery on the next agent_end for (platform, channelId). */
export function enqueuePending(platform: string, channelId: string, paths: ReadonlyArray<string>): void {
    if (paths.length === 0) return;
    const s = store();
    const k = key(platform, channelId);
    const existing = s.queues.get(k);
    if (existing) existing.push(...paths);
    else s.queues.set(k, [...paths]);
}

/** Return + clear the queue for (platform, channelId). Idempotent on empty. */
export function drainPending(platform: string, channelId: string): string[] {
    const s = store();
    const k = key(platform, channelId);
    const out = s.queues.get(k);
    if (!out) return [];
    s.queues.delete(k);
    return out;
}

/** Non-destructive peek — tests / diagnostics. */
export function peekPending(platform: string, channelId: string): ReadonlyArray<string> {
    return store().queues.get(key(platform, channelId)) ?? [];
}

/** Test-only — clear all queues. */
export function __resetPendingAttachmentsForTests(): void {
    store().queues.clear();
}
