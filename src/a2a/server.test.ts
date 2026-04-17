process.env["BOT_NAME"] = "_test_a2a_server";

import { describe, it, before, beforeEach, afterEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import { getFriends } from "./friends.js";
import { getA2AAdapter } from "./adapter.js";
import { startA2AServer, type A2AServerHandle } from "./server.js";

const TEST_DIR = botDir();

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

// Track every handle we open so we can guarantee teardown — node:test won't
// exit cleanly while a listening Server is held by the event loop.
const OPEN_HANDLES: A2AServerHandle[] = [];

before(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
    getFriends().reset();
    getA2AAdapter().reset();
});

afterEach(async () => {
    while (OPEN_HANDLES.length > 0) {
        const h = OPEN_HANDLES.pop()!;
        try { await h.stop(); } catch { /* ignore */ }
    }
});

after(rmTestDir);

async function bootServer(extras: { preferredPort?: number } = {}): Promise<A2AServerHandle> {
    const h = await startA2AServer({
        botName: "TestBot",
        agentId: "ori2-test",
        description: "test",
        baseUrl: "https://example.invalid",
        apiKey: "OUR_API_KEY",
        preferredPort: extras.preferredPort ?? 52000,
    });
    OPEN_HANDLES.push(h);
    return h;
}

function url(h: A2AServerHandle, path: string): string {
    return `http://127.0.0.1:${h.boundPort}${path}`;
}

describe("A2A server — public routes", () => {
    it("/health returns ok + bot identity", async () => {
        const h = await bootServer();
        const res = await fetch(url(h, "/health"));
        assert.equal(res.status, 200);
        const body = await res.json() as { status: string; bot_name: string; friend_count: number };
        assert.equal(body.status, "ok");
        assert.equal(body.bot_name, "TestBot");
        assert.equal(body.friend_count, 0);
    });

    it("/.well-known/agent.json returns the agent card without auth", async () => {
        const h = await bootServer({ preferredPort: 52010 });
        const res = await fetch(url(h, "/.well-known/agent.json"));
        assert.equal(res.status, 200);
        const card = await res.json() as { name: string; protocolVersion: string; skills: unknown[] };
        assert.equal(card.name, "TestBot");
        assert.equal(card.protocolVersion, "0.3.0");
        assert.ok(Array.isArray(card.skills));
    });

    it("/.well-known/agent-card.json works as alias", async () => {
        const h = await bootServer({ preferredPort: 52020 });
        const res = await fetch(url(h, "/.well-known/agent-card.json"));
        assert.equal(res.status, 200);
    });
});

describe("A2A server — auth middleware", () => {
    it("rejects /a2a/address-update with no header (401)", async () => {
        const h = await bootServer({ preferredPort: 52030 });
        const res = await fetch(url(h, "/a2a/address-update"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sender_name: "x", new_base_url: "https://x" }),
        });
        assert.equal(res.status, 401);
    });

    it("rejects /a2a/address-update with unknown bearer (401)", async () => {
        const h = await bootServer({ preferredPort: 52040 });
        const res = await fetch(url(h, "/a2a/address-update"), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-a2a-api-key": "not-a-real-key",
            },
            body: JSON.stringify({ sender_name: "x", new_base_url: "https://x" }),
        });
        assert.equal(res.status, 401);
    });

    it("accepts /a2a/address-update with a registered friend's key and updates URL", async () => {
        const friends = getFriends();
        friends.add("Peer", { url: "https://old.example", agent_id: "peer-1", added_by: "test" });
        friends.setKey("Peer", "PEER_INBOUND_KEY");
        const h = await bootServer({ preferredPort: 52050 });
        const res = await fetch(url(h, "/a2a/address-update"), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-a2a-api-key": "PEER_INBOUND_KEY",
            },
            body: JSON.stringify({ sender_name: "Peer", new_base_url: "https://new.example" }),
        });
        assert.equal(res.status, 200);
        const body = await res.json() as { status: string };
        assert.equal(body.status, "success");
        assert.equal(friends.get("Peer")!.base_url, "https://new.example");
    });

    it("400 when address-update body is missing fields", async () => {
        const friends = getFriends();
        friends.add("Peer", { url: "https://old.example", agent_id: "peer-1", added_by: "test" });
        friends.setKey("Peer", "K");
        const h = await bootServer({ preferredPort: 52060 });
        const res = await fetch(url(h, "/a2a/address-update"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "K" },
            body: JSON.stringify({ sender_name: "" }),
        });
        assert.equal(res.status, 400);
    });
});

