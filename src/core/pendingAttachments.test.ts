import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
    enqueuePending,
    drainPending,
    peekPending,
    __resetPendingAttachmentsForTests,
} from "./pendingAttachments.js";

describe("pendingAttachments — per-channel outbound file queue", () => {
    beforeEach(() => {
        __resetPendingAttachmentsForTests();
    });

    it("drain on an empty channel returns []", () => {
        assert.deepEqual(drainPending("telegram", "-100abc"), []);
    });

    it("enqueue then drain returns exactly what was pushed, in order", () => {
        enqueuePending("telegram", "-100abc", ["/tmp/a.png", "/tmp/b.pdf"]);
        enqueuePending("telegram", "-100abc", ["/tmp/c.csv"]);
        assert.deepEqual(drainPending("telegram", "-100abc"), ["/tmp/a.png", "/tmp/b.pdf", "/tmp/c.csv"]);
    });

    it("drain is destructive — a second drain returns []", () => {
        enqueuePending("telegram", "-100abc", ["/tmp/a.png"]);
        drainPending("telegram", "-100abc");
        assert.deepEqual(drainPending("telegram", "-100abc"), []);
    });

    it("queues are isolated per (platform, channelId)", () => {
        enqueuePending("telegram", "-100abc", ["/tmp/tg.png"]);
        enqueuePending("slack",    "C123",    ["/tmp/sk.png"]);
        enqueuePending("telegram", "-100xyz", ["/tmp/other.png"]);
        assert.deepEqual(drainPending("telegram", "-100abc"), ["/tmp/tg.png"]);
        assert.deepEqual(drainPending("slack", "C123"),        ["/tmp/sk.png"]);
        assert.deepEqual(drainPending("telegram", "-100xyz"),  ["/tmp/other.png"]);
    });

    it("enqueue of empty array is a no-op", () => {
        enqueuePending("telegram", "-100abc", []);
        assert.deepEqual(peekPending("telegram", "-100abc"), []);
    });

    it("peekPending is non-destructive — multiple peeks return the same queue", () => {
        enqueuePending("telegram", "-100abc", ["/tmp/a.png"]);
        assert.deepEqual(peekPending("telegram", "-100abc"), ["/tmp/a.png"]);
        assert.deepEqual(peekPending("telegram", "-100abc"), ["/tmp/a.png"]);
        // Drain still works after peek.
        assert.deepEqual(drainPending("telegram", "-100abc"), ["/tmp/a.png"]);
    });
});
