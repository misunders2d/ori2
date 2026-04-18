process.env["BOT_NAME"] = "_test_egress_allowlist";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { clearRegistryForTests } from "./singletons.js";
import { EgressAllowlist } from "./egressAllowlist.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    clearRegistryForTests();
});

describe("EgressAllowlist — built-in platform defaults", () => {
    it("ships with sensible google + github defaults", () => {
        const a = new EgressAllowlist();
        assert.ok(a.allowsPlatform("google", "https://gmail.googleapis.com/v1/users/me/messages"));
        assert.ok(a.allowsPlatform("google", "https://www.googleapis.com/oauth2/v2/userinfo"));
        assert.ok(a.allowsPlatform("github", "https://api.github.com/user"));
    });

    it("rejects look-alike attacker hosts", () => {
        const a = new EgressAllowlist();
        assert.equal(a.allowsPlatform("google", "https://evil-googleapis.com/exfil"), false);
        assert.equal(a.allowsPlatform("google", "https://googleapis.com.evil.example/x"), false);
        assert.equal(a.allowsPlatform("github", "https://api-github-com.evil.com/user"), false);
    });

    it("rejects http:// (would leak bearer in plaintext) but allows http://localhost for dev", () => {
        const a = new EgressAllowlist();
        a.addPlatformHost("internal", "127.0.0.1");
        assert.equal(a.allowsPlatform("google", "http://googleapis.com/x"), false, "no http for external hosts");
        assert.ok(a.allowsPlatform("internal", "http://127.0.0.1:8080/api"), "localhost dev allowed");
    });

    it("rejects malformed URLs gracefully", () => {
        const a = new EgressAllowlist();
        assert.equal(a.allowsPlatform("google", "not a url"), false);
        assert.equal(a.allowsPlatform("google", ""), false);
    });
});

describe("EgressAllowlist — credential allowlist (per-credential, not per-platform)", () => {
    it("returns false for any URL when credential has no entries", () => {
        const a = new EgressAllowlist();
        // credential never registered — empty set → reject everything.
        assert.equal(a.allowsCredential("brand_new_cred", "https://api.stripe.com/v1/charges"), false);
    });

    it("allows after admin adds host", () => {
        const a = new EgressAllowlist();
        a.addCredentialHost("stripe_live", "api.stripe.com");
        assert.ok(a.allowsCredential("stripe_live", "https://api.stripe.com/v1/charges"));
        // Other credential id is independent.
        assert.equal(a.allowsCredential("clickup", "https://api.stripe.com/v1/charges"), false);
    });

    it("subdomain match works (api.stripe.com allows charges-api.stripe.com)", () => {
        const a = new EgressAllowlist();
        a.addCredentialHost("stripe_live", "stripe.com");
        assert.ok(a.allowsCredential("stripe_live", "https://api.stripe.com/x"));
        assert.ok(a.allowsCredential("stripe_live", "https://files.stripe.com/x"));
        // But not the bare domain look-alike.
        assert.equal(a.allowsCredential("stripe_live", "https://stripe.com.evil/x"), false);
    });
});

describe("EgressAllowlist — add/remove/list operations", () => {
    it("adding the same host twice is idempotent", () => {
        const a = new EgressAllowlist();
        a.addPlatformHost("google", "googleapis.com"); // already present from defaults
        a.addPlatformHost("google", "googleapis.com");
        const hosts = a.listPlatformHosts("google");
        assert.equal(hosts.filter((h) => h === "googleapis.com").length, 1);
    });

    it("remove returns true when host existed, false otherwise", () => {
        const a = new EgressAllowlist();
        assert.ok(a.removePlatformHost("google", "googleapis.com"));
        assert.equal(a.removePlatformHost("google", "googleapis.com"), false);
        assert.equal(a.allowsPlatform("google", "https://googleapis.com/x"), false);
    });

    it("listAllPlatforms / listAllCredentials enumerate everything", () => {
        const a = new EgressAllowlist();
        a.addPlatformHost("custom_oauth", "api.custom.com");
        a.addCredentialHost("custom_cred", "api.example.com");

        const platforms = a.listAllPlatforms().map((p) => p.platform).sort();
        assert.ok(platforms.includes("google"));
        assert.ok(platforms.includes("github"));
        assert.ok(platforms.includes("custom_oauth"));

        const creds = a.listAllCredentials();
        assert.deepEqual(creds, [{ credential: "custom_cred", hosts: ["api.example.com"] }]);
    });
});

describe("EgressAllowlist — persistence", () => {
    it("changes survive a fresh load", () => {
        const a1 = new EgressAllowlist();
        a1.addCredentialHost("stripe_live", "api.stripe.com");
        const a2 = new EgressAllowlist(); // fresh instance reads file
        assert.ok(a2.allowsCredential("stripe_live", "https://api.stripe.com/v1/x"));
    });
});
