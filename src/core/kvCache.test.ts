process.env["BOT_NAME"] = "_test_kv_cache";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { getKVCache, __resetKVCacheForTests } from "./kvCache.js";

function cleanTestDir(): void {
    __resetKVCacheForTests();
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe("kvCache", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("set → get round-trips a JSON value", () => {
        const c = getKVCache();
        c.set("keepa", "B07XYZ", { price: 29.99, bsr: 1234 });
        const got = c.get<{ price: number; bsr: number }>("keepa", "B07XYZ");
        assert.deepEqual(got, { price: 29.99, bsr: 1234 });
    });

    it("get() returns undefined for a missing key", () => {
        const c = getKVCache();
        assert.equal(c.get("ns", "missing"), undefined);
    });

    it("namespaces are isolated (same key, different ns)", () => {
        const c = getKVCache();
        c.set("keepa", "B07", "keepa-val");
        c.set("sp-api", "B07", "sp-api-val");
        assert.equal(c.get("keepa", "B07"), "keepa-val");
        assert.equal(c.get("sp-api", "B07"), "sp-api-val");
    });

    it("set() replaces an existing value", () => {
        const c = getKVCache();
        c.set("ns", "k", "v1");
        c.set("ns", "k", "v2");
        assert.equal(c.get("ns", "k"), "v2");
    });

    it("delete() returns true once, then false; subsequent get is undefined", () => {
        const c = getKVCache();
        c.set("ns", "k", "v");
        assert.equal(c.delete("ns", "k"), true);
        assert.equal(c.delete("ns", "k"), false);
        assert.equal(c.get("ns", "k"), undefined);
    });

    it("has() tracks presence & respects TTL", async () => {
        const c = getKVCache();
        c.set("ns", "k", "v", 1); // 1 sec TTL
        assert.equal(c.has("ns", "k"), true);
        await new Promise((r) => setTimeout(r, 1100));
        assert.equal(c.has("ns", "k"), false);
    });

    it("get() on an expired key returns undefined and deletes lazily", async () => {
        const c = getKVCache();
        c.set("ns", "transient", { data: 1 }, 1);
        await new Promise((r) => setTimeout(r, 1100));
        assert.equal(c.get("ns", "transient"), undefined);
        // After lazy-delete, a second get is still undefined (would've been
        // the case anyway, but confirms no resurrection).
        assert.equal(c.get("ns", "transient"), undefined);
    });

    it("no-TTL values persist indefinitely (until explicit delete)", () => {
        const c = getKVCache();
        c.set("ns", "forever", "v"); // no ttlSec
        assert.equal(c.get("ns", "forever"), "v");
    });

    it("keys() lists non-expired keys in the namespace, sorted", () => {
        const c = getKVCache();
        c.set("ns", "b", 1);
        c.set("ns", "a", 2);
        c.set("ns", "c", 3, 1);
        c.set("other", "z", 99); // different ns — excluded
        assert.deepEqual(c.keys("ns"), ["a", "b", "c"]);
    });

    it("keys() excludes expired keys", async () => {
        const c = getKVCache();
        c.set("ns", "alive", 1);
        c.set("ns", "dying", 2, 1);
        await new Promise((r) => setTimeout(r, 1100));
        assert.deepEqual(c.keys("ns"), ["alive"]);
    });

    it("clearNamespace() deletes only that ns, returns count", () => {
        const c = getKVCache();
        c.set("ns", "a", 1);
        c.set("ns", "b", 2);
        c.set("other", "c", 3);
        assert.equal(c.clearNamespace("ns"), 2);
        assert.deepEqual(c.keys("ns"), []);
        assert.equal(c.get("other", "c"), 3);
    });

    it("sweep() drops expired rows across all namespaces", async () => {
        const c = getKVCache();
        c.set("a", "1", "x", 1);
        c.set("b", "2", "y", 1);
        c.set("c", "3", "z"); // no ttl — kept
        await new Promise((r) => setTimeout(r, 1100));
        assert.equal(c.sweep(), 2);
        assert.equal(c.get("c", "3"), "z");
    });

    it("persists across re-open (singleton reset simulates a process restart)", () => {
        const c1 = getKVCache();
        c1.set("persist", "k", { seen: true });
        __resetKVCacheForTests();

        // Re-clean? NO — we want to verify the data survives. Don't wipe botDir.
        // Just re-open via getKVCache which rebuilds the DB handle pointing at
        // the same file.
        const c2 = getKVCache();
        assert.deepEqual(c2.get("persist", "k"), { seen: true });
    });

    it("rejects non-JSON-serializable values", () => {
        const c = getKVCache();
        assert.throws(() => c.set("ns", "fn", (() => 1) as unknown as number), /not JSON-serializable/);
        assert.throws(() => c.set("ns", "undef", undefined as unknown as number), /not JSON-serializable/);
    });
});
