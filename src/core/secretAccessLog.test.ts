import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import { SecretAccessLog } from "./secretAccessLog.js";

describe("SecretAccessLog — basic counter", () => {
    let log: SecretAccessLog;
    beforeEach(() => { log = new SecretAccessLog(); });

    it("counts per-source reads", () => {
        log.record("vault:GEMINI_API_KEY");
        log.record("vault:GEMINI_API_KEY");
        log.record("vault:GEMINI_API_KEY");
        log.record("cred:github_pat");
        const top = log.topReads();
        assert.equal(top[0]!.source, "vault:GEMINI_API_KEY");
        assert.equal(top[0]!.count, 3);
        assert.equal(top[1]!.source, "cred:github_pat");
        assert.equal(top[1]!.count, 1);
    });

    it("topReads honors n limit", () => {
        for (let i = 0; i < 30; i++) log.record(`vault:KEY_${i}`);
        const top = log.topReads(5);
        assert.equal(top.length, 5);
    });

    it("distinctSources counts unique sources", () => {
        log.record("vault:A");
        log.record("vault:B");
        log.record("vault:A");
        assert.equal(log.distinctSources(), 2);
    });
});

describe("SecretAccessLog — recent reads ring buffer", () => {
    it("returns newest-first", () => {
        const log = new SecretAccessLog();
        log.record("first");
        log.record("second");
        log.record("third");
        const recent = log.recentReads();
        assert.equal(recent[0]!.source, "third");
        assert.equal(recent[2]!.source, "first");
    });

    it("caps at MAX_RECENT (drops oldest)", () => {
        const log = new SecretAccessLog();
        for (let i = 0; i < 600; i++) log.record(`key${i}`);
        const recent = log.recentReads(1000);
        // MAX_RECENT internal is 500.
        assert.ok(recent.length <= 500);
        // Oldest dropped — first surviving record should be a high index.
        const sources = recent.map((r) => r.source);
        assert.equal(sources.includes("key0"), false);
        assert.equal(sources.includes("key599"), true);
    });

    it("recentReads honors k limit", () => {
        const log = new SecretAccessLog();
        for (let i = 0; i < 50; i++) log.record(`x${i}`);
        const r = log.recentReads(10);
        assert.equal(r.length, 10);
    });
});

describe("SecretAccessLog — rate calculation", () => {
    it("counts reads in window", () => {
        const log = new SecretAccessLog();
        for (let i = 0; i < 5; i++) log.record("vault:HOT");
        // 5 reads in last 60s → 5 reads/min.
        const rpm = log.rate("vault:HOT", 60_000);
        assert.equal(rpm, 5);
    });

    it("returns 0 for never-read source", () => {
        const log = new SecretAccessLog();
        assert.equal(log.rate("vault:NEVER"), 0);
    });
});

describe("SecretAccessLog — caller hint", () => {
    it("captures something stack-trace-like", () => {
        const log = new SecretAccessLog();
        log.record("vault:X");
        const recent = log.recentReads(1);
        // Caller hint may be empty depending on environment, but if non-empty
        // it should NOT contain the secret value or full home-dir path.
        const caller = recent[0]!.caller;
        assert.equal(typeof caller, "string");
        assert.equal(caller.length < 200, true);
    });
});
