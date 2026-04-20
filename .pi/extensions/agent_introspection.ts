import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { getChannelModels } from "../../src/core/channelModels.js";
import { getChannelSessions } from "../../src/core/channelSessions.js";
import { getChannelRuntime } from "../../src/transport/channelRuntime.js";

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
                // Live-evict the cached session so the next turn rebuilds
                // with the bot-wide default. Without this, the cleared
                // override persists on disk but the running session keeps
                // the old model until cache eviction — same bug class as
                // the set path below.
                const live = had
                    ? await getChannelRuntime().resetChannel(resolved.target.platform, resolved.target.channelId)
                    : { reset: false, reason: "nothing-to-clear" };
                return {
                    content: [{
                        type: "text",
                        text: had
                            ? `Cleared model override for ${resolved.target.platform}:${resolved.target.channelId}.` +
                              (live.reset
                                ? " Live session evicted; next message starts fresh on the bot-wide default."
                                : " No cached session to evict; next message will use the default.")
                            : `No override was set for ${resolved.target.platform}:${resolved.target.channelId}.`,
                    }],
                    details: { cleared: had, live_reset: live.reset, ...resolved.target },
                };
            }

            if (!params.provider || !params.model_id) {
                throw new Error("Both provider and model_id must be provided together (or both empty to clear).");
            }

            // Validate against configured models — reject typos and models
            // the bot can't actually use. Two-layer check:
            //   1. find() — model exists in the registry at all (rejects typos).
            //   2. hasConfiguredAuth() — auth is wired for this model, so the
            //      next subprocess won't fail at runtime with "no API key".
            //      Verified at pi-coding-agent/dist/core/model-registry.d.ts:64.
            const found = ctx.modelRegistry.find(params.provider, params.model_id);
            if (!found) {
                throw new Error(
                    `Unknown model: ${params.provider}/${params.model_id}. ` +
                    `Call list_available_models first to see valid options.`,
                );
            }
            if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
                throw new Error(
                    `Model ${params.provider}/${params.model_id} exists in the registry but has no ` +
                    `configured credentials. Add an API key (e.g. /login or set ${params.provider.toUpperCase()}_API_KEY) ` +
                    `and call list_available_models to confirm it's listed as available.`,
                );
            }

            getChannelModels().set(resolved.target.platform, resolved.target.channelId, {
                provider: params.provider,
                modelId: params.model_id,
                ...(params.thinking_level !== undefined ? { thinkingLevel: params.thinking_level } : {}),
                setBy: resolved.callerDesc,
            });

            // Live-apply to the cached session so the change takes effect on
            // the NEXT turn in that channel — not on the next cache rebuild
            // (which could be 15min away, or never). Without this, the agent
            // confidently reports "model has been set" while continuing to
            // answer on the old model indefinitely.
            const live = await getChannelRuntime().applyChannelModel(
                resolved.target.platform,
                resolved.target.channelId,
            );

            const suffix = params.thinking_level ? ` at thinking=${params.thinking_level}` : "";
            const liveNote = live.applied
                ? " The live session was updated — the NEXT turn uses the new model."
                : live.reason === "no-active-session"
                    ? " No cached session for that channel yet; the first message will use the new model."
                    : ` (Live-apply warning: ${live.reason ?? "unknown"}. Persisted to disk; restart the channel or call reset_channel_session to force.)`;
            return {
                content: [{
                    type: "text",
                    text:
                        `Channel model for ${resolved.target.platform}:${resolved.target.channelId} set to ` +
                        `${params.provider}/${params.model_id}${suffix}.${liveNote}`,
                }],
                details: {
                    provider: params.provider,
                    modelId: params.model_id,
                    ...(params.thinking_level !== undefined ? { thinkingLevel: params.thinking_level } : {}),
                    live_applied: live.applied,
                    ...(live.reason ? { live_reason: live.reason } : {}),
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

            // Two-step reset:
            //   1. Drop the disk binding (platform/channelId → sessionFile) so
            //      the next inbound lazy-creates a NEW JSONL.
            //   2. Evict the CACHED AgentSession in ChannelRuntime. Without
            //      this, the cached entry keeps the old session alive and
            //      the user's "reset" is invisible — same class-of-bug as
            //      the pre-fix set_channel_model.
            const hadBinding = getChannelSessions().remove(resolved.target.platform, resolved.target.channelId);
            const live = await getChannelRuntime().resetChannel(resolved.target.platform, resolved.target.channelId);
            const anyEffect = hadBinding || live.reset;
            return {
                content: [{
                    type: "text",
                    text: anyEffect
                        ? `Session for ${resolved.target.platform}:${resolved.target.channelId} reset. ` +
                          `(Binding cleared: ${hadBinding}; cached session evicted: ${live.reset}.) ` +
                          `The next message in that channel starts fresh.`
                        : `No active state existed for ${resolved.target.platform}:${resolved.target.channelId} — nothing to reset.`,
                }],
                details: {
                    reset: anyEffect,
                    binding_cleared: hadBinding,
                    live_session_evicted: live.reset,
                    ...(live.reason ? { live_reason: live.reason } : {}),
                    ...resolved.target,
                },
            };
        },
    });

    // ---------------- hand_off_session (admin-only) ----------------
    //
    // Fresh session SEEDED with a summary of the current one. Different from:
    //   - reset_channel_session — discards everything.
    //   - compact_conversation — stays in-place, same session.
    //
    // The heavy-lifting (compact → dispose → swap → seed) lives in
    // ChannelRuntime.handOffChannel. Deferred post-turn. Compact runs FIRST;
    // if it fails we abort before any destructive step, so the user never
    // loses history to a half-completed hand-off.

    pi.registerTool({
        name: "hand_off_session",
        label: "Hand Off Session",
        description:
            "Start a FRESH session in this channel, seeded with a summary of the current " +
            "conversation. Use when the chat has grown long OR the user says things like " +
            "\"let's continue fresh but don't forget the gist\" / \"clear but remember what " +
            "we did\" / \"new session but keep context\" / \"hand off to a new session\". " +
            "\n\n" +
            "Differs from `reset_channel_session` (which throws away everything) and from " +
            "`compact_conversation` (which stays in-place). Here, Pi compacts the current " +
            "session to produce a summary, then swaps to a new session file with that " +
            "summary written as the first visible entry. Next message lands in the fresh " +
            "session with the summary as its only context. " +
            "\n\n" +
            "Runs AFTER this turn completes — same pattern as reload_extensions. " +
            "If compaction fails (e.g., session too short), the operation aborts and the " +
            "current session is unchanged. Old session JSONL is preserved on disk. " +
            "ADMIN-ONLY. " +
            "\n\n" +
            "Not supported on CLI/TUI — use Pi's `/new` slash command instead.",
        parameters: Type.Object({
            target_platform: Type.Optional(Type.String({ description: "Platform of the target channel. Optional; defaults to current chat." })),
            target_channel_id: Type.Optional(Type.String({ description: "Channel id on target_platform. Optional; defaults to current chat." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const resolved = resolveTargetAndAdmin(ctx, {
                targetPlatform: params.target_platform,
                targetChannelId: params.target_channel_id,
                toolName: "hand_off_session",
            });
            if (resolved.target.platform === "cli") {
                return {
                    content: [{
                        type: "text",
                        text: "You're on the TUI — use Pi's `/new` slash command to start a fresh session. This tool only swaps per-channel chat sessions.",
                    }],
                    details: { queued: false, ...resolved.target, reason: "cli-uses-native-new" },
                };
            }
            const result = await getChannelRuntime().handOffChannel(
                resolved.target.platform,
                resolved.target.channelId,
            );
            return {
                content: [{
                    type: "text",
                    text: result.queued
                        ? `Hand-off queued for ${resolved.target.platform}:${resolved.target.channelId}. After this turn: compact current conversation → swap to a fresh session → seed with summary. Your next message lands in the new session with the summary as context.`
                        : `Cannot hand off ${resolved.target.platform}:${resolved.target.channelId}: ${result.reason ?? "unknown"}. For a fully-fresh start (no summary) use reset_channel_session.`,
                }],
                details: { ...result, ...resolved.target },
            };
        },
    });

    // ---------------- reload_extensions (admin-only) ----------------
    //
    // Chat-native equivalent of Pi's TUI `/reload` slash command. Closes the
    // last terminal-dependent step in the evolve-from-chat loop: after the
    // agent writes a new `.pi/extensions/*.ts` file via Pi's `write` tool, it
    // calls this tool and the new extension's tools become callable on the
    // NEXT message — no operator intervention required.
    //
    // Pi SDK only exposes reload() on ExtensionCommandContext (user-initiated
    // slash commands), not on ExtensionContext (tool execute). This tool
    // bypasses that by going directly through ChannelRuntime, which owns the
    // per-channel AgentSession instances. Each channel reloads independently.
    //
    // Deferred via setImmediate in ChannelRuntime.reloadChannel so the current
    // turn (the one calling this tool) finishes cleanly before Pi emits
    // session_shutdown and rebuilds the runtime. Mirrors Pi's own compact()
    // fire-and-forget pattern.

    pi.registerTool({
        name: "reload_extensions",
        label: "Reload Extensions",
        description:
            "Reload Pi extensions, skills, APPEND_SYSTEM prompt, and themes for this channel — " +
            "without restarting the process. Call IMMEDIATELY after writing a new " +
            ".pi/extensions/*.ts file (via Pi's `write` tool) so the new extension's tools " +
            "become callable here. Chat-native equivalent of Pi's TUI `/reload` slash command. " +
            "ADMIN-ONLY. The reload runs AFTER this turn completes; new tools show up on the " +
            "NEXT message. Applies to THIS channel only — other channels pick up changes on " +
            "their next activity, or can invoke this tool themselves. " +
            "\n\n" +
            "From the TUI (CliAdapter), use Pi's /reload slash command directly — this tool " +
            "only manages per-channel chat sessions.",
        parameters: Type.Object({
            target_platform: Type.Optional(Type.String({ description: "Platform of the target channel. Optional; defaults to current chat." })),
            target_channel_id: Type.Optional(Type.String({ description: "Channel id on target_platform. Optional; defaults to current chat." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const resolved = resolveTargetAndAdmin(ctx, {
                targetPlatform: params.target_platform,
                targetChannelId: params.target_channel_id,
                toolName: "reload_extensions",
            });
            if (resolved.target.platform === "cli") {
                return {
                    content: [{
                        type: "text",
                        text: "You're on the TUI — type Pi's `/reload` slash command directly into the input. This tool only reloads per-channel chat sessions.",
                    }],
                    details: { queued: false, ...resolved.target, reason: "cli-uses-native-reload" },
                };
            }
            const result = await getChannelRuntime().reloadChannel(
                resolved.target.platform,
                resolved.target.channelId,
            );
            return {
                content: [{
                    type: "text",
                    text: result.queued
                        ? `Reload queued for ${resolved.target.platform}:${resolved.target.channelId}. Extensions, skills, and prompts will be re-imported after this turn completes. Your new tools will be callable on the NEXT message.`
                        : `Nothing to reload for ${resolved.target.platform}:${resolved.target.channelId}: ${result.reason ?? "unknown"}.`,
                }],
                details: { ...result, ...resolved.target },
            };
        },
    });

    // ---------------- list_known_channels ----------------
    //
    // Single source of truth for "where can I send a message?" — unifies:
    //   * whitelist users (each DM maps to a (platform, senderId)
    //     where senderId IS the DM chat_id on Telegram; same convention holds
    //     for other platforms),
    //   * whitelist channels (explicit per-channel allow entries),
    //   * channelSessions bindings (every channel that's ever had an inbound,
    //     which is the authoritative list for groups / channels / supergroups
    //     whose IDs don't appear anywhere else).
    //
    // CRITICAL for the scheduler / any cross-channel delivery: the LLM MUST
    // call this before asking the user for a chat ID, and MUST NOT invent
    // channel IDs. Hallucinated IDs like "-1001234567890" cause silent
    // delivery failures (Telegram: "chat not found"). See the schedule_*
    // tools' deliver_to docs.

    pi.registerTool({
        name: "list_known_channels",
        label: "List Known Channels",
        description:
            "Enumerate every channel the bot is reachable on, with its exact channel ID. " +
            "Sources: the whitelist (admin DMs + explicitly allowed per-channel entries) and " +
            "the channel-sessions registry (every platform/channel that's ever had an inbound " +
            "message — the authoritative ID source for groups, supergroups, and channels). " +
            "\n\n" +
            "USE THIS TOOL before populating `deliver_to.channelId` on any scheduled task, " +
            "reminder, or cross-channel send. Hallucinating chat IDs (e.g. picking a plausible-" +
            "looking '-100…' number) causes silent delivery failures. If none of the returned " +
            "channels match what the user meant (e.g. they ask for 'my personal Telegram' but " +
            "the whitelist only has a group), ASK them to paste the chat ID — never guess. " +
            "\n\n" +
            "Admin-only (the channel list reveals where the operator is reachable — not secret, " +
            "but not for arbitrary group members to query either).",
        parameters: Type.Object({
            platform: Type.Optional(Type.String({ description: "Filter to one platform (e.g. 'telegram', 'slack', 'a2a'). Omit for all platforms." })),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const origin = currentOrigin(ctx.sessionManager);
            const whitelist = getWhitelist();
            if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                return {
                    content: [{ type: "text", text: "list_known_channels is admin-only." }],
                    details: { error: "admin-only" },
                    isError: true,
                };
            }

            type Row = {
                platform: string;
                channelId: string;
                source: "whitelist-user-dm" | "whitelist-channel" | "channel-sessions";
                displayName?: string;
                roles?: string[];
                lastActivity?: string;
            };
            const rows: Row[] = [];
            const seen = new Set<string>();
            const key = (p: string, c: string): string => `${p}:${c}`;

            // 1. Whitelist users — senderId is the DM chat_id on Telegram
            //    (and the user/chat identifier on other DM-style transports).
            for (const u of whitelist.list()) {
                if (params.platform && u.platform !== params.platform) continue;
                const k = key(u.platform, u.senderId);
                if (seen.has(k)) continue;
                seen.add(k);
                const row: Row = {
                    platform: u.platform,
                    channelId: u.senderId,
                    source: "whitelist-user-dm",
                };
                if (u.displayName) row.displayName = u.displayName;
                if (u.roles?.length) row.roles = u.roles;
                rows.push(row);
            }

            // 2. Whitelist channels — explicit per-channel entries.
            for (const c of whitelist.listChannels()) {
                if (params.platform && c.platform !== params.platform) continue;
                const k = key(c.platform, c.channelId);
                if (seen.has(k)) continue;
                seen.add(k);
                rows.push({
                    platform: c.platform,
                    channelId: c.channelId,
                    source: "whitelist-channel",
                });
            }

            // 3. Channel-sessions bindings — every channel that's ever had
            //    inbound. The only source that covers groups/supergroups/
            //    channels whose IDs don't appear in any per-user entry.
            for (const b of getChannelSessions().all()) {
                if (params.platform && b.platform !== params.platform) continue;
                const k = key(b.platform, b.channelId);
                if (seen.has(k)) continue;
                seen.add(k);
                rows.push({
                    platform: b.platform,
                    channelId: b.channelId,
                    source: "channel-sessions",
                    lastActivity: new Date(b.createdAt).toISOString().slice(0, 19) + "Z",
                });
            }

            if (rows.length === 0) {
                return {
                    content: [{
                        type: "text",
                        text:
                            `No known channels${params.platform ? ` on platform "${params.platform}"` : ""}.\n\n` +
                            `The bot hasn't received any inbound yet, and the whitelist is empty. ` +
                            `ASK the user to paste the exact chat ID they want to target — do NOT guess.`,
                    }],
                    details: { rows: [] },
                };
            }

            const lines: string[] = [];
            lines.push(`Known channels (${rows.length}${params.platform ? `, filtered to ${params.platform}` : ""}):`);
            lines.push("");
            for (const r of rows) {
                const tail = [
                    r.displayName ? `name="${r.displayName}"` : "",
                    r.roles && r.roles.length ? `roles=[${r.roles.join(",")}]` : "",
                    r.lastActivity ? `first-seen=${r.lastActivity}` : "",
                    `source=${r.source}`,
                ].filter(Boolean).join(" ");
                lines.push(`- ${r.platform}:${r.channelId}  ${tail}`);
            }
            lines.push("");
            lines.push(
                "Use the exact `platform:channelId` pair when filling in `deliver_to` or any " +
                "cross-channel send argument. If the channel the user means isn't listed, ASK " +
                "them to paste the chat ID — never invent one.",
            );
            return {
                content: [{ type: "text", text: lines.join("\n") }],
                details: { rows },
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
