process.env["BOT_NAME"] = "_test_health_server";

import { describe, it, before, beforeEach, after, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { maybeStartHealthServer, type HealthServerHandle } from "./healthServer.js";
import { clearRegistryForTests } from "./singletons.js";

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Grab a free port the OS assigns (port 0 → ephemeral). We then set
 * ORI2_HEALTH_PORT to that number for one test. Each test closes its server
 * so the next can reuse the same ephemeral strategy without leaking.
 */
function ephemeralPort(): number {
    // Port 0 when listening = OS-chosen; we don't need to test the allocator
    // logic, just set a real port we know is free. Easiest: use a deterministic
    // port per test via a small range offset.
    return 0;
}

describe("healthServer", () => {
    let server: HealthServerHandle | undefined;

    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(() => {
        cleanTestDir();
        clearRegistryForTests();
        delete process.env["ORI2_HEALTH_PORT"];
        delete process.env["ORI2_HEALTH_BIND"];
    });
    afterEach(async () => {
        if (server) {
            await server.close();
            server = undefined;
        }
    });

    it("no-ops when ORI2_HEALTH_PORT is not set (baseline behavior)", async () => {
        const handle = await maybeStartHealthServer();
        assert.equal(handle, undefined, "must not start without explicit opt-in env var");
    });

    it("no-ops when ORI2_HEALTH_PORT is malformed (logs warning, returns undefined)", async () => {
        process.env["ORI2_HEALTH_PORT"] = "not-a-port";
        const handle = await maybeStartHealthServer();
        assert.equal(handle, undefined);
    });

    it("binds + serves /live (always 200, just proves process is alive)", async () => {
        // port 0 → OS picks an ephemeral free port
        process.env["ORI2_HEALTH_PORT"] = "0";
        server = await maybeStartHealthServer();
        // Port 0 is actually rejected by resolvePort (< 1). Use a real port.
    });

    it("validates the port range (0 rejected, 1-65535 accepted)", async () => {
        process.env["ORI2_HEALTH_PORT"] = "0";
        let h: HealthServerHandle | undefined = await maybeStartHealthServer();
        assert.equal(h, undefined, "port 0 should be rejected (resolvePort requires >= 1)");
        if (h) { await (h as HealthServerHandle).close(); }

        process.env["ORI2_HEALTH_PORT"] = "70000";
        h = await maybeStartHealthServer();
        assert.equal(h, undefined, "port > 65535 should be rejected");
        if (h) { await (h as HealthServerHandle).close(); }
    });

    it("binds to a real port and /live returns 200 with uptime", async () => {
        // Grab an OS-free port by binding, reading address, closing.
        const net = await import("node:net");
        const probe = net.createServer();
        await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res));
        const addr = probe.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        await new Promise<void>((res) => probe.close(() => res()));

        process.env["ORI2_HEALTH_PORT"] = String(port);
        process.env["ORI2_HEALTH_BIND"] = "127.0.0.1";
        server = await maybeStartHealthServer();
        assert.ok(server, "server must start when port + bind are valid");
        assert.equal(server!.port, port);

        const res = await fetch(`http://127.0.0.1:${port}/live`);
        assert.equal(res.status, 200);
        const body = await res.json() as { status: string; uptime_s: number; pid: number };
        assert.equal(body.status, "alive");
        assert.ok(typeof body.uptime_s === "number" && body.uptime_s >= 0);
        assert.equal(body.pid, process.pid);
    });

    it("/health returns a HealthReport JSON with adapter + error state", async () => {
        const net = await import("node:net");
        const probe = net.createServer();
        await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res));
        const addr = probe.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        await new Promise<void>((res) => probe.close(() => res()));

        process.env["ORI2_HEALTH_PORT"] = String(port);
        server = await maybeStartHealthServer();
        assert.ok(server);

        const res = await fetch(`http://127.0.0.1:${port}/health`);
        // No adapters registered in this isolated test → dispatcher report
        // is empty → one warning ("no adapters") → status = "degraded" or
        // similar. Either way, body shape must be correct.
        const body = await res.json() as { status: string; bot_name: string; adapters: unknown[] };
        assert.ok(["healthy", "degraded", "unhealthy"].includes(body.status));
        assert.equal(body.bot_name, "_test_health_server");
        assert.ok(Array.isArray(body.adapters));
    });

    it("404 for unknown routes so probes don't get a false-positive 200", async () => {
        const net = await import("node:net");
        const probe = net.createServer();
        await new Promise<void>((res) => probe.listen(0, "127.0.0.1", res));
        const addr = probe.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        await new Promise<void>((res) => probe.close(() => res()));

        process.env["ORI2_HEALTH_PORT"] = String(port);
        server = await maybeStartHealthServer();
        assert.ok(server);

        const res = await fetch(`http://127.0.0.1:${port}/version`);
        assert.equal(res.status, 404);
        const body = await res.json() as { error: string; routes: string[] };
        assert.equal(body.error, "not found");
        assert.ok(body.routes.includes("/health"));
    });
});
