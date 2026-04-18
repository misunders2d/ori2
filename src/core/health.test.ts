process.env["BOT_NAME"] = "_test_health";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir, secretSubdir, ensureSecretDir } from "./paths.js";
import { getVault } from "./vault.js";
import { getFriends } from "../a2a/friends.js";
import { getA2AAdapter } from "../a2a/adapter.js";
import { setA2AServerHandle } from "../a2a/server.js";
import { TransportDispatcher } from "../transport/dispatcher.js";
import type { AdapterStatus, AgentResponse, MessageHandler, TransportAdapter } from "../transport/types.js";
import { writeHeartbeat, clearHeartbeatsForTests } from "./heartbeat.js";
import { logError, logWarning, clearForTests as clearErrors } from "./errorLog.js";
import { getOAuth } from "./oauth.js";
import { getHealth, formatHealth } from "./health.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

// A trivial adapter for health-report testing.
class StubAdapter implements TransportAdapter {
    public state: AdapterStatus["state"] = "running";
    constructor(public readonly platform: string) {}
    setHandler(_h: MessageHandler): void { /* noop */ }
    async start(): Promise<void> { /* noop */ }
    async stop(): Promise<void> { this.state = "stopped"; }
    async send(_c: string, _r: AgentResponse): Promise<void> { /* noop */ }
    status(): AdapterStatus { return { platform: this.platform, state: this.state }; }
}

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
    // Suppress "a2a: server not running" degradation for tests that don't
    // spin up a server. Individual tests can override.
    getVault().set("A2A_TUNNEL_MODE", "disabled");
});

describe("getHealth — basic shape", () => {
    it("returns a healthy report when everything is configured correctly", async () => {
        TransportDispatcher.instance().register(new StubAdapter("test-inbound"));
        // Corpus has to exist at <project>/.pi/extensions/guardrail_corpus.json.
        // It does in the repo, so the default state is healthy.
        const r = await getHealth();
        assert.equal(r.bot_name, "_test_health");
        assert.equal(typeof r.uptime_s, "number");
        assert.ok(r.uptime_s >= 0);
        assert.ok(Array.isArray(r.adapters));
        assert.equal(r.adapters[0]!.platform, "test-inbound");
        assert.equal(r.status, "healthy");
        assert.deepEqual(r.warnings, []);
    });

    it("flags unhealthy when no adapters are registered", async () => {
        const r = await getHealth();
        assert.equal(r.status, "unhealthy");
        assert.ok(r.warnings.some((w) => w.includes("no transport adapters")));
    });

    it("flags degraded when OAuth has expired tokens", async () => {
        TransportDispatcher.instance().register(new StubAdapter("test-inbound"));
        // Seed an oauth state with an expired token without going through the
        // full register → device flow. Write the platforms + tokens files
        // directly and reload.
        fs.mkdirSync(TEST_DIR, { recursive: true });
        ensureSecretDir(secretSubdir());
        fs.writeFileSync(path.join(secretSubdir(), "oauth_platforms.json"), JSON.stringify({
            version: 1,
            updated_at: Date.now(),
            platforms: {
                google: {
                    id: "google",
                    name: "Google",
                    flow: "device_code",
                    client_id: "x",
                    token_endpoint: "https://oauth2.googleapis.com/token",
                    device_authorization_endpoint: "https://oauth2.googleapis.com/device/code",
                    default_scope: ["email"],
                    refresh_supported: true,
                },
            },
        }));
        fs.writeFileSync(path.join(secretSubdir(), "oauth_tokens.json"), JSON.stringify({
            version: 1,
            updated_at: Date.now(),
            tokens: {
                google: {
                    access_token: "expired",
                    token_type: "Bearer",
                    expires_at: Date.now() - 5_000, // expired 5s ago
                    obtained_at: Date.now() - 3600_000,
                    scope: "email",
                },
            },
        }));
        // Force re-read.
        (await import("./oauth.js")).getOAuth().reload();
        const r = await getHealth();
        assert.equal(r.status, "degraded");
        assert.ok(r.warnings.some((w) => w.includes("oauth") && w.includes("expired")), `expected oauth expired warning, got ${JSON.stringify(r.warnings)}`);
    });
});

