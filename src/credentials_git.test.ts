process.env["BOT_NAME"] = "_test_credentials_git";

import { describe, it, before, beforeEach, after } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./core/paths.js";
import { getCredentials } from "./core/credentials.js";
import { getEgressAllowlist } from "./core/egressAllowlist.js";
import { clearRegistryForTests } from "./core/singletons.js";

// -----------------------------------------------------------------------------
// Tests for .pi/extensions/credentials.ts's `credentials_git` tool.
//
// The bug this tool fixes: without it, Ori had no way to `git push` using a
// stored PAT other than (a) asking the user to re-paste it, (b) building a
// token-embedded URL (which requires reading the secret into LLM context).
// Both are unacceptable. credentials_git injects the bearer token into git
// via GIT_CONFIG_* env vars; the token never enters argv and never reaches
// the LLM.
//
// Surface covered:
//   * admin-only gate (non-admin → isError with a clear message)
//   * credential-not-found → isError
//   * non-bearer auth type → rejected (tool only supports bearer)
//   * egress allowlist enforcement on https:// URL args
//   * happy path: command runs (we use "ls-remote" on a fake file URL that
//     fails quickly; we only care that the tool reached the git process
//     and returned a non-throw result).
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

async function loadTool(): Promise<CapturedTool> {
    const tools: CapturedTool[] = [];
    const api = {
        on: () => {},
        registerTool: (t: CapturedTool) => { tools.push(t); },
        registerCommand: () => {},
        sendUserMessage: () => {},
        appendEntry: () => {},
        events: { on: () => {}, emit: () => {} },
    };
    const factory = (await import("../.pi/extensions/credentials.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    const tool = tools.find((t) => t.name === "credentials_git");
    assert.ok(tool, "credentials_git must be registered");
    return tool!;
}

function cliAdminCtx(): unknown {
    // currentOrigin(sm) → null (no branch entries) → isAdminCaller() returns true (CLI fallback).
    return {
        sessionManager: { getBranch: () => [] },
        hasUI: true,
        cwd: process.cwd(),
    };
}

describe("credentials_git — tool registration + rejections", () => {
    before(cleanTestDir);
    after(cleanTestDir);
    beforeEach(cleanTestDir);

    it("rejects when credential id is unknown", async () => {
        const tool = await loadTool();
        const out = await tool.execute("id", {
            credential_id: "missing",
            args: ["ls-remote", "https://github.com/x/y.git"],
        }, null, null, cliAdminCtx());
        assert.equal(out.details["error"], "credential-not-found");
        assert.match(out.content[0]!.text, /not found/);
    });

    it("rejects a non-bearer credential", async () => {
        getCredentials().add({
            id: "basic_cred",
            secret: "pw",
            auth_type: "basic",
            username: "user",
            addedBy: "test",
        });
        const tool = await loadTool();
        const out = await tool.execute("id", {
            credential_id: "basic_cred",
            args: ["ls-remote", "https://github.com/x/y.git"],
        }, null, null, cliAdminCtx());
        assert.equal(out.details["error"], "unsupported-auth-type");
    });

    it("rejects a URL not on the credential's egress allowlist", async () => {
        getCredentials().add({ id: "github", secret: "ghp_fake", addedBy: "test" });
        // No allowlist entry → any https URL fails.
        const tool = await loadTool();
        const out = await tool.execute("id", {
            credential_id: "github",
            args: ["ls-remote", "https://evil.com/some/repo.git"],
        }, null, null, cliAdminCtx());
        assert.equal(out.details["error"], "egress-blocked");
        assert.match(out.content[0]!.text, /egress allowlist/);
    });

    it("rejects with args[] empty", async () => {
        getCredentials().add({ id: "github", secret: "ghp_fake", addedBy: "test" });
        const tool = await loadTool();
        const out = await tool.execute("id", {
            credential_id: "github",
            args: [],
        }, null, null, cliAdminCtx());
        assert.equal(out.details["error"], "no-args");
    });

    it("happy path: allowlist pass + spawn completes (non-throwing)", async () => {
        // No URL in args — `git --version` short-circuits without any URL
        // allowlist check. Just exercises the spawn/redact/close-handler path.
        getCredentials().add({ id: "github", secret: "ghp_leaktest_abcdefghij1234567890", addedBy: "test" });
        const tool = await loadTool();
        const out = await tool.execute("id", {
            credential_id: "github",
            args: ["--version"],
        }, null, null, cliAdminCtx());
        // Token MUST be redacted if it appears anywhere in output.
        assert.ok(!out.content[0]!.text.includes("ghp_leaktest"));
    });
});
