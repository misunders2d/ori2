import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { getChannelModels } from "../../src/core/channelModels.js";
import { getChannelSessions } from "../../src/core/channelSessions.js";

// =============================================================================
// agent_introspection — tools the agent uses to answer questions about itself
// and manage its own runtime state from chat. Users on Telegram/Slack/A2A
// won't type slash commands; the LLM invokes these tools on their behalf.
//
// Design notes:
//   - `get_current_model` / `list_available_models` are READ-ONLY, available
//     to anyone who can already reach the agent.
//   - `set_channel_model` / `reset_channel_session` are ADMIN-ONLY. A random
//     group member shouldn't be able to make us use Opus (cost) or wipe the
//     channel history (sabotage).
//   - `compact_conversation` is available to any caller — compaction is a
//     non-destructive optimization.
//   - Pi exposes model state on ExtensionContext (`ctx.model`,
//     `ctx.getContextUsage()`, `ctx.compact()`) so tools can introspect the
//     LIVE subprocess session without us re-implementing model resolution.
//     Verified at node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts:180-209.
//   - Per-channel model override works by having channelRouter pass
//     `--model provider/id[:thinking]` to the next `pi -p` subprocess spawn.
//     Affects future turns, not the current one — Pi's AgentSession commits
//     to its model at spawn time (verified in main.js args parsing).
// =============================================================================

