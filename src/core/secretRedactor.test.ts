process.env["BOT_NAME"] = "_test_secret_redactor";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { getVault } from "./vault.js";
import { getCredentials } from "./credentials.js";
import { clearRegistryForTests } from "./singletons.js";
import { redactKnownSecrets, _testCollectTargets } from "./secretRedactor.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    clearRegistryForTests();
});

describe("redactKnownSecrets — vault values", () => {
    it("scrubs every vault value from arbitrary text", () => {
        getVault().set("GEMINI_API_KEY", "AIzaSyD-totallySecret-Value-ABC123XYZ");
        getVault().set("ANTHROPIC_API_KEY", "sk-ant-totallySecretValue-987654321");

        const text =
            "Here are the env vars:\n" +
            "GEMINI_API_KEY=AIzaSyD-totallySecret-Value-ABC123XYZ\n" +
            "ANTHROPIC_API_KEY=sk-ant-totallySecretValue-987654321\n";

        const out = redactKnownSecrets(text);
        assert.ok(!out.includes("AIzaSyD-totallySecret"), "Gemini key must be redacted");
        assert.ok(!out.includes("sk-ant-totallySecret"), "Anthropic key must be redacted");
        assert.ok(out.includes("[REDACTED:vault:GEMINI_API_KEY]"));
        assert.ok(out.includes("[REDACTED:vault:ANTHROPIC_API_KEY]"));
    });

    it("scrubs values that appear MULTIPLE times in the same text", () => {
        getVault().set("X", "supersecretvalue1234567890");
        const out = redactKnownSecrets(
            "first: supersecretvalue1234567890 then again supersecretvalue1234567890 done",
        );
        const occurrences = (out.match(/REDACTED:vault:X/g) ?? []).length;
        assert.equal(occurrences, 2);
    });

    it("does NOT redact short values (false-positive risk)", () => {
        getVault().set("SHORT", "abc"); // < 8 chars
        const out = redactKnownSecrets("the abc is fine and abc again");
        assert.equal(out, "the abc is fine and abc again");
    });

    it("returns text unchanged when vault is empty", () => {
        const out = redactKnownSecrets("nothing to redact here, just plain text");
        assert.equal(out, "nothing to redact here, just plain text");
    });
});

describe("redactKnownSecrets — credentials store", () => {
    it("scrubs bearer tokens stored in credentials.json", () => {
        getCredentials().add({
            id: "github_pat",
            secret: "ghp_thisIsAFakeButLongEnoughGitHubToken12345",
            auth_type: "bearer",
            provider: "github",
            addedBy: "test",
        });
        const out = redactKnownSecrets("curl -H 'Authorization: Bearer ghp_thisIsAFakeButLongEnoughGitHubToken12345' https://api.github.com/user");
        assert.ok(!out.includes("ghp_thisIsAFake"));
        assert.ok(out.includes("[REDACTED:cred:github_pat]"));
    });
});

describe("redactKnownSecrets — coverage of all sources", () => {
    it("collects from vault + credentials simultaneously", () => {
        getVault().set("API_KEY_ONE", "vault-secret-12345678");
        getCredentials().add({
            id: "stripe",
            secret: "sk_live_creds-secret-87654321",
            auth_type: "bearer",
            addedBy: "test",
        });
        const targets = _testCollectTargets();
        const sources = targets.map((t) => t.source).sort();
        assert.deepEqual(sources, ["cred:stripe", "vault:API_KEY_ONE"]);
    });

    it("dedupes when the same secret value appears under multiple keys", () => {
        const dup = "sharedSecretValue-abcdefghijkl";
        getVault().set("ALIAS_1", dup);
        getVault().set("ALIAS_2", dup);
        const targets = _testCollectTargets();
        const dupTargets = targets.filter((t) => t.value === dup);
        assert.equal(dupTargets.length, 1, "dedupe by value, not by source");
    });
});

describe("redactKnownSecrets — fail-open posture", () => {
    it("returns empty input untouched", () => {
        assert.equal(redactKnownSecrets(""), "");
    });
});
