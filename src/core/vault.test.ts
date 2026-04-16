// Tests run with their own BOT_NAME so each file's data dir is hermetic
// and the singleton Vault instance can't collide with other test files
// (node:test runs each file in its own subprocess, so this is enough).
process.env["BOT_NAME"] = "_test_vault";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "./paths.js";
import { Vault, getVault } from "./vault.js";

const TEST_DIR = botDir();
const VAULT_FILE = path.join(TEST_DIR, "vault.json");

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    // Reset the singleton so each test sees a fresh Vault state.
    getVault().reset();
});

describe("Vault basic CRUD", () => {
    it("set then get round-trips a value", () => {
        const v = new Vault();
        v.set("key1", "value1");
        assert.equal(v.get("key1"), "value1");
    });

    it("get returns undefined for missing key", () => {
        const v = new Vault();
        assert.equal(v.get("missing"), undefined);
    });

    it("has reflects presence", () => {
        const v = new Vault();
        v.set("a", "1");
        assert.equal(v.has("a"), true);
        assert.equal(v.has("b"), false);
    });

    it("delete removes the key and returns true on first call only", () => {
        const v = new Vault();
        v.set("k", "x");
        assert.equal(v.delete("k"), true);
        assert.equal(v.has("k"), false);
        assert.equal(v.delete("k"), false);
    });

    it("set with empty key throws", () => {
        const v = new Vault();
        assert.throws(() => v.set("", "x"), /non-empty string/);
    });

    it("set with non-string value throws", () => {
        const v = new Vault();
        // @ts-expect-error — testing the runtime guard
        assert.throws(() => v.set("k", 123), /must be a string/);
    });
});

describe("Vault list (keys-only)", () => {
    it("returns sorted keys, no values", () => {
        const v = new Vault();
        v.set("zeta", "v1");
        v.set("alpha", "v2");
        v.set("mu", "v3");
        const keys = v.list();
        assert.deepEqual(keys, ["alpha", "mu", "zeta"]);
    });

    it("returns empty array for fresh vault", () => {
        const v = new Vault();
        assert.deepEqual(v.list(), []);
    });
});

describe("Vault disk format", () => {
    it("file is created on first set with mode 0600", () => {
        const v = new Vault();
        v.set("k", "v");
        assert.ok(fs.existsSync(VAULT_FILE));
        const stat = fs.statSync(VAULT_FILE);
        // mode bits — strip the file-type bits, keep permission bits.
        assert.equal(stat.mode & 0o777, 0o600);
    });

    it("file content has version + data fields", () => {
        const v = new Vault();
        v.set("k", "v");
        const raw = JSON.parse(fs.readFileSync(VAULT_FILE, "utf-8"));
        assert.equal(typeof raw.version, "number");
        assert.deepEqual(raw.data, { k: "v" });
        assert.ok(typeof raw.created_at === "number");
        assert.ok(typeof raw.updated_at === "number");
    });

    it("subsequent set updates the file in place (atomic — no .tmp left behind)", () => {
        const v = new Vault();
        v.set("k1", "v1");
        v.set("k2", "v2");
        assert.ok(!fs.existsSync(VAULT_FILE + ".tmp"));
        const data = JSON.parse(fs.readFileSync(VAULT_FILE, "utf-8")).data;
        assert.deepEqual(data, { k1: "v1", k2: "v2" });
    });

    it("re-loads from disk in a fresh Vault instance", () => {
        const v1 = new Vault();
        v1.set("persist", "yes");
        const v2 = new Vault();
        assert.equal(v2.get("persist"), "yes");
    });
});

describe("Vault fail-loud", () => {
    it("throws on corrupt JSON", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(VAULT_FILE, "not-json{", "utf-8");
        const v = new Vault();
        assert.throws(() => v.get("any"), /corrupt JSON/);
    });

    it("throws on non-object scalar JSON", () => {
        // typeof null === "object" so we use a number to hit the wrong-shape branch.
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(VAULT_FILE, "42", "utf-8");
        const v = new Vault();
        assert.throws(() => v.get("any"), /wrong shape/);
    });

    it("throws on array (caught at the missing-fields check)", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(VAULT_FILE, "[]", "utf-8");
        const v = new Vault();
        // Arrays pass typeof === "object" so they're caught one branch later.
        assert.throws(() => v.get("any"), /missing required fields/);
    });

    it("throws on missing version field", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(VAULT_FILE, JSON.stringify({ data: {} }), "utf-8");
        const v = new Vault();
        assert.throws(() => v.get("any"), /missing required fields/);
    });

    it("throws on unsupported version", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(VAULT_FILE, JSON.stringify({ version: 999, data: {} }), "utf-8");
        const v = new Vault();
        assert.throws(() => v.get("any"), /unsupported version/);
    });
});

describe("Vault bulkSet", () => {
    it("merges multiple keys in one save", () => {
        const v = new Vault();
        v.set("existing", "stays");
        v.bulkSet({ a: "1", b: "2", c: "3" });
        assert.equal(v.get("existing"), "stays");
        assert.equal(v.get("a"), "1");
        assert.equal(v.get("b"), "2");
        assert.equal(v.get("c"), "3");
    });

    it("ignores invalid entries in the bulk payload", () => {
        const v = new Vault();
        // Cast through unknown — bulkSet has runtime guards for empty keys
        // and non-string values, and we want to exercise both.
        v.bulkSet({
            valid: "ok",
            "": "skipped-empty-key",
            also: 42,
        } as unknown as Record<string, string>);
        assert.equal(v.get("valid"), "ok");
        assert.equal(v.has(""), false);
        assert.equal(v.has("also"), false);
    });
});

describe("Vault.fileExists / Vault.path", () => {
    it("fileExists returns false then true", () => {
        assert.equal(Vault.fileExists(), false);
        new Vault().set("k", "v");
        assert.equal(Vault.fileExists(), true);
    });

    it("path returns the per-bot vault path", () => {
        assert.equal(Vault.path(), VAULT_FILE);
    });
});
