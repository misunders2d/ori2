process.env["BOT_NAME"] = "_test_error_log";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";
import { logError, logWarning, logInfo, recent, counts, clearForTests } from "./errorLog.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => { rmTestDir(); clearForTests(); });

describe("errorLog — write + read", () => {
    it("logError appends an entry that recent() returns", () => {
        logError("telegram", "poll 401", { httpStatus: 401 });
        const r = recent();
        assert.equal(r.length, 1);
        assert.equal(r[0]!.subsystem, "telegram");
        assert.equal(r[0]!.severity, "error");
        assert.equal(r[0]!.message, "poll 401");
        assert.deepEqual(r[0]!.details, { httpStatus: 401 });
    });

    it("logWarning + logInfo both land in the ledger with distinct severities", () => {
        logError("a", "err");
        logWarning("a", "warn");
        logInfo("a", "inf");
        const r = recent({ limit: 10 });
        const seen = r.map((e) => e.severity).sort();
        assert.deepEqual(seen, ["error", "info", "warning"]);
    });

    it("recent returns newest-first", () => {
        logError("a", "first");
        // Force a tiny delay so timestamps differ
        const a = Date.now();
        while (Date.now() === a) { /* spin briefly */ }
        logError("a", "second");
        const r = recent();
        assert.equal(r[0]!.message, "second");
        assert.equal(r[1]!.message, "first");
    });

    it("limit is respected and capped at 500", () => {
        for (let i = 0; i < 20; i++) logError("x", `msg-${i}`);
        assert.equal(recent({ limit: 5 }).length, 5);
        assert.equal(recent({ limit: 99999 }).length, 20); // capped by entry count, not just limit
    });
});

describe("errorLog — filters", () => {
    it("filters by subsystem", () => {
        logError("a", "1");
        logError("b", "2");
        logError("a", "3");
        const r = recent({ subsystem: "a" });
        assert.equal(r.length, 2);
        assert.ok(r.every((e) => e.subsystem === "a"));
    });

    it("filters by severity", () => {
        logError("x", "e");
        logWarning("x", "w");
        logInfo("x", "i");
        assert.equal(recent({ severity: "error" }).length, 1);
        assert.equal(recent({ severity: "warning" }).length, 1);
        assert.equal(recent({ severity: "info" }).length, 1);
    });

    it("filters by sinceMinutes", () => {
        // Write an "old" entry by manipulating the file directly (can't wait
        // in a unit test).
        const fp = path.join(TEST_DIR, "errors.jsonl");
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const old = { at: Date.now() - 120 * 60_000, subsystem: "x", severity: "error", message: "old" };
        fs.writeFileSync(fp, JSON.stringify(old) + "\n");
        logError("x", "new");
        const r = recent({ sinceMinutes: 60 });
        assert.equal(r.length, 1);
        assert.equal(r[0]!.message, "new");
    });
});

describe("errorLog — robustness", () => {
    it("skips malformed lines without breaking the query", () => {
        logError("x", "good");
        fs.appendFileSync(path.join(TEST_DIR, "errors.jsonl"), "not valid json\n");
        fs.appendFileSync(path.join(TEST_DIR, "errors.jsonl"), '{"at":"not-a-number","subsystem":"x","severity":"error","message":"bad"}\n');
        logError("x", "good2");
        const r = recent();
        assert.equal(r.length, 2);
        assert.ok(r.every((e) => e.message.startsWith("good")));
    });

    it("recent on missing ledger returns empty", () => {
        rmTestDir();
        assert.deepEqual(recent(), []);
    });

    it("file mode is 0600", () => {
        logError("x", "mode check");
        const stat = fs.statSync(path.join(TEST_DIR, "errors.jsonl"));
        // POSIX — last 3 octal digits are the permission bits.
        const mode = stat.mode & 0o777;
        assert.equal(mode, 0o600);
    });
});

describe("errorLog — counts()", () => {
    it("returns zeros when ledger is empty", () => {
        const c = counts();
        assert.equal(c.total, 0);
        assert.equal(c.errors, 0);
        assert.equal(c.warnings, 0);
        assert.equal(c.last_hour, 0);
        assert.equal(c.newest_at, undefined);
    });

    it("aggregates correctly by severity", () => {
        logError("a", "e1");
        logError("b", "e2");
        logWarning("a", "w1");
        logInfo("a", "i1");
        const c = counts();
        assert.equal(c.total, 4);
        assert.equal(c.errors, 2);
        assert.equal(c.warnings, 1);
        assert.equal(c.info, 1);
        assert.ok(c.newest_at! > 0);
    });

    it("last_hour separates recent from older", () => {
        const fp = path.join(TEST_DIR, "errors.jsonl");
        fs.mkdirSync(TEST_DIR, { recursive: true });
        const old = { at: Date.now() - 120 * 60_000, subsystem: "x", severity: "error", message: "old" };
        fs.writeFileSync(fp, JSON.stringify(old) + "\n");
        logError("x", "fresh");
        const c = counts();
        assert.equal(c.total, 2);
        assert.equal(c.last_hour, 1);
    });
});
