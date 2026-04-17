process.env["BOT_NAME"] = "_test_pi_seed";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { botDir } from "./paths.js";
import { getVault } from "./vault.js";
import {
    migrateLegacyVaultKeys,
    ensurePiAuthJsonSeeded,
    ensurePiSettingsJsonSeeded,
} from "./piSeed.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

// Isolated pi-state dir per test — use a tmp dir rather than reusing
// botSubdir(".pi-state") so we can exercise the piDir parameter.
function freshPiDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ori2-piseed-"));
}

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
});

describe("migrateLegacyVaultKeys", () => {
    it("renames GOOGLE_API_KEY → GEMINI_API_KEY when legacy-only", () => {
        getVault().set("GOOGLE_API_KEY", "gem-key-abc");
        const changed = migrateLegacyVaultKeys();
        assert.equal(changed, true);
        assert.equal(getVault().get("GEMINI_API_KEY"), "gem-key-abc");
        assert.equal(getVault().get("GOOGLE_API_KEY"), undefined);
    });

    it("is a no-op when GEMINI_API_KEY already present", () => {
        getVault().set("GEMINI_API_KEY", "existing");
        getVault().set("GOOGLE_API_KEY", "legacy");
        const changed = migrateLegacyVaultKeys();
        assert.equal(changed, false);
        // Don't clobber the canonical key.
        assert.equal(getVault().get("GEMINI_API_KEY"), "existing");
        // Legacy is left alone when both exist (conservative — operator may
        // intentionally have both; subsequent cleanup can decide).
        assert.equal(getVault().get("GOOGLE_API_KEY"), "legacy");
    });

    it("is a no-op when neither key is present", () => {
        assert.equal(migrateLegacyVaultKeys(), false);
    });

    it("is idempotent across multiple boots", () => {
        getVault().set("GOOGLE_API_KEY", "k");
        assert.equal(migrateLegacyVaultKeys(), true);
        // Second boot shouldn't change anything.
        assert.equal(migrateLegacyVaultKeys(), false);
        assert.equal(getVault().get("GEMINI_API_KEY"), "k");
    });
});

