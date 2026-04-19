import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import {
    auditSessionForEvolution,
    PRIOR_ART_ENTRY,
    SAFETY_ACK_ENTRY,
} from "./evolutionAudit.js";

function priorArtEntry(overrides: Record<string, unknown> = {}): unknown {
    return {
        type: "custom",
        customType: PRIOR_ART_ENTRY,
        data: {
            domain: "pinecone",
            pi_examples_checked: ["subagent"],
            github_searches_performed: [{ query: "pi.registerTool pinecone", relevant_hits: [] }],
            sdk_docs_reviewed: ["https://docs.pinecone.io"],
            conclusion: "adapt-existing: subagent pattern",
            at: Date.now(),
            ...overrides,
        },
    };
}

function safetyAckEntry(overrides: Record<string, unknown> = {}): unknown {
    return {
        type: "custom",
        customType: SAFETY_ACK_ENTRY,
        data: {
            domain: "pinecone",
            risks_enumerated: [
                { category: "credentials", specifics: "API key via /credentials", mitigation: "getCredential()" },
                { category: "exfil", specifics: "HTTPS only", mitigation: "pinned domain" },
            ],
            briefing_shown_to_user: "Here are the risks…",
            user_acknowledged: true,
            at: Date.now(),
            ...overrides,
        },
    };
}

describe("auditSessionForEvolution — evolution-sop gate helper", () => {
    it("empty branch → both gates MISSING, remedy explains which tools to call", () => {
        const res = auditSessionForEvolution([]);
        assert.equal(res.hasValidPriorArt, false);
        assert.equal(res.hasValidSafetyAck, false);
        assert.equal(res.missing.length, 2);
        assert.match(res.remedy, /evolution_prior_art_search/);
        assert.match(res.remedy, /evolve_safety_ack/);
    });

    it("only prior-art → safety-ack MISSING", () => {
        const res = auditSessionForEvolution([priorArtEntry()]);
        assert.equal(res.hasValidPriorArt, true);
        assert.equal(res.hasValidSafetyAck, false);
        assert.equal(res.missing.length, 1);
        assert.match(res.missing[0]!, /safety/i);
    });

    it("only safety-ack → prior-art MISSING", () => {
        const res = auditSessionForEvolution([safetyAckEntry()]);
        assert.equal(res.hasValidPriorArt, false);
        assert.equal(res.hasValidSafetyAck, true);
        assert.equal(res.missing.length, 1);
        assert.match(res.missing[0]!, /prior-art/i);
    });

    it("both present AND user_acknowledged=true → gate passes clean", () => {
        const res = auditSessionForEvolution([priorArtEntry(), safetyAckEntry()]);
        assert.equal(res.hasValidPriorArt, true);
        assert.equal(res.hasValidSafetyAck, true);
        assert.equal(res.missing.length, 0);
        assert.equal(res.remedy, "");
        assert.equal(res.mostRecentPriorArt?.domain, "pinecone");
        assert.equal(res.mostRecentSafetyAck?.risks_count, 2);
    });

    it("user_acknowledged=false → safety-ack present but INVALID; gate MUST fail", () => {
        const res = auditSessionForEvolution([
            priorArtEntry(),
            safetyAckEntry({ user_acknowledged: false }),
        ]);
        assert.equal(res.hasValidPriorArt, true);
        assert.equal(res.hasValidSafetyAck, false, "ack without user acknowledgement must NOT count as valid");
        assert.ok(res.missing.some((m) => /acknowledge/i.test(m)), "remedy must call out the missing user ack specifically");
    });

    it("most-recent entry wins when multiple exist in same session", () => {
        const res = auditSessionForEvolution([
            priorArtEntry({ domain: "sendgrid", at: 1000 }),
            priorArtEntry({ domain: "pinecone", at: 2000 }),
            safetyAckEntry({ domain: "pinecone" }),
        ]);
        assert.equal(res.hasValidPriorArt, true);
        assert.equal(res.mostRecentPriorArt?.domain, "pinecone", "the later-in-branch entry is picked");
    });

    it("ignores unrelated custom entries (transport-origin, plan-enforcer state, etc.)", () => {
        const res = auditSessionForEvolution([
            { type: "custom", customType: "transport-origin", data: { platform: "telegram" } },
            { type: "message", role: "user", content: "hi" },
            priorArtEntry(),
            safetyAckEntry(),
        ]);
        assert.equal(res.hasValidPriorArt, true);
        assert.equal(res.hasValidSafetyAck, true);
    });

    it("malformed entries are skipped silently (no crashes on corrupt session)", () => {
        const res = auditSessionForEvolution([
            null,
            "garbage",
            { type: "custom" /* no customType or data */ },
            { type: "custom", customType: PRIOR_ART_ENTRY /* no data */ },
            { type: "custom", customType: PRIOR_ART_ENTRY, data: null },
            priorArtEntry(),
            safetyAckEntry(),
        ]);
        assert.equal(res.hasValidPriorArt, true);
        assert.equal(res.hasValidSafetyAck, true);
    });
});
