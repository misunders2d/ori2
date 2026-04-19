// Tests for ChannelRuntime.reloadChannel + handOffChannel — the
// private-map-injection pattern below lets us exercise the deferred contracts
// without standing up a full Pi AgentSession.

process.env["BOT_NAME"] = "_test_channel_runtime";

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { ChannelRuntime } from "./channelRuntime.js";
import { botDir } from "../core/paths.js";
import { ChannelSessions } from "../core/channelSessions.js";

interface FakeEntry {
    session: {
        reload?: () => Promise<void>;
        compact?: () => Promise<{ summary: string; firstKeptEntryId: string; tokensBefore: number }>;
        prompt?: (text: string, opts?: unknown) => Promise<void>;
    };
    /** Optional for handOff / reload tests that don't exercise it; required
     *  in production ChannelEntry. Typed loose so tests can stub only the
     *  methods they need. */
    sessionManager?: {
        appendCustomEntry?: (customType: string, data: unknown) => string;
        getBranch?: () => ReadonlyArray<unknown>;
    };
    sessionFile: string;
    lastActivity: number;
    unsubscribe: () => void;
    typingTimer?: NodeJS.Timeout;
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

// =============================================================================
// handOffChannel — critical safety contract:
//   compaction runs BEFORE any destructive step. If compact fails, the old
//   session MUST be left intact (entry still in map, binding still in
//   channelSessions). No half-completed hand-offs.
// =============================================================================

describe("ChannelRuntime.handOffChannel", () => {
    const testDir = botDir();

    before(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });
    after(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });
    beforeEach(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
        ChannelSessions.__resetForTests();
    });

    it("returns queued:false with reason when no active session for the channel", async () => {
        const rt = new ChannelRuntime();
        const result = await rt.handOffChannel("telegram", "-100missing");
        assert.equal(result.queued, false);
        assert.match(result.reason ?? "", /no active session/i);
    });

    it("when compact succeeds: writes pending-handoff file, removes in-memory entry, drops binding, preserves old JSONL", async () => {
        const rt = new ChannelRuntime();

        const { getChannelSessions } = await import("../core/channelSessions.js");
        const { readPendingHandoff } = await import("../core/handoffPending.js");
        const oldFile = getChannelSessions().getOrCreateSessionFile("telegram", "-100handoff");
        fs.writeFileSync(oldFile, '{"type":"test-marker","content":"pre-handoff"}\n');

        const entry: FakeEntry = {
            session: {
                compact: async () => ({
                    summary: "We discussed Vienna and Pinecone integrations.",
                    firstKeptEntryId: "id-123",
                    tokensBefore: 5000,
                }),
            },
            sessionFile: oldFile,
            lastActivity: 0,
            unsubscribe: () => {},
        };
        injectEntry(rt, "telegram:-100handoff", entry);

        const result = await rt.handOffChannel("telegram", "-100handoff");
        assert.equal(result.queued, true);

        await tick(5);

        // Post-conditions:
        // 1. Pending handoff file written with the summary.
        const pending = readPendingHandoff("telegram", "-100handoff");
        assert.ok(pending, "pending handoff file must exist for the consumer to pick up");
        assert.match(pending!.summary, /Vienna and Pinecone/, "pending file must contain the compact summary");
        assert.equal(pending!.previousSessionFile, oldFile, "pending file must record old session for recovery");
        // 2. In-memory entry gone.
        assert.equal(rt.listKeys().includes("telegram:-100handoff"), false, "in-memory entry must be removed");
        // 3. channelSessions binding dropped (next inbound will create fresh).
        assert.equal(getChannelSessions().get("telegram", "-100handoff"), undefined, "old binding must be cleared");
        // 4. Old file is NOT deleted — operator recovery preserved.
        assert.ok(fs.existsSync(oldFile), "old JSONL must be preserved on disk");
    });

    it("when compact FAILS: old session remains intact, NO pending-handoff file written", async () => {
        // Load-bearing safety test. If this regresses, a failed compaction
        // could leave the user with no session AND no summary — worst case.
        const rt = new ChannelRuntime();

        const { getChannelSessions } = await import("../core/channelSessions.js");
        const { readPendingHandoff } = await import("../core/handoffPending.js");
        const oldFile = getChannelSessions().getOrCreateSessionFile("telegram", "-100abort");
        fs.writeFileSync(oldFile, '{"type":"test-marker","content":"pre-abort"}\n');

        const entry: FakeEntry = {
            session: {
                compact: async () => { throw new Error("not enough content to compact"); },
            },
            sessionFile: oldFile,
            lastActivity: 0,
            unsubscribe: () => {},
        };
        injectEntry(rt, "telegram:-100abort", entry);

        const caught: unknown[] = [];
        const onReject = (err: unknown): void => { caught.push(err); };
        process.on("unhandledRejection", onReject);
        try {
            const result = await rt.handOffChannel("telegram", "-100abort");
            assert.equal(result.queued, true, "queueing still succeeds — failure shows up in the deferred run");
            await tick(5);

            // Post-conditions after the FAILED hand-off:
            // 1. In-memory entry STILL there — nothing destructive ran.
            assert.ok(rt.listKeys().includes("telegram:-100abort"), "in-memory entry must remain after compact failure");
            // 2. Binding unchanged.
            assert.equal(getChannelSessions().get("telegram", "-100abort"), oldFile, "binding must not have been swapped");
            // 3. Old file still there and unchanged.
            assert.ok(fs.existsSync(oldFile), "old session file intact");
            // 4. NO pending handoff file — proves compact-abort happens BEFORE
            //    any side effect. This is the core safety invariant.
            assert.equal(readPendingHandoff("telegram", "-100abort"), null, "no pending file on compact failure");
            // 5. No unhandled rejection escaped.
            assert.equal(caught.length, 0, "deferred failure must be caught + logged, not escape");
        } finally {
            process.off("unhandledRejection", onReject);
        }
    });

    it("updates lastActivity when queueing a hand-off (don't evict mid-handoff)", async () => {
        const rt = new ChannelRuntime();
        const { getChannelSessions } = await import("../core/channelSessions.js");
        const oldFile = getChannelSessions().getOrCreateSessionFile("telegram", "-100touch-ho-b");
        const entry: FakeEntry = {
            session: {
                compact: async () => ({ summary: "brief", firstKeptEntryId: "x", tokensBefore: 100 }),
            },
            sessionFile: oldFile,
            lastActivity: 0,
            unsubscribe: () => {},
        };
        injectEntry(rt, "telegram:-100touch-ho-b", entry);
        const before = Date.now();
        await rt.handOffChannel("telegram", "-100touch-ho-b");
        assert.ok(entry.lastActivity >= before, "lastActivity must be refreshed");
    });
});

