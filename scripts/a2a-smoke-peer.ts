#!/usr/bin/env -S node --import tsx
/**
 * a2a-smoke-peer — minimal one-process A2A peer used by `scripts/a2a-smoke.ts`
 * to exercise the wire end-to-end. NOT for production. Imports server.ts and
 * friends.ts so the full auth middleware + JSON-RPC SDK + DNA endpoint are
 * real, but the adapter handler is stubbed to echo inbound text back.
 *
 * Driven by env vars (the orchestrator sets them before spawning):
 *   BOT_NAME      — per-bot namespace on disk (data/<BOT_NAME>/)
 *   A2A_BIND_PORT — local HTTP port to bind
 *   A2A_BASE_URL  — advertised public URL in the agent card (= local port)
 *
 * Protocol with orchestrator:
 *   - Prints `A2A_SMOKE_PEER_READY port=<n> base_url=<url>` once the server is
 *     listening.
 *   - Blocks on SIGTERM/SIGINT; the orchestrator sends SIGTERM on tear-down.
 */

process.env["BOT_NAME"] = process.env["BOT_NAME"] ?? "_smoke_peer_default";

import { randomUUID } from "node:crypto";
import { startA2AServer } from "../src/a2a/server.js";
import { getA2AAdapter } from "../src/a2a/adapter.js";

async function main(): Promise<void> {
    const botName = process.env["BOT_NAME"]!;
    const port = Number(process.env["A2A_BIND_PORT"] ?? "0");
    const baseUrl = process.env["A2A_BASE_URL"] ?? `http://127.0.0.1:${port}`;

    const adapter = getA2AAdapter();
    // Echo handler: on every inbound message, immediately synthesize an
    // agent_end response that echoes back a canned reply. The adapter's
    // dispatchAndWait awaits the Promise installed in pendingResponses; calling
    // adapter.send(channelId, ...) resolves it.
    adapter.setHandler(async (msg) => {
        setTimeout(() => {
            void adapter.send(msg.channelId, {
                text: `echo from ${botName}: ${msg.text ?? "(no text)"}`,
            });
        }, 0);
    });

    const handle = await startA2AServer({
        botName,
        agentId: `ori2-${botName}`,
        description: `${botName} — smoke peer`,
        baseUrl,
        apiKey: randomUUID(),
        preferredPort: port || 0,
    });

    console.log(`A2A_SMOKE_PEER_READY port=${handle.boundPort} base_url=${baseUrl}`);

    const stop = async () => {
        try { await handle.stop(); } catch { /* ignore */ }
        process.exit(0);
    };
    process.once("SIGTERM", () => { void stop(); });
    process.once("SIGINT", () => { void stop(); });
}

main().catch((e) => {
    console.error(`A2A_SMOKE_PEER_FAIL ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
});
