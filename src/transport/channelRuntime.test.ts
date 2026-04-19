// Tests for ChannelRuntime.reloadChannel — the private-map-injection pattern
// below lets us exercise the deferred-reload contract without standing up a
// full Pi AgentSession.

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { ChannelRuntime } from "./channelRuntime.js";

interface FakeEntry {
    session: { reload: () => Promise<void> };
    sessionFile: string;
    lastActivity: number;
    unsubscribe: () => void;
}

function injectEntry(rt: ChannelRuntime, key: string, entry: FakeEntry): void {
    // Reach into the private `channels` Map. Acceptable test-only coupling —
    // the reload contract is what matters, not the internal field name.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rt as any).channels.set(key, entry);
}

function tick(n = 2): Promise<void> {
    // setImmediate defers to the next I/O cycle; a couple of ticks ensures
    // the deferred reload has had a chance to fire + its promise to settle.
    return new Promise((resolve) => {
        const step = (left: number): void => {
            if (left === 0) return resolve();
            setImmediate(() => step(left - 1));
        };
        step(n);
    });
}

describe("ChannelRuntime.reloadChannel", () => {
    it("returns queued:false with a reason when no active session for the given channel", async () => {
        const rt = new ChannelRuntime();
        const result = await rt.reloadChannel("telegram", "-100absent");
        assert.equal(result.queued, false);
        assert.match(result.reason ?? "", /no active session/i);
    });

    it("returns queued:true and fires session.reload() exactly once after deferral", async () => {
        const rt = new ChannelRuntime();
        let reloadCalled = 0;
        injectEntry(rt, "telegram:-100present", {
            session: { reload: async () => { reloadCalled++; } },
            sessionFile: "/tmp/x.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });
        const result = await rt.reloadChannel("telegram", "-100present");
        assert.equal(result.queued, true);
        // Deferred: should NOT have run synchronously.
        assert.equal(reloadCalled, 0, "reload must not run in-line — it would rebuild the session mid-turn");
        await tick();
        assert.equal(reloadCalled, 1, "reload must run exactly once after the turn yields");
    });

    it("swallows rejections from session.reload() — deferred failure must not throw into the process", async () => {
        const rt = new ChannelRuntime();
        injectEntry(rt, "telegram:-100fail", {
            session: { reload: async () => { throw new Error("boom"); } },
            sessionFile: "/tmp/y.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        // Catch any unhandled rejection that escapes into the process. If the
        // contract holds, this listener never fires and the test passes via
        // the assert at the end.
        const caught: unknown[] = [];
        const onReject = (err: unknown): void => { caught.push(err); };
        process.on("unhandledRejection", onReject);
        try {
            const result = await rt.reloadChannel("telegram", "-100fail");
            assert.equal(result.queued, true);
            await tick();
            assert.equal(caught.length, 0, "reload rejection must not escape as unhandled");
        } finally {
            process.off("unhandledRejection", onReject);
        }
    });

    it("updates lastActivity when queueing a reload (so idle sweep doesn't evict mid-reload)", async () => {
        const rt = new ChannelRuntime();
        const entry: FakeEntry = {
            session: { reload: async () => {} },
            sessionFile: "/tmp/z.jsonl",
            lastActivity: 0, // ancient
            unsubscribe: () => {},
        };
        injectEntry(rt, "telegram:-100touch", entry);
        const before = Date.now();
        await rt.reloadChannel("telegram", "-100touch");
        assert.ok(entry.lastActivity >= before, "lastActivity must be refreshed on reload queue");
    });
});
