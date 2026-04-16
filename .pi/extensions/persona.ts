import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { getBotName } from "../../src/core/paths.js";

// Load and inject the bot's persona + global directives at every turn.
//
// Persona file: `.pi/prompts/<BOT_NAME>.md`. If missing, falls back to a
// generic stub. The agent can self-edit this file using the read/edit/write
// built-in tools — changes apply on the very next turn.
//
// Global directives are dynamic: they only mention tools that are actually
// registered in the current session. This keeps the directive honest when
// extensions are disabled or removed.

export default function (pi: ExtensionAPI) {
    pi.on("before_agent_start", async (event) => {
        const botName = getBotName();
        const promptPath = path.resolve(process.cwd(), ".pi/prompts", `${botName}.md`);

        let persona: string;
        if (fs.existsSync(promptPath)) {
            persona = fs.readFileSync(promptPath, "utf-8");
        } else {
            persona = `You are ${botName}, an intelligent agent running on the Ori2 platform.`;
        }

        // Discover what's actually available right now — no lying to the LLM about
        // tools that aren't loaded. getActiveTools() returns string[] (names only).
        const activeNames = new Set(pi.getActiveTools());
        const has = (n: string) => activeNames.has(n);

        const directives: string[] = [
            "[GLOBAL DIRECTIVE]",
            "- You are operating within a multi-agent platform (Ori2).",
            "- Never output raw API keys, tokens, or other credentials in any response.",
            `- SELF-EVOLUTION: Your persona instructions are loaded from \`${promptPath}\`. To change your behavior or personality, edit that file directly with your file editing tools (\`read\`, \`edit\`, \`write\`). Changes take effect on your very next turn.`,
        ];

        if (has("a2a_send") || has("a2a_broadcast")) {
            directives.push("- DELEGATION: To delegate a task to another agent on the network, use the `a2a_send` tool. For announcements, use `a2a_broadcast`.");
        }
        if (has("web_search") || has("web_fetch")) {
            directives.push("- RESEARCH BEFORE CODING: Before implementing any 3rd-party API integration, use `web_search` and `web_fetch` to read the LATEST official documentation. Do not rely on training-data memory for evolving APIs.");
        }
        if (has("secure_npm_install")) {
            directives.push("- DEPENDENCIES: To install npm packages, use the `secure_npm_install` tool. Raw `bash` installs are blocked by the platform.");
        }
        if (has("verify_and_commit")) {
            directives.push("- TDD: Before declaring a feature finished, write tests, run them, and finalize with `verify_and_commit`. The tool will reject commits that fail the test suite.");
        }
        if (has("plan_create") || has("plan_get_next_step")) {
            directives.push("- PLANS: For multi-step tasks, use `plan_create` to lock in a sequential plan, then `plan_get_next_step` and `plan_complete_step` to execute it strictly.");
        }
        if (has("memory_save") || has("memory_search")) {
            directives.push("- MEMORY: Use `memory_save` to persist important facts, preferences, or learnings across sessions. Use `memory_search` to recall.");
        }

        return {
            systemPrompt: `[IDENTITY: ${botName}]\n${persona}\n\n${directives.join("\n")}\n\n---\n${event.systemPrompt}`,
        };
    });
}
