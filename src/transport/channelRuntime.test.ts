// Tests for ChannelRuntime.reloadChannel + handOffChannel — the
// private-map-injection pattern below lets us exercise the deferred contracts
// without standing up a full Pi AgentSession.

process.env["BOT_NAME"] = "_test_channel_runtime";
// Force guardrails off for tests; each attachment test would otherwise pay
// the fastembed ONNX boot cost (~25s first time, flaky in CI). The lazy-
// import in buildKickoffContent catches the ModuleLoadError and proceeds
// without tagging — which is exactly the path we're exercising here (the
// regressions aren't about the tag content, they're about whether the
// attachment reaches session.prompt at all).
process.env["GUARDRAIL_DISABLED"] = "1";

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelRuntime, buildKickoffContent } from "./channelRuntime.js";
import { botDir } from "../core/paths.js";
import { ChannelSessions } from "../core/channelSessions.js";
import { enqueuePending, __resetPendingAttachmentsForTests } from "../core/pendingAttachments.js";
import { TransportDispatcher, getDispatcher } from "./dispatcher.js";
import type { Message, MediaPayload, AgentResponse, TransportAdapter } from "./types.js";

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

// =============================================================================
// REGRESSION GUARD — cached-runtime ↔ disk-state consistency boundary.
//
// CLASS OF BUG: session-management tools (set_channel_model,
// reset_channel_session, set_thinking_mode, future equivalents) mutate disk
// state. Pre-fix, the CACHED AgentSession in ChannelRuntime.channels kept
// running on the old state indefinitely — "set_channel_model" returned
// success, the JSON was written, but the bot kept answering on the old
// model until the idle-sweep evicted the cache 15min later.
//
// Why the old tests missed it: they verified disk persistence (getChannelModels
// returns what we set) but never asserted that the cached live session was
// updated. The disk layer was tested in isolation. These tests sit on the
// SEAM between disk state and live runtime — that's where the bug lived.
//
// Required invariants:
//   - applyChannelModel: after set_channel_model writes disk, the cached
//     session.setModel is called with the right model.
//   - resetChannel: evicts the cached ChannelEntry so next inbound rebuilds.
//   - getOrCreate: if a binding exists at session-create time, Pi's
//     createAgentSessionFromServices receives it as `{ model, thinkingLevel }`.
// =============================================================================

