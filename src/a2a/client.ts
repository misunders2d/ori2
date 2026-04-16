import { randomUUID } from "node:crypto";
import { A2AClient } from "@a2a-js/sdk/client";
import type { Message, Task } from "@a2a-js/sdk";
import { getFriends, type Friends } from "./friends.js";
import type { AgentCard } from "./types.js";

// =============================================================================
// Outbound A2A client wrapper.
//
// Two surfaces:
//   - `callFriend(name, message)` — looks up friend by name + outbound key,
//     sends message, polls task to terminal state, extracts response text.
//   - `callAgent(url, message, apiKey)` — same pattern but for an unregistered
//     peer (testing, transient calls). Caller supplies the URL + auth key.
//   - `discoverAgentCard(url)` — bare GET on /.well-known/agent.json. Used by
//     add_friend to learn the peer's identity + skills before storing.
//
// Polling: max 60 attempts at 1.5s = 90s default ceiling. Tunable via
// `pollIntervalMs` and `pollMaxAttempts`. If you need long-running tasks,
// move them onto streaming (Phase 1.x — currently disabled in our agent card).
// =============================================================================

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_MAX_ATTEMPTS = 60;
const TERMINAL_TASK_STATES = new Set(["completed", "canceled", "failed", "rejected"]);

export interface CallResult {
    /** Aggregated text from all response artifacts. Empty string if no text artifacts. */
    text: string;
    /** Final task object (for callers that want raw artifacts/metadata). */
    task: Task;
}

export interface CallOptions {
    pollIntervalMs?: number;
    pollMaxAttempts?: number;
    /** Override for testing — defaults to global fetch. */
    fetchImpl?: typeof fetch;
}

/** GET <url>/.well-known/agent.json and parse. Throws on network error or invalid card. */
export async function discoverAgentCard(
    baseUrl: string,
    fetchImpl: typeof fetch = fetch,
): Promise<AgentCard> {
    const trimmed = baseUrl.replace(/\/+$/, "");
    const cardUrl = `${trimmed}/.well-known/agent.json`;
    const res = await fetchImpl(cardUrl, { method: "GET" });
    if (!res.ok) {
        throw new Error(`agent card discovery failed at ${cardUrl}: HTTP ${res.status}`);
    }
    const body = (await res.json()) as Partial<AgentCard>;
    if (typeof body?.name !== "string" || typeof body?.url !== "string") {
        throw new Error(`agent card discovery at ${cardUrl}: missing required fields (name/url)`);
    }
    return body as AgentCard;
}

/** Build an authenticated fetch that injects x-a2a-api-key on every request. */
function authedFetch(apiKey: string, base: typeof fetch = fetch): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        headers.set("x-a2a-api-key", apiKey);
        return base(input, { ...init, headers });
    }) as typeof fetch;
}

