import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getVault } from "../../src/core/vault.js";

// =============================================================================
// thinking_mode — bot-wide LLM extended-thinking toggle.
//
// Why bot-wide: thinking-mode models burn 10-60s on small inputs ("hey")
// before emitting any text. For chat UX that's unacceptable. Default OFF.
// Operator / agent flips it on for genuinely complex tasks via the
// LLM-callable `set_thinking_mode` tool — the LLM only needs to see the
// natural-language ask ("turn on thinking" / "use deep reasoning for the
// next reply") and call this tool with the matching level.
//
// Storage: vault key `THINKING_LEVEL`. Persists across restarts. Read by
// channelRouter when spawning per-channel subprocesses (`--thinking <level>`).
//
// Per-channel override: agent_introspection's `set_channel_model` already
// supports a thinking suffix on the model id ("google/gemini-3-flash:high")
// — that wins over the bot-wide default for THAT channel. This extension
// is the BOT-WIDE knob that doesn't require knowing the model id.
//
// Pattern reference: ported the "tool-callable persistent toggle" idea from
// amazon_manager (app/tools/system.py:set_planner_mode), adapted to Pi's
// vault + per-subprocess --thinking flag instead of ADK's session state.
// =============================================================================

const VAULT_KEY = "THINKING_LEVEL";
const VALID_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type Level = (typeof VALID_LEVELS)[number];
const DEFAULT_LEVEL: Level = "off";

function currentLevel(): Level {
    const raw = (getVault().get(VAULT_KEY) ?? DEFAULT_LEVEL).toLowerCase();
    return (VALID_LEVELS as readonly string[]).includes(raw) ? (raw as Level) : DEFAULT_LEVEL;
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "set_thinking_mode",
        label: "Set thinking-mode level",
        description:
            "Toggle the LLM's extended-thinking (reasoning) mode for ALL channels. " +
            "Default is OFF — fast, terse replies suitable for chat. Turn on (level=low|medium|high|xhigh) " +
            "when the user explicitly asks for deeper reasoning OR when a task is genuinely complex " +
            "(multi-step planning, math, code review, ambiguous spec interpretation). " +
            "Turn back off when the heavy work is done — leaving it on burns 10-60s per simple reply.\n\n" +
            "User cues that mean 'turn it on': \"think hard\", \"think deeply\", \"reason step by step\", " +
            "\"take your time\", \"deep thought\", \"think this through carefully\".\n" +
            "User cues that mean 'turn it off': \"just answer\", \"quick reply\", \"don't overthink\", " +
            "\"stop thinking so much\", \"be brief\".\n\n" +
            "Persists across bot restarts via vault key " + VAULT_KEY + ".",
        parameters: Type.Object({
            level: Type.String({
                description:
                    "One of: off, minimal, low, medium, high, xhigh. " +
                    "Use 'off' to disable thinking entirely (default). " +
                    "Use 'low' or 'medium' for moderate reasoning. " +
                    "Use 'high' / 'xhigh' for maximum reasoning depth.",
            }),
        }),
        async execute(_id, params) {
            const requested = params.level.toLowerCase();
            if (!(VALID_LEVELS as readonly string[]).includes(requested)) {
                return {
                    content: [{
                        type: "text",
                        text: `Invalid thinking level "${params.level}". Valid: ${VALID_LEVELS.join(", ")}.`,
                    }],
                    isError: true,
                };
            }
            const previous = currentLevel();
            getVault().set(VAULT_KEY, requested);
            return {
                content: [{
                    type: "text",
                    text:
                        `Thinking mode set to "${requested}" (was "${previous}"). ` +
                        `Effect: every NEW chat turn (subprocess spawn) will use --thinking ${requested}. ` +
                        `In-flight turns are unaffected. Persists across restarts.`,
                }],
                details: { previous, current: requested },
            };
        },
    });

    pi.registerTool({
        name: "get_thinking_mode",
        label: "Get current thinking-mode level",
        description: "Report the current bot-wide thinking-mode level.",
        parameters: Type.Object({}),
        async execute() {
            const level = currentLevel();
            return {
                content: [{ type: "text", text: `Current thinking mode: ${level}.` }],
                details: { level, default: DEFAULT_LEVEL, valid: [...VALID_LEVELS] },
            };
        },
    });
}
