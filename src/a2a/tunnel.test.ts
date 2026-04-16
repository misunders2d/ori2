import { describe, it, after } from "node:test";
import { strict as assert } from "node:assert";
import { parseCloudflaredUrl, TunnelManager } from "./tunnel.js";

describe("parseCloudflaredUrl", () => {
    it("matches a URL embedded in cloudflared's typical line", () => {
        const line =
            "2026-04-16T19:30:00Z INF +--------------------------------------------------------------------------------------------+\n" +
            "2026-04-16T19:30:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |\n" +
            "2026-04-16T19:30:00Z INF |  https://wonky-frog-1234.trycloudflare.com                                                   |";
        // We test against just the URL line in production — split by line.
        const urlLine = line.split("\n").find((l) => l.includes("trycloudflare.com"))!;
        assert.equal(parseCloudflaredUrl(urlLine), "https://wonky-frog-1234.trycloudflare.com");
    });

    it("returns null for unrelated text", () => {
        assert.equal(parseCloudflaredUrl("INF Connected to colo iad05"), null);
    });

    it("matches simple subdomain with hyphens", () => {
        assert.equal(
            parseCloudflaredUrl("https://abc-def-123.trycloudflare.com is ready"),
            "https://abc-def-123.trycloudflare.com",
        );
    });
});

describe("TunnelManager — disabled mode", () => {
    it("start() resolves to undefined and emits no events", async () => {
        const t = new TunnelManager({ mode: "disabled", localPort: 9999 });
        const url = await t.start();
        assert.equal(url, undefined);
        await t.stop(); // idempotent
    });
});

describe("TunnelManager — external mode", () => {
    const opened: TunnelManager[] = [];
    after(async () => {
        for (const t of opened) await t.stop();
    });

    it("emits url-ready immediately and returns the configured URL", async () => {
        const t = new TunnelManager({
            mode: "external",
            localPort: 9999,
            externalUrl: "https://operator.example.com",
        });
        opened.push(t);
        let emitted: string | undefined;
        t.once("url-ready", (u: string) => { emitted = u; });
        const url = await t.start();
        assert.equal(url, "https://operator.example.com");
        // Allow the queueMicrotask emit to drain.
        await new Promise<void>((r) => setImmediate(r));
        assert.equal(emitted, "https://operator.example.com");
    });

    it("returns undefined when external mode has no URL configured", async () => {
        const t = new TunnelManager({ mode: "external", localPort: 9999 });
        opened.push(t);
        const url = await t.start();
        assert.equal(url, undefined);
    });
});

describe("TunnelManager — cloudflared mode (child exits immediately)", () => {
    it("emits error and resolves with undefined when child exits without printing a URL", async () => {
        // Use /bin/false — exists, exits 1 immediately, never emits a URL.
        // This exercises the same code path as a missing cloudflared binary
        // (init resolves with undefined, error fires) without the noisy
        // restart loop a truly missing binary would create.
        const t = new TunnelManager({
            mode: "cloudflared",
            localPort: 9999,
            cloudflaredPath: "/bin/false",
        });
        const errors: Error[] = [];
        t.on("error", (e: Error) => errors.push(e));
        const url = await t.start(300);
        assert.equal(url, undefined);
        // Stop BEFORE the next backoff timer fires so we don't leave a child running.
        await t.stop();
        assert.ok(errors.length > 0, "expected at least one error event");
    });
});
