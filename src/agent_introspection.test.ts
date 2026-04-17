process.env["BOT_NAME"] = "_test_agent_introspection";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./core/paths.js";
import { clearRegistryForTests } from "./core/singletons.js";
import { ChannelModels, getChannelModels } from "./core/channelModels.js";
import { ChannelSessions } from "./core/channelSessions.js";
import { getWhitelist } from "./core/whitelist.js";

// =============================================================================
// Regression tests for agent_introspection tools. Each case targets a specific
// failure mode that has bitten a real session:
//
//   - set_channel_model from TUI without target args — user hit this in live
//     chat; tool crashed with "requires an identifiable origin". Fix: accept
//     explicit target_platform + target_channel_id; hasUI+operator = implicit
//     admin.
//
//   - set_channel_model from non-TUI subprocess with no origin — fail closed.
//
//   - reset_channel_session with explicit target — same resolver path.
// =============================================================================

interface FakeCtx {
    sessionManager: { getBranch: () => Array<{ type: string; customType?: string; data?: unknown }> };
    modelRegistry: {
        find: (p: string, id: string) => { provider: string; id: string; name: string } | undefined;
        getAvailable: () => Array<{ provider: string; id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] }>;
        hasConfiguredAuth: (m: { provider: string; id: string }) => boolean;
    };
    model: undefined | { provider: string; id: string; name: string; contextWindow: number; maxTokens: number; reasoning: boolean; input: string[] };
    hasUI: boolean;
    cwd: string;
    ui: { notify: () => void };
    isIdle: () => boolean;
    signal: undefined;
    abort: () => void;
    hasPendingMessages: () => boolean;
    shutdown: () => void;
    getContextUsage: () => undefined;
    compact: () => void;
    getSystemPrompt: () => string;
}

