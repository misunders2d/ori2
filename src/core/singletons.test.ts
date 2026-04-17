import { describe, it, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import {
    getOrCreate,
    setSingleton,
    getSingleton,
    clearRegistryForTests,
} from "./singletons.js";

beforeEach(() => { clearRegistryForTests(); });

describe("singletons — getOrCreate", () => {
    it("creates on first call and returns same instance thereafter", () => {
        let factoryCalls = 0;
        class Thing { id = ++factoryCalls; }
        const a = getOrCreate("x", () => new Thing());
        const b = getOrCreate("x", () => new Thing());
        assert.equal(a, b);
        assert.equal(factoryCalls, 1);
        assert.equal(a.id, 1);
    });

    it("different keys return different instances", () => {
        class Thing { constructor(public readonly tag: string) {} }
        const a = getOrCreate("alpha", () => new Thing("A"));
        const b = getOrCreate("beta", () => new Thing("B"));
        assert.notEqual(a, b);
        assert.equal(a.tag, "A");
        assert.equal(b.tag, "B");
    });

    it("survives dynamic re-import of the module (simulated jiti scenario)", async () => {
        // This is the core scenario: two module graphs load the same file,
        // each seeing its own `getOrCreate` import. With globalThis-backed
        // registry, both should observe the same stored instance.
        class Thing { id = Math.random(); }
        const first = getOrCreate("shared", () => new Thing());
        // Simulate a fresh graph by re-importing via query-string cache-bust.
        const secondImport = await import(`./singletons.js?v=${Date.now()}`) as typeof import("./singletons.js");
        const second = secondImport.getOrCreate("shared", () => new Thing());
        assert.equal(first, second, "second graph must observe same instance via globalThis");
        assert.equal(first.id, second.id);
    });
});

describe("singletons — setSingleton / getSingleton", () => {
    it("set + get round-trips a value", () => {
        setSingleton("k", { a: 1 });
        assert.deepEqual(getSingleton("k"), { a: 1 });
    });

    it("set null removes the entry", () => {
        setSingleton("k", { a: 1 });
        setSingleton("k", null);
        assert.equal(getSingleton("k"), undefined);
    });

    it("getSingleton returns undefined for unknown keys", () => {
        assert.equal(getSingleton("nope"), undefined);
    });

    it("setSingleton followed by getOrCreate: operator's value wins, factory not called", () => {
        const preexisting = { preset: true };
        setSingleton("k", preexisting);
        let factoryCalls = 0;
        const result = getOrCreate("k", () => { factoryCalls++; return { preset: false }; });
        assert.equal(result, preexisting);
        assert.equal(factoryCalls, 0);
    });
});

describe("singletons — clearRegistryForTests", () => {
    it("wipes everything", () => {
        setSingleton("a", 1);
        getOrCreate("b", () => 2);
        clearRegistryForTests();
        assert.equal(getSingleton("a"), undefined);
        assert.equal(getSingleton("b"), undefined);
    });

    it("next getOrCreate after clear re-runs the factory", () => {
        let calls = 0;
        getOrCreate("x", () => ++calls);
        clearRegistryForTests();
        getOrCreate("x", () => ++calls);
        assert.equal(calls, 2);
    });
});