/** Send a text message to a peer URL using the supplied bearer key. */
export async function callAgent(
    baseUrl: string,
    text: string,
    apiKey: string,
    opts: CallOptions = {},
): Promise<CallResult> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const trimmed = baseUrl.replace(/\/+$/, "");
    const cardUrl = `${trimmed}/.well-known/agent.json`;
    const client = await A2AClient.fromCardUrl(cardUrl, {
        fetchImpl: authedFetch(apiKey, fetchImpl),
    });
    const messageId = randomUUID();
    const sendResp = await client.sendMessage({
        message: {
            kind: "message",
            messageId,
            role: "user",
            parts: [{ kind: "text", text }],
        },
    });
    if ("error" in sendResp && sendResp.error) {
        throw new Error(`peer rejected message: ${JSON.stringify(sendResp.error)}`);
    }
    const result = (sendResp as { result?: Task | Message }).result;
    if (!result) {
        throw new Error("peer returned no result");
    }
    if (result.kind === "message") {
        // Direct message reply (Phase 1 doesn't expect this from ori2 peers,
        // but other A2A-spec agents may answer this way).
        return { text: extractText(result), task: synthTaskFromMessage(result) };
    }
    // Task path — poll until terminal.
    let task: Task = result;
    const interval = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const maxAttempts = opts.pollMaxAttempts ?? DEFAULT_POLL_MAX_ATTEMPTS;
    for (let i = 0; i < maxAttempts; i++) {
        if (TERMINAL_TASK_STATES.has(task.status.state)) break;
        await new Promise((r) => setTimeout(r, interval));
        const getResp = await client.getTask({ id: task.id });
        if ("error" in getResp && getResp.error) {
            throw new Error(`getTask failed: ${JSON.stringify(getResp.error)}`);
        }
        const fresh = (getResp as { result?: Task }).result;
        if (!fresh) throw new Error("getTask returned no result");
        task = fresh;
    }
    if (!TERMINAL_TASK_STATES.has(task.status.state)) {
        throw new Error(
            `task ${task.id} did not reach terminal state within ${maxAttempts} polls (still: ${task.status.state})`,
        );
    }
    if (task.status.state !== "completed") {
        const reason = task.status.message
            ? extractText(task.status.message)
            : `terminal state: ${task.status.state}`;
        throw new Error(`task failed: ${reason}`);
    }
    return { text: extractTaskText(task), task };
}

/** Send a text message to a registered friend. */
export async function callFriend(
    friendName: string,
    text: string,
    opts: CallOptions = {},
    friends: Friends = getFriends(),
): Promise<CallResult> {
    const friend = friends.get(friendName);
    if (!friend) throw new Error(`unknown friend: ${friendName}`);
    const key = friends.getOutboundKey(friendName);
    if (!key) {
        throw new Error(
            `friend ${friendName} has no outbound key — invitation not yet completed (run /a2a invite again, or set manually)`,
        );
    }
    return await callAgent(friend.base_url, text, key, opts);
}

/** Cancel a running task on a friend. Returns the final task. */
export async function cancelFriendTask(
    friendName: string,
    taskId: string,
    fetchImpl: typeof fetch = fetch,
    friends: Friends = getFriends(),
): Promise<Task> {
    const friend = friends.get(friendName);
    if (!friend) throw new Error(`unknown friend: ${friendName}`);
    const key = friends.getOutboundKey(friendName);
    if (!key) throw new Error(`friend ${friendName} has no outbound key`);
    const cardUrl = `${friend.base_url.replace(/\/+$/, "")}/.well-known/agent.json`;
    const client = await A2AClient.fromCardUrl(cardUrl, { fetchImpl: authedFetch(key, fetchImpl) });
    const res = await client.cancelTask({ id: taskId });
    if ("error" in res && res.error) {
        throw new Error(`cancelTask failed: ${JSON.stringify(res.error)}`);
    }
    const final = (res as { result?: Task }).result;
    if (!final) throw new Error("cancelTask returned no result");
    return final;
}

// -------------------- helpers --------------------

function extractText(msg: { parts: Array<{ kind: string; text?: string }> }): string {
    if (!msg?.parts || !Array.isArray(msg.parts)) return "";
    const out: string[] = [];
    for (const p of msg.parts) {
        if (p.kind === "text" && typeof p.text === "string") out.push(p.text);
    }
    return out.join("\n");
}

function extractTaskText(task: Task): string {
    if (!task.artifacts) return "";
    const out: string[] = [];
    for (const a of task.artifacts) {
        for (const p of a.parts ?? []) {
            if (p.kind === "text" && typeof (p as { text?: string }).text === "string") {
                out.push((p as { text: string }).text);
            }
        }
    }
    return out.join("\n");
}

function synthTaskFromMessage(msg: Message): Task {
    return {
        kind: "task",
        id: randomUUID(),
        contextId: msg.contextId ?? randomUUID(),
        status: { state: "completed", timestamp: new Date().toISOString() },
        artifacts: [
            {
                artifactId: randomUUID(),
                name: "response",
                parts: msg.parts,
            },
        ],
    };
}
