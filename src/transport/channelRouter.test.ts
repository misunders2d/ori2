process.env["BOT_NAME"] = "_test_channel_router";

import { describe, it, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "../core/paths.js";
import { ChannelSessions, getChannelSessions } from "../core/channelSessions.js";
import { ChannelModels } from "../core/channelModels.js";
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
} from "./channelRouter.js";

// =============================================================================
// channelRouter tests cover ONLY the passive path.
//
// The active path was rewritten in this codebase: it used to spawn `pi -p`
// subprocesses (tested via injectable spawnFn), now it delegates to
// channelRuntime which keeps long-lived in-process AgentSessions per channel.
// Active-path tests live in channelRuntime.test.ts where the SDK-level
// Pi machinery can be stubbed at the right layer.
// =============================================================================

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
        installChannelRouter();

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
        installChannelRouter();

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