// =============================================================================
// REGRESSION GUARD: handleActiveInbound MUST write a transport-origin custom
// entry to the per-channel session's SessionManager BEFORE invoking
// session.prompt(). Without this, currentOrigin() returns null for tools
// running in per-channel Telegram/Slack/A2A sessions — breaking
// set_channel_model, reset_channel_session, reload_extensions, admin_gate's
// tool-ACL, and memory attribution.
//
// Pre-f69bb81 (subprocess model), transport_bridge's setPushToPi callback
// wrote the origin. Post-f69bb81 (in-process per-channel), non-CLI inbound
// skips pushToPi entirely (it's CLI-only). channelRuntime is the ONLY choke-
// point that sees every non-CLI inbound — it's the correct place to write.
// =============================================================================

describe("ChannelRuntime.handleActiveInbound — transport-origin tagging (regression guard for currentOrigin)", () => {
    it("writes transport-origin to the per-channel SessionManager BEFORE calling session.prompt", async () => {
        const rt = new ChannelRuntime();
        const events: Array<string> = [];
        const appended: Array<{ customType: string; data: Record<string, unknown> }> = [];
        const promptCalls: Array<{ text: string }> = [];

        const fakeSm = {
            appendCustomEntry: (customType: string, data: unknown): string => {
                events.push("append");
                appended.push({ customType, data: data as Record<string, unknown> });
                return "id-origin";
            },
            getBranch: () => [],
        };
        const fakeSession = {
            prompt: async (text: string, _opts: unknown): Promise<void> => {
                events.push("prompt");
                promptCalls.push({ text });
            },
        };
        injectEntry(rt, "telegram:-100msgguard", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: fakeSession as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: fakeSm as any,
            sessionFile: "/tmp/msgguard.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        await rt.handleActiveInbound({
            platform: "telegram",
            channelId: "-100msgguard",
            senderId: "alice",
            senderDisplayName: "Alice",
            text: "switch to opus",
            addressedToBot: true,
            timestamp: 1713400000000,
        });

        // (a) Exactly one transport-origin entry written.
        assert.equal(appended.length, 1, "exactly one transport-origin entry must be written per inbound");
        assert.equal(appended[0]!.customType, "transport-origin");
        // (b) Entry data matches the inbound message fields.
        const data = appended[0]!.data;
        assert.equal(data["platform"], "telegram");
        assert.equal(data["channelId"], "-100msgguard");
        assert.equal(data["senderId"], "alice");
        assert.equal(data["senderDisplayName"], "Alice");
        assert.equal(data["timestamp"], 1713400000000);
        // (c) Ordering: append ran BEFORE prompt. This is load-bearing — if
        //     prompt fires first, tools invoked during the turn still see an
        //     empty branch and currentOrigin returns null.
        assert.deepEqual(events, ["append", "prompt"], "append must happen before prompt");
        assert.equal(promptCalls.length, 1, "prompt called exactly once");
    });

    it("preserves threadId when present on the inbound message", async () => {
        const rt = new ChannelRuntime();
        let captured: Record<string, unknown> | null = null;
        injectEntry(rt, "telegram:-100thread", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: { prompt: async () => {} } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: {
                appendCustomEntry: (_ct: string, data: unknown) => {
                    captured = data as Record<string, unknown>;
                    return "id";
                },
                getBranch: () => [],
            } as any,
            sessionFile: "/tmp/thread.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        await rt.handleActiveInbound({
            platform: "telegram",
            channelId: "-100thread",
            threadId: "42",
            senderId: "bob",
            senderDisplayName: "Bob",
            text: "hi in thread",
            addressedToBot: true,
            timestamp: 1713400001000,
        });

        assert.ok(captured, "appendCustomEntry must have been called");
        assert.equal((captured as Record<string, unknown>)["threadId"], "42");
    });

    it("still writes origin even when session.prompt throws — origin must land before the prompt runs", async () => {
        const rt = new ChannelRuntime();
        let originWritten = false;
        injectEntry(rt, "telegram:-100throw", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: {
                prompt: async () => { throw new Error("model API down"); },
            } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: {
                appendCustomEntry: (ct: string, _d: unknown) => {
                    if (ct === "transport-origin") originWritten = true;
                    return "id";
                },
                getBranch: () => [],
            } as any,
            sessionFile: "/tmp/throw.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        // handleActiveInbound catches the throw internally and sends an error
        // message to the user — it should NOT propagate. We still expect the
        // origin to have been written before the throw hit.
        await rt.handleActiveInbound({
            platform: "telegram",
            channelId: "-100throw",
            senderId: "alice",
            senderDisplayName: "Alice",
            text: "x",
            addressedToBot: true,
            timestamp: 1713400002000,
        });

        assert.equal(originWritten, true, "origin must land before session.prompt runs (so even failed turns have an audit trail)");
    });
});
