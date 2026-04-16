import os from "node:os";
import type { AdapterStatus, AgentResponse, MessageHandler, TransportAdapter } from "./types.js";

// =============================================================================
// CliAdapter — terminal/SSH adapter.
//
// Pi's `InteractiveMode` already owns terminal I/O end-to-end (it reads stdin,
// renders the TUI, drives the agent loop). This adapter therefore does NOT
// poll stdin or push messages into the dispatcher — that would double-handle
// every keystroke. CLI input flows directly through Pi's normal path.
//
// What this adapter DOES provide:
//   - A registered identity ("cli") so the dispatcher can fan OUTBOUND
//     messages here when an extension wants to surface something via the
//     terminal (e.g. plan-enforcer reporting a scheduled run's failure to
//     an admin who happens to be at the terminal).
//   - A status surface so /transports shows it's live.
//   - A reference implementation for Sprint 4's Telegram adapter — same
//     interface, different platform.
//
// Outbound rendering: writes the response text to stdout. Attachments other
// than `text` are surfaced as a one-line summary (the agent's TUI can render
// images directly via `pi.sendMessage` if needed; this adapter is a fallback
// for headless background notifications).
//
// Sender identity for the CLI is the OS user — used for whitelist (Sprint 5)
// when the same admin SSHes in.
// =============================================================================

export const CLI_PLATFORM = "cli";
export const CLI_DEFAULT_CHANNEL = "cli:default";

export class CliAdapter implements TransportAdapter {
    readonly platform = CLI_PLATFORM;
    private state: AdapterStatus["state"] = "stopped";
    private connectedAt?: number;
    // Handler is reserved for future: if we ever want to capture user input
    // through a non-TUI path (e.g. piped stdin in scripted runs), we'd call it
    // here. For now it's stored but never invoked.
    private _handler: MessageHandler | null = null;

    setHandler(handler: MessageHandler): void {
        this._handler = handler;
    }

    async start(): Promise<void> {
        this.state = "running";
        this.connectedAt = Date.now();
    }

    async stop(): Promise<void> {
        this.state = "stopped";
    }

    async send(channelId: string, response: AgentResponse): Promise<void> {
        // The TUI is normally drawing — emit cleanly without disrupting it.
        // Use stderr so it doesn't get mixed up with TUI's stdout drawing.
        const lines: string[] = [];
        lines.push(""); // leading newline so it doesn't paste onto a TUI prompt
        lines.push(`[${this.platform}:${channelId}] ${response.text}`);
        if (response.attachments && response.attachments.length > 0) {
            for (const a of response.attachments) {
                if (a.kind === "text") {
                    lines.push(`  📄 ${a.filename ?? a.mimeType} (${a.text.length} chars)`);
                } else if (a.kind === "image") {
                    lines.push(`  🖼  ${a.filename ?? a.mimeType} (${Math.round(a.data.length * 0.75 / 1024)}KB)`);
                } else {
                    lines.push(`  📦 ${a.filename ?? a.mimeType} (${a.sizeBytes} bytes) at ${a.localPath}`);
                }
            }
        }
        process.stderr.write(`${lines.join("\n")}\n`);
    }

    status(): AdapterStatus {
        const status: AdapterStatus = {
            platform: this.platform,
            state: this.state,
            details: {
                os_user: os.userInfo().username,
                hostname: os.hostname(),
                tty: Boolean(process.stdout.isTTY),
            },
        };
        if (this.connectedAt !== undefined) status.connectedAt = this.connectedAt;
        return status;
    }
}
