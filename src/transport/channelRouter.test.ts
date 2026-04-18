process.env["BOT_NAME"] = "_test_channel_router";

import { describe, it, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "../core/paths.js";
import { ChannelSessions, getChannelSessions } from "../core/channelSessions.js";
import { ChannelModels, getChannelModels } from "../core/channelModels.js";
import { TransportDispatcher } from "./dispatcher.js";
import type {
    AdapterStatus,
    AgentResponse,
    Message,
    MessageHandler,
    TransportAdapter,
} from "./types.js";
import {
    installChannelRouter,
    __drainChannelLocksForTests,
    __resetChannelLocksForTests,
    type SpawnPiPrint,
} from "./channelRouter.js";

class FakeAdapter implements TransportAdapter {
    public readonly platform: string;
    public sent: Array<{ channelId: string; response: AgentResponse }> = [];
    private handler: MessageHandler | null = null;
    constructor(platform: string) { this.platform = platform; }
    setHandler(h: MessageHandler): void { this.handler = h; }
    async start(): Promise<void> { /* noop */ }
    async stop(): Promise<void> { /* noop */ }
    async send(channelId: string, response: AgentResponse): Promise<void> {
        this.sent.push({ channelId, response });
    }
    status(): AdapterStatus { return { platform: this.platform, state: "running" }; }
    async simulateInbound(msg: Message): Promise<void> {
        if (!this.handler) throw new Error("handler not installed");
        await this.handler(msg);
    }
}

function baseMsg(overrides: Partial<Message> = {}): Message {
    return {
        platform: "telegram",
        channelId: "-100abc",
        senderId: "42",
        senderDisplayName: "Alice",
        timestamp: Date.now(),
        text: "hello world",
        addressedToBot: true,
        ...overrides,
    };
}

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function resetAll(): void {
    cleanTestDir();
    TransportDispatcher.__resetForTests();
    ChannelSessions.__resetForTests();
    ChannelModels.__resetForTests();
    __resetChannelLocksForTests();
}

describe("channelRouter — passive path", () => {
    beforeEach(resetAll);
    after(cleanTestDir);

    it("appends a CustomMessageEntry to the channel session on addressedToBot=false", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);
        installChannelRouter(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

        await tg.simulateInbound(baseMsg({ text: "I just watched The Matrix", addressedToBot: false }));
        await __drainChannelLocksForTests();

        const sessionFile = getChannelSessions().get("telegram", "-100abc");
        assert.ok(sessionFile, "binding should exist after passive ingest");
        assert.ok(fs.existsSync(sessionFile), "session file should exist after append");

        const lines = fs.readFileSync(sessionFile, "utf-8").trim().split("\n");
        const customMessageLines = lines
            .map((l) => JSON.parse(l))
            .filter((e) => e.type === "custom_message" && e.customType === "chat-context");
        assert.equal(customMessageLines.length, 1);
        assert.match(customMessageLines[0]!.content, /^Alice:/);
        assert.match(customMessageLines[0]!.content, /The Matrix/);
        // display=false — this is context, not a TUI-rendered turn.
        assert.equal(customMessageLines[0]!.display, false);
    });

    it("appends per-speaker lines so multi-user attribution is preserved", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);
        installChannelRouter(async () => ({ stdout: "", stderr: "", exitCode: 0 }));

        await tg.simulateInbound(baseMsg({
            addressedToBot: false,
            senderId: "42",
            senderDisplayName: "Alice",
            text: "I just watched The Matrix",
        }));
        await tg.simulateInbound(baseMsg({
            addressedToBot: false,
            senderId: "99",
            senderDisplayName: "Bob",
            text: "The bullet-time scene was wild",
        }));
        await __drainChannelLocksForTests();

        const sessionFile = getChannelSessions().get("telegram", "-100abc")!;
        const entries = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        const contexts = entries.filter((e) => e.type === "custom_message" && e.customType === "chat-context");
        assert.equal(contexts.length, 2);
        assert.match(contexts[0]!.content, /^Alice: I just watched/);
        assert.match(contexts[1]!.content, /^Bob: The bullet-time/);
    });
});

