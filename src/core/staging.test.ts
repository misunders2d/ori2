process.env["BOT_NAME"] = "_test_staging";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { botDir, secretSubdir } from "./paths.js";
import { Staging, parseApproval } from "./staging.js";

const TEST_DIR = botDir();
const DB_FILE = path.join(secretSubdir(), "pending_actions.db");

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

function newStaging(): Staging {
    return new Staging();
}

before(rmTestDir);
after(rmTestDir);
beforeEach(rmTestDir);

describe("Staging.stage", () => {
    it("returns a token in ACT-XXXXXX format with the safe alphabet", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "bash", args: { cmd: "ls" }, userPlatform: "telegram", userSenderId: "alice" });
        assert.match(a.token, /^ACT-[A-HJ-NP-Z2-9]{6}$/);
        // Confusable chars (0/O/1/I) MUST not appear.
        assert.equal(/[01OI]/.test(a.token.slice(4)), false);
    });

    it("persists fields including requires2fa default false", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "x", args: { k: "v" }, userPlatform: "telegram", userSenderId: "alice" });
        assert.equal(a.toolName, "x");
        assert.equal(a.userPlatform, "telegram");
        assert.equal(a.userSenderId, "alice");
        assert.equal(a.requires2fa, false);
        assert.equal(a.consumedAt, null);
        assert.ok(a.expiresAt > a.requestedAt);
    });

    it("persists requires2fa=true when requested", () => {
        const s = newStaging();
        const a = s.stage({
            toolName: "x", args: {}, userPlatform: "p", userSenderId: "u",
            requires2fa: true,
        });
        assert.equal(a.requires2fa, true);
    });

    it("custom ttlMinutes is honored", () => {
        const s = newStaging();
        const a = s.stage({
            toolName: "x", args: {}, userPlatform: "p", userSenderId: "u",
            ttlMinutes: 1,
        });
        const elapsed = a.expiresAt - a.requestedAt;
        assert.ok(elapsed >= 60_000 && elapsed <= 60_500, `expected ~60000ms, got ${elapsed}`);
    });

    it("tokens are unique across many stages", () => {
        const s = newStaging();
        const tokens = new Set<string>();
        for (let i = 0; i < 200; i++) {
            tokens.add(s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u" }).token);
        }
        assert.equal(tokens.size, 200);
    });
});

describe("Staging.peek", () => {
    it("returns the action without consuming it", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u", requires2fa: true });
        const p = s.peek(a.token);
        assert.ok(p);
        assert.equal(p!.token, a.token);
        assert.equal(p!.requires2fa, true);
        // Peek again — still returns it.
        assert.ok(s.peek(a.token));
    });

    it("returns null for unknown token", () => {
        const s = newStaging();
        assert.equal(s.peek("ACT-AAAAAA"), null);
    });

    it("returns null for already-consumed token", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u" });
        s.approve(a.token, "approver");
        assert.equal(s.peek(a.token), null);
    });
});

describe("Staging.approve", () => {
    it("returns the action on first call, null on second (single-use)", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u" });
        const first = s.approve(a.token, "admin");
        assert.ok(first);
        assert.equal(first!.token, a.token);
        const second = s.approve(a.token, "admin");
        assert.equal(second, null);
    });

    it("records approver on consume", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u" });
        const result = s.approve(a.token, "admin:42");
        assert.ok(result);
        assert.equal(result!.consumedBy, "admin:42");
        assert.ok(typeof result!.consumedAt === "number");
    });

    it("returns null for unknown token", () => {
        const s = newStaging();
        assert.equal(s.approve("ACT-NEVER1", "admin"), null);
    });

    it("returns null for expired token", () => {
        const s = newStaging();
        // Stage with already-elapsed TTL by manipulating the DB row.
        const a = s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u" });
        const db = new Database(DB_FILE);
        db.prepare("UPDATE pending_actions SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, a.token);
        db.close();
        assert.equal(s.approve(a.token, "admin"), null);
    });
});

describe("Staging.cancel", () => {
    it("marks token consumed without leaving it pendable", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "x", args: {}, userPlatform: "p", userSenderId: "u" });
        assert.equal(s.cancel(a.token), true);
        assert.equal(s.cancel(a.token), false);
        assert.equal(s.approve(a.token, "admin"), null);
    });
});

