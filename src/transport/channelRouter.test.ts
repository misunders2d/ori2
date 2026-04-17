process.env["BOT_NAME"] = "_test_channel_router";

import { describe, it, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "../core/paths.js";
import { ChannelSessions, getChannelSessions } from "../core/channelSessions.js";
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

    it("skips delivery on non-zero exit code", async () => {
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

        assert.equal(tg.sent.length, 0);
    });

    it("skips delivery when stdout is empty (whitespace only)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        installChannelRouter(async () => ({ stdout: "   \n\n  ", stderr: "", exitCode: 0 }));

        await tg.simulateInbound(baseMsg());
        await __drainChannelLocksForTests();

        assert.equal(tg.sent.length, 0);
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
});

describe("channelRouter — per-channel serialization", () => {
    beforeEach(resetAll);
    after(cleanTestDir);

    it("serializes two inbound on the SAME channel (they do not overlap)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        // A controllable spawn — each call waits on an external resolver so
        // we can directly observe overlap. If calls were concurrent, both
        // would be pending at the same time.
        const pending: Array<(r: { stdout: string; stderr: string; exitCode: number }) => void> = [];
        let startedCount = 0;
        const fakeSpawn: SpawnPiPrint = () => new Promise((resolve) => {
            startedCount++;
            pending.push(resolve);
        });
        installChannelRouter(fakeSpawn);

        // Enqueue two messages on the SAME channel. First one starts spawn;
        // second one should NOT start until the first resolves.
        await tg.simulateInbound(baseMsg({ text: "first" }));
        await tg.simulateInbound(baseMsg({ text: "second" }));

        // Yield a few microtasks so any eager starts fire.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.equal(startedCount, 1, "second must not start until first resolves");

        // Finish the first one.
        pending[0]!({ stdout: "out-1", stderr: "", exitCode: 0 });
        // Wait for second to start.
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        assert.equal(startedCount, 2, "second should start once first resolves");

        pending[1]!({ stdout: "out-2", stderr: "", exitCode: 0 });
        await __drainChannelLocksForTests();

        assert.deepEqual(tg.sent.map((s) => s.response.text), ["out-1", "out-2"]);
    });

    it("does NOT serialize across DIFFERENT channels (they run in parallel)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        const pending: Array<(r: { stdout: string; stderr: string; exitCode: number }) => void> = [];
        let startedCount = 0;
        const fakeSpawn: SpawnPiPrint = () => new Promise((resolve) => {
            startedCount++;
            pending.push(resolve);
        });
        installChannelRouter(fakeSpawn);

        await tg.simulateInbound(baseMsg({ channelId: "chan-A", text: "A1" }));
        await tg.simulateInbound(baseMsg({ channelId: "chan-B", text: "B1" }));

        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));

        assert.equal(startedCount, 2, "both channels should start in parallel");

        pending[0]!({ stdout: "A-out", stderr: "", exitCode: 0 });
        pending[1]!({ stdout: "B-out", stderr: "", exitCode: 0 });
        await __drainChannelLocksForTests();

        assert.equal(tg.sent.length, 2);
    });
});
