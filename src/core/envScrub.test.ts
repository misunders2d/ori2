import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { scrubCredentialEnvVars, CREDENTIAL_ENV_PATTERN } from "./envScrub.js";

describe("CREDENTIAL_ENV_PATTERN — names that match", () => {
    const matches = [
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "OPENAI_API_KEY",
        "MY_CUSTOM_API_KEY",
        "TELEGRAM_BOT_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "NPM_TOKEN",
        "AWS_SECRET_ACCESS_KEY",
        "DB_PASSWORD",
        "INIT_PASSCODE",
        "ADMIN_USER_IDS",
        "AWS_CREDENTIALS",
        "anthropic_api_key", // case-insensitive
    ];
    for (const m of matches) {
        it(`matches ${m}`, () => assert.ok(CREDENTIAL_ENV_PATTERN.test(m), `${m} should match`));
    }
});

describe("CREDENTIAL_ENV_PATTERN — names that DON'T match", () => {
    const nonMatches = [
        "PATH",
        "HOME",
        "USER",
        "BOT_NAME",
        "PI_CODING_AGENT_DIR",
        "ORI2_DAEMON",
        "NODE_ENV",
        "GUARDRAIL_EMBEDDINGS",
        "FASTEMBED_SKIP_PREWARM",
        "LANG",
        "TERM",
    ];
    for (const m of nonMatches) {
        it(`leaves ${m} alone`, () => assert.ok(!CREDENTIAL_ENV_PATTERN.test(m), `${m} should NOT match`));
    }
});

describe("scrubCredentialEnvVars", () => {
    it("deletes matching keys and reports them", () => {
        const env: NodeJS.ProcessEnv = {
            PATH: "/usr/bin",
            HOME: "/home/test",
            ANTHROPIC_API_KEY: "sk-ant-...",
            GEMINI_API_KEY: "AIza...",
            BOT_NAME: "_test",
            GITHUB_TOKEN: "ghp_...",
            ADMIN_USER_IDS: "telegram:123",
        };
        const r = scrubCredentialEnvVars(env);
        assert.deepEqual(r.scrubbed.sort(), ["ADMIN_USER_IDS", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"]);
        assert.equal(env["ANTHROPIC_API_KEY"], undefined);
        assert.equal(env["GEMINI_API_KEY"], undefined);
        assert.equal(env["GITHUB_TOKEN"], undefined);
        assert.equal(env["ADMIN_USER_IDS"], undefined);
        // Non-credential vars survive.
        assert.equal(env["PATH"], "/usr/bin");
        assert.equal(env["HOME"], "/home/test");
        assert.equal(env["BOT_NAME"], "_test");
    });

    it("returns an empty scrubbed list when env has no credentials", () => {
        const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", HOME: "/h" };
        const r = scrubCredentialEnvVars(env);
        assert.deepEqual(r.scrubbed, []);
        assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/h" });
    });
});
