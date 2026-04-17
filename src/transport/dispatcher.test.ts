import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { TransportDispatcher } from "./dispatcher.js";
import type {
    AdapterStatus,
    AgentResponse,
    Message,
    MessageHandler,
    TransportAdapter,
} from "./types.js";

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
    status(): AdapterStatus {
        return { platform: this.platform, state: "running" };
    }
    /** Shortcut for tests to fire an inbound message as if from the adapter. */
    async simulateInbound(msg: Message): Promise<void> {
        if (!this.handler) throw new Error("handler not installed");
        await this.handler(msg);
    }
}

function sampleMsg(platform: string, overrides?: Partial<Message>): Message {
    return {
        platform,
        channelId: `${platform}:chan-1`,
        senderId: "user-1",
        senderDisplayName: "User One",
        timestamp: Date.now(),
        text: "hello",
        ...overrides,
    };
}

describe("TransportDispatcher — post-block hooks", () => {
    beforeEach(() => TransportDispatcher.__resetForTests());

    it("fires post-block hooks when a pre-hook returns block:true", async () => {
        const d = TransportDispatcher.instance();
        const adapter = new FakeAdapter("test");
        d.register(adapter);

        d.addPreDispatchHook(() => ({ block: true, reason: "whitelist miss" }));

        const seen: Array<{ msg: Message; reason: string }> = [];
        d.addPostBlockHook((msg, reason) => { seen.push({ msg, reason }); });

        const msg = sampleMsg("test");
        await adapter.simulateInbound(msg);

        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.reason, "whitelist miss");
        assert.equal(seen[0]!.msg.senderId, "user-1");
    });

    it("does NOT fire post-block hooks for delivered messages", async () => {
        const d = TransportDispatcher.instance();
        const adapter = new FakeAdapter("test");
        d.register(adapter);
        d.setPushToPi(async () => { /* accept */ });

        let blockCalls = 0;
        d.addPostBlockHook(() => { blockCalls++; });

        await adapter.simulateInbound(sampleMsg("test"));
        assert.equal(blockCalls, 0);
    });

    it("fires for every pre-hook that blocks — whitelist, rate limit, etc.", async () => {
        const d = TransportDispatcher.instance();
        const adapter = new FakeAdapter("test");
        d.register(adapter);

        d.addPreDispatchHook((m) => {
            if (m.senderId === "bad") return { block: true, reason: "whitelist miss" };
            return { block: false };
        });
        d.addPreDispatchHook((m) => {
            if (m.senderId === "flooder") return { block: true, reason: "rate limit" };
            return { block: false };
        });
        d.setPushToPi(async () => { /* accept */ });

        const seen: Array<{ reason: string; senderId: string }> = [];
        d.addPostBlockHook((msg, reason) => { seen.push({ reason, senderId: msg.senderId }); });

        await adapter.simulateInbound(sampleMsg("test", { senderId: "bad" }));
        await adapter.simulateInbound(sampleMsg("test", { senderId: "flooder" }));
        await adapter.simulateInbound(sampleMsg("test", { senderId: "ok" }));

        assert.equal(seen.length, 2);
        assert.deepEqual(seen.map((s) => s.reason).sort(), ["rate limit", "whitelist miss"]);
    });

    it("a post-block hook exception doesn't prevent other post-block hooks from running", async () => {
        const d = TransportDispatcher.instance();
        const adapter = new FakeAdapter("test");
        d.register(adapter);

        d.addPreDispatchHook(() => ({ block: true, reason: "nope" }));

        d.addPostBlockHook(() => { throw new Error("first hook boom"); });
        let secondCalled = false;
        d.addPostBlockHook(() => { secondCalled = true; });

        await adapter.simulateInbound(sampleMsg("test"));
        assert.equal(secondCalled, true);
    });

    it("adapter still gets the block-surface send() regardless of post-block hooks", async () => {
        const d = TransportDispatcher.instance();
        const adapter = new FakeAdapter("test");
        d.register(adapter);
        d.addPreDispatchHook(() => ({ block: true, reason: "forbidden" }));
        d.addPostBlockHook(() => { throw new Error("observer error"); });

        await adapter.simulateInbound(sampleMsg("test"));
        assert.equal(adapter.sent.length, 1);
        assert.match(adapter.sent[0]!.response.text ?? "", /forbidden/);
    });
});