function makeCtx(opts: {
    hasUI: boolean;
    origin?: { platform: string; senderId: string; senderDisplayName?: string; channelId: string };
    /** Providers considered "authenticated" — hasConfiguredAuth returns true
     *  for models under these. Defaults to ["anthropic", "google"]. */
    authenticatedProviders?: string[];
} = { hasUI: false }): FakeCtx {
    const authProviders = new Set(opts.authenticatedProviders ?? ["anthropic", "google"]);
    const branch = opts.origin
        ? [{
            type: "custom",
            customType: "transport-origin",
            data: {
                platform: opts.origin.platform,
                senderId: opts.origin.senderId,
                senderDisplayName: opts.origin.senderDisplayName ?? opts.origin.senderId,
                channelId: opts.origin.channelId,
                timestamp: Date.now(),
            },
        }]
        : [];
    return {
        sessionManager: { getBranch: () => branch },
        modelRegistry: {
            find: (p, id) => {
                if (p === "anthropic" && id === "claude-opus-4-5") return { provider: p, id, name: "Claude Opus 4.5" };
                if (p === "google" && id === "gemini-3.1-flash") return { provider: p, id, name: "Gemini 3.1 Flash" };
                // openai model exists in the registry but isn't in authProviders
                // by default — test fixture for the auth-missing case.
                if (p === "openai" && id === "gpt-4o") return { provider: p, id, name: "GPT-4o" };
                return undefined;
            },
            getAvailable: () => [
                { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", contextWindow: 200000, maxTokens: 16000, reasoning: true, input: ["text", "image"] },
            ],
            hasConfiguredAuth: (m) => authProviders.has(m.provider),
        },
        model: { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5", contextWindow: 200000, maxTokens: 16000, reasoning: true, input: ["text", "image"] },
        hasUI: opts.hasUI,
        cwd: process.cwd(),
        ui: { notify: () => {} },
        isIdle: () => true,
        signal: undefined,
        abort: () => {},
        hasPendingMessages: () => false,
        shutdown: () => {},
        getContextUsage: () => undefined,
        compact: () => {},
        getSystemPrompt: () => "",
    };
}

interface CapturedTool {
    name: string;
    execute: (id: string, params: Record<string, unknown>, signal: unknown, onUpdate: unknown, ctx: FakeCtx) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

function makeFakePi(): { tools: CapturedTool[]; api: unknown } {
    const tools: CapturedTool[] = [];
    const api = {
        on: () => {},
        registerTool: (t: CapturedTool) => { tools.push(t); },
        registerCommand: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        events: { on: () => {}, emit: () => {} },
    };
    return { tools, api };
}

async function loadTools(): Promise<CapturedTool[]> {
    const { api, tools } = makeFakePi();
    const factory = (await import("../.pi/extensions/agent_introspection.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    return tools;
}

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe("agent_introspection — set_channel_model target resolution", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cleanTestDir();
        clearRegistryForTests();
        ChannelModels.__resetForTests();
        ChannelSessions.__resetForTests();
    });

    it("works from TUI when explicit target is provided", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;
        assert.ok(t, "tool must be registered");

        const ctx = makeCtx({ hasUI: true });
        const out = await t.execute("call", {
            provider: "anthropic",
            model_id: "claude-opus-4-5",
            target_platform: "telegram",
            target_channel_id: "-100marketing",
        }, null, null, ctx);

        assert.match(out.content[0]!.text, /telegram:-100marketing/);
        assert.match(out.content[0]!.text, /claude-opus-4-5/);
        assert.equal(getChannelModels().get("telegram", "-100marketing")?.modelId, "claude-opus-4-5");
    });

    it("fails from TUI with a HELPFUL error when no target args", async () => {
        // Previous bug: "requires an identifiable origin. Not available in this context."
        // — user couldn't tell what to do. New behavior: explicit guidance.
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;
        const ctx = makeCtx({ hasUI: true });

        await assert.rejects(
            async () => {
                await t.execute("call", {
                    provider: "anthropic",
                    model_id: "claude-opus-4-5",
                }, null, null, ctx);
            },
            /target_platform.*target_channel_id/,
        );
    });

    it("uses current origin when no explicit target is provided (non-TUI)", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;

        // Simulate a subprocess-side call: hasUI=false, origin entry present.
        getWhitelist().add("telegram", "alice", { roles: ["admin"], addedBy: "test" });
        const ctx = makeCtx({
            hasUI: false,
            origin: { platform: "telegram", senderId: "alice", channelId: "-100group", senderDisplayName: "Alice" },
        });
        const out = await t.execute("call", {
            provider: "anthropic",
            model_id: "claude-opus-4-5",
        }, null, null, ctx);

        assert.match(out.content[0]!.text, /telegram:-100group/);
        assert.equal(getChannelModels().get("telegram", "-100group")?.modelId, "claude-opus-4-5");
    });

    it("fails closed from non-TUI subprocess with no origin", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;

        const ctx = makeCtx({ hasUI: false });
        await assert.rejects(
            async () => {
                await t.execute("call", {
                    provider: "anthropic",
                    model_id: "claude-opus-4-5",
                }, null, null, ctx);
            },
            /no current channel origin.*not running in TUI|Cannot infer/,
        );
    });

    it("rejects non-admin caller from chat origin", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;

        // alice is allowlisted but not admin.
        getWhitelist().add("telegram", "alice", { roles: ["user"], addedBy: "test" });
        const ctx = makeCtx({
            hasUI: false,
            origin: { platform: "telegram", senderId: "alice", channelId: "-100group" },
        });
        await assert.rejects(
            async () => {
                await t.execute("call", {
                    provider: "anthropic",
                    model_id: "claude-opus-4-5",
                }, null, null, ctx);
            },
            /admin-only/i,
        );
    });

    it("TUI operator is implicit admin even without an explicit whitelist entry", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;
        // No whitelist setup — TUI operator should still pass the admin check
        // because hasUI=true implies operator owns the process.
        const ctx = makeCtx({ hasUI: true });
        const out = await t.execute("call", {
            provider: "anthropic",
            model_id: "claude-opus-4-5",
            target_platform: "telegram",
            target_channel_id: "-100any",
        }, null, null, ctx);
        assert.match(out.content[0]!.text, /-100any/);
    });

    it("rejects unknown provider/model_id (not in registry)", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;
        const ctx = makeCtx({ hasUI: true });
        await assert.rejects(
            async () => {
                await t.execute("call", {
                    provider: "anthropic",
                    model_id: "nonexistent-model",
                    target_platform: "telegram",
                    target_channel_id: "-100",
                }, null, null, ctx);
            },
            /Unknown model/,
        );
    });

    it("rejects a model that exists in the registry but has no configured credentials", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;
        // openai is NOT in authenticatedProviders — find() succeeds but
        // hasConfiguredAuth() returns false.
        const ctx = makeCtx({ hasUI: true, authenticatedProviders: ["anthropic", "google"] });
        await assert.rejects(
            async () => {
                await t.execute("call", {
                    provider: "openai",
                    model_id: "gpt-4o",
                    target_platform: "telegram",
                    target_channel_id: "-100",
                }, null, null, ctx);
            },
            /no configured credentials|OPENAI_API_KEY/i,
        );
    });

    it("clear path (empty provider + model_id) removes the binding for the resolved target", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "set_channel_model")!;
        const ctx = makeCtx({ hasUI: true });

        // Pre-seed a binding.
        getChannelModels().set("telegram", "-100clearme", {
            provider: "anthropic",
            modelId: "claude-opus-4-5",
            setBy: "test",
        });
        assert.ok(getChannelModels().get("telegram", "-100clearme"));

        const out = await t.execute("call", {
            provider: "",
            model_id: "",
            target_platform: "telegram",
            target_channel_id: "-100clearme",
        }, null, null, ctx);

        assert.match(out.content[0]!.text, /Cleared/);
        assert.equal(getChannelModels().get("telegram", "-100clearme"), undefined);
    });
});

