process.env["BOT_NAME"] = "_test_rate_limiter";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { getVault } from "./vault.js";
import { getWhitelist } from "./whitelist.js";
import { RateLimiter } from "./rateLimiter.js";

const TEST_DIR = botDir();

function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
    getWhitelist().reset();
});

describe("RateLimiter — exemptions", () => {
    it("CLI is always allowed regardless of consumption", () => {
        const rl = new RateLimiter();
        getVault().set("AGENT_RPM", "2");
        for (let i = 0; i < 10; i++) {
            const r = rl.tryConsume("cli", "operator");
            assert.equal(r.allowed, true);
        }
    });

    it("admins are always allowed (infinite remaining, 0 retry)", () => {
        const rl = new RateLimiter();
        getVault().set("AGENT_RPM", "1");
        getWhitelist().add("telegram", "u1", { roles: ["admin"], addedBy: "test" });
        for (let i = 0; i < 10; i++) {
            const r = rl.tryConsume("telegram", "u1");
            assert.equal(r.allowed, true);
        }
    });
});

describe("RateLimiter — bucket consumption", () => {
    it("allows up to capacity, then blocks with retryAfterMs", () => {
        getVault().set("AGENT_RPM", "3");
        const rl = new RateLimiter();
        for (let i = 0; i < 3; i++) {
            const r = rl.tryConsume("telegram", "u1");
            assert.equal(r.allowed, true, `call #${i + 1} should be allowed`);
        }
        const blocked = rl.tryConsume("telegram", "u1");
        assert.equal(blocked.allowed, false);
        assert.equal(blocked.remaining, 0);
        assert.ok(blocked.retryAfterMs > 0, "retryAfterMs must be positive");
    });

    it("different senderIds have independent buckets", () => {
        getVault().set("AGENT_RPM", "1");
        const rl = new RateLimiter();
        assert.equal(rl.tryConsume("telegram", "u1").allowed, true);
        assert.equal(rl.tryConsume("telegram", "u1").allowed, false);
        // u2 gets its own fresh bucket.
        assert.equal(rl.tryConsume("telegram", "u2").allowed, true);
    });

    it("refills over time", async () => {
        getVault().set("AGENT_RPM", "60"); // 1 token per second
        const rl = new RateLimiter();
        // Drain bucket.
        for (let i = 0; i < 60; i++) rl.tryConsume("telegram", "u1");
        const blocked = rl.tryConsume("telegram", "u1");
        assert.equal(blocked.allowed, false);
        // Wait slightly more than 1s for one token to refill.
        await new Promise((r) => setTimeout(r, 1100));
        const afterRefill = rl.tryConsume("telegram", "u1");
        assert.equal(afterRefill.allowed, true);
    });
});

describe("RateLimiter — config + admin ops", () => {
    it("reloadConfig picks up new AGENT_RPM", () => {
        getVault().set("AGENT_RPM", "1");
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "u1"); // creates bucket with capacity 1
        // Update vault + reload.
        getVault().set("AGENT_RPM", "50");
        rl.reloadConfig();
        rl.resetAll();
        // A fresh bucket should now have capacity 50.
        const stats = rl.stats();
        assert.equal(stats.length, 0);
        rl.tryConsume("telegram", "u2");
        const s2 = rl.stats();
        assert.equal(s2[0]!.capacity, 50);
    });

    it("reset clears a single bucket", () => {
        getVault().set("AGENT_RPM", "1");
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "u1");
        assert.equal(rl.reset("telegram", "u1"), true);
        assert.equal(rl.reset("telegram", "u1"), false); // already cleared
    });

    it("resetAll returns count cleared", () => {
        getVault().set("AGENT_RPM", "1");
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "a");
        rl.tryConsume("telegram", "b");
        rl.tryConsume("slack", "c");
        assert.equal(rl.resetAll(), 3);
    });

    it("stats returns buckets sorted by consumed desc", () => {
        getVault().set("AGENT_RPM", "10");
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "quiet");
        for (let i = 0; i < 5; i++) rl.tryConsume("telegram", "chatty");
        const s = rl.stats();
        assert.equal(s[0]!.senderId, "chatty");
        assert.equal(s[0]!.consumed, 5);
        assert.equal(s[1]!.senderId, "quiet");
    });

    it("falls back to default RPM when vault AGENT_RPM is missing or invalid", () => {
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "u1");
        assert.equal(rl.stats()[0]!.capacity, 30);

        rl.resetAll();
        rl.reloadConfig();
        getVault().set("AGENT_RPM", "not-a-number");
        rl.reloadConfig();
        rl.tryConsume("telegram", "u2");
        assert.equal(rl.stats()[0]!.capacity, 30);
    });
});

describe("RateLimiter — status (peek)", () => {
    it("peeks without consuming", () => {
        getVault().set("AGENT_RPM", "5");
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "u1"); // creates bucket, consumes 1
        const s = rl.status("telegram", "u1");
        assert.equal(s.capacity, 5);
        assert.equal(s.tokens, 4);
        const s2 = rl.status("telegram", "u1");
        assert.equal(s2.tokens, 4);
    });

    it("reports retryAfterMs when drained", () => {
        getVault().set("AGENT_RPM", "2");
        const rl = new RateLimiter();
        rl.tryConsume("telegram", "u1");
        rl.tryConsume("telegram", "u1");
        rl.tryConsume("telegram", "u1"); // one blocked
        const s = rl.status("telegram", "u1");
        assert.ok(s.retryAfterMs > 0);
    });
});
