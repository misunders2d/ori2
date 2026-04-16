process.env["BOT_NAME"] = "_test_toolacl";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";
import { ToolAcl } from "./toolAcl.js";

const TEST_DIR = botDir();
const ACL_FILE = path.join(TEST_DIR, "tool_acl.json");

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

before(rmTestDir);
after(rmTestDir);
beforeEach(rmTestDir);

describe("ToolAcl defaults & lock-down", () => {
    it("unlisted tool falls back to ['admin']", () => {
        const acl = new ToolAcl();
        assert.deepEqual(acl.requiredRoles("totally_made_up_tool"), ["admin"]);
    });

    it("seeded defaults are present after first load", () => {
        const acl = new ToolAcl();
        // Force a load via any read.
        acl.requiredRoles("bash");
        // Seeded admin tool.
        assert.deepEqual(acl.requiredRoles("bash"), ["admin"]);
        assert.deepEqual(acl.requiredRoles("verify_and_commit"), ["admin"]);
        // Seeded user tool.
        assert.deepEqual(acl.requiredRoles("web_search"), ["user"]);
        assert.deepEqual(acl.requiredRoles("memory_search"), ["user"]);
    });

    it("first read materializes the ACL file on disk", () => {
        const acl = new ToolAcl();
        acl.requiredRoles("bash");
        assert.ok(fs.existsSync(ACL_FILE));
        const file = JSON.parse(fs.readFileSync(ACL_FILE, "utf-8"));
        assert.equal(file.version, 2);
        assert.ok(Array.isArray(file.entries));
    });
});

describe("ToolAcl set", () => {
    it("set persists a new role list", () => {
        const acl = new ToolAcl();
        acl.set("custom_tool", ["dba", "admin"], "test");
        assert.deepEqual(acl.requiredRoles("custom_tool"), ["dba", "admin"]);
    });

    it("set preserves rules from a previous entry", () => {
        const acl = new ToolAcl();
        // Seed an entry with rules by writing the file directly.
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(ACL_FILE, JSON.stringify({
            version: 2,
            updated_at: 1,
            entries: [{
                toolName: "x",
                requiredRoles: ["admin"],
                rules: [{ match: { role: "admin" }, action: "deny", reason: "no" }],
                alwaysConfirm: true,
                updatedAt: 1,
                updatedBy: "seed",
            }],
        }));
        const acl2 = new ToolAcl();
        acl2.set("x", ["analyst"], "test");
        const entry = acl2.policyEntry("x");
        assert.deepEqual(entry.requiredRoles, ["analyst"]);
        assert.equal(entry.alwaysConfirm, true);
        assert.ok(Array.isArray(entry.rules));
        assert.equal(entry.rules!.length, 1);
        assert.equal(entry.rules![0]!.action, "deny");
    });

    it("unset removes the entry", () => {
        const acl = new ToolAcl();
        acl.set("custom", ["analyst"], "t");
        assert.equal(acl.unset("custom"), true);
        assert.equal(acl.unset("custom"), false);
        // Falls back to default.
        assert.deepEqual(acl.requiredRoles("custom"), ["admin"]);
    });
});

describe("ToolAcl policyEntry", () => {
    it("returns clone-safe shape (modifying result doesn't mutate ACL)", () => {
        const acl = new ToolAcl();
        const e = acl.policyEntry("bash");
        e.requiredRoles.push("hacker");
        assert.deepEqual(acl.requiredRoles("bash"), ["admin"]);
    });

    it("unlisted tool: returns lock-down default with no rules / alwaysConfirm", () => {
        const acl = new ToolAcl();
        const e = acl.policyEntry("never_seen");
        assert.deepEqual(e.requiredRoles, ["admin"]);
        assert.equal(e.rules, undefined);
        assert.equal(e.alwaysConfirm, undefined);
    });

    it("listed tool with rules: forwards rules + alwaysConfirm", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(ACL_FILE, JSON.stringify({
            version: 2,
            updated_at: 1,
            entries: [{
                toolName: "bigquery_query",
                requiredRoles: ["analyst", "admin"],
                rules: [{ match: { args: { dataset: "production" } }, action: "require_2fa" }],
                alwaysConfirm: false,
                updatedAt: 1,
                updatedBy: "seed",
            }],
        }));
        const acl = new ToolAcl();
        const e = acl.policyEntry("bigquery_query");
        assert.deepEqual(e.requiredRoles, ["analyst", "admin"]);
        assert.equal(e.rules?.length, 1);
        assert.equal(e.alwaysConfirm, false);
    });
});

describe("ToolAcl v1 → v2 migration", () => {
    it("loads a v1 file (no rules / alwaysConfirm fields) without error", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        // v1 had version: 1 and no rules/alwaysConfirm.
        fs.writeFileSync(ACL_FILE, JSON.stringify({
            version: 1,
            updated_at: 1,
            entries: [{
                toolName: "legacy_tool",
                requiredRoles: ["admin"],
                updatedAt: 1,
                updatedBy: "seed",
            }],
        }));
        const acl = new ToolAcl();
        assert.deepEqual(acl.requiredRoles("legacy_tool"), ["admin"]);
        // policyEntry should not crash and rules/alwaysConfirm absent.
        const e = acl.policyEntry("legacy_tool");
        assert.equal(e.rules, undefined);
        assert.equal(e.alwaysConfirm, undefined);
    });

    it("save after load rewrites file as v2", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(ACL_FILE, JSON.stringify({
            version: 1,
            updated_at: 1,
            entries: [{ toolName: "x", requiredRoles: ["admin"], updatedAt: 1, updatedBy: "seed" }],
        }));
        const acl = new ToolAcl();
        acl.requiredRoles("x"); // triggers load + auto-save of seeded defaults
        const file = JSON.parse(fs.readFileSync(ACL_FILE, "utf-8"));
        assert.equal(file.version, 2);
    });

    it("ignores malformed rule entries (defensive load)", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(ACL_FILE, JSON.stringify({
            version: 2,
            updated_at: 1,
            entries: [{
                toolName: "x",
                requiredRoles: ["admin"],
                rules: [
                    { match: { role: "ok" }, action: "deny" },
                    "not-an-object",
                    { incomplete: true },
                ],
                updatedAt: 1,
                updatedBy: "seed",
            }],
        }));
        const acl = new ToolAcl();
        const e = acl.policyEntry("x");
        // Only the well-formed rule survives.
        assert.equal(e.rules?.length, 1);
    });
});

describe("ToolAcl introspection", () => {
    it("listConfigured returns all entries sorted by name", () => {
        const acl = new ToolAcl();
        acl.set("zzz_late", ["admin"], "t");
        acl.set("aaa_early", ["admin"], "t");
        const list = acl.listConfigured();
        const names = list.map((e) => e.toolName);
        const earlyIdx = names.indexOf("aaa_early");
        const lateIdx = names.indexOf("zzz_late");
        assert.ok(earlyIdx >= 0);
        assert.ok(lateIdx >= 0);
        assert.ok(earlyIdx < lateIdx);
    });

    it("allReferencedRoles aggregates from all entries", () => {
        const acl = new ToolAcl();
        acl.set("a", ["dba"], "t");
        acl.set("b", ["analyst"], "t");
        const roles = acl.allReferencedRoles();
        assert.ok(roles.includes("dba"));
        assert.ok(roles.includes("analyst"));
        assert.ok(roles.includes("admin")); // from seeded defaults
        assert.ok(roles.includes("user"));
    });
});