describe("ensurePiAuthJsonSeeded", () => {
    it("writes auth.json in Pi-native shape when vault has keys and file is missing", () => {
        const piDir = freshPiDir();
        try {
            getVault().set("GEMINI_API_KEY", "gem-k");
            getVault().set("ANTHROPIC_API_KEY", "ant-k");
            const changed = ensurePiAuthJsonSeeded(piDir);
            assert.equal(changed, true);
            const f = path.join(piDir, "auth.json");
            assert.ok(fs.existsSync(f));
            const body = JSON.parse(fs.readFileSync(f, "utf-8")) as Record<string, { type: string; key: string }>;
            assert.deepEqual(body["google"], { type: "api_key", key: "gem-k" });
            assert.deepEqual(body["anthropic"], { type: "api_key", key: "ant-k" });
            assert.equal(body["openai"], undefined);
            // File mode should be 0600
            const mode = fs.statSync(f).mode & 0o777;
            assert.equal(mode, 0o600);
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("respects existing auth.json entries (operator /login state wins)", () => {
        const piDir = freshPiDir();
        try {
            fs.writeFileSync(path.join(piDir, "auth.json"), JSON.stringify({
                google: { type: "oauth", access_token: "operator-token", refresh_token: "r" },
            }));
            getVault().set("GEMINI_API_KEY", "vault-k");
            const changed = ensurePiAuthJsonSeeded(piDir);
            assert.equal(changed, false, "should not overwrite existing google entry");
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "auth.json"), "utf-8")) as Record<string, { type: string }>;
            assert.equal(body["google"]!.type, "oauth");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("merges: keeps existing oauth google, adds anthropic from vault", () => {
        const piDir = freshPiDir();
        try {
            fs.writeFileSync(path.join(piDir, "auth.json"), JSON.stringify({
                google: { type: "oauth", access_token: "op" },
            }));
            getVault().set("ANTHROPIC_API_KEY", "ant-k");
            const changed = ensurePiAuthJsonSeeded(piDir);
            assert.equal(changed, true);
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "auth.json"), "utf-8")) as Record<string, { type: string; key?: string }>;
            assert.equal(body["google"]!.type, "oauth");
            assert.deepEqual(body["anthropic"], { type: "api_key", key: "ant-k" });
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("returns false when vault has no LLM API keys", () => {
        const piDir = freshPiDir();
        try {
            getVault().set("TELEGRAM_BOT_TOKEN", "unrelated");
            assert.equal(ensurePiAuthJsonSeeded(piDir), false);
            assert.equal(fs.existsSync(path.join(piDir, "auth.json")), false);
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("overwrites a malformed auth.json rather than crashing", () => {
        const piDir = freshPiDir();
        try {
            fs.writeFileSync(path.join(piDir, "auth.json"), "not json {{{");
            getVault().set("GEMINI_API_KEY", "k");
            const changed = ensurePiAuthJsonSeeded(piDir);
            assert.equal(changed, true);
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "auth.json"), "utf-8")) as Record<string, { key: string }>;
            assert.equal(body["google"]!.key, "k");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("is idempotent", () => {
        const piDir = freshPiDir();
        try {
            getVault().set("GEMINI_API_KEY", "k");
            assert.equal(ensurePiAuthJsonSeeded(piDir), true);
            assert.equal(ensurePiAuthJsonSeeded(piDir), false, "second run is no-op");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });
});

describe("ensurePiSettingsJsonSeeded", () => {
    it("writes defaultProvider when settings.json is missing", () => {
        const piDir = freshPiDir();
        try {
            getVault().set("GEMINI_API_KEY", "k");
            const changed = ensurePiSettingsJsonSeeded(piDir);
            assert.equal(changed, true);
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf-8")) as Record<string, string>;
            assert.equal(body["defaultProvider"], "google");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("does not clobber an existing defaultProvider", () => {
        const piDir = freshPiDir();
        try {
            fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({
                defaultProvider: "anthropic",
                theme: "dark",
            }));
            getVault().set("GEMINI_API_KEY", "k"); // would pick google if seeding
            assert.equal(ensurePiSettingsJsonSeeded(piDir), false);
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf-8")) as Record<string, string>;
            assert.equal(body["defaultProvider"], "anthropic");
            assert.equal(body["theme"], "dark");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("picks Gemini over Anthropic over OpenAI (wizard order)", () => {
        const piDir = freshPiDir();
        try {
            getVault().set("OPENAI_API_KEY", "o");
            getVault().set("ANTHROPIC_API_KEY", "a");
            getVault().set("GEMINI_API_KEY", "g");
            ensurePiSettingsJsonSeeded(piDir);
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf-8")) as Record<string, string>;
            assert.equal(body["defaultProvider"], "google");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("preserves other settings keys when merging", () => {
        const piDir = freshPiDir();
        try {
            fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({
                theme: "ocean",
                lastChangelogVersion: "0.67.3",
            }));
            getVault().set("ANTHROPIC_API_KEY", "ant");
            ensurePiSettingsJsonSeeded(piDir);
            const body = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf-8")) as Record<string, string>;
            assert.equal(body["defaultProvider"], "anthropic");
            assert.equal(body["theme"], "ocean");
            assert.equal(body["lastChangelogVersion"], "0.67.3");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });

    it("returns false when no LLM API key is in vault", () => {
        const piDir = freshPiDir();
        try {
            assert.equal(ensurePiSettingsJsonSeeded(piDir), false);
            assert.equal(fs.existsSync(path.join(piDir, "settings.json")), false);
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });
});

describe("piSeed — full migration flow (integration)", () => {
    it("legacy vault → migrate + seed auth + seed settings = working TUI state", () => {
        const piDir = freshPiDir();
        try {
            // Arrange: a bot from before the rename — only GOOGLE_API_KEY in vault,
            // empty auth.json + settings.json (exactly the user's current state).
            getVault().set("GOOGLE_API_KEY", "live-gemini-key");
            fs.writeFileSync(path.join(piDir, "auth.json"), "{}");
            fs.writeFileSync(path.join(piDir, "settings.json"), JSON.stringify({
                lastChangelogVersion: "0.67.3",
            }));

            // Act: simulate boot.
            migrateLegacyVaultKeys();
            ensurePiAuthJsonSeeded(piDir);
            ensurePiSettingsJsonSeeded(piDir);

            // Assert: vault renamed, auth.json has Pi-native google entry,
            // settings.json has defaultProvider=google.
            assert.equal(getVault().get("GEMINI_API_KEY"), "live-gemini-key");
            assert.equal(getVault().get("GOOGLE_API_KEY"), undefined);
            const auth = JSON.parse(fs.readFileSync(path.join(piDir, "auth.json"), "utf-8")) as Record<string, { key: string }>;
            assert.equal(auth["google"]!.key, "live-gemini-key");
            const settings = JSON.parse(fs.readFileSync(path.join(piDir, "settings.json"), "utf-8")) as Record<string, string>;
            assert.equal(settings["defaultProvider"], "google");
            assert.equal(settings["lastChangelogVersion"], "0.67.3", "pre-existing settings preserved");
        } finally { fs.rmSync(piDir, { recursive: true, force: true }); }
    });
});