describe("ChannelRuntime.applyChannelModel — live-apply after set_channel_model (bug-class guard)", () => {
    beforeEach(() => {
        TransportDispatcher.__resetForTests();
    });

    it("no cached session → applied:false, reason:no-active-session (lazy path)", async () => {
        const rt = new ChannelRuntime();
        const result = await rt.applyChannelModel("telegram", "-100absent");
        assert.equal(result.applied, false);
        assert.equal(result.reason, "no-active-session");
    });

    it("cached session + binding present → session.setModel/setThinkingLevel invoked on the live session", async () => {
        const rt = new ChannelRuntime();
        const calls: Array<{ type: "setModel" | "setThinking"; value: unknown }> = [];
        const fakeModel = { provider: "google", id: "gemini-3-flash-preview" };
        const fakeRegistry = {
            find: (provider: string, modelId: string) => {
                if (provider === "google" && modelId === "gemini-3-flash-preview") return fakeModel;
                return undefined;
            },
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rt as any).services = { modelRegistry: fakeRegistry };
        injectEntry(rt, "telegram:-100live", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: {
                setModel: async (m: unknown) => { calls.push({ type: "setModel", value: m }); },
                setThinkingLevel: (l: unknown) => { calls.push({ type: "setThinking", value: l }); },
            } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: { appendCustomEntry: () => "id", getBranch: () => [] } as any,
            sessionFile: "/tmp/live.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });
        // Seed the binding as if set_channel_model just wrote it.
        const { getChannelModels, ChannelModels } = await import("../core/channelModels.js");
        ChannelModels.__resetForTests();
        getChannelModels().set("telegram", "-100live", {
            provider: "google",
            modelId: "gemini-3-flash-preview",
            thinkingLevel: "medium",
            setBy: "test",
        });

        const result = await rt.applyChannelModel("telegram", "-100live");
        assert.equal(result.applied, true, "applied must be true when binding resolves to a real model");
        // Exactly the expected hot-apply calls landed, in setModel-then-thinking order.
        assert.equal(calls.length, 2);
        assert.equal(calls[0]!.type, "setModel");
        assert.deepEqual(calls[0]!.value, fakeModel, "the same model object returned by registry.find must flow into setModel");
        assert.equal(calls[1]!.type, "setThinking");
        assert.equal(calls[1]!.value, "medium");
    });

    it("binding provider/modelId missing from registry → applied:false with diagnostic reason (no crash)", async () => {
        const rt = new ChannelRuntime();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (rt as any).services = {
            modelRegistry: { find: () => undefined }, // registry doesn't know the model
        };
        injectEntry(rt, "telegram:-100stale", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: { setModel: async () => {}, setThinkingLevel: () => {} } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: { appendCustomEntry: () => "id", getBranch: () => [] } as any,
            sessionFile: "/tmp/stale.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });
        const { getChannelModels, ChannelModels } = await import("../core/channelModels.js");
        ChannelModels.__resetForTests();
        getChannelModels().set("telegram", "-100stale", {
            provider: "anthropic",
            modelId: "claude-gone-from-registry",
            setBy: "test",
        });

        const result = await rt.applyChannelModel("telegram", "-100stale");
        assert.equal(result.applied, false);
        assert.equal(result.reason, "model-not-in-registry");
    });
});

// =============================================================================
// Abort keyword ("stop" / "/stop") — pi-telegram convention.
// Without this, "stop" queues as a new user message via followUp and the
// current turn keeps streaming. User expectation + pi-telegram canonical
// behavior: abort the live turn, reply "Stopped.", no prompt dispatch.
// =============================================================================

describe("ChannelRuntime.handleActiveInbound — 'stop' keyword aborts the live turn", () => {
    beforeEach(() => {
        TransportDispatcher.__resetForTests();
    });

    type SessionCall = { type: "prompt" | "abort"; arg?: unknown };

    function rigForStop(channelKey: string): { rt: ChannelRuntime; sessionCalls: SessionCall[]; dispatchedTo: Array<{ channelId: string; text: string }> } {
        const rt = new ChannelRuntime();
        const sessionCalls: SessionCall[] = [];
        const dispatchedTo: Array<{ channelId: string; text: string }> = [];

        // Fake adapter records outbound sends.
        const d = getDispatcher();
        d.register({
            platform: "telegram",
            start: async () => {}, stop: async () => {},
            send: async (channelId: string, response: AgentResponse) => {
                dispatchedTo.push({ channelId, text: response.text });
            },
            setHandler: () => {},
            status: () => ({ platform: "telegram", state: "running" }),
        });

        injectEntry(rt, channelKey, {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: {
                prompt: async (text: string) => { sessionCalls.push({ type: "prompt", arg: text }); },
                abort: async () => { sessionCalls.push({ type: "abort" }); },
            } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: { appendCustomEntry: () => "id", getBranch: () => [] } as any,
            sessionFile: "/tmp/stop.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        return { rt, sessionCalls, dispatchedTo };
    }

    it("bare 'stop' → session.abort called; session.prompt NOT called; user gets 'Stopped.'", async () => {
        const { rt, sessionCalls, dispatchedTo } = rigForStop("telegram:-100stop1");

        await rt.handleActiveInbound({
            platform: "telegram", channelId: "-100stop1", senderId: "u1",
            senderDisplayName: "U", text: "stop", addressedToBot: true, timestamp: 1,
        });
        // Flush microtasks so the void-awaited abort lands.
        await tick(2);

        assert.equal(sessionCalls.filter((c) => c.type === "abort").length, 1);
        assert.equal(sessionCalls.filter((c) => c.type === "prompt").length, 0,
            "prompt MUST NOT be called — that would queue 'stop' as a followUp user message instead of aborting");
        assert.equal(dispatchedTo.length, 1);
        assert.equal(dispatchedTo[0]!.text, "Stopped.");
    });

    it("'/stop' (slash-command form) → same abort path, language-agnostic", async () => {
        const { rt, sessionCalls } = rigForStop("telegram:-100stop2");
        await rt.handleActiveInbound({
            platform: "telegram", channelId: "-100stop2", senderId: "u1",
            senderDisplayName: "U", text: "/stop", addressedToBot: true, timestamp: 1,
        });
        await tick(2);
        assert.equal(sessionCalls.filter((c) => c.type === "abort").length, 1);
        assert.equal(sessionCalls.filter((c) => c.type === "prompt").length, 0);
    });

    it("case-insensitive + trims surrounding whitespace — 'STOP ' and ' stop\\n' both abort", async () => {
        const { rt, sessionCalls } = rigForStop("telegram:-100stop3");
        await rt.handleActiveInbound({
            platform: "telegram", channelId: "-100stop3", senderId: "u1",
            senderDisplayName: "U", text: "STOP ", addressedToBot: true, timestamp: 1,
        });
        await rt.handleActiveInbound({
            platform: "telegram", channelId: "-100stop3", senderId: "u1",
            senderDisplayName: "U", text: " stop\n", addressedToBot: true, timestamp: 2,
        });
        await tick(2);
        assert.equal(sessionCalls.filter((c) => c.type === "abort").length, 2);
        assert.equal(sessionCalls.filter((c) => c.type === "prompt").length, 0);
    });

    it("partial match does NOT abort — 'stop doing X' goes through as a normal prompt", async () => {
        const { rt, sessionCalls } = rigForStop("telegram:-100stop4");
        await rt.handleActiveInbound({
            platform: "telegram", channelId: "-100stop4", senderId: "u1",
            senderDisplayName: "U", text: "stop doing that and tell me what model you are on",
            addressedToBot: true, timestamp: 1,
        });
        await tick(2);
        assert.equal(sessionCalls.filter((c) => c.type === "abort").length, 0,
            "literal match only — partial 'stop ...' must NOT abort, the LLM interprets it");
        assert.equal(sessionCalls.filter((c) => c.type === "prompt").length, 1);
    });
});

describe("ChannelRuntime.resetChannel — cache eviction (bug-class guard)", () => {
    it("no cached session → reset:false, reason:no-active-session", async () => {
        const rt = new ChannelRuntime();
        const result = await rt.resetChannel("telegram", "-100absent");
        assert.equal(result.reset, false);
        assert.equal(result.reason, "no-active-session");
    });

    it("cached session → entry removed from map AND unsubscribe called", async () => {
        const rt = new ChannelRuntime();
        let unsubCalled = 0;
        injectEntry(rt, "telegram:-100drop", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: {} as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: {} as any,
            sessionFile: "/tmp/drop.jsonl",
            lastActivity: 0,
            unsubscribe: () => { unsubCalled++; },
        });
        assert.equal(rt.listKeys().includes("telegram:-100drop"), true, "seeded");

        const result = await rt.resetChannel("telegram", "-100drop");
        assert.equal(result.reset, true);
        assert.equal(rt.listKeys().includes("telegram:-100drop"), false, "entry must be gone from the channels Map");
        assert.equal(unsubCalled, 1, "unsubscribe must run so Pi doesn't fire events at a torn-down session");
    });
});

// =============================================================================
// buildKickoffContent — pure helper. Unit-tests the multimodal wiring
// (images → ImageContent[], text → inlined, binary → path+size mention).
// =============================================================================

describe("buildKickoffContent — multimodal wiring (regression guard for dropped attachments)", () => {
    it("plain-text message (no attachments): text passes through, images=[]", async () => {
        const { text, images } = await buildKickoffContent({
            platform: "telegram", channelId: "-100plain", senderId: "u1",
            senderDisplayName: "User One", text: "hello", addressedToBot: true,
            timestamp: 1,
        });
        assert.equal(images.length, 0);
        assert.match(text, /telegram inbound.*User One/);
        assert.match(text, /hello/);
        assert.doesNotMatch(text, /Attachments from this message/);
    });

    it("image attachment: becomes ImageContent in options.images + listed in prompt", async () => {
        const { text, images } = await buildKickoffContent({
            platform: "telegram", channelId: "-100img", senderId: "u1",
            senderDisplayName: "U", text: "look at this", addressedToBot: true,
            timestamp: 1,
            attachments: [
                { kind: "image", mimeType: "image/png", data: "BASE64IMG==", filename: "photo.png" },
            ],
        });
        assert.equal(images.length, 1);
        assert.equal(images[0]!.type, "image");
        assert.equal(images[0]!.data, "BASE64IMG==");
        assert.equal(images[0]!.mimeType, "image/png");
        assert.match(text, /Attachments from this message/);
        assert.match(text, /image "photo\.png"/);
    });

    it("text attachment (PDF/CSV text extracted at boundary): extracted text inlined in prompt", async () => {
        const { text, images } = await buildKickoffContent({
            platform: "telegram", channelId: "-100txt", senderId: "u1",
            senderDisplayName: "U", text: "summarize", addressedToBot: true,
            timestamp: 1,
            attachments: [
                {
                    kind: "text",
                    mimeType: "application/pdf",
                    text: "Invoice #42\nTotal: $1234.56",
                    filename: "invoice.pdf",
                    sourceBytes: 51234,
                },
            ],
        });
        assert.equal(images.length, 0);
        assert.match(text, /file "invoice\.pdf"/);
        assert.match(text, /=== invoice\.pdf ===/);
        assert.match(text, /Invoice #42/);
        assert.match(text, /Total: \$1234\.56/);
        assert.match(text, /=== end of invoice\.pdf ===/);
    });

    it("binary attachment: path + size mentioned, NOT inlined", async () => {
        const { text, images } = await buildKickoffContent({
            platform: "telegram", channelId: "-100bin", senderId: "u1",
            senderDisplayName: "U", text: "", addressedToBot: true,
            timestamp: 1,
            attachments: [
                {
                    kind: "binary",
                    mimeType: "application/x-executable",
                    localPath: "/tmp/mystery.bin",
                    sizeBytes: 8192,
                    filename: "mystery.bin",
                },
            ],
        });
        assert.equal(images.length, 0);
        assert.match(text, /file "mystery\.bin"/);
        assert.match(text, /saved locally at \/tmp\/mystery\.bin/);
        assert.match(text, /8192 bytes/);
    });

    it("mixed: image + PDF-text + binary produces single coherent prompt + one ImageContent", async () => {
        const { text, images } = await buildKickoffContent({
            platform: "telegram", channelId: "-100mix", senderId: "u1",
            senderDisplayName: "U", text: "process these", addressedToBot: true,
            timestamp: 1,
            attachments: [
                { kind: "image", mimeType: "image/jpeg", data: "JPEG==", filename: "pic.jpg" },
                { kind: "text",  mimeType: "text/csv",   text: "a,b\n1,2", filename: "data.csv", sourceBytes: 8 },
                { kind: "binary", mimeType: "application/zip", localPath: "/tmp/stuff.zip", sizeBytes: 1024, filename: "stuff.zip" },
            ],
        });
        assert.equal(images.length, 1);
        assert.match(text, /image "pic\.jpg"/);
        assert.match(text, /file "data\.csv"/);
        assert.match(text, /file "stuff\.zip"/);
        assert.match(text, /=== data\.csv ===/);
    });
});

// =============================================================================
// handleActiveInbound — END-TO-END regression guard for the "images make it
// into session.prompt options" contract. Without this test, the next refactor
// that drops options.images would slip through type-checking (images is
// optional) and we'd be back to week-one.
// =============================================================================

describe("ChannelRuntime.handleActiveInbound — attachments reach session.prompt", () => {
    it("image attachment → session.prompt called with options.images", async () => {
        const rt = new ChannelRuntime();
        const captured: Array<{ text: string; opts: unknown }> = [];
        injectEntry(rt, "telegram:-100atta", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: {
                prompt: async (text: string, opts: unknown) => { captured.push({ text, opts }); },
            } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: {
                appendCustomEntry: () => "id",
                getBranch: () => [],
            } as any,
            sessionFile: "/tmp/atta.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        await rt.handleActiveInbound({
            platform: "telegram",
            channelId: "-100atta",
            senderId: "alice",
            senderDisplayName: "Alice",
            text: "look at this image",
            addressedToBot: true,
            timestamp: 1713500000000,
            attachments: [
                { kind: "image", mimeType: "image/png", data: "PNGBYTES==", filename: "photo.png" },
            ],
        });

        assert.equal(captured.length, 1);
        const opts = captured[0]!.opts as { images?: Array<{ type: string; data: string; mimeType: string }> };
        assert.ok(opts.images, "options.images must be set when msg.attachments has an image");
        assert.equal(opts.images!.length, 1);
        assert.equal(opts.images![0]!.type, "image");
        assert.equal(opts.images![0]!.data, "PNGBYTES==");
        assert.equal(opts.images![0]!.mimeType, "image/png");
        // Path also mentioned in the text prompt (belt-and-suspenders).
        assert.match(captured[0]!.text, /image "photo\.png"/);
    });

    it("text-only message (no attachments) → options.images NOT set", async () => {
        const rt = new ChannelRuntime();
        const captured: Array<{ text: string; opts: unknown }> = [];
        injectEntry(rt, "telegram:-100txtonly", {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            session: {
                prompt: async (text: string, opts: unknown) => { captured.push({ text, opts }); },
            } as any,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            sessionManager: {
                appendCustomEntry: () => "id",
                getBranch: () => [],
            } as any,
            sessionFile: "/tmp/txtonly.jsonl",
            lastActivity: 0,
            unsubscribe: () => {},
        });

        await rt.handleActiveInbound({
            platform: "telegram",
            channelId: "-100txtonly",
            senderId: "bob",
            senderDisplayName: "Bob",
            text: "hello",
            addressedToBot: true,
            timestamp: 1713500001000,
        });

        assert.equal(captured.length, 1);
        const opts = captured[0]!.opts as { images?: unknown[] };
        assert.equal(opts.images, undefined, "no attachments → options.images must be undefined so Pi doesn't wire a no-op multimodal channel");
    });
});

// =============================================================================
// deliverAgentEnd — outbound contract: pendingAttachments drained and attached
// to the AgentResponse sent via the dispatcher. This is the LLM → user path
// that was completely absent pre-baseline (the agent could call attach_file
// but no one drained).
// =============================================================================

describe("ChannelRuntime.deliverAgentEnd (via agent_end subscription) — pending attachments drain", () => {
    beforeEach(() => {
        __resetPendingAttachmentsForTests();
        // Fresh dispatcher per test — otherwise a previous test's fake
        // adapter (whose capture array is now GC-bound) steals send() calls
        // from the current test's freshly-registered adapter.
        TransportDispatcher.__resetForTests();
    });

    it("text reply + queued file path → dispatcher.send receives {text, attachments}", async () => {
        // 1. Register a fake adapter that records the AgentResponse it gets.
        const d = getDispatcher();
        const captured: Array<{ channelId: string; response: AgentResponse }> = [];
        const fake: TransportAdapter = {
            platform: "telegram",
            start: async () => {},
            stop: async () => {},
            send: async (channelId: string, response: AgentResponse) => {
                captured.push({ channelId, response });
            },
            setHandler: () => {},
            status: () => ({ platform: "telegram", state: "running" }),
        };
        d.register(fake);

        // 2. Create a temp file the LLM "produced" and enqueue its path.
        const tmp = path.join(os.tmpdir(), `ori2-test-outbound-${Date.now()}.txt`);
        fs.writeFileSync(tmp, "generated content");
        enqueuePending("telegram", "-100deliver", [tmp]);

        // 3. Simulate agent_end by directly invoking the private delivery
        //    method. Keeps the test focused on the drain+build+send logic
        //    without needing a full Pi AgentSession boot.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (new ChannelRuntime() as any).deliverAgentEnd("telegram", "-100deliver", {
            type: "agent_end",
            messages: [
                { role: "assistant", content: [{ type: "text", text: "here is the file you asked for" }] },
            ],
        });

        // Cleanup temp file
        fs.unlinkSync(tmp);

        const delivered = captured.filter((c) => c.channelId === "-100deliver");
        assert.equal(delivered.length, 1, "exactly one send call for our channel");
        const resp = delivered[0]!.response;
        assert.equal(resp.text, "here is the file you asked for");
        assert.ok(resp.attachments, "attachments must be populated");
        assert.equal(resp.attachments!.length, 1);
        // .txt → text/plain → binary kind (adapter uploads as document)
        const att = resp.attachments![0]!;
        assert.equal(att.kind, "binary");
        assert.equal(att.mimeType, "text/plain");
        assert.equal(att.filename, path.basename(tmp));
    });

    it("PNG path in queue → kind:\"image\" with base64 data so adapter can sendPhoto", async () => {
        const d = getDispatcher();
        const captured: Array<{ channelId: string; response: AgentResponse }> = [];
        const fake: TransportAdapter = {
            platform: "telegram",
            start: async () => {}, stop: async () => {},
            send: async (channelId, response) => { captured.push({ channelId, response }); },
            setHandler: () => {},
            status: () => ({ platform: "telegram", state: "running" }),
        };
        d.register(fake);

        const tmp = path.join(os.tmpdir(), `ori2-test-img-${Date.now()}.png`);
        // A minimal 1x1 PNG (magic bytes are sufficient for the sniff).
        const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
        fs.writeFileSync(tmp, pngMagic);
        enqueuePending("telegram", "-100img-out", [tmp]);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (new ChannelRuntime() as any).deliverAgentEnd("telegram", "-100img-out", {
            type: "agent_end",
            messages: [{ role: "assistant", content: [{ type: "text", text: "chart:" }] }],
        });

        fs.unlinkSync(tmp);

        const resp = captured.find((c) => c.channelId === "-100img-out")!.response;
        assert.equal(resp.attachments!.length, 1);
        const att = resp.attachments![0]! as Extract<MediaPayload, { kind: "image" }>;
        assert.equal(att.kind, "image");
        assert.equal(att.mimeType, "image/png");
        assert.ok(att.data && att.data.length > 0, "base64 data populated");
    });

    it("no text, no attachments → nothing sent (no empty messages)", async () => {
        const d = getDispatcher();
        const captured: Array<{ channelId: string }> = [];
        const fake: TransportAdapter = {
            platform: "telegram",
            start: async () => {}, stop: async () => {},
            send: async (channelId) => { captured.push({ channelId }); },
            setHandler: () => {},
            status: () => ({ platform: "telegram", state: "running" }),
        };
        d.register(fake);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (new ChannelRuntime() as any).deliverAgentEnd("telegram", "-100empty", {
            type: "agent_end",
            messages: [],
        });

        assert.equal(
            captured.filter((c) => c.channelId === "-100empty").length,
            0,
            "empty agent_end must NOT trigger a send",
        );
    });
});
