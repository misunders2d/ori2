process.env["BOT_NAME"] = "_test_a2a_dna";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import {
    DnaCatalog,
    getDnaCatalog,
    validateDnaPath,
    listSnapshots,
    listImports,
    pruneSnapshots,
} from "./dna.js";

const TEST_DIR = botDir();

function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
    getDnaCatalog().reset();
});

describe("validateDnaPath", () => {
    const root = process.cwd();

    it("accepts paths under .pi/extensions/", () => {
        const r = validateDnaPath(".pi/extensions/foo.ts", root);
        assert.equal(r.ok, true);
    });

    it("accepts paths under .pi/skills/", () => {
        const r = validateDnaPath(".pi/skills/myskill/SKILL.md", root);
        assert.equal(r.ok, true);
    });

    it("accepts paths under .pi/prompts/", () => {
        const r = validateDnaPath(".pi/prompts/foo.md", root);
        assert.equal(r.ok, true);
    });

    it("rejects absolute paths", () => {
        const r = validateDnaPath("/etc/passwd", root);
        assert.equal(r.ok, false);
    });

    it("rejects path traversal", () => {
        const r = validateDnaPath(".pi/../etc/passwd", root);
        assert.equal(r.ok, false);
    });

    it("rejects paths outside the allowed prefixes", () => {
        const r = validateDnaPath("src/core/vault.ts", root);
        assert.equal(r.ok, false);
    });

    it("rejects empty path", () => {
        const r = validateDnaPath("", root);
        assert.equal(r.ok, false);
    });
});

describe("DnaCatalog.register / unregister / get / list", () => {
    it("register stores the feature and asAgentCardEntries reflects it", () => {
        const c = new DnaCatalog();
        c.register("clickup-integration", {
            description: "ClickUp tasks.",
            files: [".pi/extensions/clickup.ts"],
            tags: ["crm"],
            registered_by: "test",
        });
        assert.ok(c.get("clickup-integration"));
        const entries = c.asAgentCardEntries();
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.id, "clickup-integration");
        assert.deepEqual(entries[0]!.tags, ["crm"]);
    });

    it("rejects registration with id starting with 'dna:' (the prefix is added in the card)", () => {
        const c = new DnaCatalog();
        assert.throws(
            () =>
                c.register("dna:clickup", {
                    description: "x",
                    files: [".pi/extensions/clickup.ts"],
                    registered_by: "t",
                }),
            /must NOT start with "dna:"/,
        );
    });

    it("rejects registration with an out-of-tree path", () => {
        const c = new DnaCatalog();
        assert.throws(
            () =>
                c.register("bad", {
                    description: "x",
                    files: ["src/core/vault.ts"],
                    registered_by: "t",
                }),
            /invalid file path/,
        );
    });

    it("rejects registration with a hard-forbidden filename", () => {
        const c = new DnaCatalog();
        assert.throws(
            () =>
                c.register("bad-env", {
                    description: "x",
                    files: [".pi/extensions/.env"],
                    registered_by: "t",
                }),
            /hard-forbidden filename/,
        );
    });

    it("default share_with is ['*']", () => {
        const c = new DnaCatalog();
        const f = c.register("open", {
            description: "x",
            files: [".pi/extensions/open.ts"],
            registered_by: "t",
        });
        assert.deepEqual(f.share_with, ["*"]);
    });

    it("explicit share_with is honoured", () => {
        const c = new DnaCatalog();
        const f = c.register("private-feature", {
            description: "x",
            files: [".pi/extensions/p.ts"],
            share_with: [],
            registered_by: "t",
        });
        assert.deepEqual(f.share_with, []);
        const f2 = c.register("scoped", {
            description: "x",
            files: [".pi/extensions/s.ts"],
            share_with: ["AmazonBot", "MarketingBot"],
            registered_by: "t",
        });
        assert.deepEqual(f2.share_with, ["AmazonBot", "MarketingBot"]);
    });

    it("unregister removes the entry", () => {
        const c = new DnaCatalog();
        c.register("foo", {
            description: "x",
            files: [".pi/extensions/foo.ts"],
            registered_by: "t",
        });
        assert.equal(c.unregister("foo"), true);
        assert.equal(c.get("foo"), undefined);
        assert.equal(c.unregister("foo"), false);
    });

    it("list returns features keyed by id", () => {
        const c = new DnaCatalog();
        c.register("a", { description: "x", files: [".pi/extensions/a.ts"], registered_by: "t" });
        c.register("b", { description: "y", files: [".pi/extensions/b.ts"], registered_by: "t" });
        const all = c.list();
        assert.equal(all.length, 2);
        assert.deepEqual(all.map((f) => f.id).sort(), ["a", "b"]);
    });
});

