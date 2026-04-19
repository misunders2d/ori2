import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
    SENSITIVE_SUBSTRINGS,
    containsSensitiveSubstring,
    resolvedUnderBotDir,
} from "../../src/core/secretFilesDeny.js";

// =============================================================================
// secret_files_guard — denies generic file tools (read/edit/write/grep/find/
// glob/ls/bash) any access to data/<bot>/. The LLM must use the dedicated
// slash commands and tools instead.
//
// Rationale: APPEND_SYSTEM.md tells the agent that vault.json/credentials.json/
// oauth_tokens.json are off-limits. That's a hint, not enforcement — when the
// user asked "how do I add Telegram?" the agent reasoned its way around the
// hint and read+pasted vault.json into chat. Prompts guide a cooperative
// agent; they don't constrain a confused or jailbroken one. Path-level deny
// at the tool layer is the structural defense.
//
// Coverage:
//   - Path-arg tools (read/edit/write/find/grep/ls): path resolved against
//     cwd; deny if it lands under botDir() or matches the .secret/ leaf
//     anywhere (defense against `BOT_NAME` mismatches and cross-bot probes).
//   - Pattern-arg tools (find.pattern, grep.glob): substring-match the
//     pattern against `data/<bot>/`, `.secret/`, and known sensitive
//     filenames so `find / -name vault.json` and `grep -r SECRET data/`
//     also fail.
//   - bash: substring-match the command for the same set of strings.
//     Not airtight — bash with file-system access is fundamentally a
//     foot-gun. Tightened ACL elsewhere ensures bash is admin-only; this
//     guard is the second line.
//
// What's NOT denied:
//   - ANY tool *registered by ori2* (memory_save/search, read_attachment,
//     read_channel_log, list_scheduled_tasks, oauth_get_access_token, etc.).
//     Those have their own per-tool ACL; they're how the agent legitimately
//     reaches the bot's own state.
//
// Failure mode: deny returns the slash-command hint so the LLM knows the
// supported alternative. We've found the agent will follow these hints
// reliably once the deny lands — it's the silent footgun that breaks down,
// not the explicit redirection.
// =============================================================================

const PATH_ARG_TOOLS = new Set(["read", "edit", "write", "find", "grep", "ls"]);
const PATTERN_ARG_TOOLS = new Map<string, string[]>([
    // tool name -> arg field names that hold filename/glob patterns
    ["find", ["pattern"]],
    ["grep", ["glob"]],
]);

// Tools whose params include a string[] of paths. Each element is validated
// the same way as a single path arg for read/edit/write.
const PATH_ARRAY_ARG_TOOLS = new Map<string, string[]>([
    ["attach_file", ["paths"]],
]);

// Sensitive-substring list lives in src/core/secretFilesDeny.ts so
// attach_file (and future call-sites) consume the same source of truth.
// Re-export for tests that still import from this module.
export { SENSITIVE_SUBSTRINGS };

const SLASH_COMMAND_HINT =
    "Off limits. Use slash commands instead: " +
    "/connect-telegram <token> for Telegram, " +
    "/credentials add for arbitrary API tokens, " +
    "/oauth connect <platform> for OAuth (Google/GitHub/etc.), " +
    "/totp setup for 2FA. " +
    "For the bot's own data use the dedicated tools (memory_*, read_channel_log, " +
    "list_scheduled_tasks, read_attachment) — never read these files directly.";

interface ToolCallEvent {
    toolName: string;
    input: unknown;
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_call", (event: ToolCallEvent) => {
        const decision = guard(event);
        if (decision !== undefined) {
            console.log(`[secret_files_guard] DENIED ${event.toolName}: ${decision.reason}`);
            return decision;
        }
        return undefined;
    });
}

/** Pure, exported for tests. */
export function guard(event: ToolCallEvent): { block: true; reason: string } | undefined {
    const toolName = event.toolName;
    const input = (event.input ?? {}) as Record<string, unknown>;

    // 1. Path-arg tools: resolve every path-like arg and check against botDir().
    if (PATH_ARG_TOOLS.has(toolName)) {
        const candidatePaths = collectPathArgs(input);
        for (const p of candidatePaths) {
            if (resolvedUnderBotDir(p)) {
                return { block: true, reason: `${toolName} target "${p}" is under the bot's private state dir. ${SLASH_COMMAND_HINT}` };
            }
            // Defense-in-depth: even if path resolves outside botDir() but
            // STILL contains ".secret/", reject. Catches cross-bot probes
            // like `read ../OtherBot/.secret/vault.json` from a sibling bot
            // sharing a checkout.
            if (containsSensitiveSubstring(p)) {
                return { block: true, reason: `${toolName} target "${p}" looks like a secret-bearing path. ${SLASH_COMMAND_HINT}` };
            }
        }
    }

    // 1b. Path-ARRAY-arg tools (attach_file, future multi-file tools): same
    //     check, iterated over each string in the array.
    const arrayFields = PATH_ARRAY_ARG_TOOLS.get(toolName);
    if (arrayFields) {
        for (const f of arrayFields) {
            const v = input[f];
            if (!Array.isArray(v)) continue;
            for (const item of v) {
                if (typeof item !== "string") continue;
                if (resolvedUnderBotDir(item)) {
                    return { block: true, reason: `${toolName} target "${item}" is under the bot's private state dir. ${SLASH_COMMAND_HINT}` };
                }
                if (containsSensitiveSubstring(item)) {
                    return { block: true, reason: `${toolName} target "${item}" looks like a secret-bearing path. ${SLASH_COMMAND_HINT}` };
                }
            }
        }
    }

    // 2. Pattern-arg tools (find.pattern, grep.glob): block patterns that
    //    name sensitive files / dirs.
    const patternFields = PATTERN_ARG_TOOLS.get(toolName);
    if (patternFields) {
        for (const f of patternFields) {
            const v = input[f];
            if (typeof v === "string" && containsSensitiveSubstring(v)) {
                return { block: true, reason: `${toolName} pattern "${v}" targets bot-private state. ${SLASH_COMMAND_HINT}` };
            }
        }
    }

    // 3. bash: substring-match the command.
    if (toolName === "bash") {
        const cmd = input["command"];
        if (typeof cmd === "string" && containsSensitiveSubstring(cmd)) {
            return { block: true, reason: `bash command references bot-private state. ${SLASH_COMMAND_HINT}` };
        }
    }

    return undefined;
}

function collectPathArgs(input: Record<string, unknown>): string[] {
    const out: string[] = [];
    // Pi tools use either `path` (read/edit/write/grep/find/ls) or `file_path`
    // (some legacy forms — render-utils.js checks both). Cover both.
    for (const key of ["path", "file_path"]) {
        const v = input[key];
        if (typeof v === "string" && v !== "") out.push(v);
    }
    return out;
}
