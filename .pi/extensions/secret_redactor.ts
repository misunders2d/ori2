import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { redactKnownSecrets } from "../../src/core/secretRedactor.js";

// =============================================================================
// secret_redactor — universal tool_result scrubber. Final defense layer:
// every tool result, regardless of which tool produced it, has known-secret
// values replaced by [REDACTED:source] before the LLM sees it.
//
// Why this exists alongside secret_files_guard: that guard prevents tools
// from REACHING secrets via file paths / bash commands. This one catches
// anything that leaks past — env reads we missed, third-party services
// that reflect our headers in their responses, web pages that happen to
// quote a string identical to a credential, errors that include the
// connection string, etc.
//
// Scrubs:
//   - Vault values
//   - Credentials store secrets
//   - OAuth access + refresh tokens
//
// See src/core/secretRedactor.ts for the value-collection logic.
// =============================================================================

interface ToolResultEvent {
    toolName: string;
    content?: Array<{ type: string; text?: string } & Record<string, unknown>>;
}

export default function (pi: ExtensionAPI) {
    pi.on("tool_result", (event: ToolResultEvent) => {
        if (!event.content || event.content.length === 0) return undefined;

        let mutated = false;
        const out = event.content.map((part) => {
            if (part.type !== "text" || typeof part.text !== "string") return part;
            const before = part.text;
            const after = redactKnownSecrets(before);
            if (after === before) return part;
            mutated = true;
            return { ...part, text: after };
        });

        if (!mutated) return undefined;
        // Pi expects the same content array shape we received.
        return { content: out };
    });
}
