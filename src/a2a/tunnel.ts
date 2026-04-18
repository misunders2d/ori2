import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { EventEmitter } from "node:events";
import { writeHeartbeat } from "../core/heartbeat.js";
import { logError, logWarning } from "../core/errorLog.js";

// =============================================================================
// Cloudflared tunnel manager.
//
// Modes (operator picks via vault A2A_TUNNEL_MODE):
//   - "cloudflared" (default): we spawn `cloudflared tunnel --url
//     http://127.0.0.1:<port>` as a managed child, parse the assigned
//     *.trycloudflare.com URL from stdout, persist, broadcast to friends,
//     restart with exponential backoff on crash.
//   - "external": no spawn. Operator runs their own tunnel/proxy and supplies
//     A2A_BASE_URL via vault. We just emit the configured URL and stand idle.
//   - "disabled": skip A2A server entirely (handled higher up; tunnel never
//     instantiated).
//
// Events (extend EventEmitter):
//   "url-ready"   (url: string)  — first URL detected
//   "url-changed" (url: string)  — subsequent URLs (cloudflared restart picked
//                                  up a new ephemeral domain)
//   "error"       (err: Error)   — non-fatal — caller decides whether to escalate
// =============================================================================

export const URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export type TunnelMode = "cloudflared" | "external" | "disabled";

export interface TunnelOptions {
    mode: TunnelMode;
    /** Local port cloudflared forwards to (the bound A2A server port). */
    localPort: number;
    /** For mode="external" — the URL the operator already configured. */
    externalUrl?: string;
    /** Path to cloudflared binary. Default: resolveCloudflaredPath() — searches
     *  PATH and a list of common install locations. Set explicitly only when
     *  the binary is in a non-standard location. */
    cloudflaredPath?: string;
}

/**
 * Locate the cloudflared binary, searching:
 *   1. The supplied override (if any).
 *   2. PATH (`which cloudflared` equivalent via spawnSync).
 *   3. Common install locations operators forget to add to PATH:
 *      /usr/local/bin, /usr/bin, /opt/homebrew/bin (mac arm),
 *      /home/linuxbrew/.linuxbrew/bin, $HOME/.local/bin,
 *      /opt/cloudflared/cloudflared, /snap/bin.
 *
 * Returns the first existing executable path, or null if none found.
 * Pure / sync — safe to call at startup.
 */
export function resolveCloudflaredPath(override?: string): string | null {
    const candidates: string[] = [];
    if (override && override.trim()) candidates.push(override.trim());
    // PATH search via `command -v` is more portable than `which` (busybox/Alpine).
    try {
        const r = spawnSync("/bin/sh", ["-c", "command -v cloudflared"], { encoding: "utf-8" });
        const found = r.stdout?.trim();
        if (r.status === 0 && found) candidates.push(found);
    } catch { /* fall through to fixed-path probes */ }
    // Common install locations.
    candidates.push(
        "/usr/local/bin/cloudflared",
        "/usr/bin/cloudflared",
        "/opt/homebrew/bin/cloudflared",
        "/home/linuxbrew/.linuxbrew/bin/cloudflared",
        `${process.env["HOME"] ?? ""}/.local/bin/cloudflared`,
        "/opt/cloudflared/cloudflared",
        "/snap/bin/cloudflared",
    );
    // Sync fs probe — accept the first that exists and is executable.
    for (const p of candidates) {
        if (!p) continue;
        try {
            accessSync(p, fsConstants.X_OK);
            return p;
        } catch { /* try next */ }
    }
    return null;
}

const BACKOFF_SCHEDULE_MS = [1000, 2000, 4000, 8000, 16000, 32000, 60000];

/** Pure parser — extract first *.trycloudflare.com URL from a line. */
export function parseCloudflaredUrl(line: string): string | null {
    const m = line.match(URL_REGEX);
    return m ? m[0]! : null;
}

export class TunnelManager extends EventEmitter {
    private mode: TunnelMode;
    private localPort: number;
    private externalUrl: string | undefined;
    private cloudflaredPath: string;
    private child: ChildProcess | null = null;
    private currentUrl: string | undefined;
    private restartAttempt = 0;
    private restartTimer: NodeJS.Timeout | null = null;
    private stopped = true;
    private heartbeatTimer: NodeJS.Timeout | null = null;

    constructor(opts: TunnelOptions) {
        super();
        this.mode = opts.mode;
        this.localPort = opts.localPort;
        this.externalUrl = opts.externalUrl;
        // Resolve at construction so the spawn site doesn't fail with a
        // cryptic ENOENT when cloudflared is installed but not in PATH.
        // Fall back to bare "cloudflared" only when nothing was found —
        // spawn will then ENOENT loudly with a path resolution we can't help.
        this.cloudflaredPath =
            (opts.cloudflaredPath && opts.cloudflaredPath.trim())
            || resolveCloudflaredPath()
            || "cloudflared";
    }

