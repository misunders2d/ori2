process.env["BOT_NAME"] = "_test_proactive_diag";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { getVault } from "./vault.js";
import { getFriends } from "../a2a/friends.js";
import { getA2AAdapter } from "../a2a/adapter.js";
import { setA2AServerHandle } from "../a2a/server.js";
import { TransportDispatcher } from "../transport/dispatcher.js";
import type { AdapterStatus, AgentResponse, MessageHandler, TransportAdapter } from "../transport/types.js";
import { clearHeartbeatsForTests } from "./heartbeat.js";
import { clearForTests as clearErrors } from "./errorLog.js";
import { getOAuth } from "./oauth.js";
import { parseAdmins, composeAlert, runCheckOnceForTests, resetForTests } from "./proactiveDiagnostics.js";
import { getHealth } from "./health.js";

class RecordingAdapter implements TransportAdapter {
    public state: AdapterStatus["state"] = "running";
    public sent: Array<{ channelId: string; response: AgentResponse }> = [];
    public shouldFail = false;
    constructor(public readonly platform: string) {}
    setHandler(_: MessageHandler): void { /* noop */ }
    async start(): Promise<void> { this.state = "running"; }
    async stop(): Promise<void> { this.state = "stopped"; }
    async send(channelId: string, response: AgentResponse): Promise<void> {
        if (this.shouldFail) throw new Error("send failed");
        this.sent.push({ channelId, response });
    }
    status(): AdapterStatus { return { platform: this.platform, state: this.state }; }
}

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
    getFriends().reset();
    getA2AAdapter().reset();
    setA2AServerHandle(null);
    clearHeartbeatsForTests();
    clearErrors();
    TransportDispatcher.__resetForTests();
    getOAuth().reload();
    resetForTests();
    getVault().set("A2A_TUNNEL_MODE", "disabled");
});

describe("parseAdmins", () => {
    it("returns empty for undefined/empty", () => {
        assert.deepEqual(parseAdmins(undefined), []);
        assert.deepEqual(parseAdmins(""), []);
        assert.deepEqual(parseAdmins("   "), []);
    });

    it("parses platform:senderId form", () => {
        const r = parseAdmins("telegram:12345,a2a:WebAgent");
        assert.deepEqual(r, [
            { platform: "telegram", senderId: "12345" },
            { platform: "a2a", senderId: "WebAgent" },
        ]);
    });

    it("expands bare senderId into preferred-platform candidates", () => {
        const r = parseAdmins("12345");
        // Default preference is telegram > a2a.
        assert.equal(r.length, 2);
        assert.equal(r[0]!.platform, "telegram");
        assert.equal(r[0]!.senderId, "12345");
        assert.equal(r[1]!.platform, "a2a");
        assert.equal(r[1]!.senderId, "12345");
    });

    it("mixes forms and trims whitespace", () => {
        const r = parseAdmins(" telegram:42 , 99 ");
        assert.deepEqual(r[0], { platform: "telegram", senderId: "42" });
        // 99 expands to 2 preferred-platform entries.
        assert.ok(r.length >= 2);
    });

    it("ignores malformed entries (empty platform or senderId)", () => {
        const r = parseAdmins(":,telegram:,:12345,good:id");
        assert.deepEqual(r, [{ platform: "good", senderId: "id" }]);
    });
});

describe("composeAlert", () => {
    it("includes bot name, status, uptime, warnings, and recent errors", async () => {
        const report = await getHealth();
        // Forge a degraded report for the test.
        const mutated = {
            ...report,
            status: "degraded" as const,
            warnings: ["adapter telegram: heartbeat stale (120s)", "oauth: 1 token(s) expired"],
            errors: {
                ...report.errors,
                recent: [
                    { at: Date.now(), subsystem: "telegram", severity: "error" as const, message: "poll 401" },
                ],
            },
        };
        const body = composeAlert(mutated);
        assert.ok(body.includes("DEGRADED"));
        assert.ok(body.includes(mutated.bot_name));
        assert.ok(body.includes("heartbeat stale"));
        assert.ok(body.includes("poll 401"));
        assert.ok(body.includes("/health")); // action hint
    });

    it("truncates at 10 warnings with a continuation note", async () => {
        const report = await getHealth();
        const mutated = { ...report, status: "degraded" as const, warnings: [] as string[] };
        for (let i = 0; i < 15; i++) mutated.warnings.push(`warning ${i}`);
        const body = composeAlert(mutated);
        assert.ok(body.includes("warning 0"));
        assert.ok(body.includes("warning 9"));
        assert.ok(body.includes("+5 more"));
        assert.ok(!body.includes("warning 10"));
    });
});

