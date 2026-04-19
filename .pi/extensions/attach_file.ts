import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { currentOrigin } from "../../src/core/identity.js";
import { enqueuePending } from "../../src/core/pendingAttachments.js";
import { containsSensitivePath } from "../../src/core/secretFilesDeny.js";

// =============================================================================
// attach_file — baseline outbound-file plumbing.
//
// The TOOL contract any evolved extension plugs into:
//   1. An evolved tool (generate_chart, export_csv, generate_image, etc.)
//      writes a file and returns its path.
//   2. The LLM calls attach_file({ paths: [<that path>] }) to schedule the
//      file for delivery with the next reply.
//   3. On agent_end for the active turn, channelRuntime drains the per-
//      channel queue, loads the bytes, and sends them as attachments on
//      the outbound AgentResponse via dispatcher.send() → adapter.send().
//
// Design source: pi-telegram's `telegram_attach` tool (by Mario Zechner,
// Pi SDK author — see github.com/badlogic/pi-telegram). Adapted to
// ori2's cross-transport model:
//   - Tool is platform-agnostic: it resolves the CURRENT channel from
//     the inbound origin entry. Same tool works across Telegram / Slack /
//     CLI / A2A without each transport registering its own variant.
//   - Path validation layered on top of pi-telegram's basic stat() check:
//     reject any file resolving under .secret/ or matching any of ori2's
//     sensitive filenames. Belt-and-suspenders with secret_files_guard.
//   - Size cap enforced at the tool so a compromised/confused agent can't
//     schedule a 2GB attachment that hangs the adapter on upload.
//
// Admin gating / staging: the tool respects the project's role/ACL
// model via tool_acl.json like every other tool. Operators can add
// `alwaysConfirm: true` or `requiredRoles: ["admin"]` per-instance.
// Baseline default: open to all whitelisted users (secret-path denial is
// the structural gate; ACL is for policy tuning).
// =============================================================================

const MAX_ATTACHMENTS_PER_TURN = 10;
const MAX_FILE_BYTES = 50 * 1024 * 1024; // Telegram upload ceiling-friendly

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "attach_file",
        label: "Attach File",
        description:
            "Queue one or more local files to be sent alongside the next outbound reply on the CURRENT transport channel (Telegram/Slack/CLI/A2A — whichever channel this inbound originated from). " +
            "Call this when the user asked for a file or generated artifact. The files are delivered AFTER your text reply finishes, in the order queued. " +
            "Do NOT rely on mentioning paths in plain text — only files scheduled via this tool are transmitted. " +
            "Rejects paths under the bot's private state (data/<bot>/.secret/, vault.json, credentials.json, oauth_tokens.json, etc.) — those are never deliverable.",
        promptSnippet:
            "Use attach_file({ paths: [\"/local/path/to/file.ext\", ...] }) to send files with your reply. Max 10 files per turn, max 50MB each.",
        promptGuidelines: [
            "When the user asks for a file, a generated report, an image you created, a CSV export, or any binary artifact: produce the file via the appropriate tool, then call attach_file with its local path BEFORE finalizing your reply.",
            "Listing the path in your text reply does NOT send the file. The transport adapter ONLY delivers files scheduled via attach_file.",
            "Do not attempt to attach files under data/<bot>/.secret/ or any vault/credentials/oauth JSON — those are always refused.",
        ],
        parameters: Type.Object({
            paths: Type.Array(
                Type.String({
                    description: "Local filesystem path to the file being attached. Must be an existing regular file under 50MB.",
                }),
                {
                    minItems: 1,
                    maxItems: MAX_ATTACHMENTS_PER_TURN,
                    description: `Up to ${MAX_ATTACHMENTS_PER_TURN} file paths to attach to the next reply.`,
                },
            ),
        }),
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            const origin = currentOrigin(ctx.sessionManager);
            if (!origin) {
                throw new Error(
                    "attach_file can only run in a transport-routed session (the current session has no transport-origin entry — are you in the TUI? Attach is only for chat channels).",
                );
            }

            const validated: string[] = [];
            for (const rawPath of params.paths) {
                const abs = path.resolve(rawPath);

                // 1. Secret-path denial — single source of truth (sibling of
                //    secret_files_guard's substring check).
                if (containsSensitivePath(abs)) {
                    throw new Error(
                        `attach_file: path "${rawPath}" points to bot-private state and cannot be delivered.`,
                    );
                }

                // 2. File existence + regular-file check.
                let stats: fs.Stats;
                try {
                    stats = fs.statSync(abs);
                } catch (e) {
                    const reason = e instanceof Error ? e.message : String(e);
                    throw new Error(`attach_file: cannot stat "${rawPath}": ${reason}`);
                }
                if (!stats.isFile()) {
                    throw new Error(`attach_file: "${rawPath}" is not a regular file.`);
                }

                // 3. Size cap — mostly for Telegram (50MB document limit).
                //    Adapters can choose to silently accept larger, but the
                //    tool rejects here so the LLM fails fast with a clear msg.
                if (stats.size > MAX_FILE_BYTES) {
                    throw new Error(
                        `attach_file: "${rawPath}" is ${stats.size} bytes, exceeds the ${MAX_FILE_BYTES}-byte cap. ` +
                        `Trim the file (or drop it at a link) and re-queue.`,
                    );
                }

                validated.push(abs);
            }

            enqueuePending(origin.platform, origin.channelId, validated);

            return {
                content: [
                    {
                        type: "text" as const,
                        text:
                            `Queued ${validated.length} file(s) for delivery on ${origin.platform}:${origin.channelId}. ` +
                            `They will be sent AFTER this turn's text reply.`,
                    },
                ],
                details: {
                    channel: `${origin.platform}:${origin.channelId}`,
                    paths: validated,
                    count: validated.length,
                },
            };
        },
    });
}