describe("Staging.listActive", () => {
    it("returns only pending (not consumed, not expired)", () => {
        const s = newStaging();
        const a1 = s.stage({ toolName: "a", args: {}, userPlatform: "p", userSenderId: "u" });
        const a2 = s.stage({ toolName: "b", args: {}, userPlatform: "p", userSenderId: "u" });
        s.stage({ toolName: "c", args: {}, userPlatform: "p", userSenderId: "u" });
        s.approve(a1.token, "admin");           // consumed
        // Mark a2 expired.
        const db = new Database(DB_FILE);
        db.prepare("UPDATE pending_actions SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, a2.token);
        db.close();
        const active = s.listActive();
        assert.equal(active.length, 1);
        assert.equal(active[0]!.toolName, "c");
    });

    it("orders by requestedAt DESC", () => {
        const s = newStaging();
        const a = s.stage({ toolName: "first", args: {}, userPlatform: "p", userSenderId: "u" });
        // Simulate a later requestedAt by direct UPDATE — Date.now() resolution
        // is too coarse to reliably distinguish two back-to-back inserts.
        const db = new Database(DB_FILE);
        const newer = s.stage({ toolName: "second", args: {}, userPlatform: "p", userSenderId: "u" });
        db.prepare("UPDATE pending_actions SET requested_at = ? WHERE token = ?").run(Date.now() + 10_000, newer.token);
        db.prepare("UPDATE pending_actions SET requested_at = ? WHERE token = ?").run(Date.now() - 10_000, a.token);
        db.close();
        const active = s.listActive();
        assert.equal(active[0]!.toolName, "second");
        assert.equal(active[1]!.toolName, "first");
    });
});

describe("Staging schema migration", () => {
    it("auto-adds requires_2fa column to a pre-existing v1 table", () => {
        // Create a v1 schema (without requires_2fa) directly.
        fs.mkdirSync(secretSubdir(), { recursive: true });
        const db = new Database(DB_FILE);
        db.prepare(`
            CREATE TABLE pending_actions (
                token             TEXT PRIMARY KEY,
                tool_name         TEXT NOT NULL,
                args_json         TEXT NOT NULL,
                user_platform     TEXT NOT NULL,
                user_sender_id    TEXT NOT NULL,
                user_display_name TEXT,
                requested_at      INTEGER NOT NULL,
                expires_at        INTEGER NOT NULL,
                consumed_at       INTEGER,
                consumed_by       TEXT
            )
        `).run();
        // Insert a v1-shape row.
        db.prepare(`
            INSERT INTO pending_actions
                (token, tool_name, args_json, user_platform, user_sender_id, requested_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run("ACT-LEGACY", "old_tool", "{}", "telegram", "alice", Date.now(), Date.now() + 60_000);
        db.close();

        // Open via Staging — migration runs.
        const s = newStaging();
        const peeked = s.peek("ACT-LEGACY");
        assert.ok(peeked);
        assert.equal(peeked!.requires2fa, false);

        // Verify column actually exists.
        const db2 = new Database(DB_FILE);
        const cols = db2.prepare("PRAGMA table_info(pending_actions)").all() as Array<{ name: string }>;
        db2.close();
        assert.ok(cols.some((c) => c.name === "requires_2fa"));
    });
});

describe("parseApproval", () => {
    it("matches Approve ACT-XXXXXX with no code", () => {
        const r = parseApproval("Approve ACT-WXYZAB");
        assert.deepEqual(r, { token: "ACT-WXYZAB", totpCode: null });
    });

    it("matches Approve ACT-XXXXXX 123456 with TOTP code", () => {
        const r = parseApproval("Approve ACT-WXYZAB 123456");
        assert.deepEqual(r, { token: "ACT-WXYZAB", totpCode: "123456" });
    });

    it("is case-insensitive on the keyword and normalises token to upper case", () => {
        const r = parseApproval("approve act-wxyzab");
        assert.equal(r?.token, "ACT-WXYZAB");
    });

    it("tolerates leading/trailing whitespace", () => {
        const r = parseApproval("  Approve ACT-WXYZAB  ");
        assert.equal(r?.token, "ACT-WXYZAB");
    });

    it("returns null for non-approval text", () => {
        assert.equal(parseApproval("hello"), null);
        assert.equal(parseApproval("Approve nothing"), null);
        assert.equal(parseApproval("ACT-XXXXXX without verb"), null);
    });

    it("rejects 5-digit and 7-digit TOTP-like trailing numbers", () => {
        assert.equal(parseApproval("Approve ACT-WXYZAB 12345"), null);
        assert.equal(parseApproval("Approve ACT-WXYZAB 1234567"), null);
    });
});
