process.env["BOT_NAME"] = "_test_a2a_broadcaster";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import { Friends } from "./friends.js";
import { broadcastAddressUpdate } from "./broadcaster.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
});

function makeFakeFetch(plan: Map<string, Response | Error>): typeof fetch {
    return ((input: RequestInfo | URL, _init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        for (const [match, result] of plan) {
            if (url.includes(match)) {
                if (result instanceof Error) return Promise.reject(result);
                return Promise.resolve(result);
            }
        }
        return Promise.reject(new Error(`unmatched fetch in test plan: ${url}`));
    }) as typeof fetch;
}

describe("broadcastAddressUpdate", () => {
    it("succeeds for each friend that returns 200", async () => {
        const friends = new Friends();
        friends.add("Alice", { url: "https://alice.example", agent_id: "a", added_by: "test" });
        friends.add("Bob", { url: "https://bob.example", agent_id: "b", added_by: "test" });
        friends.setOutboundKey("Alice", "key-alice");
        friends.setOutboundKey("Bob", "key-bob");

        const fakeFetch = makeFakeFetch(new Map([
            ["alice.example", new Response('{"status":"success"}', { status: 200 })],
            ["bob.example", new Response('{"status":"success"}', { status: 200 })],
        ]));

        const report = await broadcastAddressUpdate({
            senderName: "Us",
            newBaseUrl: "https://us.new.example",
            friends,
            fetchImpl: fakeFetch,
            baseDelayMs: 1, // fast retries
        });

        assert.deepEqual(report.succeeded.sort(), ["Alice", "Bob"]);
        assert.equal(report.failed.length, 0);
        assert.equal(report.skippedNoKey.length, 0);
    });

    it("skips friends with no outbound key", async () => {
        const friends = new Friends();
        friends.add("WithKey", { url: "https://withkey", agent_id: "a", added_by: "test" });
        friends.add("NoKey", { url: "https://nokey", agent_id: "b", added_by: "test" });
        friends.setOutboundKey("WithKey", "k");

        const fakeFetch = makeFakeFetch(new Map([
            ["withkey", new Response('{"status":"success"}', { status: 200 })],
        ]));

        const report = await broadcastAddressUpdate({
            senderName: "Us",
            newBaseUrl: "https://us",
            friends,
            fetchImpl: fakeFetch,
            baseDelayMs: 1,
        });

        assert.deepEqual(report.succeeded, ["WithKey"]);
        assert.deepEqual(report.skippedNoKey, ["NoKey"]);
    });

    it("retries on failure and reports the last error after exhausting", async () => {
        const friends = new Friends();
        friends.add("Flaky", { url: "https://flaky.example", agent_id: "f", added_by: "test" });
        friends.setOutboundKey("Flaky", "k");

        let calls = 0;
        const fakeFetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
            calls++;
            return Promise.resolve(new Response("server error", { status: 500 }));
        }) as typeof fetch;

        const report = await broadcastAddressUpdate({
            senderName: "Us",
            newBaseUrl: "https://us",
            friends,
            fetchImpl: fakeFetch,
            maxAttempts: 3,
            baseDelayMs: 1,
        });

        assert.equal(report.succeeded.length, 0);
        assert.equal(report.failed.length, 1);
        assert.equal(report.failed[0]!.name, "Flaky");
        assert.match(report.failed[0]!.lastError, /500/);
        assert.equal(calls, 3);
    });

    it("recovers if a retry succeeds before exhausting", async () => {
        const friends = new Friends();
        friends.add("Recovers", { url: "https://recovers.example", agent_id: "r", added_by: "test" });
        friends.setOutboundKey("Recovers", "k");

        let calls = 0;
        const fakeFetch = ((_input: RequestInfo | URL, _init?: RequestInit) => {
            calls++;
            if (calls < 3) return Promise.resolve(new Response("nope", { status: 503 }));
            return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        }) as typeof fetch;

        const report = await broadcastAddressUpdate({
            senderName: "Us",
            newBaseUrl: "https://us",
            friends,
            fetchImpl: fakeFetch,
            maxAttempts: 5,
            baseDelayMs: 1,
        });

        assert.deepEqual(report.succeeded, ["Recovers"]);
        assert.equal(report.failed.length, 0);
        assert.equal(calls, 3);
    });

    it("honours the skip set", async () => {
        const friends = new Friends();
        friends.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        friends.add("B", { url: "https://b", agent_id: "b", added_by: "x" });
        friends.setOutboundKey("A", "k");
        friends.setOutboundKey("B", "k");

        let bCalled = false;
        const fakeFetch = ((input: RequestInfo | URL) => {
            const u = typeof input === "string" ? input : (input as URL).toString();
            if (u.includes("/b/") || u.includes("//b/") || u.startsWith("https://b")) bCalled = true;
            return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        }) as typeof fetch;

        const report = await broadcastAddressUpdate({
            senderName: "Us",
            newBaseUrl: "https://us",
            friends,
            fetchImpl: fakeFetch,
            skip: ["B"],
            baseDelayMs: 1,
        });

        assert.deepEqual(report.succeeded, ["A"]);
        assert.equal(bCalled, false);
    });
});
