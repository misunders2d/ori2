import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { getBotName } from "../../src/core/paths.js";

// Run `synapse <args...>` safely (no shell, no string-concat injection risk).
// Returns stdout+stderr+exitCode. Caller decides how to interpret.
function runSynapse(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
    return new Promise((resolve, reject) => {
        const proc = spawn("synapse", args, { signal });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        proc.on("error", (err) => reject(err));
        proc.on("close", (code) => resolve({ stdout, stderr, code }));
    });
}

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "a2a_send",
        label: "A2A Send Message",
        description: "Send a direct message or task to another independent agent via the Synapse A2A bus.",
        parameters: Type.Object({
            target: Type.String({ description: "The Bot Name or ID of the receiving agent (e.g., MarketingBot)" }),
            message: Type.String({ description: "The instruction, question, or data to send" }),
            wait: Type.Optional(Type.Boolean({ description: "If true, wait for a reply before continuing" })),
        }),
        async execute(_toolCallId, params, signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: `Routing message to ${params.target}...` }], details: {} });

            const senderName = getBotName();
            const modeFlag = params.wait ? "--wait" : "--notify";
            const args = ["send", params.target, params.message, "--from", senderName, modeFlag];

            try {
                const { stdout, stderr, code } = await runSynapse(args, signal);
                if (code !== 0 && !stdout) {
                    throw new Error(`synapse exited ${code}: ${stderr || "(no stderr)"}`);
                }
                return {
                    content: [{ type: "text", text: `A2A Message sent.\nSynapse Response: ${stdout || stderr}` }],
                    details: { target: params.target, exit_code: code, stderr },
                };
            } catch (error: unknown) {
                throw new Error(`A2A Communication failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    });

    pi.registerTool({
        name: "a2a_broadcast",
        label: "A2A Broadcast",
        description: "Broadcast a message to all agents currently running on the server.",
        parameters: Type.Object({
            message: Type.String({ description: "The announcement or data to broadcast" }),
        }),
        async execute(_toolCallId, params, signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: `Broadcasting message to all agents...` }], details: {} });
            try {
                const { stdout, stderr, code } = await runSynapse(["broadcast", params.message], signal);
                if (code !== 0 && !stdout) {
                    throw new Error(`synapse broadcast exited ${code}: ${stderr || "(no stderr)"}`);
                }
                return {
                    content: [{ type: "text", text: `Broadcast successful.\n${stdout || stderr}` }],
                    details: { exit_code: code },
                };
            } catch (error: unknown) {
                throw new Error(`Broadcast failed: ${error instanceof Error ? error.message : String(error)}`);
            }
        },
    });
}
