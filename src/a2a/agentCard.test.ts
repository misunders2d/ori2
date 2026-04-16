// Pure-function tests — no env, no fs, no vault. Just the builder.
import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { buildAgentCard, FIXED_SKILLS } from "./agentCard.js";

const BASE = {
    botName: "AmazonBot",
    agentId: "ori2-amazon-bot",
    description: "Amazon listings + inventory.",
    baseUrl: "https://abc.trycloudflare.com",
};

describe("buildAgentCard — basics", () => {
    it("populates required v1.0 fields", () => {
        const card = buildAgentCard(BASE);
        assert.equal(card.id, "ori2-amazon-bot");
        assert.equal(card.name, "AmazonBot");
        assert.equal(card.version, "1.0.0"); // default
        assert.equal(card.url, "https://abc.trycloudflare.com");
        assert.equal(card.description, "Amazon listings + inventory.");
        assert.deepEqual(card.defaultInputModes, ["text/plain"]);
        assert.deepEqual(card.defaultOutputModes, ["text/plain"]);
        assert.equal(card.endpoints.length, 1);
        assert.equal(card.endpoints[0]!.type, "json-rpc");
        assert.equal(card.endpoints[0]!.url, "https://abc.trycloudflare.com");
    });

    it("capabilities default for Phase 1: poll-only, no streaming, multi-turn yes", () => {
        const card = buildAgentCard(BASE);
        assert.equal(card.capabilities.streaming, false);
        assert.equal(card.capabilities.pushNotifications, false);
        assert.equal(card.capabilities.multiTurn, true);
        assert.equal(card.capabilities.extendedAgentCard, false);
    });

    it("provider defaults to Ori2 Project + base URL when not given", () => {
        const card = buildAgentCard(BASE);
        assert.equal(card.provider.organization, "Ori2 Project");
        assert.equal(card.provider.url, "https://abc.trycloudflare.com");
    });

    it("provider override is honoured", () => {
        const card = buildAgentCard({
            ...BASE,
            providerName: "Acme Corp",
            providerUrl: "https://acme.example.com",
        });
        assert.equal(card.provider.organization, "Acme Corp");
        assert.equal(card.provider.url, "https://acme.example.com");
    });

    it("custom version is honoured", () => {
        const card = buildAgentCard({ ...BASE, version: "2.3.4" });
        assert.equal(card.version, "2.3.4");
    });
});

describe("buildAgentCard — skills composition", () => {
    it("includes the fixed core skills with no additions", () => {
        const card = buildAgentCard(BASE);
        // FIXED_SKILLS is the source of truth — assert the card contains all of them.
        for (const fixed of FIXED_SKILLS) {
            assert.ok(
                card.skills.find((s) => s.id === fixed.id),
                `expected fixed skill '${fixed.id}' in card`,
            );
        }
    });

    it("appends additionalSkills after the fixed list", () => {
        const card = buildAgentCard({
            ...BASE,
            additionalSkills: [
                { id: "amazon-listings", name: "amazon-listings", description: "...", tags: ["amazon"] },
            ],
        });
        const ids = card.skills.map((s) => s.id);
        const fixedLastIdx = ids.lastIndexOf(FIXED_SKILLS[FIXED_SKILLS.length - 1]!.id);
        const additionalIdx = ids.indexOf("amazon-listings");
        assert.ok(additionalIdx > fixedLastIdx, "additional must come after fixed");
    });

    it("appends DNA features last with `dna:` prefix on id", () => {
        const card = buildAgentCard({
            ...BASE,
            dnaFeatures: [
                { id: "clickup-integration", description: "ClickUp tasks.", tags: ["crm"] },
            ],
        });
        const dnaSkill = card.skills.find((s) => s.id === "dna:clickup-integration");
        assert.ok(dnaSkill);
        assert.equal(dnaSkill!.name, "clickup-integration");
        assert.equal(dnaSkill!.description, "ClickUp tasks.");
        assert.ok(dnaSkill!.tags?.includes("dna"));
        assert.ok(dnaSkill!.tags?.includes("crm"));
    });

    it("ordering: fixed → additional → dna", () => {
        const card = buildAgentCard({
            ...BASE,
            additionalSkills: [{ id: "extra", name: "extra", description: "x", tags: [] }],
            dnaFeatures: [{ id: "feat-x", description: "x" }],
        });
        const ids = card.skills.map((s) => s.id);
        const fixedFirstIdx = ids.indexOf(FIXED_SKILLS[0]!.id);
        const extraIdx = ids.indexOf("extra");
        const dnaIdx = ids.indexOf("dna:feat-x");
        assert.ok(fixedFirstIdx >= 0 && extraIdx > fixedFirstIdx && dnaIdx > extraIdx);
    });

    it("tolerates empty / missing skill arrays", () => {
        const card1 = buildAgentCard({ ...BASE, additionalSkills: [], dnaFeatures: [] });
        const card2 = buildAgentCard(BASE);
        assert.equal(card1.skills.length, card2.skills.length); // only fixed in both
    });
});

describe("buildAgentCard — security scheme", () => {
    it("omits securitySchemes/security entirely when hasApiKey is false", () => {
        const card = buildAgentCard({ ...BASE, hasApiKey: false });
        assert.equal(card.securitySchemes, undefined);
        assert.equal(card.security, undefined);
    });

    it("declares apiKey scheme when hasApiKey is true", () => {
        const card = buildAgentCard({ ...BASE, hasApiKey: true });
        assert.ok(card.securitySchemes);
        assert.deepEqual(card.securitySchemes!["apiKey"], {
            type: "apiKey",
            name: "x-a2a-api-key",
            in: "header",
        });
        assert.deepEqual(card.security, [{ apiKey: [] }]);
    });
});