describe("A2A server — /a2a/friend-accept", () => {
    it("rejects when no pending invitation matches the bearer (401)", async () => {
        const h = await bootServer({ preferredPort: 52070 });
        const res = await fetch(url(h, "/a2a/friend-accept"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "wrong" },
            body: JSON.stringify({
                accepting_name: "PeerBot",
                accepting_url: "https://peer.example",
                accepting_key: "their-key-for-us",
            }),
        });
        assert.equal(res.status, 401);
    });

    it("creates a friend record + outbound key when invitation matches", async () => {
        const h = await bootServer({ preferredPort: 52080 });
        h.registerPendingInvitation({
            invite_id: "inv-1",
            inviter_local_name: "FriendlyPeer",
            inviter_key: "INV_KEY",
            expires_at: Date.now() + 60_000,
        });
        const res = await fetch(url(h, "/a2a/friend-accept"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "INV_KEY" },
            body: JSON.stringify({
                accepting_name: "PeerBot",
                accepting_url: "https://peer.example",
                accepting_key: "OUTBOUND_KEY_FOR_PEER",
            }),
        });
        assert.equal(res.status, 200);
        const body = await res.json() as { status: string; local_name: string };
        assert.equal(body.status, "accepted");
        assert.equal(body.local_name, "FriendlyPeer");
        const friends = getFriends();
        const rec = friends.get("FriendlyPeer");
        assert.ok(rec);
        assert.equal(rec!.base_url, "https://peer.example");
        assert.equal(friends.getOutboundKey("FriendlyPeer"), "OUTBOUND_KEY_FOR_PEER");
    });

    it("expired invitations are rejected and pruned", async () => {
        const h = await bootServer({ preferredPort: 52090 });
        h.registerPendingInvitation({
            invite_id: "inv-expired",
            inviter_local_name: "Expired",
            inviter_key: "EXP_KEY",
            expires_at: Date.now() - 1000,
        });
        const res = await fetch(url(h, "/a2a/friend-accept"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "EXP_KEY" },
            body: JSON.stringify({
                accepting_name: "Whatever",
                accepting_url: "https://x",
                accepting_key: "k",
            }),
        });
        assert.equal(res.status, 401);
    });
});

describe("A2A server — refreshAgentCard", () => {
    it("regenerates the card with a new baseUrl", async () => {
        const h = await bootServer({ preferredPort: 52100 });
        assert.equal(h.agentCard.url, "https://example.invalid");
        h.refreshAgentCard({ baseUrl: "https://changed.invalid" });
        assert.equal(h.agentCard.url, "https://changed.invalid");
        // The /.well-known endpoint must reflect the refresh.
        const res = await fetch(url(h, "/.well-known/agent.json"));
        const card = await res.json() as { url: string };
        assert.equal(card.url, "https://changed.invalid");
    });
});

describe("A2A server — port allocation", () => {
    it("allocates the preferred port when free", async () => {
        const h = await bootServer({ preferredPort: 52110 });
        assert.equal(h.boundPort, 52110);
    });

    it("walks +1 when preferred port is in use", async () => {
        const h1 = await bootServer({ preferredPort: 52120 });
        // Spin up a second server with the SAME preferred port — must walk.
        const h2 = await startA2AServer({
            botName: "TestBot2",
            agentId: "ori2-test-2",
            description: "test 2",
            baseUrl: "https://example.invalid",
            apiKey: "OUR_API_KEY_2",
            preferredPort: 52120,
        });
        OPEN_HANDLES.push(h2);
        assert.equal(h1.boundPort, 52120);
        assert.equal(h2.boundPort, 52121);
    });
});

