process.env["BOT_NAME"] = "_test_whitelist";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { Whitelist } from "./whitelist.js";
import { getVault } from "./vault.js";

const TEST_DIR = botDir();

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
});

describe("Whitelist add/remove/get", () => {
    it("add then get round-trips a user", () => {
        const w = new Whitelist();
        const u = w.add("telegram", "alice", { roles: ["analyst"], displayName: "Alice", addedBy: "test" });
        assert.equal(u.platform, "telegram");
        assert.equal(u.senderId, "alice");
        assert.deepEqual(u.roles, ["analyst"]);
        const got = w.get("telegram", "alice");
        assert.ok(got);
        assert.equal(got!.displayName, "Alice");
    });

    it("add merges roles on re-add", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["analyst"], addedBy: "t" });
        const merged = w.add("telegram", "alice", { roles: ["dba"], addedBy: "t" });
        assert.deepEqual(merged.roles, ["analyst", "dba"]);
    });

    it("add filters out the implicit 'user' role", () => {
        const w = new Whitelist();
        const u = w.add("telegram", "alice", { roles: ["user", "dba"], addedBy: "t" });
        // 'user' is implicit — kept out of the explicit role list to keep files clean.
        assert.deepEqual(u.roles, ["dba"]);
    });

    it("remove returns true once, then false", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { addedBy: "t" });
        assert.equal(w.remove("telegram", "alice"), true);
        assert.equal(w.remove("telegram", "alice"), false);
    });

    it("get returns undefined for unknown user", () => {
        const w = new Whitelist();
        assert.equal(w.get("telegram", "ghost"), undefined);
    });
});

describe("Whitelist roles", () => {
    it("rolesOf returns sorted union including implicit 'user'", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["analyst"], addedBy: "t" });
        const r = w.rolesOf("telegram", "alice");
        assert.deepEqual(r, ["analyst", "user"]);
    });

    it("admin role implies the 'admin' bit in rolesOf", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["admin"], addedBy: "t" });
        const r = w.rolesOf("telegram", "alice");
        assert.ok(r.includes("admin"));
        assert.ok(r.includes("user"));
    });

    it("rolesOf returns empty for blacklisted user", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["admin"], addedBy: "t" });
        w.blacklist("telegram", "alice", { addedBy: "t" });
        assert.deepEqual(w.rolesOf("telegram", "alice"), []);
    });

    it("grantRole / revokeRole cycle", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { addedBy: "t" });
        assert.equal(w.grantRole("telegram", "alice", "dba"), true);
        assert.equal(w.grantRole("telegram", "alice", "dba"), false);
        assert.equal(w.revokeRole("telegram", "alice", "dba"), true);
        assert.equal(w.revokeRole("telegram", "alice", "dba"), false);
    });

    it("grantRole on unknown user returns false", () => {
        const w = new Whitelist();
        assert.equal(w.grantRole("telegram", "ghost", "x"), false);
    });

    it("hasAnyRole: empty required list always allows", () => {
        const w = new Whitelist();
        assert.equal(w.hasAnyRole("telegram", "ghost", []), true);
    });

    it("hasAnyRole: admin role satisfies any requirement", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["admin"], addedBy: "t" });
        assert.equal(w.hasAnyRole("telegram", "alice", ["specific-role"]), true);
    });

    it("hasAnyRole: any-of semantics", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["dba"], addedBy: "t" });
        assert.equal(w.hasAnyRole("telegram", "alice", ["analyst", "dba"]), true);
        assert.equal(w.hasAnyRole("telegram", "alice", ["analyst", "intern"]), false);
    });
});

describe("Whitelist isAdmin", () => {
    it("CLI is implicitly admin regardless of any list state", () => {
        const w = new Whitelist();
        assert.equal(w.isAdmin("cli", "anyone"), true);
    });

    it("user with admin role is admin", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["admin"], addedBy: "t" });
        assert.equal(w.isAdmin("telegram", "alice"), true);
    });

    it("plain whitelisted user is NOT admin", () => {
        const w = new Whitelist();
        w.add("telegram", "bob", { roles: ["analyst"], addedBy: "t" });
        assert.equal(w.isAdmin("telegram", "bob"), false);
    });

    it("vault ADMIN_USER_IDS keyed format (platform:senderId) wins regardless of whitelist", () => {
        getVault().set("ADMIN_USER_IDS", "telegram:bootstrap");
        const w = new Whitelist();
        assert.equal(w.isAdmin("telegram", "bootstrap"), true);
        assert.equal(w.isAdmin("telegram", "wrong-id"), false);
    });

    it("vault ADMIN_USER_IDS plain senderId matches across platforms", () => {
        getVault().set("ADMIN_USER_IDS", "rootuser");
        const w = new Whitelist();
        assert.equal(w.isAdmin("telegram", "rootuser"), true);
        assert.equal(w.isAdmin("slack", "rootuser"), true);
    });

    it("vault ADMIN_USER_IDS with multiple comma-separated entries", () => {
        getVault().set("ADMIN_USER_IDS", "telegram:abc, slack:xyz, rootuser");
        const w = new Whitelist();
        assert.equal(w.isAdmin("telegram", "abc"), true);
        assert.equal(w.isAdmin("slack", "xyz"), true);
        assert.equal(w.isAdmin("anywhere", "rootuser"), true);
        assert.equal(w.isAdmin("telegram", "xyz"), false); // platform-keyed mismatch
    });
});

