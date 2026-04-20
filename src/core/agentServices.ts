import { createAgentSessionServices, type AgentSessionServices } from "@mariozechner/pi-coding-agent";

// =============================================================================
// agentServices — single process-wide AgentSessionServices instance.
//
// Background:
//   Since the f69bb81 refactor, per-channel inbound uses in-process
//   AgentSessions via createAgentSessionFromServices(). Services were created
//   once inside ChannelRuntime.start(). The scheduler path stayed on
//   subprocess-per-fire (npx pi -p) and paid no services cost in-process.
//
//   The scheduler subprocess model was retired in a later rewrite — fire
//   handlers now also create in-process AgentSessions. BOTH callers need the
//   same services (extensions are loaded into services.resourceLoader; two
//   copies = parse every .pi/extensions/*.ts twice + two resource-loader
//   caches to keep warm). Centralizing here avoids that.
//
// Init semantics:
//   Lazy on first call. The servicesPromise is cached so concurrent callers
//   await the same in-flight init; later callers get the resolved value for
//   ~free.
// =============================================================================

let servicesPromise: Promise<AgentSessionServices> | null = null;

export async function getSharedAgentServices(): Promise<AgentSessionServices> {
    if (!servicesPromise) {
        servicesPromise = createAgentSessionServices({ cwd: process.cwd() });
    }
    return servicesPromise;
}

/** Test-only. Resets the cache so the next call re-creates services. */
export function __resetSharedAgentServicesForTests(): void {
    servicesPromise = null;
}

/**
 * Extract the assistant's textual reply from an agent_end event's messages.
 * Shared across channelRuntime (inbound) and scheduler (cron fires) — both
 * drive AgentSessions via subscribe() and need the same extraction shape.
 *
 * Concats all `text` content blocks across every `role === "assistant"`
 * message in the event. Trimmed. Returns "" when nothing assistant-shaped
 * is present.
 */
export function extractAssistantText(messages: ReadonlyArray<unknown>): string {
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