describe("agent_introspection — reset_channel_session target resolution", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cleanTestDir();
        clearRegistryForTests();
        ChannelModels.__resetForTests();
        ChannelSessions.__resetForTests();
    });

    it("works from TUI with explicit target", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "reset_channel_session")!;
        assert.ok(t);
        const ctx = makeCtx({ hasUI: true });
        // No binding yet — still resolves OK; returns "nothing to reset".
        const out = await t.execute("call", {
            target_platform: "telegram",
            target_channel_id: "-100neverseen",
        }, null, null, ctx);
        assert.match(out.content[0]!.text, /nothing to reset/);
    });

    it("fails from TUI with no target args (helpful error)", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "reset_channel_session")!;
        const ctx = makeCtx({ hasUI: true });
        await assert.rejects(
            async () => { await t.execute("call", {}, null, null, ctx); },
            /target_platform.*target_channel_id/,
        );
    });
});

describe("agent_introspection — get_current_model", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cleanTestDir();
        clearRegistryForTests();
    });

    it("returns live model info from ctx.model", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "get_current_model")!;
        const ctx = makeCtx({ hasUI: true });
        const out = await t.execute("call", {}, null, null, ctx);
        assert.match(out.content[0]!.text, /Claude Opus 4.5/);
        assert.match(out.content[0]!.text, /anthropic/);
        assert.match(out.content[0]!.text, /claude-opus-4-5/);
    });

    it("handles no-model-configured gracefully", async () => {
        const tools = await loadTools();
        const t = tools.find((x) => x.name === "get_current_model")!;
        const ctx = makeCtx({ hasUI: true });
        ctx.model = undefined;
        const out = await t.execute("call", {}, null, null, ctx);
        assert.match(out.content[0]!.text, /No model is currently configured/i);
    });
});
