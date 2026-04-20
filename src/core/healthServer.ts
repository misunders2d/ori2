import express from "express";
import type { Server } from "node:http";
import { getHealth, type HealthReport } from "./health.js";
import { logWarning } from "./errorLog.js";

// =============================================================================
// External HTTP health endpoint.
//
// Why this exists:
//   The `/health` slash command (inside `.pi/extensions/diagnostics.ts`) is
//   chat-only — an operator invokes it from TUI/Telegram and sees the report
//   inline. Great for human ops but useless for automated monitoring:
//   UptimeRobot, Pingdom, a k8s liveness probe, an admin's curl from outside
//   the server — none of those can invoke a chat command. An external HTTP
//   endpoint is the missing piece.
//
// Opt-in only:
//   Binds a port IFF `ORI2_HEALTH_PORT` is set. Default = disabled. This
//   matches existing ori2 conventions (A2A too waits for explicit activation)
//   and avoids surprising port conflicts on shared hosts.
//
// Routes:
//   GET /live   — always 200. Just proves the event loop is alive +
//                 returns {bot_name, uptime_s}. Use for k8s liveness.
//   GET /ready  — 200 if HealthReport.status is "healthy" or "degraded";
//                 503 if "unhealthy". Use for k8s readiness / loadbalancer
//                 deactivation.
//   GET /health — full HealthReport JSON. 200/503 mapping same as /ready.
//                 Use for detailed dashboards / Grafana / etc.
//   GET /health/deep — same as /health but with deep=true (live Telegram
//                 getMe + A2A friend probes + disk walk). Slow. Gate via
//                 reverse proxy / basic auth if exposing publicly.
//
// Security posture:
//   The report contains operational state — adapter platforms, error counts,
//   disk bytes — but NO secrets (vault values are never included). Still:
//   bind to 127.0.0.1 or a trusted subnet by default. Reverse-proxy with
//   auth if you need internet exposure. `ORI2_HEALTH_BIND` (default
//   "127.0.0.1") controls the bind address.
// =============================================================================

export interface HealthServerHandle {
    port: number;
    bindAddress: string;
    close(): Promise<void>;
}

function resolvePort(): number | undefined {
    const raw = process.env["ORI2_HEALTH_PORT"];
    if (!raw) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        logWarning("healthServer", `ORI2_HEALTH_PORT="${raw}" invalid — endpoint disabled`, { raw });
        return undefined;
    }
    return n;
}

function resolveBind(): string {
    const raw = process.env["ORI2_HEALTH_BIND"];
    if (!raw || raw.trim() === "") return "127.0.0.1";
    return raw.trim();
}

function statusCodeFor(status: HealthReport["status"]): number {
    return status === "unhealthy" ? 503 : 200;
}

/**
 * Start the external health server if `ORI2_HEALTH_PORT` is configured.
 * Returns a handle if started, undefined if disabled. Safe to call from
 * bootstrap regardless of mode — interactive TUI, daemon, subprocess —
 * the env-gate keeps it opt-in.
 */
export async function maybeStartHealthServer(): Promise<HealthServerHandle | undefined> {
    const port = resolvePort();
    if (port === undefined) return undefined;

    // NOTE: the ORI2_SCHEDULER_SUBPROCESS guard that lived here was necessary
    // back when channelRouter and scheduler spawned `pi -p` children —
    // subprocesses inherited ORI2_HEALTH_PORT and would EADDRINUSE. Both
    // subprocess paths are gone (f69bb81 for inbound, later rewrite for
    // scheduler fires). One process, one health server, no guard needed.

    const bindAddress = resolveBind();
    const app = express();

    // CORS: intentionally not permissive. Health endpoints are infrastructure,
    // not browser features. If you need browser access, put it behind a
    // reverse proxy that handles CORS.

    app.get("/live", (_req, res) => {
        res.status(200).json({
            status: "alive",
            uptime_s: Math.round(process.uptime()),
            pid: process.pid,
        });
    });

    app.get("/ready", async (_req, res) => {
        try {
            const report = await getHealth();
            res.status(statusCodeFor(report.status)).json({
                status: report.status,
                uptime_s: report.uptime_s,
                bot_name: report.bot_name,
            });
        } catch (e) {
            res.status(503).json({ status: "unhealthy", error: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/health", async (_req, res) => {
        try {
            const report = await getHealth();
            res.status(statusCodeFor(report.status)).json(report);
        } catch (e) {
            res.status(503).json({ status: "unhealthy", error: e instanceof Error ? e.message : String(e) });
        }
    });

    app.get("/health/deep", async (_req, res) => {
        try {
            const report = await getHealth({ deep: true });
            res.status(statusCodeFor(report.status)).json(report);
        } catch (e) {
            res.status(503).json({ status: "unhealthy", error: e instanceof Error ? e.message : String(e) });
        }
    });

    // 404 for everything else so a probe to /version or similar doesn't
    // return an empty 200 that would look healthy.
    app.use((_req, res) => {
        res.status(404).json({ error: "not found", routes: ["/live", "/ready", "/health", "/health/deep"] });
    });

    return new Promise<HealthServerHandle>((resolve, reject) => {
        const server: Server = app.listen(port, bindAddress, () => {
            const addr = server.address();
            const actualPort = typeof addr === "object" && addr ? addr.port : port;
            console.log(`[health-server] listening on http://${bindAddress}:${actualPort}/health`);
            resolve({
                port: actualPort,
                bindAddress,
                close: async () => {
                    // closeIdleConnections + closeAllConnections sever any
                    // lingering keep-alive sockets that would otherwise keep
                    // the event loop alive past close(). Without this, Node's
                    // test runner IPC can hang waiting for the worker to exit.
                    server.closeIdleConnections();
                    server.closeAllConnections();
                    await new Promise<void>((res, rej) => server.close((err) => err ? rej(err) : res()));
                },
            });
        });
        // Short keep-alive so a straggling client can't hold the server open
        // for the default 5-second timeout after close.
        server.keepAliveTimeout = 100;
        server.headersTimeout = 500;
        server.on("error", reject);
    });
}
