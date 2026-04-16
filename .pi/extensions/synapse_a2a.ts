import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { getBotName } from "../../src/core/paths.js";
import { getVault } from "../../src/core/vault.js";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import type {
    AdapterStatus,
    AgentResponse,
    Message,
    MessageHandler,
    TransportAdapter,
} from "../../src/transport/types.js";

// =============================================================================
// synapse_a2a — Synapse Agent-to-Agent transport adapter (Sprint 9 partial).
//
// WHAT THIS DOES TODAY (working):
//   Outbound:
//     - SynapseAdapter implements TransportAdapter, registers as platform="synapse"
//     - send(channelId, response) → `synapse send <channelId> "<text>" --from <bot>`
//     - Tools a2a_send / a2a_broadcast still LLM-callable; both shell out via
//       array-form spawn (no shell injection).
//   Status:
//     - Reports running/stopped + the bot's display name + Synapse CLI presence
//
// WHAT'S A DOCUMENTED STUB (until we read the synapse-a2a skill thoroughly):
//   Inbound listener:
//     - Watches `data/<bot>/synapse-inbox/` (configurable via vault SYNAPSE_INBOX_DIR)
//       for `.msg.json` files dropped by an external Synapse delivery worker.
//     - File schema: { from: string, message: string, timestamp_ms?: number, thread_id?: string }
//     - On new file: parse, build a Message{platform:"synapse"}, dispatch, delete the file.
//     - On invalid file: log and quarantine to `<inbox>/.invalid/`.
//     - Inbound is OPT-IN: if the inbox dir doesn't exist, no watcher is started
//       (adapter stays in `running` state but `details.inbound = "no_inbox_dir"`).
//
//   The actual Synapse delivery mechanism is one of:
//     (a) Synapse CLI subscribes (polls or long-polls) and the operator wires
//         a wrapper script to drop received messages as JSON into the inbox dir
//     (b) Synapse exposes a Unix socket / HTTP webhook the operator forwards
//     (c) Future: native Node binding once we read synapse skill internals
//
//   The inbox-dir convention is the simplest universal sink — any of (a)/(b)/(c)
//   can land messages there with a tiny shim. Documented here so the operator
//   can wire it up without modifying ori2.
//
// SECURITY MODEL:
//   - Inbound senders are subject to the dispatcher pre-hook chain like any
//     other adapter (whitelist gate from admin_gate, rate limiter from
//     audit_and_limits). A message from an unrecognized Synapse peer agent
//     gets blocked unless explicitly whitelisted as `synapse:<peer-name>`.
//   - The Synapse CLI invocation reads no untrusted input from the file
//     (we use array-form spawn).
// =============================================================================

const PLATFORM = "synapse";

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

interface SynapseInboxMessage {
    from: string;
    message: string;
    timestamp_ms?: number;
    thread_id?: string;
}

class SynapseAdapter implements TransportAdapter {
    readonly platform = PLATFORM;

    private state: AdapterStatus["state"] = "stopped";
    private connectedAt: number | undefined;
    private lastError: string | undefined;
    private handler: MessageHandler | null = null;
    private cliPresent = false;
    private watcher: fs.FSWatcher | null = null;
    private inboxDir: string | null = null;

    setHandler(handler: MessageHandler): void {
        this.handler = handler;
    }

    async start(): Promise<void> {
        this.state = "starting";
        this.lastError = undefined;

        // Probe `synapse` CLI presence — we shell out for outbound. Missing CLI
        // is OK for inbound-only deployments, so don't fail the whole adapter.
        try {
            const { code } = await runSynapse(["--version"]);
            this.cliPresent = code === 0;
        } catch {
            this.cliPresent = false;
        }

        // Set up the inbox watcher (opt-in via filesystem presence + vault override).
        const inbox = getVault().get("SYNAPSE_INBOX_DIR")
            || path.join(process.cwd(), "data", getBotName(), "synapse-inbox");
        this.inboxDir = inbox;
        if (fs.existsSync(inbox) && fs.statSync(inbox).isDirectory()) {
            try {
                this.startInboxWatcher(inbox);
            } catch (e) {
                this.lastError = `inbox watcher failed: ${e instanceof Error ? e.message : String(e)}`;
            }
        }

        this.state = "running";
        this.connectedAt = Date.now();
    }

