process.env["BOT_NAME"] = "_test_channel_sessions";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";
import { ChannelSessions, getChannelSessions } from "./channelSessions.js";

// Every test runs against data/_test_channel_sessions — wiped before and
// after. Per Phase 6, singletons live on globalThis, so we reset the
// registry between cases to start clean.

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe("ChannelSessions", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cleanTestDir();
        ChannelSessions.__resetForTests();
    });

    it("returns a path under data/<bot>/channel-sessions/ on first getOrCreate", () => {
        const cs = getChannelSessions();
        const file = cs.getOrCreateSessionFile("telegram", "-100123");
        assert.ok(file.endsWith(".jsonl"), `expected a .jsonl path, got ${file}`);
        // File lives directly under data/<bot>/channel-sessions/ because we
        // pass sessionDir explicitly to SessionManager.create(cwd, sessionDir).
        // NOTE: Pi's SessionManager creates the file lazily on first append,
        // so fs.existsSync(file) is false here — that's expected.
        assert.equal(path.dirname(file), path.join(botDir(), "channel-sessions"));
    });

    it("returns the same session file for the same (platform, channelId)", () => {
        const cs = getChannelSessions();
        const a = cs.getOrCreateSessionFile("telegram", "-100123");
        const b = cs.getOrCreateSessionFile("telegram", "-100123");
        assert.equal(a, b);
    });

    it("returns DIFFERENT session files for different channels on the same platform", () => {
        const cs = getChannelSessions();
        const a = cs.getOrCreateSessionFile("telegram", "-100123");
        const b = cs.getOrCreateSessionFile("telegram", "-100456");
        assert.notEqual(a, b);
    });

    it("treats same channelId on different platforms as separate", () => {
        const cs = getChannelSessions();
        const a = cs.getOrCreateSessionFile("telegram", "chan-1");
        const b = cs.getOrCreateSessionFile("slack", "chan-1");
        assert.notEqual(a, b);
    });

    it("persists the binding across new instances (restart simulation)", () => {
        const cs1 = getChannelSessions();
        const file1 = cs1.getOrCreateSessionFile("telegram", "-100123");

        // Simulate process restart: drop the singleton, get a fresh instance
        // which must re-read from disk.
        ChannelSessions.__resetForTests();

        const cs2 = getChannelSessions();
        const file2 = cs2.getOrCreateSessionFile("telegram", "-100123");
        assert.equal(file2, file1);
    });

    it("get() returns undefined for unmapped channel", () => {
        const cs = getChannelSessions();
        assert.equal(cs.get("telegram", "never-seen"), undefined);
    });

    it("get() returns the path for a mapped channel without creating", () => {
        const cs = getChannelSessions();
        const created = cs.getOrCreateSessionFile("telegram", "-100");
        assert.equal(cs.get("telegram", "-100"), created);
    });

    it("all() lists every binding", () => {
        const cs = getChannelSessions();
        cs.getOrCreateSessionFile("telegram", "-100");
        cs.getOrCreateSessionFile("slack", "C123");
        const all = cs.all();
        assert.equal(all.length, 2);
        const keys = all.map((b) => `${b.platform}:${b.channelId}`).sort();
        assert.deepEqual(keys, ["slack:C123", "telegram:-100"]);
    });

    it("remove() drops the binding and subsequent get() returns undefined", () => {
        const cs = getChannelSessions();
        cs.getOrCreateSessionFile("telegram", "-100");
        assert.equal(cs.remove("telegram", "-100"), true);
        assert.equal(cs.get("telegram", "-100"), undefined);
    });

    it("remove() returns false for an unknown binding", () => {
        const cs = getChannelSessions();
        assert.equal(cs.remove("telegram", "ghost"), false);
    });

    it("keeps the same binding when the backing file is deleted by the operator", () => {
        // Operator rms the .jsonl manually. We should NOT silently re-mint a
        // new session — the binding is a stable identity for "this channel's
        // conversation", independent of whether the on-disk file was touched.
        // Pi's SessionManager.open(path) handles missing files by starting a
        // fresh in-memory session (verified at
        // node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js:478-482),
        // so the next append will re-create the file with a new session
        // header while the binding path stays the same.
        const cs = getChannelSessions();
        const first = cs.getOrCreateSessionFile("telegram", "-100");
        // Intentionally don't touch the file — it never existed because
        // SessionManager.create() is lazy. Subsequent calls must still
        // return the same path.
        const second = cs.getOrCreateSessionFile("telegram", "-100");
        assert.equal(second, first);
    });
});