describe("getHealth — heartbeats", () => {
    it("detects stale heartbeats", async () => {
        TransportDispatcher.instance().register(new StubAdapter("telegram"));
        // Forge an old heartbeat.
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const file = path.join(TEST_DIR, ".heartbeat.telegram");
        fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 5 * 60_000 }));
        const r = await getHealth();
        assert.equal(r.status, "degraded");
        const tg = r.adapters.find((a) => a.platform === "telegram");
        assert.equal(tg?.heartbeat?.present, true);
        assert.equal(tg?.heartbeat?.stale, true);
        assert.ok(r.warnings.some((w) => w.includes("heartbeat stale")));
    });

    it("fresh heartbeats don't warn", async () => {
        TransportDispatcher.instance().register(new StubAdapter("telegram"));
        writeHeartbeat("telegram", "just polled");
        const r = await getHealth();
        const tg = r.adapters.find((a) => a.platform === "telegram");
        assert.equal(tg?.heartbeat?.present, true);
        assert.equal(tg?.heartbeat?.stale, false);
        assert.equal(r.status, "healthy");
    });
});

describe("getHealth — error ledger integration", () => {
    it("elevated error count in the last hour bumps status to degraded", async () => {
        TransportDispatcher.instance().register(new StubAdapter("test-inbound"));
        // Write 6 errors — above the "elevated" threshold (>5) but below loud (>20)
        for (let i = 0; i < 6; i++) logError("x", `msg-${i}`);
        const r = await getHealth({ errorSample: 3 });
        assert.equal(r.status, "degraded");
        assert.ok(r.warnings.some((w) => /elevated|hour/.test(w)));
        assert.ok(r.errors.recent && r.errors.recent.length === 3);
    });

    it("1 error does NOT degrade status", async () => {
        TransportDispatcher.instance().register(new StubAdapter("test-inbound"));
        logError("x", "just one");
        logWarning("x", "just one warn");
        const r = await getHealth();
        assert.equal(r.status, "healthy");
    });
});

describe("getHealth — deep probes", () => {
    it("invokes the injected fetchImpl for Telegram getMe when configured", async () => {
        TransportDispatcher.instance().register(new StubAdapter("telegram"));
        getVault().set("TELEGRAM_BOT_TOKEN", "fake-token");
        let tgProbed = false;
        const fakeFetch = ((input: RequestInfo | URL) => {
            const url = typeof input === "string" ? input : (input as URL).toString();
            if (url.includes("telegram.org/bot")) {
                tgProbed = true;
                return Promise.resolve(new Response(JSON.stringify({ ok: true, result: { id: 1 } }), { status: 200 }));
            }
            return Promise.reject(new Error("unexpected fetch"));
        }) as typeof fetch;
        const r = await getHealth({ deep: true, fetchImpl: fakeFetch });
        assert.equal(tgProbed, true);
        const tg = r.adapters.find((a) => a.platform === "telegram");
        assert.equal(tg?.probe?.ok, true);
    });

    it("friend probes surface unreachable peers as degraded", async () => {
        TransportDispatcher.instance().register(new StubAdapter("test-inbound"));
        getFriends().add("Offline", { url: "https://offline.example", agent_id: "o", added_by: "t" });
        const fakeFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
        const r = await getHealth({ deep: true, fetchImpl: fakeFetch });
        assert.ok(r.a2a.friend_probes);
        assert.equal(r.a2a.friend_probes!.length, 1);
        assert.equal(r.a2a.friend_probes![0]!.ok, false);
        assert.equal(r.status, "degraded");
        assert.ok(r.warnings.some((w) => w.includes("friend")));
    });
});

describe("formatHealth", () => {
    it("produces a readable multi-line summary", async () => {
        TransportDispatcher.instance().register(new StubAdapter("test-inbound"));
        const r = await getHealth();
        const text = formatHealth(r);
        assert.ok(text.includes("Health:"));
        assert.ok(text.includes("Adapters:"));
        assert.ok(text.includes("Memory:"));
        assert.ok(text.includes("A2A:"));
    });
});
