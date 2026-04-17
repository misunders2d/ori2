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
        addressedToBot: true,
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

describe("TransportDispatcher — routing on addressedToBot + platform", () => {
    beforeEach(() => TransportDispatcher.__resetForTests());

    it("CLI inbound always goes to pushToPi (live Pi runtime)", async () => {
        const d = TransportDispatcher.instance();
        // Use the CLI adapter sentinel shape — a bare FakeAdapter can't claim
        // platform="cli" (dispatcher rejects without the __isOriCliAdapter
        // marker). Build a shim with the marker.
        const cliLike = Object.assign(new FakeAdapter("cli"), { __isOriCliAdapter: true });
        d.register(cliLike as unknown as TransportAdapter);

        let pushed = 0;
        let active = 0;
        let passive = 0;
        d.setPushToPi(() => { pushed++; });
        d.setOnActiveResponse(() => { active++; });
        d.setOnPassiveContext(() => { passive++; });

        await cliLike.simulateInbound(sampleMsg("cli"));
        assert.equal(pushed, 1, "CLI must route to pushToPi");
        assert.equal(active, 0, "CLI must NOT route to onActiveResponse");
        assert.equal(passive, 0, "CLI must NOT route to onPassiveContext");
    });

    it("non-CLI addressed=true routes to onActiveResponse (NOT pushToPi)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        let pushed = 0;
        let active = 0;
        d.setPushToPi(() => { pushed++; });
        d.setOnActiveResponse(() => { active++; });

        await tg.simulateInbound(sampleMsg("telegram", { addressedToBot: true }));
        assert.equal(active, 1);
        assert.equal(pushed, 0, "non-CLI must NOT reach the live runtime");
    });

    it("non-CLI addressed=false routes to onPassiveContext (NOT pushToPi)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        let pushed = 0;
        let passive = 0;
        d.setPushToPi(() => { pushed++; });
        d.setOnPassiveContext(() => { passive++; });

        await tg.simulateInbound(sampleMsg("telegram", { addressedToBot: false }));
        assert.equal(passive, 1);
        assert.equal(pushed, 0);
    });

    it("non-CLI addressed=true is dropped (with warning) when onActiveResponse unwired", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);
        // Intentionally do NOT set onActiveResponse.

        await tg.simulateInbound(sampleMsg("telegram", { addressedToBot: true }));
        // Adapter.send() NOT invoked — we silently dropped, not replied with
        // an error. The console.warn is enough signal for operators.
        assert.equal(tg.sent.length, 0);
    });

    it("non-CLI addressed=false is dropped (with warning) when onPassiveContext unwired", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        await tg.simulateInbound(sampleMsg("telegram", { addressedToBot: false }));
        assert.equal(tg.sent.length, 0);
    });

    it("CLI messages received before pushToPi wired are buffered and drained on wire-up", async () => {
        const d = TransportDispatcher.instance();
        const cliLike = Object.assign(new FakeAdapter("cli"), { __isOriCliAdapter: true });
        d.register(cliLike as unknown as TransportAdapter);

        // Two CLI messages arrive before the runtime wires pushToPi.
        await cliLike.simulateInbound(sampleMsg("cli", { text: "first" }));
        await cliLike.simulateInbound(sampleMsg("cli", { text: "second" }));

        const received: string[] = [];
        d.setPushToPi((msg) => { received.push(msg.text); });

        // Drain is async (fire-and-forget per the source). Yield once.
        await new Promise((r) => setImmediate(r));
        assert.deepEqual(received, ["first", "second"]);
    });

    it("non-CLI messages received before handlers wired are NOT buffered (dropped)", async () => {
        const d = TransportDispatcher.instance();
        const tg = new FakeAdapter("telegram");
        d.register(tg);

        // This arrives before onActiveResponse is wired — should be dropped
        // (buffering per-handler types that may never get wired in this
        // process would leak memory).
        await tg.simulateInbound(sampleMsg("telegram", { addressedToBot: true }));

        let active = 0;
        d.setOnActiveResponse(() => { active++; });

        // No drain happened — the earlier message is gone.
        await new Promise((r) => setImmediate(r));
        assert.equal(active, 0);
    });
});
