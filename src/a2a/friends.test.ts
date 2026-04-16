process.env["BOT_NAME"] = "_test_a2a_friends";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { botDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import { Friends } from "./friends.js";

const TEST_DIR = botDir();
const FRIENDS_FILE = path.join(TEST_DIR, "friends.json");

function rmTestDir() {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

before(rmTestDir);
after(rmTestDir);
beforeEach(() => {
    rmTestDir();
    getVault().reset();
});

describe("Friends.add / get / list / remove", () => {
    it("add then get round-trips a friend", () => {
        const f = new Friends();
        const rec = f.add("WebAgent", {
            url: "https://chat.example.com",
            agent_id: "webagent-prod-1",
            added_by: "telegram:42",
            displayName: "Web Agent",
            card_skills: ["general-conversation", "site-search"],
        });
        assert.equal(rec.name, "WebAgent");
        assert.equal(rec.base_url, "https://chat.example.com");
        assert.equal(rec.endpoint_url, "https://chat.example.com");
        assert.equal(rec.agent_id, "webagent-prod-1");
        assert.equal(rec.added_by, "telegram:42");
        const got = f.get("WebAgent");
        assert.ok(got);
        assert.equal(got!.displayName, "Web Agent");
        assert.deepEqual(got!.card_skills, ["general-conversation", "site-search"]);
    });

    it("get returns undefined for missing", () => {
        const f = new Friends();
        assert.equal(f.get("ghost"), undefined);
    });

    it("re-add updates fields, preserves added_at and added_by", () => {
        const f = new Friends();
        const first = f.add("Bot", { url: "https://old", agent_id: "id-1", added_by: "a" });
        const second = f.add("Bot", {
            url: "https://new",
            agent_id: "id-1",
            added_by: "different-user-now",
            card_skills: ["s1"],
        });
        assert.equal(second.base_url, "https://new");
        assert.equal(second.added_at, first.added_at);
        assert.equal(second.added_by, "a");
        assert.deepEqual(second.card_skills, ["s1"]);
    });

    it("list returns all friends", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        f.add("B", { url: "https://b", agent_id: "b", added_by: "x" });
        const all = f.list();
        assert.equal(all.length, 2);
        assert.deepEqual(all.map((r) => r.name).sort(), ["A", "B"]);
    });

    it("remove returns true once, false thereafter, and wipes keys", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        f.setKey("A", "their-key-for-us");
        f.setOutboundKey("A", "our-key-for-them");
        assert.equal(f.remove("A"), true);
        assert.equal(f.remove("A"), false);
        assert.equal(f.get("A"), undefined);
        // Vault keys must be cleaned up to avoid stale credentials.
        assert.equal(f.getKey("A"), undefined);
        assert.equal(f.getOutboundKey("A"), undefined);
    });
});

describe("Friends.updateUrl / setLastSeen / setCardSkills", () => {
    it("updateUrl changes both base_url and endpoint_url and bumps last_address_update", () => {
        const f = new Friends();
        f.add("A", { url: "https://old", agent_id: "a", added_by: "x" });
        const ok = f.updateUrl("A", "https://new");
        assert.equal(ok, true);
        const r = f.get("A")!;
        assert.equal(r.base_url, "https://new");
        assert.equal(r.endpoint_url, "https://new");
        assert.ok(typeof r.last_address_update === "number");
    });

    it("updateUrl returns false for unknown friend", () => {
        const f = new Friends();
        assert.equal(f.updateUrl("ghost", "https://x"), false);
    });

    it("setLastSeen records wallclock", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        const before = Date.now();
        f.setLastSeen("A");
        const r = f.get("A")!;
        assert.ok(typeof r.last_seen_at === "number");
        assert.ok(r.last_seen_at! >= before);
    });

    it("setCardSkills replaces the list", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x", card_skills: ["one"] });
        f.setCardSkills("A", ["two", "three"]);
        assert.deepEqual(f.get("A")!.card_skills, ["two", "three"]);
    });
});

describe("Friends bearer keys (vault-backed)", () => {
    it("setKey / getKey round-trips THEIR key (presented when they call us)", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        f.setKey("A", "abc123");
        assert.equal(f.getKey("A"), "abc123");
        // Stored in vault under the documented key shape.
        assert.equal(getVault().get("a2a:friend_key:A"), "abc123");
    });

    it("setOutboundKey / getOutboundKey round-trips OUR key (presented when we call them)", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        f.setOutboundKey("A", "xyz789");
        assert.equal(f.getOutboundKey("A"), "xyz789");
        assert.equal(getVault().get("a2a:friend_outbound_key:A"), "xyz789");
    });

    it("removeKeys wipes both directions", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        f.setKey("A", "k1");
        f.setOutboundKey("A", "k2");
        f.removeKeys("A");
        assert.equal(f.getKey("A"), undefined);
        assert.equal(f.getOutboundKey("A"), undefined);
    });
});

describe("Friends.resolveByKey", () => {
    it("returns the friend name when a stored inbound key matches", () => {
        const f = new Friends();
        f.add("Alice", { url: "https://alice", agent_id: "a", added_by: "x" });
        f.add("Bob", { url: "https://bob", agent_id: "b", added_by: "x" });
        f.setKey("Alice", "alice-incoming-key");
        f.setKey("Bob", "bob-incoming-key");
        assert.equal(f.resolveByKey("alice-incoming-key"), "Alice");
        assert.equal(f.resolveByKey("bob-incoming-key"), "Bob");
    });

    it("returns null for unknown key", () => {
        const f = new Friends();
        f.add("Alice", { url: "https://alice", agent_id: "a", added_by: "x" });
        f.setKey("Alice", "alice-key");
        assert.equal(f.resolveByKey("not-a-real-key"), null);
        // Importantly: it must not match against OUR outbound key (those go in the
        // other direction; a peer never presents our outbound key to us).
        f.setOutboundKey("Alice", "our-outbound-to-alice");
        assert.equal(f.resolveByKey("our-outbound-to-alice"), null);
    });
});

describe("Friends persistence", () => {
    it("friends.json is written with the documented shape and mode 0600", () => {
        const f = new Friends();
        f.add("A", { url: "https://a", agent_id: "a", added_by: "x" });
        assert.ok(fs.existsSync(FRIENDS_FILE));
        const stat = fs.statSync(FRIENDS_FILE);
        assert.equal(stat.mode & 0o777, 0o600);
        const file = JSON.parse(fs.readFileSync(FRIENDS_FILE, "utf-8"));
        assert.equal(typeof file.version, "number");
        assert.ok(file.friends.A);
        assert.equal(file.friends.A.base_url, "https://a");
    });

    it("loads back into a fresh instance", () => {
        const f1 = new Friends();
        f1.add("A", { url: "https://a", agent_id: "a", added_by: "x", card_skills: ["s1"] });
        const f2 = new Friends();
        const r = f2.get("A");
        assert.ok(r);
        assert.deepEqual(r!.card_skills, ["s1"]);
    });

    it("throws on corrupt friends.json", () => {
        fs.mkdirSync(TEST_DIR, { recursive: true });
        fs.writeFileSync(FRIENDS_FILE, "{not json", "utf-8");
        const f = new Friends();
        assert.throws(() => f.list(), /corrupt/i);
    });
});
