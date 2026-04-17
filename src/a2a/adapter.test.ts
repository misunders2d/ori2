import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { A2AAdapter, A2A_PLATFORM } from "./adapter.js";
import type { Message } from "../transport/types.js";

function msg(overrides?: Partial<Message>): Message {
    return {
        platform: A2A_PLATFORM,
        channelId: "a2a:task-1",
        senderId: "a2a:peer",
        senderDisplayName: "Peer",
        timestamp: Date.now(),
        text: "hi",
        ...overrides,
    };
}

describe("A2AAdapter — lifecycle state", () => {
    let a: A2AAdapter;
    beforeEach(() => { a = new A2AAdapter(); });

    it("starts in 'stopped'", () => {
        assert.equal(a.status().state, "stopped");
    });

    it("start() transitions to 'starting'", async () => {
        await a.start();
        assert.equal(a.status().state, "starting");
    });

    it("markRunning moves to 'running' and records port + baseUrl", () => {
        a.markRunning(8085, "https://abc.trycloudflare.com");
        const s = a.status();
        assert.equal(s.state, "running");
        assert.equal(s.details?.bound_port, 8085);
        assert.equal(s.details?.base_url, "https://abc.trycloudflare.com");
        assert.ok(s.connectedAt);
    });

    it("markError moves to 'error' + preserves lastError", () => {
        a.markError("boom");
        const s = a.status();
        assert.equal(s.state, "error");
        assert.equal(s.lastError, "boom");
    });

    it("markRunning clears a previous error", () => {
        a.markError("first");
        a.markRunning(8085, "url");
        assert.equal(a.status().lastError, undefined);
    });
});

describe("A2AAdapter — dispatchAndWait", () => {
    it("resolves when adapter.send() is called with the matching channelId", async () => {
        const a = new A2AAdapter();
        const seen: Message[] = [];
        a.setHandler(async (m) => {
            seen.push(m);
            // Echo back asynchronously — simulates the dispatcher bridge.
            setTimeout(() => { void a.send(m.channelId, { text: `echo: ${m.text}` }); }, 5);
        });
        const resp = await a.dispatchAndWait(msg(), 1000);
        assert.equal(resp.text, "echo: hi");
        assert.equal(seen.length, 1);
    });

    it("rejects with timeout error after timeoutMs expires without a send()", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { /* never responds */ });
        await assert.rejects(a.dispatchAndWait(msg({ channelId: "a2a:never" }), 50), /timeout/);
    });

    it("rejects if the handler throws", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { throw new Error("handler exploded"); });
        await assert.rejects(a.dispatchAndWait(msg(), 1000), /handler exploded/);
    });

    it("rejects if no handler is installed", async () => {
        const a = new A2AAdapter();
        await assert.rejects(async () => a.dispatchAndWait(msg(), 1000), /no dispatcher handler/);
    });

    it("refuses a message whose platform is not 'a2a'", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { /* unreachable */ });
        await assert.rejects(
            async () => a.dispatchAndWait(msg({ platform: "telegram" }), 1000),
            /expected platform=a2a/,
        );
    });

    it("independent channelIds are isolated", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { /* tests drive .send() manually */ });

        const p1 = a.dispatchAndWait(msg({ channelId: "a2a:task-1" }), 1000);
        const p2 = a.dispatchAndWait(msg({ channelId: "a2a:task-2" }), 1000);
        // Resolve second first.
        await a.send("a2a:task-2", { text: "second" });
        await a.send("a2a:task-1", { text: "first" });
        const r1 = await p1;
        const r2 = await p2;
        assert.equal(r1.text, "first");
        assert.equal(r2.text, "second");
    });

    it("a send to an unknown channelId is a silent drop (no throw)", async () => {
        const a = new A2AAdapter();
        await a.send("a2a:nobody", { text: "stale" }); // should not throw
    });
});

describe("A2AAdapter — stop / reset", () => {
    it("stop() rejects pending resolvers so callers don't hang past shutdown", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { /* never responds */ });
        const pending = a.dispatchAndWait(msg(), 60_000);
        await a.stop();
        await assert.rejects(pending, /stopping/);
        assert.equal(a.status().state, "stopped");
    });

    it("reset() clears pending + all state", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { /* never responds */ });
        a.markRunning(8085, "url");
        const pending = a.dispatchAndWait(msg(), 60_000);
        a.reset();
        await assert.rejects(pending, /reset/);
        const s = a.status();
        assert.equal(s.state, "stopped");
        assert.equal(s.details?.bound_port, undefined);
        assert.equal(s.details?.base_url, undefined);
    });
});

describe("A2AAdapter — status details", () => {
    it("reports pending_responses count", async () => {
        const a = new A2AAdapter();
        a.setHandler(async () => { /* never responds */ });
        const p1 = a.dispatchAndWait(msg({ channelId: "a2a:q-1" }), 60_000).catch(() => null);
        const p2 = a.dispatchAndWait(msg({ channelId: "a2a:q-2" }), 60_000).catch(() => null);
        const s = a.status();
        assert.equal(s.details?.pending_responses, 2);
        a.reset(); // rejects both pending promises → absorbed by .catch() above
        await Promise.all([p1, p2]);
    });
});