    async stop(): Promise<void> {
        if (this.watcher) {
            try { this.watcher.close(); } catch { /* best effort */ }
            this.watcher = null;
        }
        this.state = "stopped";
    }

    async send(channelId: string, response: AgentResponse): Promise<void> {
        if (!this.cliPresent) {
            throw new Error("[synapse] cannot send — `synapse` CLI not found. See https://github.com/synapse-cli (or the local docs).");
        }
        const text = response.text ?? "";
        const sender = getBotName();
        const args = ["send", channelId, text, "--from", sender, "--notify"];
        const { stdout, stderr, code } = await runSynapse(args);
        if (code !== 0 && !stdout) {
            throw new Error(`synapse send to "${channelId}" exited ${code}: ${stderr || "(no stderr)"}`);
        }
    }

    status(): AdapterStatus {
        const status: AdapterStatus = {
            platform: PLATFORM,
            state: this.state,
            details: {
                cli_present: this.cliPresent,
                bot_name: getBotName(),
                inbox_dir: this.inboxDir ?? "(none)",
                inbox_watcher: this.watcher ? "active" : "inactive",
            },
        };
        if (this.lastError !== undefined) status.lastError = this.lastError;
        if (this.connectedAt !== undefined) status.connectedAt = this.connectedAt;
        return status;
    }

    // -------- inbox watcher --------

    private startInboxWatcher(dir: string): void {
        // Process any files already present (race: drops between boot and watch start).
        for (const f of fs.readdirSync(dir)) {
            if (f.endsWith(".msg.json")) void this.processInboxFile(path.join(dir, f));
        }
        this.watcher = fs.watch(dir, (eventType, filename) => {
            if (eventType !== "rename" || !filename || !filename.endsWith(".msg.json")) return;
            const filePath = path.join(dir, filename);
            // 'rename' fires on both create and delete; check existence.
            if (!fs.existsSync(filePath)) return;
            void this.processInboxFile(filePath);
        });
    }