describe("Whitelist blacklist", () => {
    it("blacklist add then isBlacklisted true", () => {
        const w = new Whitelist();
        w.blacklist("telegram", "evil", { reason: "spam", addedBy: "t" });
        assert.equal(w.isBlacklisted("telegram", "evil"), true);
    });

    it("blacklist removes from whitelist if present", () => {
        const w = new Whitelist();
        w.add("telegram", "user", { roles: ["analyst"], addedBy: "t" });
        w.blacklist("telegram", "user", { addedBy: "t" });
        assert.equal(w.get("telegram", "user"), undefined);
    });

    it("add removes from blacklist if present", () => {
        const w = new Whitelist();
        w.blacklist("telegram", "redeemed", { addedBy: "t" });
        w.add("telegram", "redeemed", { addedBy: "t" });
        assert.equal(w.isBlacklisted("telegram", "redeemed"), false);
    });

    it("unblacklist returns true once, then false", () => {
        const w = new Whitelist();
        w.blacklist("telegram", "x", { addedBy: "t" });
        assert.equal(w.unblacklist("telegram", "x"), true);
        assert.equal(w.unblacklist("telegram", "x"), false);
    });
});

describe("Whitelist isAllowed", () => {
    it("blacklist beats whitelist", () => {
        const w = new Whitelist();
        w.add("telegram", "x", { roles: ["analyst"], addedBy: "t" });
        w.blacklist("telegram", "x", { addedBy: "t" });
        assert.equal(w.isAllowed("telegram", "x"), false);
    });

    it("blacklist beats vault admin", () => {
        getVault().set("ADMIN_USER_IDS", "telegram:x");
        const w = new Whitelist();
        w.blacklist("telegram", "x", { addedBy: "t" });
        assert.equal(w.isAllowed("telegram", "x"), false);
    });

    it("admin always allowed (CLI shortcut)", () => {
        const w = new Whitelist();
        assert.equal(w.isAllowed("cli", "anybody"), true);
    });

    it("plain whitelisted user is allowed", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { addedBy: "t" });
        assert.equal(w.isAllowed("telegram", "alice"), true);
    });

    it("unknown user is not allowed", () => {
        const w = new Whitelist();
        assert.equal(w.isAllowed("telegram", "stranger"), false);
    });
});

describe("Whitelist persistence", () => {
    it("whitelist.json is written with correct shape", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["analyst"], addedBy: "t" });
        const file = JSON.parse(fs.readFileSync(`${TEST_DIR}/whitelist.json`, "utf-8"));
        assert.equal(typeof file.version, "number");
        assert.ok(Array.isArray(file.users));
        assert.equal(file.users.length, 1);
    });

    it("loads back into a fresh Whitelist instance", () => {
        const w1 = new Whitelist();
        w1.add("telegram", "alice", { roles: ["dba"], addedBy: "t" });
        const w2 = new Whitelist();
        assert.deepEqual(w2.rolesOf("telegram", "alice"), ["dba", "user"]);
    });

    it("throws on corrupt whitelist.json", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(`${TEST_DIR}/whitelist.json`, "{not-json", "utf-8");
        const w = new Whitelist();
        assert.throws(() => w.list(), /corrupt/);
    });
});

describe("Whitelist allRoles", () => {
    it("includes implicit admin + user, plus assigned roles", () => {
        const w = new Whitelist();
        w.add("telegram", "alice", { roles: ["analyst"], addedBy: "t" });
        w.add("telegram", "bob", { roles: ["dba"], addedBy: "t" });
        const r = w.allRoles();
        assert.ok(r.includes("admin"));
        assert.ok(r.includes("user"));
        assert.ok(r.includes("analyst"));
        assert.ok(r.includes("dba"));
    });

    it("merges in extraRoles from caller (e.g. tool ACL roles)", () => {
        const w = new Whitelist();
        const r = w.allRoles(["bigquery-readers"]);
        assert.ok(r.includes("bigquery-readers"));
    });
});