describe("DnaCatalog.canShareWith", () => {
    it("'*' allows any friend", () => {
        const c = new DnaCatalog();
        c.register("public", { description: "x", files: [".pi/extensions/p.ts"], share_with: ["*"], registered_by: "t" });
        assert.equal(c.canShareWith("public", "Anyone"), true);
    });

    it("explicit list permits only listed friends", () => {
        const c = new DnaCatalog();
        c.register("scoped", {
            description: "x",
            files: [".pi/extensions/s.ts"],
            share_with: ["Alice", "Bob"],
            registered_by: "t",
        });
        assert.equal(c.canShareWith("scoped", "Alice"), true);
        assert.equal(c.canShareWith("scoped", "Carol"), false);
    });

    it("empty share_with denies everyone", () => {
        const c = new DnaCatalog();
        c.register("private", {
            description: "x",
            files: [".pi/extensions/p.ts"],
            share_with: [],
            registered_by: "t",
        });
        assert.equal(c.canShareWith("private", "Anyone"), false);
    });

    it("missing feature is false", () => {
        const c = new DnaCatalog();
        assert.equal(c.canShareWith("nonexistent", "Anyone"), false);
    });
});

describe("DnaCatalog persistence", () => {
    it("file is mode 0600 + has correct shape", () => {
        const c = new DnaCatalog();
        c.register("a", { description: "x", files: [".pi/extensions/a.ts"], registered_by: "t" });
        const file = path.join(TEST_DIR, "dna_features.json");
        assert.ok(fs.existsSync(file));
        const stat = fs.statSync(file);
        assert.equal(stat.mode & 0o777, 0o600);
        const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
        assert.equal(parsed.version, 1);
        assert.ok(parsed.features.a);
    });

    it("loads back into a fresh instance", () => {
        const c1 = new DnaCatalog();
        c1.register("a", {
            description: "x",
            files: [".pi/extensions/a.ts"],
            tags: ["tag1"],
            share_with: ["Bob"],
            registered_by: "t",
        });
        const c2 = new DnaCatalog();
        const f = c2.get("a");
        assert.ok(f);
        assert.deepEqual(f!.share_with, ["Bob"]);
        assert.deepEqual(f!.tags, ["tag1"]);
    });

    it("throws on corrupt dna_features.json", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(path.join(TEST_DIR, "dna_features.json"), "{garbage", "utf-8");
        const c = new DnaCatalog();
        assert.throws(() => c.list(), /corrupt/);
    });
});

describe("listSnapshots / listImports / pruneSnapshots", () => {
    it("listSnapshots is empty when no snapshots exist", () => {
        assert.deepEqual(listSnapshots(), []);
    });

    it("pruneSnapshots tolerates an empty dir", () => {
        pruneSnapshots(20); // should not throw
    });

    it("listImports skips _build- staging dirs", () => {
        const stagingRoot = path.join(TEST_DIR, "dna_staging");
        fs.mkdirSync(path.join(stagingRoot, "_build-abc"), { recursive: true });
        fs.mkdirSync(path.join(stagingRoot, "real-import-xyz"), { recursive: true });
        const list = listImports();
        assert.equal(list.length, 1);
        assert.equal(list[0]!.id, "real-import-xyz");
    });
});