describe("A2A server — /a2a/key-update", () => {
    it("401 when x-a2a-api-key is missing", async () => {
        const h = await bootServer({ preferredPort: 52200 });
        const res = await fetch(url(h, "/a2a/key-update"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sender_name: "P", new_key: "nk" }),
        });
        assert.equal(res.status, 401);
    });

    it("401 when bearer key doesn't match any registered friend", async () => {
        const h = await bootServer({ preferredPort: 52210 });
        const res = await fetch(url(h, "/a2a/key-update"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "unknown-key" },
            body: JSON.stringify({ sender_name: "P", new_key: "nk" }),
        });
        assert.equal(res.status, 401);
    });

    it("400 when body is missing new_key or sender_name", async () => {
        const h = await bootServer({ preferredPort: 52220 });
        getFriends().add("Peer", { url: "https://peer", agent_id: "p", added_by: "t" });
        getFriends().setKey("Peer", "peer-inbound");
        const res = await fetch(url(h, "/a2a/key-update"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "peer-inbound" },
            body: JSON.stringify({ sender_name: "Peer" }),
        });
        assert.equal(res.status, 400);
    });

    it("accepted: stores new_key as outbound key for the authenticated friend", async () => {
        const h = await bootServer({ preferredPort: 52230 });
        const friends = getFriends();
        friends.add("Peer", { url: "https://peer", agent_id: "p", added_by: "t" });
        friends.setKey("Peer", "peer-inbound");
        friends.setOutboundKey("Peer", "peer-old-outbound");

        const res = await fetch(url(h, "/a2a/key-update"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "peer-inbound" },
            body: JSON.stringify({ sender_name: "Peer", new_key: "peer-NEW-outbound" }),
        });
        assert.equal(res.status, 200);
        const body = await res.json() as { status: string };
        assert.equal(body.status, "accepted");
        assert.equal(friends.getOutboundKey("Peer"), "peer-NEW-outbound");
    });

    it("idempotent: resubmitting the same new_key returns no-op", async () => {
        const h = await bootServer({ preferredPort: 52240 });
        const friends = getFriends();
        friends.add("Peer", { url: "https://peer", agent_id: "p", added_by: "t" });
        friends.setKey("Peer", "peer-inbound");
        friends.setOutboundKey("Peer", "same-key");

        const res = await fetch(url(h, "/a2a/key-update"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": "peer-inbound" },
            body: JSON.stringify({ sender_name: "Peer", new_key: "same-key" }),
        });
        assert.equal(res.status, 200);
        const body = await res.json() as { status: string };
        assert.equal(body.status, "no-op");
    });

    it("round-trip: rotateAllFriendKeys fired at one bot lands on the other bot's server", async () => {
        // Boot a peer server; it will be the target of our key-update POST.
        const peer = await bootServer({ preferredPort: 52250 });
        // Pre-register ourselves as that peer's friend so the auth middleware
        // resolves our bearer key.
        const friends = getFriends();
        friends.add("Caller", { url: `http://127.0.0.1:${peer.boundPort}`, agent_id: "caller", added_by: "t" });
        friends.setKey("Caller", "caller-inbound");
        friends.setOutboundKey("Caller", "peer-will-receive-this");

        // Fire the rotation — as if from a separate bot that has "Peer" in
        // its friend list. We reuse the real fetch so this exercises the HTTP
        // path end-to-end.
        const { rotateAllFriendKeys } = await import("./keyRotation.js");
        const otherFriends = new (await import("./friends.js")).Friends();
        otherFriends.add("Peer", { url: `http://127.0.0.1:${peer.boundPort}`, agent_id: "p", added_by: "t" });
        otherFriends.setKey("Peer", "we-stored-for-peer");
        otherFriends.setOutboundKey("Peer", "caller-inbound"); // = Peer's inbound for us

        const report = await rotateAllFriendKeys({
            senderName: "Caller",
            friends: otherFriends,
            genKey: () => "hot-fresh-key",
        });

        assert.deepEqual(report.rotated, ["Peer"]);
        // On the Peer side (= our current test singleton friends registry),
        // the authenticated-as name is "Caller" (resolved from bearer), so
        // the new key is stored as Caller's outbound key.
        assert.equal(friends.getOutboundKey("Caller"), "hot-fresh-key");
        // On the caller's side, inbound key got committed.
        assert.equal(otherFriends.getKey("Peer"), "hot-fresh-key");
    });
});
