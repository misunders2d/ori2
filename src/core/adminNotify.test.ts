process.env["BOT_NAME"] = "_test_admin_notify";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { getVault } from "./vault.js";
import { getWhitelist } from "./whitelist.js";
import { clearRegistryForTests } from "./singletons.js";
import { TransportDispatcher } from "../transport/dispatcher.js";
import type {
    AdapterStatus,
    AgentResponse,
    Message,
    MessageHandler,
    TransportAdapter,
} from "../transport/types.js";
import { AdminNotifier, getAdminNotifier } from "./adminNotify.js";

const TEST_DIR = botDir();

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

class FakeAdapter implements TransportAdapter {
    public readonly platform: string;
    public sent: Array<{ channelId: string; response: AgentResponse }> = [];
    private handler: MessageHandler | null = null;
    public sendShouldThrow = false;
    constructor(platform: string) { this.platform = platform; }
    setHandler(h: MessageHandler): void { this.handler = h; }
    async start(): Promise<void> { /* noop */ }
    async stop(): Promise<void> { /* noop */ }
    async send(channelId: string, response: AgentResponse): Promise<void> {
        if (this.sendShouldThrow) throw new Error("fake adapter send failure");
        this.sent.push({ channelId, response });
    }
    status(): AdapterStatus { return { platform: this.platform, state: "running" }; }
    /** Trip-wire used by one test — adapter installs as cli but lets us
     * verify notifier doesn't try to DM cli platform. */
    asCli(): this {
        (this as unknown as { __isOriCliAdapter: boolean }).__isOriCliAdapter = true;
        return this;
    }
    /** Tests that simulate an inbound use this; not needed by adminNotify. */
    async simulateInbound(msg: Message): Promise<void> {
        if (!this.handler) throw new Error("handler not installed");
        await this.handler(msg);
    }
}

function strangerMsg(overrides?: Partial<Message>): Message {
    return {
        platform: "telegram",
        channelId: "12345",
        senderId: "12345",
        senderDisplayName: "@StrangerBob",
        timestamp: Date.now(),
        text: "hi, are you the bot?",
        addressedToBot: true,
        ...overrides,
    };
}

let captured: string[] = [];
const origWarn = console.warn;
const origLog = console.log;
function silenceConsole() {
    captured = [];
    console.warn = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
    console.log = (...args: unknown[]) => { captured.push(args.map(String).join(" ")); };
}
function restoreConsole() {
    console.warn = origWarn;
    console.log = origLog;
}

before(rmTestDir);
after(() => { rmTestDir(); restoreConsole(); });
beforeEach(() => {
    rmTestDir();
    clearRegistryForTests();
    getVault().reset();
    getWhitelist().reset();
    silenceConsole();
});

describe("AdminNotifier — admin recipient resolution", () => {
    it("resolves whitelist entries holding the admin role", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        getWhitelist().add("telegram", "222", { roles: ["user"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);

        await new AdminNotifier().notifyUnknownUser(strangerMsg());

        assert.equal(adapter.sent.length, 1);
        assert.equal(adapter.sent[0]!.channelId, "111");
    });

    it("resolves keyed vault ADMIN_USER_IDS entries", async () => {
        getVault().set("ADMIN_USER_IDS", "telegram:999,telegram:888");
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);

        await new AdminNotifier().notifyUnknownUser(strangerMsg());

        const channels = adapter.sent.map((s) => s.channelId).sort();
        assert.deepEqual(channels, ["888", "999"]);
    });

    it("skips plain (non-keyed) vault ADMIN_USER_IDS entries — no platform to route to", async () => {
        // Plain "operator" is the typical CLI-bootstrap form. Has no DM target.
        getVault().set("ADMIN_USER_IDS", "operator");
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);

        await new AdminNotifier().notifyUnknownUser(strangerMsg());

        assert.equal(adapter.sent.length, 0);
        // But console.warn fallback still fires.
        assert.ok(captured.some((l) => l.includes("Unknown user wants to reach the bot")));
    });

    it("dedupes admins seen in BOTH whitelist and vault", async () => {
        getWhitelist().add("telegram", "777", { roles: ["admin"], addedBy: "test" });
        getVault().set("ADMIN_USER_IDS", "telegram:777");
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);

        await new AdminNotifier().notifyUnknownUser(strangerMsg());

        assert.equal(adapter.sent.length, 1);
        assert.equal(adapter.sent[0]!.channelId, "777");
    });
});