export default function (pi: ExtensionAPI) {
    // ---------------- get_current_model ----------------

    pi.registerTool({
        name: "get_current_model",
        label: "Get Current Model",
        description:
            "Return the LLM model this agent is currently running on — provider, model id, " +
            "context window, thinking support. Use when the user asks 'what model are you?' or " +
            "'which LLM is this?'. Read-only; no side effects.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const m = ctx.model;
            if (!m) {
                return {
                    content: [{ type: "text", text: "No model is currently configured for this session." }],
                    details: { configured: false },
                };
            }
            const lines = [
                `Model: ${m.name}`,
                `Provider: ${m.provider}`,
                `Model ID: ${m.id}`,
                `Context window: ${m.contextWindow.toLocaleString()} tokens`,
                `Max output: ${m.maxTokens.toLocaleString()} tokens`,
                `Reasoning: ${m.reasoning ? "yes" : "no"}`,
                `Modalities: ${m.input.join(", ")}`,
            ];
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {
                    provider: m.provider,
                    id: m.id,
                    name: m.name,
                    contextWindow: m.contextWindow,
                    maxTokens: m.maxTokens,
                    reasoning: m.reasoning,
                    input: m.input,
                },
            };
        },
    });

    // ---------------- list_available_models ----------------

    pi.registerTool({
        name: "list_available_models",
        label: "List Available Models",
        description:
            "List every model this bot has valid credentials for. Use when the user asks 'what " +
            "models can you use?' or before set_channel_model to show options. " +
            "Returns only models whose API keys / OAuth tokens are actually configured.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const available = ctx.modelRegistry.getAvailable();
            if (available.length === 0) {
                return {
                    content: [{ type: "text", text: "No models available — no provider credentials configured." }],
                    details: { count: 0, models: [] },
                };
            }
            // Group by provider for readability.
            const byProvider = new Map<string, typeof available>();
            for (const m of available) {
                const list = byProvider.get(m.provider) ?? [];
                list.push(m);
                byProvider.set(m.provider, list);
            }
            const lines: string[] = [];
            for (const [provider, models] of byProvider) {
                lines.push(`**${provider}**`);
                for (const m of models) {
                    const reasoning = m.reasoning ? " [reasoning]" : "";
                    lines.push(`  - ${m.id} — ${m.name}, ${m.contextWindow.toLocaleString()}ctx${reasoning}`);
                }
            }
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: {
                    count: available.length,
                    models: available.map((m) => ({
                        provider: m.provider,
                        id: m.id,
                        name: m.name,
                        contextWindow: m.contextWindow,
                        reasoning: m.reasoning,
                    })),
                },
            };
        },
    });

    // ---------------- set_channel_model (admin-only) ----------------

    pi.registerTool({
        name: "set_channel_model",
        label: "Set Channel Model",
        description:
            "Set the LLM model to use for FUTURE responses in the current chat/channel. " +
            "Takes effect on the next message — not this one (the current subprocess is already " +
            "running on whatever model it was spawned with). ADMIN-ONLY: prevents random users " +
            "from running up costs or swapping capabilities. Call list_available_models first " +
            "to confirm the provider + model_id are valid. " +
            "To clear an override and fall back to the bot-wide default, set provider='' and model_id=''.",
        parameters: Type.Object({
            provider: Type.String({ description: "Provider id from list_available_models (e.g. 'anthropic', 'openai', 'google'). Empty string to clear." }),
            model_id: Type.String({ description: "Model id from list_available_models (e.g. 'claude-opus-4-5'). Empty string to clear." }),
            thinking_level: Type.Optional(Type.String({ description: "Optional thinking level: off | minimal | low | medium | high | xhigh. Omit for model default." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const origin = currentOrigin(ctx.sessionManager);
            if (!origin) {
                throw new Error("set_channel_model requires an identifiable origin (channel). Not available in this context.");
            }
            if (!getWhitelist().isAdmin(origin.platform, origin.senderId)) {
                throw new Error("set_channel_model is admin-only. Ask an admin to run this tool.");
            }

            // Clear path: empty strings → remove the override.
            if (!params.provider && !params.model_id) {
                const had = getChannelModels().clear(origin.platform, origin.channelId);
                return {
                    content: [{
                        type: "text",
                        text: had
                            ? `Cleared model override for ${origin.platform}:${origin.channelId}. Future responses will use the bot-wide default.`
                            : `No override was set for ${origin.platform}:${origin.channelId}.`,
                    }],
                    details: { cleared: had, platform: origin.platform, channelId: origin.channelId },
                };
            }

            if (!params.provider || !params.model_id) {
                throw new Error("Both provider and model_id must be provided together (or both empty to clear).");
            }

            // Validate against the configured models — reject typos and models
            // the bot can't actually use (no API key).
            const found = ctx.modelRegistry.find(params.provider, params.model_id);
            if (!found) {
                throw new Error(
                    `Unknown model: ${params.provider}/${params.model_id}. ` +
                    `Call list_available_models first to see valid options.`,
                );
            }

            const setByOpt = origin.senderDisplayName ?? origin.senderId;
            getChannelModels().set(origin.platform, origin.channelId, {
                provider: params.provider,
                modelId: params.model_id,
                ...(params.thinking_level !== undefined ? { thinkingLevel: params.thinking_level } : {}),
                setBy: `${origin.platform}:${origin.senderId} (${setByOpt})`,
            });

            const suffix = params.thinking_level ? ` at thinking=${params.thinking_level}` : "";
            return {
                content: [{
                    type: "text",
                    text:
                        `Channel model set to ${params.provider}/${params.model_id}${suffix}. ` +
                        `The NEXT message in this channel will run on the new model. ` +
                        `The current response you're about to receive is still on the old one.`,
                }],
                details: {
                    provider: params.provider,
                    modelId: params.model_id,
                    ...(params.thinking_level !== undefined ? { thinkingLevel: params.thinking_level } : {}),
                    platform: origin.platform,
                    channelId: origin.channelId,
                },
            };
        },
    });

    // ---------------- compact_conversation ----------------

    pi.registerTool({
        name: "compact_conversation",
        label: "Compact Conversation",
        description:
            "Summarize older messages to free up context window space. Pi replaces the bulk of " +
            "the session history with a single compacted summary, keeping the most recent " +
            "messages verbatim. Use when context is approaching the window limit, or when the " +
            "user asks you to 'summarize what we've discussed' / 'start over but remember what " +
            "we did'. Non-destructive — the original session JSONL is preserved on disk.",
        parameters: Type.Object({
            custom_instructions: Type.Optional(Type.String({
                description: "Optional guidance for the summary (e.g. 'focus on technical decisions' or 'preserve all file paths mentioned').",
            })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const opts = params.custom_instructions
                ? { customInstructions: params.custom_instructions }
                : {};
            ctx.compact(opts);
            return {
                content: [{
                    type: "text",
                    text: "Compaction started. The session's older messages will be replaced with a summary. The next turn you see will have a shorter context.",
                }],
                details: { started: true, ...opts },
            };
        },
    });

    // ---------------- get_context_usage ----------------

    pi.registerTool({
        name: "get_context_usage",
        label: "Get Context Usage",
        description:
            "Report how much of the model's context window is currently in use. Answers 'how " +
            "much context have we used?' and helps decide when to call compact_conversation.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const usage = ctx.getContextUsage();
            if (!usage) {
                return {
                    content: [{ type: "text", text: "Context usage is not yet available (no turn has completed)." }],
                    details: { available: false },
                };
            }
            return {
                content: [{ type: "text", text: JSON.stringify(usage, null, 2) }],
                details: { available: true, ...usage },
            };
        },
    });

    // ---------------- reset_channel_session (admin-only) ----------------

    pi.registerTool({
        name: "reset_channel_session",
        label: "Reset Channel Session",
        description:
            "Start a fresh conversation for this channel. Drops the binding that links " +
            "this channel to its session JSONL, so the NEXT message creates a new session " +
            "with empty history. The old JSONL stays on disk (operator can recover manually). " +
            "ADMIN-ONLY. Use when the user explicitly asks to start over — 'new conversation', " +
            "'forget everything', 'clear'. Warn them this is irreversible from their side.",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
            const origin = currentOrigin(ctx.sessionManager);
            if (!origin) {
                throw new Error("reset_channel_session requires an identifiable origin (channel).");
            }
            if (!getWhitelist().isAdmin(origin.platform, origin.senderId)) {
                throw new Error("reset_channel_session is admin-only.");
            }
            const had = getChannelSessions().remove(origin.platform, origin.channelId);
            return {
                content: [{
                    type: "text",
                    text: had
                        ? `Session binding for ${origin.platform}:${origin.channelId} cleared. The next message in this channel starts fresh.`
                        : `No session binding existed for ${origin.platform}:${origin.channelId} — nothing to reset.`,
                }],
                details: { reset: had, platform: origin.platform, channelId: origin.channelId },
            };
        },
    });
}
