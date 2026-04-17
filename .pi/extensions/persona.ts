import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getBotName } from "../../src/core/paths.js";

// =============================================================================
// persona — dynamic, per-turn system-prompt additions.
//
// Static directives (operating within Ori2, never output keys, self-evolution
// pointer) live in `.pi/APPEND_SYSTEM.md` — Pi appends those to the default
// system prompt natively (pi-coding-agent/docs — §Context Files). This hook
// adds the bits that REQUIRE runtime data:
//
//   - Identity line: the bot's name isn't known when APPEND_SYSTEM.md is read.
//   - Tool-conditional hints: the agent should only be told about tools that
//     are actually registered in THIS session. `pi.getActiveTools()` returns
//     the live list; we emit directives only for tools that exist.
//
// Everything else → APPEND_SYSTEM.md.
// =============================================================================

export default function (pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event) => {
        const botName = getBotName();

        // Live tool discovery — never lie to the LLM about capabilities it
        // doesn't have. getActiveTools() returns string[] (names only).
        const activeNames = new Set(pi.getActiveTools());
        const has = (n: string) => activeNames.has(n);

        const hints: string[] = [];
        if (has("a2a_send") || has("a2a_broadcast")) {
            hints.push("- DELEGATION: To delegate a task to another agent on the network, use the `a2a_send` tool. For announcements, use `a2a_broadcast`.");
        }
        if (has("web_search") || has("web_fetch")) {
            hints.push("- RESEARCH BEFORE CODING: Before implementing any 3rd-party API integration, use `web_search` and `web_fetch` to read the LATEST official documentation. Do not rely on training-data memory for evolving APIs.");
        }
        if (has("secure_npm_install")) {
            hints.push("- DEPENDENCIES: To install npm packages, use the `secure_npm_install` tool. Raw `bash` installs are blocked by the platform.");
        }
        if (has("verify_and_commit")) {
            hints.push("- TDD: Before declaring a feature finished, write tests, run them, and finalize with `verify_and_commit`. The tool will reject commits that fail the test suite.");
        }
        if (has("plan_create") || has("plan_get_next_step")) {
            hints.push("- PLANS: For multi-step tasks, use `plan_create` to lock in a sequential plan, then `plan_get_next_step` and `plan_complete_step` to execute it strictly.");
        }
        if (has("memory_save") || has("memory_search")) {
            hints.push("- MEMORY: Use `memory_save` to persist important facts, preferences, or learnings across sessions. Use `memory_search` to recall.");
        }

        const header = `[IDENTITY: ${botName}]`;
        const body = hints.length > 0 ? `${header}\n\n[CAPABILITIES — this session]\n${hints.join("\n")}` : header;

        return { systemPrompt: `${body}\n\n---\n${event.systemPrompt}` };
    });
}