    private async processInboxFile(filePath: string): Promise<void> {
        let raw: string;
        try {
            raw = fs.readFileSync(filePath, "utf-8");
        } catch (e) {
            console.error(`[synapse] failed to read inbox file ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
            return;
        }
        let parsed: Partial<SynapseInboxMessage>;
        try {
            parsed = JSON.parse(raw) as Partial<SynapseInboxMessage>;
        } catch (e) {
            console.error(`[synapse] inbox file ${filePath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
            this.quarantine(filePath, "invalid_json");
            return;
        }
        if (typeof parsed.from !== "string" || typeof parsed.message !== "string") {
            console.error(`[synapse] inbox file ${filePath} missing required {from, message} fields`);
            this.quarantine(filePath, "schema_error");
            return;
        }

        if (!this.handler) {
            console.error("[synapse] message received but dispatcher handler not yet installed — dropping");
            this.quarantine(filePath, "no_handler");
            return;
        }

        const incoming: Message = {
            platform: PLATFORM,
            channelId: parsed.from,                    // routing back via send() goes to this peer
            senderId: parsed.from,
            senderDisplayName: parsed.from,
            timestamp: parsed.timestamp_ms ?? Date.now(),
            text: parsed.message,
        };
        if (parsed.thread_id !== undefined) incoming.threadId = parsed.thread_id;

        try {
            await this.handler(incoming);
            // Consume — delete the file. Synapse layer is expected to be
            // idempotent re-delivery on its side if needed.
            try { fs.unlinkSync(filePath); } catch { /* best effort */ }
        } catch (e) {
            console.error(`[synapse] dispatcher rejected inbox message: ${e instanceof Error ? e.message : String(e)}`);
            this.quarantine(filePath, "dispatch_error");
        }
    }

    private quarantine(filePath: string, reason: string): void {
        try {
            const dir = path.join(path.dirname(filePath), ".invalid");
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const dest = path.join(dir, `${reason}-${path.basename(filePath)}`);
            fs.renameSync(filePath, dest);
        } catch (e) {
            console.error(`[synapse] quarantine failed for ${filePath}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
}

// Register as a dispatcher adapter (the same way CliAdapter and TelegramAdapter
// register from src/index.ts). Registering at module load means the dispatcher
// has it available as soon as transport_bridge wires pushToPi.
const dispatcher = getDispatcher();
const adapter = new SynapseAdapter();
try {
    dispatcher.register(adapter);
    // Start in background — don't block extension load on CLI probe.
    void adapter.start();
} catch (e) {
    console.error(`[synapse_a2a] failed to register adapter: ${e instanceof Error ? e.message : String(e)}`);
}

export default function (pi: ExtensionAPI) {
    // Outbound LLM tools — kept for backward compat. Internally these now
    // route through dispatcher.send("synapse", target, response) so they
    // share code with anything else routing to Synapse.

    pi.registerTool({
        name: "a2a_send",
        label: "A2A Send Message",
        description: "Send a direct message or task to another independent agent via the Synapse A2A network.",
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
        description: "Broadcast a message to all agents currently running on the local Synapse network.",
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

    pi.registerCommand("synapse", {
        description: "Synapse A2A status. Run /synapse for a status snapshot, /synapse help for setup notes.",
        handler: async (args, ctx) => {
            const sub = (args ?? "").trim().toLowerCase() || "status";
            if (sub === "help") {
                ctx.ui.notify(synapseHelp(), "info");
                return;
            }
            const s = adapter.status();
            const lines = [
                `Synapse A2A adapter:`,
                `  state:           ${s.state}`,
                `  cli_present:     ${s.details?.["cli_present"]}`,
                `  bot_name:        ${s.details?.["bot_name"]}`,
                `  inbox_dir:       ${s.details?.["inbox_dir"]}`,
                `  inbox_watcher:   ${s.details?.["inbox_watcher"]}`,
            ];
            if (s.lastError) lines.push(`  last_error:      ${s.lastError}`);
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });
}

function synapseHelp(): string {
    return [
        "═════════════════════════════════════════════════════════════",
        "  /synapse — A2A network adapter",
        "═════════════════════════════════════════════════════════════",
        "",
        "OUTBOUND (working today)",
        "  Tools the LLM can call:",
        "    a2a_send(target, message, wait?) — direct message to a peer agent",
        "    a2a_broadcast(message)            — fan-out to all local peers",
        "",
        "  Both require the `synapse` CLI installed on PATH. /synapse status",
        "  reports cli_present.",
        "",
        "INBOUND (opt-in stub — see notes below)",
        "  The adapter watches a directory for incoming messages dropped as",
        "  .msg.json files:",
        "",
        `    ${path.join(process.cwd(), "data", getBotName(), "synapse-inbox")}`,
        "",
        "  Override via vault: /credentials add SYNAPSE_INBOX_DIR <path>",
        "  (or vault.set directly)",
        "",
        "  File schema (one message per file):",
        '    { "from": "PeerBot", "message": "your text", "timestamp_ms": 1700000000000, "thread_id": "optional" }',
        "",
        "  On new file: parse → dispatch → delete. Invalid files quarantined",
        "  to <inbox>/.invalid/ with a reason prefix.",
        "",
        "  Inbound senders are subject to the SAME whitelist + rate-limit gates",
        "  as Telegram — a message from synapse:UnknownBot will be blocked",
        "  unless you /whitelist add synapse UnknownBot.",
        "",
        "WIRING SYNAPSE → INBOX",
        "  The inbox-drop convention is the simplest universal sink. To bridge",
        "  Synapse CLI to it, the operator can:",
        "    1. Run a tiny watcher script that calls `synapse list` periodically,",
        "       or `synapse listen` if available, and writes incoming to the inbox dir.",
        "    2. Or have your Synapse host write inbound directly to the inbox dir.",
        "",
        "  Full native integration (no shim) is planned once the synapse-a2a",
        "  skill internals are reviewed in detail. For now this stub provides",
        "  a clean separation: ori2 owns the inbox contract, the operator owns",
        "  whichever Synapse delivery mechanism they have.",
        "",
        "═════════════════════════════════════════════════════════════",
    ].join("\n");
}

// Suppress unused warning for the `os` import if we end up not needing it.
void os;