describe("channelRouter — active path", () => {
    beforeEach(resetAll);
    after(cleanTestDir);

    it("spawns pi -p with the right kickoff + session file and delivers stdout", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        const calls: Array<{ kickoff: string; sessionFile: string }> = [];
        const fakeSpawn: SpawnPiPrint = async (kickoff, sessionFile) => {
            calls.push({ kickoff, sessionFile });
            return { stdout: "Here is the summary you asked for.", stderr: "", exitCode: 0 };
        };
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg({
            text: "@MyOriBot summarize this",
            addressedToBot: true,
        }));
        await __drainChannelLocksForTests();

        assert.equal(calls.length, 1);
        assert.match(calls[0]!.kickoff, /telegram inbound \| from: Alice/);
        assert.match(calls[0]!.kickoff, /summarize this/);
        const expectedSessionFile = getChannelSessions().get("telegram", "-100abc");
        assert.equal(calls[0]!.sessionFile, expectedSessionFile);

        assert.equal(tg.sent.length, 1);
        assert.equal(tg.sent[0]!.channelId, "-100abc");
        assert.equal(tg.sent[0]!.response.text, "Here is the summary you asked for.");
    });

    it("sends a user-facing failure message on non-zero exit code", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        const fakeSpawn: SpawnPiPrint = async () => ({
            stdout: "some output",
            stderr: "oops",
            exitCode: 1,
        });
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        // CONTRACT: silent failure trains users to think the bot just doesn't
        // reply. Always surface a message so they know to retry / report.
        assert.equal(tg.sent.length, 1);
        assert.match(tg.sent[0]!.response.text, /internal error/i);
        assert.match(tg.sent[0]!.response.text, /subprocess exit 1/);
    });

    it("sends a user-facing failure message when stdout is empty (whitespace only)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        installChannelRouter(async () => ({ stdout: "   \n\n  ", stderr: "", exitCode: 0 }));

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        assert.equal(tg.sent.length, 1);
        assert.match(tg.sent[0]!.response.text, /no reply/i);
    });

    it("sends a watchdog-timeout message when subprocess stderr signals WATCHDOG", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        installChannelRouter(async () => ({
            stdout: "",
            stderr: "[channelRouter] WATCHDOG: subprocess exceeded 120000ms — sent SIGTERM.",
            exitCode: null,
        }));

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        assert.equal(tg.sent.length, 1);
        assert.match(tg.sent[0]!.response.text, /took too long/i);
    });

    it("passes msg.threadId through as replyToMessageId on delivery", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        installChannelRouter(async () => ({ stdout: "reply text", stderr: "", exitCode: 0 }));

        await tg.simulateInbound(baseMsg({ threadId: "msg-321" }));
        await __drainChannelLocksForTests();

        assert.equal(tg.sent.length, 1);
        assert.equal(tg.sent[0]!.response.replyToMessageId, "msg-321");
    });

    it("passes --model provider/id when a channel model preference is set", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        // Preference set for this channel.
        getChannelModels().set("telegram", "-100abc", {
            provider: "anthropic",
            modelId: "claude-opus-4-5",
            thinkingLevel: "medium",
            setBy: "test",
        });

        let capturedArgs: string[] = [];
        const fakeSpawn: SpawnPiPrint = async (_k, _f, extraArgs) => {
            capturedArgs = extraArgs;
            return { stdout: "ok", stderr: "", exitCode: 0 };
        };
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        // Pi's --model format is provider/modelId[:thinking]; verified at
        // node_modules/@mariozechner/pi-coding-agent/dist/cli/args.js:41-66.
        assert.deepEqual(capturedArgs, ["--model", "anthropic/claude-opus-4-5:medium"]);
    });

    it("passes only --thinking off when no channel preference is set (bot-wide default)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        let capturedArgs: string[] = [];
        const fakeSpawn: SpawnPiPrint = async (_k, _f, extraArgs) => {
            capturedArgs = extraArgs;
            return { stdout: "ok", stderr: "", exitCode: 0 };
        };
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        // Bot-wide thinking default is OFF (vault THINKING_LEVEL absent →
        // "off"). Pi receives --thinking off so reasoning models don't burn
        // 30s on a "hey".
        assert.deepEqual(capturedArgs, ["--thinking", "off"]);
    });

    it("appends --thinking off when modelPref has no thinkingLevel (per-channel respects bot-wide default)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        getChannelModels().set("telegram", "-100abc", {
            provider: "openai",
            modelId: "gpt-4o",
            setBy: "test",
        });

        let capturedArgs: string[] = [];
        const fakeSpawn: SpawnPiPrint = async (_k, _f, extraArgs) => {
            capturedArgs = extraArgs;
            return { stdout: "ok", stderr: "", exitCode: 0 };
        };
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        assert.deepEqual(capturedArgs, ["--model", "openai/gpt-4o", "--thinking", "off"]);
    });

    it("does NOT add --thinking when channel modelPref has its own thinkingLevel (per-channel wins)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        getChannelModels().set("telegram", "-100abc", {
            provider: "openai",
            modelId: "gpt-5",
            thinkingLevel: "high",
            setBy: "test",
        });

        let capturedArgs: string[] = [];
        const fakeSpawn: SpawnPiPrint = async (_k, _f, extraArgs) => {
            capturedArgs = extraArgs;
            return { stdout: "ok", stderr: "", exitCode: 0 };
        };
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        // Per-channel thinking suffix is in --model already; we don't double-set it.
        assert.deepEqual(capturedArgs, ["--model", "openai/gpt-5:high"]);
    });

    it("seeds a transport-origin CustomEntry before spawning so subprocess sees the sender", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        // Capture the session file state at the moment spawn is called —
        // that's the frozen state the subprocess would load.
        let sessionStateAtSpawn = "";
        installChannelRouter(async (_kickoff, sessionFile) => {
            if (fs.existsSync(sessionFile)) sessionStateAtSpawn = fs.readFileSync(sessionFile, "utf-8");
            return { stdout: "ok", stderr: "", exitCode: 0 };
        });

        await tg.simulateInbound(baseMsg({
            senderId: "42",
            senderDisplayName: "Alice",
            threadId: "msg-9",
        }));
        await __drainChannelLocksForTests();

        assert.ok(sessionStateAtSpawn.length > 0, "session file must be written before spawn so subprocess can read origin");
        const entries = sessionStateAtSpawn.trim().split("\n").map((l) => JSON.parse(l));
        const originEntry = entries.find((e) => e.type === "custom" && e.customType === "transport-origin");
        assert.ok(originEntry, "transport-origin CustomEntry should be appended");
        assert.equal(originEntry.data.platform, "telegram");
        assert.equal(originEntry.data.senderId, "42");
        assert.equal(originEntry.data.senderDisplayName, "Alice");
        assert.equal(originEntry.data.threadId, "msg-9");
    });
});