describe("runCheck — delivery", () => {
    it("delivers DM to a registered admin via telegram when status is degraded", async () => {
        const telegram = new RecordingAdapter("telegram");
        TransportDispatcher.instance().register(telegram);
        getVault().set("ADMIN_USER_IDS", "telegram:999");
        // Force degradation: forge stale heartbeat so adapter heartbeat goes stale.
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(`${TEST_DIR}/.heartbeat.telegram`, JSON.stringify({ at: Date.now() - 5 * 60_000 }));

        await runCheckOnceForTests();

        assert.equal(telegram.sent.length, 1);
        assert.equal(telegram.sent[0]!.channelId, "999");
        assert.ok(telegram.sent[0]!.response.text!.includes("DEGRADED"));
    });

    it("does NOT spam when the same warning persists across checks", async () => {
        const telegram = new RecordingAdapter("telegram");
        TransportDispatcher.instance().register(telegram);
        getVault().set("ADMIN_USER_IDS", "telegram:999");
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(`${TEST_DIR}/.heartbeat.telegram`, JSON.stringify({ at: Date.now() - 5 * 60_000 }));

        await runCheckOnceForTests();
        const firstSent = telegram.sent.length;
        await runCheckOnceForTests();
        const secondSent = telegram.sent.length;

        assert.equal(firstSent, 1);
        assert.equal(secondSent, 1, "second identical-warning check should NOT re-send");
    });

    it("re-DMs when warnings CHANGE between checks", async () => {
        const telegram = new RecordingAdapter("telegram");
        TransportDispatcher.instance().register(telegram);
        getVault().set("ADMIN_USER_IDS", "telegram:999");
        fs.mkdirSync(TEST_DIR, { recursive: true });

        // First check: stale telegram heartbeat.
        fs.writeFileSync(`${TEST_DIR}/.heartbeat.telegram`, JSON.stringify({ at: Date.now() - 5 * 60_000 }));
        await runCheckOnceForTests();
        assert.equal(telegram.sent.length, 1);

        // Second check: remove heartbeat, add an OAuth-expired warning instead.
        fs.unlinkSync(`${TEST_DIR}/.heartbeat.telegram`);
        fs.writeFileSync(`${TEST_DIR}/oauth_platforms.json`, JSON.stringify({
            version: 1, updated_at: Date.now(),
            platforms: {
                google: {
                    id: "google", name: "Google", flow: "device_code", client_id: "x",
                    token_endpoint: "https://t/token",
                    device_authorization_endpoint: "https://t/device",
                    default_scope: ["email"], refresh_supported: true,
                },
            },
        }));
        fs.writeFileSync(`${TEST_DIR}/oauth_tokens.json`, JSON.stringify({
            version: 1, updated_at: Date.now(),
            tokens: {
                google: { access_token: "x", token_type: "Bearer", expires_at: Date.now() - 5000, obtained_at: Date.now() - 100000 },
            },
        }));
        getOAuth().reload();
        await runCheckOnceForTests();
        assert.equal(telegram.sent.length, 2, "different warnings should trigger a new DM");
    });

    it("does NOT DM when status is healthy", async () => {
        const adapter = new RecordingAdapter("test-inbound");
        TransportDispatcher.instance().register(adapter);
        getVault().set("ADMIN_USER_IDS", "test-inbound:999");
        await runCheckOnceForTests();
        assert.equal(adapter.sent.length, 0);
    });

    it("falls back to stdout when no admins are configured", async () => {
        const adapter = new RecordingAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        // No ADMIN_USER_IDS set.
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(`${TEST_DIR}/.heartbeat.telegram`, JSON.stringify({ at: Date.now() - 5 * 60_000 }));

        // Capture stderr.
        const origWarn = console.warn;
        const captured: string[] = [];
        console.warn = ((...args: unknown[]) => { captured.push(args.map((a) => String(a)).join(" ")); }) as typeof console.warn;
        try {
            await runCheckOnceForTests();
        } finally {
            console.warn = origWarn;
        }
        assert.ok(captured.some((s) => s.includes("DEGRADED") || s.includes("no admins in vault")));
        assert.equal(adapter.sent.length, 0);
    });

    it("skips targets whose preferred adapter isn't registered", async () => {
        const adapter = new RecordingAdapter("telegram");
        TransportDispatcher.instance().register(adapter);
        // Admin on a2a but no a2a adapter running in this test.
        getVault().set("ADMIN_USER_IDS", "a2a:WebAgent");
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(`${TEST_DIR}/.heartbeat.telegram`, JSON.stringify({ at: Date.now() - 5 * 60_000 }));

        await runCheckOnceForTests();
        assert.equal(adapter.sent.length, 0, "a2a admin target should not be sent via telegram");
    });
});
