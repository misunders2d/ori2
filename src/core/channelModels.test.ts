process.env["BOT_NAME"] = "_test_channel_models";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { ChannelModels, getChannelModels } from "./channelModels.js";

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe("ChannelModels", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cleanTestDir();
        ChannelModels.__resetForTests();
    });

    it("get() returns undefined for an unset channel", () => {
        const cm = getChannelModels();
        assert.equal(cm.get("telegram", "-100"), undefined);
    });

    it("set() then get() round-trips a binding", () => {
        const cm = getChannelModels();
        cm.set("telegram", "-100", {
            provider: "anthropic",
            modelId: "claude-opus-4-5",
            thinkingLevel: "medium",
            setBy: "telegram:alice",
        });
        const got = cm.get("telegram", "-100");
        assert.ok(got);
        assert.equal(got!.provider, "anthropic");
        assert.equal(got!.modelId, "claude-opus-4-5");
        assert.equal(got!.thinkingLevel, "medium");
        assert.equal(got!.setBy, "telegram:alice");
    });

    it("set() is per-(platform, channelId) — same channelId on different platforms is separate", () => {
        const cm = getChannelModels();
        cm.set("telegram", "chan-X", { provider: "anthropic", modelId: "a", setBy: "t" });
        cm.set("slack", "chan-X", { provider: "openai", modelId: "b", setBy: "t" });
        assert.equal(cm.get("telegram", "chan-X")!.provider, "anthropic");
        assert.equal(cm.get("slack", "chan-X")!.provider, "openai");
    });

    it("set() replaces an existing binding", () => {
        const cm = getChannelModels();
        cm.set("telegram", "-100", { provider: "anthropic", modelId: "sonnet-4-6", setBy: "t" });
        cm.set("telegram", "-100", { provider: "anthropic", modelId: "opus-4-5", setBy: "t" });
        assert.equal(cm.get("telegram", "-100")!.modelId, "opus-4-5");
    });

    it("clear() removes the binding, returns true once then false", () => {
        const cm = getChannelModels();
        cm.set("telegram", "-100", { provider: "anthropic", modelId: "opus", setBy: "t" });
        assert.equal(cm.clear("telegram", "-100"), true);
        assert.equal(cm.clear("telegram", "-100"), false);
        assert.equal(cm.get("telegram", "-100"), undefined);
    });

    it("all() lists every binding", () => {
        const cm = getChannelModels();
        cm.set("telegram", "-100", { provider: "anthropic", modelId: "a", setBy: "t" });
        cm.set("slack", "C-X", { provider: "openai", modelId: "b", setBy: "t" });
        const list = cm.all();
        assert.equal(list.length, 2);
    });

    it("persists across instances (reload simulation)", () => {
        const cm1 = getChannelModels();
        cm1.set("telegram", "-100", {
            provider: "anthropic",
            modelId: "opus-4-5",
            thinkingLevel: "high",
            setBy: "t",
        });

        ChannelModels.__resetForTests();
        const cm2 = getChannelModels();
        const got = cm2.get("telegram", "-100");
        assert.ok(got);
        assert.equal(got!.provider, "anthropic");
        assert.equal(got!.modelId, "opus-4-5");
        assert.equal(got!.thinkingLevel, "high");
    });
});
