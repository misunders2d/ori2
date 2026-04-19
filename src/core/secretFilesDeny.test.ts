process.env["BOT_NAME"] = "_test_secretdeny";

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import path from "node:path";
import {
    SENSITIVE_SUBSTRINGS,
    containsSensitiveSubstring,
    containsSensitivePath,
    resolvedUnderBotDir,
} from "./secretFilesDeny.js";
import { botDir } from "./paths.js";

describe("secretFilesDeny — shared helper for secret-path denial", () => {
    describe("containsSensitiveSubstring", () => {
        it("matches every declared substring (case-insensitive)", () => {
            for (const sub of SENSITIVE_SUBSTRINGS) {
                assert.equal(containsSensitiveSubstring(`/foo/${sub}/bar`), true, `should match ${sub}`);
                assert.equal(containsSensitiveSubstring(`/FOO/${sub.toUpperCase()}/bar`), true, `should match upper-case ${sub}`);
            }
        });

        it("rejects legitimate non-secret paths", () => {
            assert.equal(containsSensitiveSubstring("/home/user/docs/report.pdf"), false);
            assert.equal(containsSensitiveSubstring("/tmp/generated-chart.png"), false);
            assert.equal(containsSensitiveSubstring("./outgoing/invoice.pdf"), false);
        });
    });

    describe("resolvedUnderBotDir", () => {
        it("is true for any path inside botDir()", () => {
            const p = path.join(botDir(), "subdir", "file.txt");
            assert.equal(resolvedUnderBotDir(p), true);
        });

        it("is false for a path outside botDir()", () => {
            assert.equal(resolvedUnderBotDir("/tmp/unrelated.txt"), false);
            assert.equal(resolvedUnderBotDir("/home/someone/else.pdf"), false);
        });

        it("handles `..` traversal — `data/<bot>/../escape` resolves outside", () => {
            const escape = path.join(botDir(), "..", "escape.txt");
            assert.equal(resolvedUnderBotDir(escape), false);
        });
    });

    describe("containsSensitivePath (union gate)", () => {
        it("blocks paths under botDir()", () => {
            assert.equal(containsSensitivePath(path.join(botDir(), "anything.txt")), true);
        });

        it("blocks substring matches outside botDir() (cross-bot probes)", () => {
            assert.equal(containsSensitivePath("/home/other/data/other-bot/.secret/vault.json"), true);
            assert.equal(containsSensitivePath("/tmp/my_vault.json"), true);
        });

        it("passes clean paths untouched", () => {
            assert.equal(containsSensitivePath("/tmp/generated-report.csv"), false);
            assert.equal(containsSensitivePath("/home/user/Documents/plan.md"), false);
        });
    });
});
