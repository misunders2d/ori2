process.env["BOT_NAME"] = "_test_egress_cmd";

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./core/paths.js";
import { getEgressAllowlist } from "./core/egressAllowlist.js";

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    getEgressAllowlist().reset();
}

// -----------------------------------------------------------------------------
// Unit tests for the pure helpers + the captured-command handler.
// -----------------------------------------------------------------------------

describe("egress — normalizeHost", () => {
    before(cleanTestDir);
    after(cleanTestDir);

    it("accepts a plain hostname", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("api.github.com"), "api.github.com");
    });

    it("lowercases", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("API.GitHub.Com"), "api.github.com");
    });

    it("strips scheme if accidentally pasted", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("https://api.github.com"), "api.github.com");
    });

    it("strips path", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("api.github.com/repos"), "api.github.com");
    });

    it("strips port", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("api.github.com:443"), "api.github.com");
    });

    it("allows localhost (single-label)", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("localhost"), "localhost");
    });

    it("rejects empty / whitespace", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost(""), null);
        assert.equal(__test.normalizeHost("   "), null);
    });

    it("rejects garbage (spaces, weird chars)", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("foo bar"), null);
        assert.equal(__test.normalizeHost("foo!@bar.com"), null);
    });

    it("rejects bare label that isn't localhost", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("bare"), null);
    });

    it("rejects double-dot / leading-dot / trailing-dot", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.normalizeHost("a..b"), null);
        assert.equal(__test.normalizeHost(".foo.com"), null);
        assert.equal(__test.normalizeHost("foo.com."), null);
    });
});

// -----------------------------------------------------------------------------
// addPlatform / addCredential / removeEntry — exercise the EgressAllowlist
// integration with the cleaned-room filesystem.
// -----------------------------------------------------------------------------

describe("egress — add/remove integration", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("addPlatform writes a host the allowlist accepts", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        const r = __test.addPlatform("acme", "api.acme.com");
        assert.equal(r.ok, true);
        assert.ok(getEgressAllowlist().allowsPlatform("acme", "https://api.acme.com/v1/foo"));
    });

    it("addCredential writes a host the allowlist accepts", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        const r = __test.addCredential("stripe_live", "api.stripe.com");
        assert.equal(r.ok, true);
        assert.ok(getEgressAllowlist().allowsCredential("stripe_live", "https://api.stripe.com/v1/charges"));
    });

    it("addPlatform rejects invalid host input", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        const r = __test.addPlatform("acme", "not a host");
        assert.equal(r.ok, false);
        assert.match(r.msg, /Rejected host/);
    });

    it("addPlatform rejects missing args", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        assert.equal(__test.addPlatform(undefined, "x").ok, false);
        assert.equal(__test.addPlatform("acme", undefined).ok, false);
    });

    it("removeEntry platform removes a previously-added host", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        __test.addPlatform("acme", "api.acme.com");
        const r = __test.removeEntry(["platform", "acme", "api.acme.com"]);
        assert.equal(r.ok, true);
        assert.equal(getEgressAllowlist().allowsPlatform("acme", "https://api.acme.com/"), false);
    });

    it("removeEntry credential removes a previously-added host", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        __test.addCredential("stripe", "api.stripe.com");
        const r = __test.removeEntry(["credential", "stripe", "api.stripe.com"]);
        assert.equal(r.ok, true);
        assert.equal(getEgressAllowlist().allowsCredential("stripe", "https://api.stripe.com/"), false);
    });

    it("removeEntry reports no-match when the host wasn't listed", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        const r = __test.removeEntry(["credential", "ghost", "api.nowhere.com"]);
        assert.equal(r.ok, false);
        assert.match(r.msg, /No matching entry/);
    });

    it("removeEntry rejects invalid scope", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        const r = __test.removeEntry(["everything", "acme", "api.acme.com"]);
        assert.equal(r.ok, false);
        assert.match(r.msg, /Usage:/);
    });

    it("listAll includes built-in platforms seeded on first access", async () => {
        const { __test } = await import("../.pi/extensions/egress.js");
        const out = __test.listAll();
        assert.match(out, /github:.*api\.github\.com/);
        assert.match(out, /google:.*googleapis\.com/);
    });
});

// -----------------------------------------------------------------------------
// Captured-command handler — confirm the full /egress-allow pipeline works
// (admin gate, subcommand dispatch, ctx.ui.notify emission).
// -----------------------------------------------------------------------------

interface CapturedCommand {
    name: string;
    spec: { description: string; handler: (args: string, ctx: unknown) => Promise<void> };
}

async function loadCommand(): Promise<CapturedCommand["spec"]> {
    const commands = new Map<string, CapturedCommand["spec"]>();
    const api = {
        on: () => {},
        registerTool: () => {},
        registerCommand: (name: string, spec: CapturedCommand["spec"]) => { commands.set(name, spec); },
        sendUserMessage: () => {},
        appendEntry: () => {},
        events: { on: () => {}, emit: () => {} },
    };
    const factory = (await import("../.pi/extensions/egress.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    const cmd = commands.get("egress-allow");
    assert.ok(cmd, "/egress-allow was not registered");
    return cmd!;
}

interface Notify { text: string; level: string; }

function fakeCtx(notifications: Notify[]): unknown {
    // We bypass admin-gate by leaving sessionManager undefined-ish — isAdminCaller
    // short-circuits to "true" when currentOrigin returns null (CLI fallback).
    return {
        sessionManager: { getBranch: () => [] },
        ui: { notify: (text: string, level: string) => { notifications.push({ text, level }); } },
    };
}

describe("egress — command handler", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("no args → help", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("", fakeCtx(out));
        assert.equal(out.length, 1);
        assert.equal(out[0]!.level, "info");
        assert.match(out[0]!.text, /Subcommands:/);
    });

    it("list → shows built-in github seeded hosts", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("list", fakeCtx(out));
        assert.match(out[0]!.text, /api\.github\.com/);
    });

    it("platform <n> <h> → info notify + allowlist mutated", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("platform acme api.acme.com", fakeCtx(out));
        assert.equal(out[0]!.level, "info");
        assert.ok(getEgressAllowlist().allowsPlatform("acme", "https://api.acme.com/"));
    });

    it("credential <id> <h> → info notify + allowlist mutated", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("credential github api.github.com", fakeCtx(out));
        assert.equal(out[0]!.level, "info");
        assert.ok(getEgressAllowlist().allowsCredential("github", "https://api.github.com/repos"));
    });

    it("credential with bogus host → error notify, allowlist unchanged", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("credential github nope!@garbage", fakeCtx(out));
        assert.equal(out[0]!.level, "error");
        assert.equal(getEgressAllowlist().allowsCredential("github", "https://nope/"), false);
    });

    it("remove credential <id> <h> → removes host", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("credential github api.github.com", fakeCtx(out));
        await spec.handler("remove credential github api.github.com", fakeCtx(out));
        assert.equal(out.at(-1)!.level, "info");
        assert.equal(getEgressAllowlist().allowsCredential("github", "https://api.github.com/"), false);
    });

    it("unknown subcommand → error notify", async () => {
        const spec = await loadCommand();
        const out: Notify[] = [];
        await spec.handler("nuke everything", fakeCtx(out));
        assert.equal(out[0]!.level, "error");
        assert.match(out[0]!.text, /Unknown/);
    });
});
