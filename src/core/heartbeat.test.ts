process.env["BOT_NAME"] = "_test_heartbeat";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";
import {
    writeHeartbeat,
    readHeartbeat,
    listHeartbeats,
    clearHeartbeatsForTests,
    DEFAULT_STALE_MS,
} from "./heartbeat.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => { rmTestDir(); clearHeartbeatsForTests(); });

describe("heartbeat — write + read", () => {
    it("writeHeartbeat creates a file and readHeartbeat parses it", () => {
        writeHeartbeat("telegram", "poll ok, 3 updates");
        const s = readHeartbeat("telegram");
        assert.equal(s.present, true);
        assert.ok(s.at);
        assert.ok(s.age_ms != null && s.age_ms >= 0 && s.age_ms < 1000);
        assert.equal(s.note, "poll ok, 3 updates");
        assert.equal(s.stale, false);
    });

    it("readHeartbeat returns present=false when no heartbeat exists", () => {
        const s = readHeartbeat("nobody");
        assert.equal(s.present, false);
        assert.equal(s.stale, false);
        assert.equal(s.at, undefined);
    });

    it("stale threshold works: old heartbeat is flagged stale", () => {
        writeHeartbeat("tunnel");
        // Forge an old timestamp by writing a stale file directly.
        const file = path.join(TEST_DIR, ".heartbeat.tunnel");
        const old = { at: Date.now() - 5 * 60_000, note: "forged" };
        fs.writeFileSync(file, JSON.stringify(old));
        const s = readHeartbeat("tunnel");
        assert.equal(s.present, true);
        assert.equal(s.stale, true);
        assert.ok(s.age_ms! >= 5 * 60_000);
    });

    it("custom staleMs overrides default", () => {
        const file = path.join(TEST_DIR, ".heartbeat.pi");
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ at: Date.now() - 10_000 }));
        assert.equal(readHeartbeat("pi", 5_000).stale, true);   // >5s → stale
        assert.equal(readHeartbeat("pi", 20_000).stale, false);  // <20s → ok
        assert.equal(readHeartbeat("pi", DEFAULT_STALE_MS).stale, false); // <60s default
    });

    it("atomic write: no half-written file visible during rename", () => {
        writeHeartbeat("x");
        // Verify no .tmp file lingered
        const listing = fs.readdirSync(TEST_DIR);
        assert.equal(listing.includes(".heartbeat.x.tmp"), false);
        assert.equal(listing.includes(".heartbeat.x"), true);
    });

    it("file mode is 0600", () => {
        writeHeartbeat("secure");
        const stat = fs.statSync(path.join(TEST_DIR, ".heartbeat.secure"));
        assert.equal(stat.mode & 0o777, 0o600);
    });

    it("malformed file returns present=false gracefully", () => {
        const file = path.join(TEST_DIR, ".heartbeat.corrupt");
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(file, "not json");
        assert.equal(readHeartbeat("corrupt").present, false);
    });
});

describe("heartbeat — name sanitisation", () => {
    it("stores path-escape-safe filename", () => {
        writeHeartbeat("../../etc/passwd");
        const listing = fs.readdirSync(TEST_DIR);
        // File should be under TEST_DIR with sanitised name, not escape.
        assert.ok(listing.some((f) => f.startsWith(".heartbeat.") && !f.includes("/")));
        const s = readHeartbeat("../../etc/passwd");
        assert.equal(s.present, true);
    });
});

describe("heartbeat — listHeartbeats", () => {
    it("discovers all registered heartbeats", () => {
        writeHeartbeat("a");
        writeHeartbeat("b");
        writeHeartbeat("c");
        const names = listHeartbeats().sort();
        assert.deepEqual(names, ["a", "b", "c"]);
    });

    it("skips .tmp partial files", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(path.join(TEST_DIR, ".heartbeat.legit"), "{}");
        fs.writeFileSync(path.join(TEST_DIR, ".heartbeat.partial.tmp"), "{}");
        assert.deepEqual(listHeartbeats(), ["legit"]);
    });

    it("returns empty when botDir doesn't exist", () => {
        rmTestDir();
        assert.deepEqual(listHeartbeats(), []);
    });
});
