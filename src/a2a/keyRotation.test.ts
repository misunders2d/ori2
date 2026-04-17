process.env["BOT_NAME"] = "_test_a2a_key_rotation";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import { Friends } from "./friends.js";
import { rotateAllFriendKeys } from "./keyRotation.js";

const TEST_DIR = botDir();
function rmTestDir() { if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true }); }

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
});

function makeFakeFetch(plan: Map<string, Response | Error>, recorder?: Array<{ url: string; body: unknown; headers: Record<string, string> }>): typeof fetch {
    return ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : (input as URL).toString();
        if (recorder) {
            const headers = init?.headers as Record<string, string> | undefined;
            const body = init?.body ? JSON.parse(init.body as string) : null;
            recorder.push({ url, body, headers: headers ?? {} });
        }
        for (const [match, result] of plan) {
            if (url.includes(match)) {
                if (result instanceof Error) return Promise.reject(result);
                return Promise.resolve(result);
            }
        }
        return Promise.reject(new Error(`unmatched fetch: ${url}`));
    }) as typeof fetch;
}

describe("rotateAllFriendKeys", () => {
    it("rotates every friend with a new key and commits locally after 2xx ack", async () => {
        const friends = new Friends();
        friends.add("Alice", { url: "https://alice.example", agent_id: "a", added_by: "t" });
        friends.add("Bob", { url: "https://bob.example", agent_id: "b", added_by: "t" });
        friends.setKey("Alice", "alice-inbound-old");
        friends.setKey("Bob", "bob-inbound-old");
        friends.setOutboundKey("Alice", "alice-outbound");
        friends.setOutboundKey("Bob", "bob-outbound");

        const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
        const fakeFetch = makeFakeFetch(new Map([
            ["alice.example", new Response('{"status":"accepted"}', { status: 200 })],
            ["bob.example", new Response('{"status":"accepted"}', { status: 200 })],
        ]), calls);

        let counter = 0;
        const genKey = () => `new-key-${++counter}`;

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
            genKey,
            baseDelayMs: 1,
        });

        assert.deepEqual(report.rotated.sort(), ["Alice", "Bob"]);
        assert.equal(report.failed.length, 0);

        // Both /a2a/key-update POSTs authenticated with the CURRENT outbound key
        const aliceCall = calls.find((c) => c.url.includes("alice.example"))!;
        const bobCall = calls.find((c) => c.url.includes("bob.example"))!;
        assert.equal(aliceCall.url.endsWith("/a2a/key-update"), true);
        assert.equal(aliceCall.headers["x-a2a-api-key"], "alice-outbound");
        assert.equal(bobCall.headers["x-a2a-api-key"], "bob-outbound");

        // New inbound keys committed; old ones gone
        assert.ok(friends.getKey("Alice") !== "alice-inbound-old");
        assert.ok(friends.getKey("Bob") !== "bob-inbound-old");
        assert.match(friends.getKey("Alice")!, /^new-key-/);
        assert.match(friends.getKey("Bob")!, /^new-key-/);
    });

    it("does NOT commit locally when peer fails to ack (friend keeps old inbound key)", async () => {
        const friends = new Friends();
        friends.add("Offline", { url: "https://offline.example", agent_id: "o", added_by: "t" });
        friends.setKey("Offline", "offline-old-inbound");
        friends.setOutboundKey("Offline", "offline-outbound");

        const fakeFetch = makeFakeFetch(new Map([
            ["offline.example", new Response("bad gateway", { status: 502 })],
        ]));

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
            maxAttempts: 2,
            baseDelayMs: 1,
        });

        assert.deepEqual(report.rotated, []);
        assert.equal(report.failed.length, 1);
        assert.equal(report.failed[0]!.name, "Offline");
        assert.match(report.failed[0]!.lastError, /502/);

        // CRITICAL: inbound key not overwritten — the old key must still work.
        assert.equal(friends.getKey("Offline"), "offline-old-inbound");
    });

    it("retries on transient failure and commits on eventual success", async () => {
        const friends = new Friends();
        friends.add("Flaky", { url: "https://flaky.example", agent_id: "f", added_by: "t" });
        friends.setKey("Flaky", "flaky-old");
        friends.setOutboundKey("Flaky", "flaky-out");

        let calls = 0;
        const fakeFetch = ((_input: RequestInfo | URL) => {
            calls++;
            if (calls < 2) return Promise.resolve(new Response("transient", { status: 503 }));
            return Promise.resolve(new Response('{"status":"accepted"}', { status: 200 }));
        }) as typeof fetch;

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
            maxAttempts: 3,
            baseDelayMs: 1,
            genKey: () => "recovered-key",
        });

        assert.deepEqual(report.rotated, ["Flaky"]);
        assert.equal(friends.getKey("Flaky"), "recovered-key");
        assert.equal(calls, 2);
    });

    it("skips friends without outbound keys (can't authenticate the rotate call)", async () => {
        const friends = new Friends();
        friends.add("NoOut", { url: "https://noout.example", agent_id: "x", added_by: "t" });
        friends.setKey("NoOut", "noout-inbound");
        // No outbound key set

        const fakeFetch = ((_input: RequestInfo | URL) => {
            throw new Error("should not be called");
        }) as typeof fetch;

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
            baseDelayMs: 1,
        });

        assert.deepEqual(report.skippedNoOutboundKey, ["NoOut"]);
        assert.equal(report.rotated.length, 0);
        assert.equal(friends.getKey("NoOut"), "noout-inbound"); // unchanged
    });

    it("skips friends without any inbound key (nothing to rotate)", async () => {
        const friends = new Friends();
        friends.add("Incomplete", { url: "https://incomplete.example", agent_id: "i", added_by: "t" });
        friends.setOutboundKey("Incomplete", "out");

        const fakeFetch = ((_input: RequestInfo | URL) => {
            throw new Error("should not be called");
        }) as typeof fetch;

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
        });

        assert.deepEqual(report.skippedNoInboundKey, ["Incomplete"]);
        assert.equal(report.rotated.length, 0);
    });

    it("only=<names> limits rotation to the named friends", async () => {
        const friends = new Friends();
        for (const n of ["A", "B", "C"]) {
            friends.add(n, { url: `https://${n.toLowerCase()}.example`, agent_id: n, added_by: "t" });
            friends.setKey(n, `${n}-in-old`);
            friends.setOutboundKey(n, `${n}-out`);
        }
        const fakeFetch = makeFakeFetch(new Map([
            ["a.example", new Response("ok", { status: 200 })],
            ["b.example", new Response("ok", { status: 200 })],
            ["c.example", new Response("ok", { status: 200 })],
        ]));

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
            only: ["A"],
            baseDelayMs: 1,
        });

        assert.deepEqual(report.rotated, ["A"]);
        assert.ok(report.skippedByCaller.includes("B"));
        assert.ok(report.skippedByCaller.includes("C"));
        assert.notEqual(friends.getKey("A"), "A-in-old");
        assert.equal(friends.getKey("B"), "B-in-old");
        assert.equal(friends.getKey("C"), "C-in-old");
    });

    it("honours the skip list", async () => {
        const friends = new Friends();
        for (const n of ["X", "Y"]) {
            friends.add(n, { url: `https://${n.toLowerCase()}.example`, agent_id: n, added_by: "t" });
            friends.setKey(n, `${n}-in-old`);
            friends.setOutboundKey(n, `${n}-out`);
        }
        const fakeFetch = makeFakeFetch(new Map([
            ["x.example", new Response("ok", { status: 200 })],
        ]));

        const report = await rotateAllFriendKeys({
            senderName: "Us",
            friends,
            fetchImpl: fakeFetch,
            skip: ["Y"],
            baseDelayMs: 1,
        });

        assert.deepEqual(report.rotated, ["X"]);
        assert.ok(report.skippedByCaller.includes("Y"));
    });

    it("includes sender_name and new_key in the request body", async () => {
        const friends = new Friends();
        friends.add("Peer", { url: "https://peer.example", agent_id: "p", added_by: "t" });
        friends.setKey("Peer", "peer-in");
        friends.setOutboundKey("Peer", "peer-out");

        const calls: Array<{ url: string; body: unknown; headers: Record<string, string> }> = [];
        const fakeFetch = makeFakeFetch(
            new Map([["peer.example", new Response("ok", { status: 200 })]]),
            calls,
        );

        await rotateAllFriendKeys({
            senderName: "MyBot",
            friends,
            fetchImpl: fakeFetch,
            genKey: () => "the-new-key",
            baseDelayMs: 1,
        });

        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0]!.body, { sender_name: "MyBot", new_key: "the-new-key" });
    });
});