describe("AdminNotifier — cooldown / dedupe", () => {
    it("notifies once, then silences repeats from same stranger", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        const n = new AdminNotifier();

        await n.notifyUnknownUser(strangerMsg());
        await n.notifyUnknownUser(strangerMsg());
        await n.notifyUnknownUser(strangerMsg({ text: "still here" }));

        assert.equal(adapter.sent.length, 1, "only the first notification should fire within cooldown");
    });

    it("treats different (platform, senderId) tuples as separate strangers", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        const n = new AdminNotifier();

        await n.notifyUnknownUser(strangerMsg({ senderId: "x" }));
        await n.notifyUnknownUser(strangerMsg({ senderId: "y" }));
        await n.notifyUnknownUser(strangerMsg({ senderId: "x" })); // x is still in cooldown

        assert.equal(adapter.sent.length, 2);
    });

    it("re-notifies after cooldown expires", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        const n = new AdminNotifier();

        await n.notifyUnknownUser(strangerMsg());
        // Reach into the dedupe map and backdate the entry past the 1h cooldown.
        // (Doing this without exposing internals would require fake timers,
        // which node:test doesn't ship by default. The internal map is the
        // contract under test, so manipulating it is acceptable.)
        const internal = n as unknown as { lastNotified: Map<string, number> };
        const key = "telegram:12345";
        internal.lastNotified.set(key, Date.now() - 61 * 60 * 1000); // 61 min ago

        await n.notifyUnknownUser(strangerMsg());

        assert.equal(adapter.sent.length, 2);
    });
});

describe("AdminNotifier — multi-admin fan-out + error isolation", () => {
    it("DMs every reachable admin, even when one's send throws", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        getWhitelist().add("telegram", "222", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        // Make the FIRST send throw, second succeed.
        let first = true;
        const origSend = adapter.send.bind(adapter);
        adapter.send = async (chat, resp) => {
            if (first) { first = false; throw new Error("boom"); }
            return origSend(chat, resp);
        };

        await new AdminNotifier().notifyUnknownUser(strangerMsg());

        // The successful send should have landed for the second admin.
        assert.equal(adapter.sent.length, 1);
        // And the failure should have surfaced via console.warn.
        assert.ok(captured.some((l) => l.includes("failed to DM")));
    });
});

describe("AdminNotifier — non-DM-capable platforms", () => {
    it("skips dispatcher.send for cli admins (no DM convention)", async () => {
        getWhitelist().add("cli", "operator", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("cli").asCli();
        TransportDispatcher.instance().register(adapter);

        await new AdminNotifier().notifyUnknownUser(strangerMsg());

        assert.equal(adapter.sent.length, 0);
        // Console.warn fallback is the operator's notification path.
        assert.ok(captured.some((l) => l.includes("Unknown user wants to reach the bot")));
    });

    it("skips admin whose platform has no registered adapter (operator may have disabled it)", async () => {
        getWhitelist().add("slack", "U999", { roles: ["admin"], addedBy: "test" });
        // No slack adapter registered.

        await new AdminNotifier().notifyUnknownUser(strangerMsg());
        // No throw, no send anywhere — only the console.warn header.
        assert.ok(captured.some((l) => l.includes("Unknown user wants to reach the bot")));
    });
});

describe("AdminNotifier — notification text", () => {
    it("contains the copy-pasteable /whitelist + /blacklist commands keyed on stranger identity", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);

        await new AdminNotifier().notifyUnknownUser(
            strangerMsg({ senderId: "9876543210", senderDisplayName: "@Probe" }),
        );

        assert.equal(adapter.sent.length, 1);
        const body = adapter.sent[0]!.response.text;
        assert.match(body, /Unknown user wants to reach the bot/);
        assert.match(body, /@Probe \(9876543210\) on telegram/);
        assert.match(body, /\/whitelist add telegram 9876543210$/m);
        assert.match(body, /\/whitelist add telegram 9876543210 admin/);
        assert.match(body, /\/blacklist add telegram 9876543210 unsolicited/);
    });

    it("truncates very long stranger messages and shows a placeholder for empty text", async () => {
        getWhitelist().add("telegram", "111", { roles: ["admin"], addedBy: "test" });
        const adapter = new FakeAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        const n = new AdminNotifier();

        await n.notifyUnknownUser(strangerMsg({ senderId: "long", text: "x".repeat(500) }));
        const longBody = adapter.sent[0]!.response.text;
        assert.ok(longBody.includes("…"), "long text should be truncated with ellipsis");
        assert.ok(!longBody.includes("x".repeat(300)), "should not contain the full 500 chars");

        await n.notifyUnknownUser(strangerMsg({ senderId: "empty", text: "" }));
        const emptyBody = adapter.sent[1]!.response.text;
        assert.match(emptyBody, /\(no text — message contained only attachments\)/);
    });
});

describe("AdminNotifier — singleton accessor", () => {
    it("getAdminNotifier returns the same instance across calls", () => {
        const a = getAdminNotifier();
        const b = getAdminNotifier();
        assert.strictEqual(a, b);
    });
});
