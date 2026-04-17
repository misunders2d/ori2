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
            "Set the LLM model to use for FUTURE responses in a chat/channel. Takes effect on " +
            "the NEXT message — the current response is still on the old model (the running " +
            "subprocess can't be re-modeled mid-turn). " +
            "\n\n" +
            "Target resolution (in order): " +
            "(1) if you provide `target_platform` and `target_channel_id`, those are used — " +
            "use this from the TUI to set a remote channel's model; " +
            "(2) otherwise the current chat's channel is used — the normal case for 'switch " +
            "to Opus here' in a Telegram/Slack group. " +
            "\n\n" +
            "ADMIN-ONLY. Call list_available_models first to confirm provider+model_id exist. " +
            "To clear an override and fall back to the bot-wide default, pass provider='' and " +
            "model_id='' (with the usual target resolution). " +
            "\n\n" +
            "Note: this cannot change the model of the CURRENT TUI session — extensions have no " +
            "access to the live AgentSession.setModel(). Use Pi's /model slash command for that.",
        parameters: Type.Object({
            provider: Type.String({ description: "Provider id (e.g. 'anthropic', 'openai', 'google'). Empty string to clear." }),
            model_id: Type.String({ description: "Model id (e.g. 'claude-opus-4-5'). Empty string to clear." }),
            thinking_level: Type.Optional(Type.String({ description: "off | minimal | low | medium | high | xhigh. Omit for model default." })),
            target_platform: Type.Optional(Type.String({ description: "Platform of the target channel — 'telegram', 'slack', 'a2a'. Optional; defaults to current chat. Required when calling from TUI." })),
            target_channel_id: Type.Optional(Type.String({ description: "Channel id on target_platform. Optional; defaults to current chat. Required alongside target_platform." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const resolved = resolveTargetAndAdmin(ctx, {
                targetPlatform: params.target_platform,
                targetChannelId: params.target_channel_id,
                toolName: "set_channel_model",
            });

            // Clear path: empty strings → remove the override.
            if (!params.provider && !params.model_id) {
                const had = getChannelModels().clear(resolved.target.platform, resolved.target.channelId);
                return {
                    content: [{
                        type: "text",
                        text: had
                            ? `Cleared model override for ${resolved.target.platform}:${resolved.target.channelId}. Future responses will use the bot-wide default.`
                            : `No override was set for ${resolved.target.platform}:${resolved.target.channelId}.`,
                    }],
                    details: { cleared: had, ...resolved.target },
                };
            }

            if (!params.provider || !params.model_id) {
                throw new Error("Both provider and model_id must be provided together (or both empty to clear).");
            }

            // Validate against configured models — reject typos and models
            // the bot can't actually use (no API key).
            const found = ctx.modelRegistry.find(params.provider, params.model_id);
            if (!found) {
                throw new Error(
                    `Unknown model: ${params.provider}/${params.model_id}. ` +
                    `Call list_available_models first to see valid options.`,
                );
            }

            getChannelModels().set(resolved.target.platform, resolved.target.channelId, {
                provider: params.provider,
                modelId: params.model_id,
                ...(params.thinking_level !== undefined ? { thinkingLevel: params.thinking_level } : {}),
                setBy: resolved.callerDesc,
            });

            const suffix = params.thinking_level ? ` at thinking=${params.thinking_level}` : "";
            return {
                content: [{
                    type: "text",
                    text:
                        `Channel model for ${resolved.target.platform}:${resolved.target.channelId} set to ` +
                        `${params.provider}/${params.model_id}${suffix}. The next message in that channel ` +
                        `runs on the new model.`,
                }],
                details: {
                    provider: params.provider,
                    modelId: params.model_id,
                    ...(params.thinking_level !== undefined ? { thinkingLevel: params.thinking_level } : {}),
                    ...resolved.target,
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
            "Start a fresh conversation for a chat/channel. Drops the binding that links " +
            "the channel to its session JSONL, so the NEXT message creates a new session with " +
            "empty history. The old JSONL stays on disk (operator can recover manually). " +
            "\n\n" +
            "Target resolution: same as set_channel_model — optional `target_platform` + " +
            "`target_channel_id` to reset a specific remote channel from the TUI, or omit to " +
            "reset the current chat. ADMIN-ONLY.",
        parameters: Type.Object({
            target_platform: Type.Optional(Type.String({ description: "Platform of the target channel. Optional; defaults to current chat." })),
            target_channel_id: Type.Optional(Type.String({ description: "Channel id on target_platform. Optional; defaults to current chat." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const resolved = resolveTargetAndAdmin(ctx, {
                targetPlatform: params.target_platform,
                targetChannelId: params.target_channel_id,
                toolName: "reset_channel_session",
            });

            const had = getChannelSessions().remove(resolved.target.platform, resolved.target.channelId);
            return {
                content: [{
                    type: "text",
                    text: had
                        ? `Session binding for ${resolved.target.platform}:${resolved.target.channelId} cleared. The next message in that channel starts fresh.`
                        : `No session binding existed for ${resolved.target.platform}:${resolved.target.channelId} — nothing to reset.`,
                }],
                details: { reset: had, ...resolved.target },
            };
        },
    });
}

// -----------------------------------------------------------------------------
// Shared helper — resolves (target channel, admin check) for tools that need
// both. Called by set_channel_model and reset_channel_session.
//
// Target resolution:
//   1. explicit target_platform AND target_channel_id → use them.
//   2. otherwise: current chat origin (from session's transport-origin entry).
//   3. otherwise: fail.
//
// Admin check:
//   - If we resolved an origin: check whitelist.isAdmin(origin.platform, senderId).
//   - If no origin but ctx.hasUI (TUI): operator is implicit admin (owns the
//     process, the vault, the data dir — CLI is implicit admin per
//     Whitelist.isAdmin). Verified in whitelist.ts:196.
//   - If no origin AND !ctx.hasUI (a subprocess with no transport-origin seed,
//     which shouldn't normally happen — channelRouter always seeds it): fail
//     closed. ctx.hasUI verified at pi-coding-agent types.d.ts:184.
// -----------------------------------------------------------------------------

interface ResolveArgs {
    targetPlatform?: string | undefined;
    targetChannelId?: string | undefined;
    toolName: string;
}

function resolveTargetAndAdmin(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any,
    args: ResolveArgs,
): { target: { platform: string; channelId: string }; callerDesc: string } {
    const origin = currentOrigin(ctx.sessionManager);

    // ---- target ----
    let target: { platform: string; channelId: string };
    const hasTP = typeof args.targetPlatform === "string" && args.targetPlatform.length > 0;
    const hasTC = typeof args.targetChannelId === "string" && args.targetChannelId.length > 0;
    if (hasTP && hasTC) {
        target = { platform: args.targetPlatform!, channelId: args.targetChannelId! };
    } else if (hasTP || hasTC) {
        throw new Error(`${args.toolName}: target_platform and target_channel_id must be provided together.`);
    } else if (origin) {
        target = { platform: origin.platform, channelId: origin.channelId };
    } else if (ctx.hasUI) {
        throw new Error(
            `${args.toolName}: you're calling from the TUI, which has no implicit channel. ` +
            `Pass target_platform and target_channel_id explicitly — e.g. ` +
            `target_platform='telegram', target_channel_id='-100123456'.`,
        );
    } else {
        throw new Error(
            `${args.toolName}: no current channel origin and not running in TUI. ` +
            `Cannot infer target channel.`,
        );
    }

    // ---- admin check ----
    let isAdmin: boolean;
    let callerDesc: string;
    if (origin) {
        isAdmin = getWhitelist().isAdmin(origin.platform, origin.senderId);
        callerDesc = `${origin.platform}:${origin.senderId} (${origin.senderDisplayName ?? origin.senderId})`;
    } else if (ctx.hasUI) {
        // TUI operator owns the process — implicit admin. Matches the same
        // short-circuit in Whitelist.isAdmin for platform="cli".
        isAdmin = true;
        callerDesc = "cli:operator (TUI)";
    } else {
        throw new Error(`${args.toolName}: cannot identify caller.`);
    }
    if (!isAdmin) {
        throw new Error(`${args.toolName} is admin-only. Caller ${callerDesc} is not an admin.`);
    }

    return { target, callerDesc };
}