    /**
     * Begin running. For "cloudflared" mode, spawns the child and resolves
     * once the URL is detected (with a generous 30s timeout — if cloudflared
     * is slow to print, we still resolve and let url-changed handle it later).
     * For "external" mode, emits url-ready immediately with the configured URL.
     * For "disabled" mode, no-op (caller shouldn't construct a TunnelManager
     * in disabled mode, but tolerate it).
     *
     * Returns the initial URL, or undefined if none was discovered.
     */
    async start(initialUrlTimeoutMs = 30_000): Promise<string | undefined> {
        if (this.mode === "disabled") return undefined;
        this.stopped = false;
        if (this.mode === "external") {
            if (!this.externalUrl) return undefined;
            this.currentUrl = this.externalUrl;
            // Emit on a microtask boundary so subscribers added between
            // construction and start() still receive the event.
            queueMicrotask(() => this.emit("url-ready", this.externalUrl!));
            return this.externalUrl;
        }
        // cloudflared mode — spawn and await the first URL.
        return await new Promise<string | undefined>((resolve) => {
            const settle = (url: string | undefined) => {
                clearTimeout(timeout);
                this.off("url-ready", onReady);
                resolve(url);
            };
            const onReady = (url: string) => settle(url);
            this.once("url-ready", onReady);
            // NOT unref'd — we're actively awaiting the resolve. unref'ing
            // would let the loop exit before the timeout fires when nothing
            // else holds it alive (e.g. /bin/false in tests, or a CI runner
            // that has no other pending work). caller is expected to await
            // start() before going idle, so a brief synchronous wait here
            // is fine.
            const timeout = setTimeout(() => {
                console.warn(
                    `[a2a/tunnel] cloudflared did not emit a URL within ${initialUrlTimeoutMs}ms; ` +
                        "the server is up but unreachable until cloudflared catches up.",
                );
                this.off("url-ready", onReady);
                resolve(undefined);
            }, initialUrlTimeoutMs);
            this.spawnChild();
        });
    }

    async stop(): Promise<void> {
        this.stopped = true;
        this.stopHeartbeatTimer();
        if (this.restartTimer) {
            clearTimeout(this.restartTimer);
            this.restartTimer = null;
        }
        const c = this.child;
        if (!c || c.killed) return;
        await new Promise<void>((resolve) => {
            const onExit = () => resolve();
            c.once("exit", onExit);
            c.kill("SIGTERM");
            // 5s SIGTERM grace; then SIGKILL.
            const t = setTimeout(() => {
                if (!c.killed) try { c.kill("SIGKILL"); } catch { /* ignore */ }
            }, 5000);
            t.unref();
        });
        this.child = null;
    }

    /** The most recently discovered public URL, or undefined. */
    getUrl(): string | undefined {
        return this.currentUrl;
    }

    // -------------------- internal --------------------

    private spawnChild(): void {
        const args = ["tunnel", "--url", `http://127.0.0.1:${this.localPort}`, "--no-autoupdate"];
        let proc: ChildProcess;
        try {
            proc = spawn(this.cloudflaredPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        } catch (e) {
            this.emit("error", e instanceof Error ? e : new Error(String(e)));
            this.scheduleRestart();
            return;
        }
        this.child = proc;
        const handleLine = (line: string) => {
            const url = parseCloudflaredUrl(line);
            if (!url) return;
            const isFirst = this.currentUrl === undefined;
            const changed = !isFirst && url !== this.currentUrl;
            this.currentUrl = url;
            if (isFirst) {
                this.restartAttempt = 0; // success — reset the backoff
                writeHeartbeat("tunnel", `url=${url}`);
                this.startHeartbeatTimer();
                this.emit("url-ready", url);
            } else if (changed) {
                this.restartAttempt = 0;
                writeHeartbeat("tunnel", `url=${url} (rotated)`);
                this.emit("url-changed", url);
            }
        };
        const lineBuffer = (chunk: Buffer) => {
            const s = chunk.toString("utf-8");
            for (const line of s.split(/\r?\n/)) {
                if (line.trim()) handleLine(line);
            }
        };
        proc.stdout?.on("data", lineBuffer);
        proc.stderr?.on("data", lineBuffer); // cloudflared logs to stderr too
        proc.once("exit", (code, signal) => {
            this.child = null;
            this.stopHeartbeatTimer();
            if (this.stopped) return; // operator-initiated shutdown
            logWarning("a2a-tunnel", "cloudflared exited unexpectedly", {
                code: code ?? null,
                signal: signal ?? null,
                restartAttempt: this.restartAttempt + 1,
            });
            this.emit(
                "error",
                new Error(`cloudflared exited (code=${code ?? "null"}, signal=${signal ?? "none"})`),
            );
            this.scheduleRestart();
        });
        proc.once("error", (e) => {
            logError("a2a-tunnel", "cloudflared process error", { err: e.message });
            this.emit("error", e);
            // exit will follow; restart scheduled there.
        });
    }

    private startHeartbeatTimer(): void {
        if (this.heartbeatTimer) return;
        // Periodic heartbeat while the tunnel is believed alive — lets the
        // health aggregator distinguish "haven't polled yet" from "tunnel is
        // wedged" for bots with no inbound traffic.
        this.heartbeatTimer = setInterval(() => {
            if (this.child && !this.stopped && this.currentUrl) {
                writeHeartbeat("tunnel", `url=${this.currentUrl}`);
            }
        }, 30_000);
        // Don't keep the event loop alive just for the heartbeat ticker.
        this.heartbeatTimer.unref?.();
    }

    private stopHeartbeatTimer(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private scheduleRestart(): void {
        if (this.stopped) return;
        const idx = Math.min(this.restartAttempt, BACKOFF_SCHEDULE_MS.length - 1);
        const delay = BACKOFF_SCHEDULE_MS[idx]!;
        this.restartAttempt += 1;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            if (!this.stopped) this.spawnChild();
        }, delay);
        this.restartTimer.unref();
    }
}