describe("channelRouter — mid-flight interrupt (ori/-style)", () => {
    beforeEach(resetAll);
    after(cleanTestDir);

    it("a new active mention on the same channel ABORTS the running subprocess", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        const pending: Array<{
            resolve: (r: { stdout: string; stderr: string; exitCode: number | null }) => void;
            signal: AbortSignal;
            aborted: boolean;
        }> = [];
        const fakeSpawn: SpawnPiPrint = (_k, _f, _args, signal) => new Promise((resolve) => {
            const slot = { resolve, signal, aborted: false };
            pending.push(slot);
            signal.addEventListener("abort", () => {
                slot.aborted = true;
                // Simulate a SIGTERM'd subprocess: resolve with null exitCode.
                resolve({ stdout: "", stderr: "SIGTERM", exitCode: null });
            }, { once: true });
        });
        installChannelRouter(fakeSpawn);

        // First active — starts spawn, hangs.
        await tg.simulateInbound(baseMsg({ text: "first" }));
        await new Promise((r) => setImmediate(r));
        assert.equal(pending.length, 1, "first spawn should have started");
        assert.equal(pending[0]!.aborted, false);

        // Second active on SAME channel — must abort the first.
        await tg.simulateInbound(baseMsg({ text: "second" }));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.equal(pending[0]!.aborted, true, "first subprocess should have been aborted");
        assert.equal(pending.length, 2, "second spawn should have started");

        // Finish the second normally.
        pending[1]!.resolve({ stdout: "answer from second", stderr: "", exitCode: 0 });
        await __drainChannelLocksForTests();

        // Only the second's output is delivered; the aborted first's is discarded.
        assert.equal(tg.sent.length, 1);
        assert.equal(tg.sent[0]!.response.text, "answer from second");
    });

    it("saves the interrupted prior kickoff as a passive context entry", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        const pending: Array<{ resolve: (r: { stdout: string; stderr: string; exitCode: number | null }) => void; signal: AbortSignal }> = [];
        const fakeSpawn: SpawnPiPrint = (_k, _f, _args, signal) => new Promise((resolve) => {
            pending.push({ resolve, signal });
            signal.addEventListener("abort", () => {
                resolve({ stdout: "", stderr: "SIGTERM", exitCode: null });
            }, { once: true });
        });
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg({
            senderDisplayName: "Alice",
            text: "summarize everything since Monday",
        }));
        await new Promise((r) => setImmediate(r));
        // Interrupt with a different mention:
        await tg.simulateInbound(baseMsg({
            senderDisplayName: "Bob",
            text: "actually just the last hour",
        }));
        await new Promise((r) => setImmediate(r));

        // The session file should now contain a passive entry for Alice's
        // interrupted request.
        const sessionFile = getChannelSessions().get("telegram", "-100abc")!;
        const entries = fs.readFileSync(sessionFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
        const interruptedEntry = entries.find((e) =>
            e.type === "custom_message" &&
            e.customType === "chat-context" &&
            typeof e.content === "string" &&
            e.content.includes("interrupted") &&
            e.content.includes("Alice"),
        );
        assert.ok(
            interruptedEntry,
            `expected a passive context entry for the interrupted Alice request; session has ${entries.length} entries`,
        );

        // Cleanup the still-pending second promise.
        pending[1]!.resolve({ stdout: "short answer", stderr: "", exitCode: 0 });
        await __drainChannelLocksForTests();
    });

    it("does NOT abort across DIFFERENT channels (independent subprocess lifecycles)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        const pending: Array<{ resolve: (r: { stdout: string; stderr: string; exitCode: number | null }) => void; aborted: boolean; signal: AbortSignal }> = [];
        const fakeSpawn: SpawnPiPrint = (_k, _f, _args, signal) => new Promise((resolve) => {
            const slot = { resolve, aborted: false, signal };
            pending.push(slot);
            signal.addEventListener("abort", () => {
                slot.aborted = true;
                resolve({ stdout: "", stderr: "SIGTERM", exitCode: null });
            }, { once: true });
        });
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg({ channelId: "chan-A", text: "A1" }));
        await tg.simulateInbound(baseMsg({ channelId: "chan-B", text: "B1" }));
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.equal(pending.length, 2, "both channel subprocesses should be running");
        assert.equal(pending[0]!.aborted, false, "chan-A must not be aborted by chan-B's activity");
        assert.equal(pending[1]!.aborted, false);

        pending[0]!.resolve({ stdout: "A-out", stderr: "", exitCode: 0 });
        pending[1]!.resolve({ stdout: "B-out", stderr: "", exitCode: 0 });
        await __drainChannelLocksForTests();

        assert.equal(tg.sent.length, 2);
    });

    it("a cancel-intent message (any language) is handled by the LLM in the fresh subprocess — no hardcoded word list", async () => {
        // Contract: channelRouter does NOT inspect message text for cancel
        // keywords. Whatever language the user uses to say "cancel", it's
        // the SUBPROCESS LLM's job to interpret and respond. Interruption
        // always happens (so the user gets a fast response), spawn always
        // follows.
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        let spawnKickoffs: string[] = [];
        const fakeSpawn: SpawnPiPrint = (kickoff, _f, _args, signal) => new Promise((resolve) => {
            spawnKickoffs.push(kickoff);
            signal.addEventListener("abort", () => {
                resolve({ stdout: "", stderr: "SIGTERM", exitCode: null });
            }, { once: true });
            // Resolve normally for non-aborted calls after a microtask.
            queueMicrotask(() => {
                if (!signal.aborted) resolve({ stdout: "llm-reply", stderr: "", exitCode: 0 });
            });
        });
        installChannelRouter(fakeSpawn);

        // Non-English "cancel" — Ukrainian, Russian, German — must all reach
        // the subprocess with their original text for the LLM to interpret.
        const cases = ["скасуй", "отмена", "abbrechen", "cancel", "stop"];
        for (const txt of cases) {
            const sent = tg.sent.length;
            await tg.simulateInbound(baseMsg({ text: txt }));
            await __drainChannelLocksForTests();
            // Some kickoff must have been sent for this message (either the
            // new one, or — if an abort fired — the previous one survived and
            // delivered). Key invariant: text is NOT short-circuited by any
            // regex; the subprocess is spawned.
            assert.ok(
                spawnKickoffs.some((k) => k.includes(txt)),
                `expected spawn kickoff containing "${txt}" — router must not filter non-English cancel words`,
            );
            void sent;
        }
    });
});
