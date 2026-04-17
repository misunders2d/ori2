process.env["BOT_NAME"] = "_test_plan_threads";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";
import { recordPlanThread, findPlanSessionByThread, writeAbortControlFile } from "../../.pi/extensions/plan_enforcer.js";

const TEST_DIR = botDir();

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

before(rmTestDir);
after(rmTestDir);
beforeEach(rmTestDir);

describe("plan-thread registry", () => {
    it("records and reverse-looks-up a thread-to-session map", () => {
        recordPlanThread({
            platform: "slack",
            channelId: "C0123",
            threadId: "1700000000.000100",
            sessionId: "sess-abc",
            planId: "plan-xyz",
            scheduleId: "amazon_daily",
        });
        const res = findPlanSessionByThread("slack", "C0123", "1700000000.000100");
        assert.deepEqual(res, { sessionId: "sess-abc", planId: "plan-xyz" });
    });

    it("returns null when no mapping exists", () => {
        assert.equal(findPlanSessionByThread("slack", "C0", "nope"), null);
    });

    it("falls back to threadless mapping when thread-keyed not found", () => {
        recordPlanThread({
            platform: "telegram",
            channelId: "chat-42",
            sessionId: "sess-tele",
            planId: "plan-tele",
        });
        const res = findPlanSessionByThread("telegram", "chat-42", "some-thread-id");
        assert.deepEqual(res, { sessionId: "sess-tele", planId: "plan-tele" });
    });

    it("sanitises path-escape characters in thread key", () => {
        recordPlanThread({
            platform: "slack",
            channelId: "C/../../etc",
            threadId: "../../../escape",
            sessionId: "sess-quarantine",
            planId: "plan-q",
        });
        // Whatever filename landed on disk must live under threadsDir().
        const dir = path.join(TEST_DIR, "plan-threads");
        const listing = fs.readdirSync(dir);
        assert.equal(listing.length, 1);
        for (const f of listing) {
            assert.ok(!f.includes("/"), `filename must not contain directory separator: ${f}`);
            assert.ok(!/(^|\/)\.\.(\/|$)/.test(f), `filename must not be a path-escape component: ${f}`);
            // A resolved path rooted at threadsDir stays inside threadsDir.
            const resolved = path.resolve(dir, f);
            assert.ok(resolved.startsWith(dir + path.sep), `resolved path escapes threadsDir: ${resolved}`);
        }
        const res = findPlanSessionByThread("slack", "C/../../etc", "../../../escape");
        assert.deepEqual(res, { sessionId: "sess-quarantine", planId: "plan-q" });
    });

    it("idempotent — re-recording a thread overwrites the previous mapping", () => {
        recordPlanThread({ platform: "a", channelId: "b", sessionId: "s1", planId: "p1" });
        recordPlanThread({ platform: "a", channelId: "b", sessionId: "s2", planId: "p2" });
        assert.deepEqual(findPlanSessionByThread("a", "b", undefined), { sessionId: "s2", planId: "p2" });
    });
});

describe("writeAbortControlFile", () => {
    it("creates the abort control file with the expected shape", () => {
        writeAbortControlFile("sess-abort", "testing", "cli:op");
        const f = path.join(TEST_DIR, "plan-control", "abort-sess-abort.json");
        assert.ok(fs.existsSync(f));
        const body = JSON.parse(fs.readFileSync(f, "utf-8")) as { reason: string; by: string; issuedAt: number };
        assert.equal(body.reason, "testing");
        assert.equal(body.by, "cli:op");
        assert.equal(typeof body.issuedAt, "number");
    });
});
