process.env["BOT_NAME"] = "_test_list_known_channels";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./core/paths.js";
import { getWhitelist } from "./core/whitelist.js";
import { getChannelSessions } from "./core/channelSessions.js";
import { clearRegistryForTests } from "./core/singletons.js";

// -----------------------------------------------------------------------------
// Tests for the list_known_channels tool in agent_introspection.ts.
//
// The bug this tool fixes: Ori had no programmatic way to resolve "my
// Telegram" to a real chat ID when scheduling from the TUI, so she invented
// one ("-1001234567890") and delivery silently failed with "chat not found".
// These tests lock in the contract: (a) it enumerates ALL known channels
// from both whitelist + channelSessions, (b) it DOES NOT invent, (c) it
// tells the agent to ASK when nothing matches.
// -----------------------------------------------------------------------------

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    clearRegistryForTests();
}

interface CapturedTool {
    name: string;
    execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown>; isError?: boolean }>;
}

async function loadTools(): Promise<Map<string, CapturedTool>> {
    const tools = new Map<string, CapturedTool>();
    const api = {
        on: () => {},
        registerTool: (t: CapturedTool) => { tools.set(t.name, t); },
        registerCommand: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        events: { on: () => {}, emit: () => {} },
    };
    const factory = (await import("../.pi/extensions/agent_introspection.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    return tools;
}

function cliAdminCtx(): unknown {
    // CLI fallback — currentOrigin returns null → isAdminCaller treats as admin.
    return {
        sessionManager: { getBranch: () => [] },
        hasUI: true,
        cwd: process.cwd(),
    };
}

describe("list_known_channels", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("returns a helpful 'nothing here yet, ASK the user' message on empty registries", async () => {
        const tools = await loadTools();
        const tool = tools.get("list_known_channels")!;
        assert.ok(tool);
        const out = await tool.execute("id", {}, null, null, cliAdminCtx());
        assert.match(out.content[0]!.text, /No known channels/);
        assert.match(out.content[0]!.text, /ASK the user.*chat ID/);
        assert.deepEqual(out.details["rows"], []);
    });

    it("includes whitelist user DMs with roles + source=whitelist-user-dm", async () => {
        getWhitelist().add("telegram", "330959414", {
            displayName: "operator",
            roles: ["marketing"],
            addedBy: "cli:test",
        });
        const tools = await loadTools();
        const out = await tools.get("list_known_channels")!.execute("id", {}, null, null, cliAdminCtx());
        const text = out.content[0]!.text;
        assert.match(text, /telegram:330959414/);
        assert.match(text, /name="operator"/);
        assert.match(text, /source=whitelist-user-dm/);
        const rows = out.details["rows"] as Array<{ platform: string; channelId: string }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.channelId, "330959414");
    });

    it("includes channel-sessions bindings (groups/supergroups with no per-user entry)", async () => {
        // Group chat ID only reachable via an inbound — no whitelist row exists.
        getChannelSessions().getOrCreateSessionFile("telegram", "-1001111222333");
        const tools = await loadTools();
        const out = await tools.get("list_known_channels")!.execute("id", {}, null, null, cliAdminCtx());
        const text = out.content[0]!.text;
        assert.match(text, /telegram:-1001111222333/);
        assert.match(text, /source=channel-sessions/);
    });

    it("deduplicates when the same (platform, channelId) shows up in both registries", async () => {
        getWhitelist().add("telegram", "330959414", { addedBy: "cli:test" });
        getChannelSessions().getOrCreateSessionFile("telegram", "330959414");
        const tools = await loadTools();
        const out = await tools.get("list_known_channels")!.execute("id", {}, null, null, cliAdminCtx());
        const rows = out.details["rows"] as Array<{ platform: string; channelId: string; source: string }>;
        const matches = rows.filter((r) => r.platform === "telegram" && r.channelId === "330959414");
        assert.equal(matches.length, 1, "duplicates should be merged into a single row");
        // Whitelist beats channel-sessions (whitelist-user-dm is appended first).
        assert.equal(matches[0]!.source, "whitelist-user-dm");
    });

    it("filters to a single platform when requested", async () => {
        getWhitelist().add("telegram", "111", { addedBy: "cli:t" });
        getWhitelist().add("slack", "222", { addedBy: "cli:t" });
        getChannelSessions().getOrCreateSessionFile("a2a", "peerbot");
        const tools = await loadTools();
        const out = await tools.get("list_known_channels")!.execute("id", { platform: "telegram" }, null, null, cliAdminCtx());
        const rows = out.details["rows"] as Array<{ platform: string }>;
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.platform, "telegram");
    });

    it("includes the anti-hallucination guidance in the human-readable text", async () => {
        getWhitelist().add("telegram", "1", { addedBy: "cli:t" });
        const tools = await loadTools();
        const out = await tools.get("list_known_channels")!.execute("id", {}, null, null, cliAdminCtx());
        assert.match(out.content[0]!.text, /never invent/);
        assert.match(out.content[0]!.text, /ASK them to paste the chat ID/);
    });
});
