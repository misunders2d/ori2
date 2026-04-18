process.env["BOT_NAME"] = "_test_secret_guard";

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { guard } from "./secret_files_guard.js";

// Pure-function tests — guard() doesn't touch the filesystem; it just
// inspects toolName + input and returns a deny decision (or undefined).
// botDir() returns `<cwd>/data/_test_secret_guard` here.

function denied(toolName: string, input: unknown): { block: true; reason: string } {
    const r = guard({ toolName, input });
    if (!r) throw new Error(`expected deny, got allow for ${toolName} with input=${JSON.stringify(input)}`);
    return r;
}

function allowed(toolName: string, input: unknown): void {
    const r = guard({ toolName, input });
    if (r) throw new Error(`expected allow, got deny: ${r.reason}`);
}

describe("secret_files_guard — read/edit/write target botDir()", () => {
    it("denies read of relative path under botDir", () => {
        denied("read", { path: "data/_test_secret_guard/.secret/vault.json" });
    });
    it("denies read of legacy direct path (pre-migration vault.json)", () => {
        denied("read", { path: "data/_test_secret_guard/vault.json" });
    });
    it("denies edit of credentials file", () => {
        denied("edit", { path: "data/_test_secret_guard/.secret/credentials.json" });
    });
    it("denies write to oauth_tokens", () => {
        denied("write", { path: "data/_test_secret_guard/.secret/oauth_tokens.json" });
    });
    it("denies read using legacy `file_path` alias", () => {
        denied("read", { file_path: "data/_test_secret_guard/.secret/vault.json" });
    });
    it("denies absolute-path access too", () => {
        const abs = `${process.cwd()}/data/_test_secret_guard/.secret/vault.json`;
        denied("read", { path: abs });
    });
    it("blocks `..` traversal that lands inside botDir", () => {
        // From a subdir, ../<bot>/.secret/x resolves under botDir.
        denied("read", { path: "src/../data/_test_secret_guard/.secret/vault.json" });
    });
});

describe("secret_files_guard — sensitive substring catch-all", () => {
    it("denies cross-bot read by filename even outside our botDir", () => {
        // Sibling bot in same checkout — different BOT_NAME, same risk.
        denied("read", { path: "data/OtherBot/.secret/vault.json" });
    });
    it("denies path containing /.secret/ regardless of root", () => {
        denied("read", { path: "/tmp/.secret/foo" });
    });
    it("denies path naming auth.json (Pi SDK secret store)", () => {
        denied("read", { path: "/some/where/.pi-state/auth.json" });
    });
});

describe("secret_files_guard — pattern-arg tools", () => {
    it("blocks `find . -name vault.json`-style by pattern", () => {
        denied("find", { pattern: "vault.json" });
    });
    it("blocks `grep -r SECRET data/`-style by glob", () => {
        denied("grep", { glob: "data/**/*.json" });
    });
    it("allows benign find pattern", () => {
        allowed("find", { pattern: "*.test.ts" });
    });
    it("allows benign grep glob", () => {
        allowed("grep", { glob: "*.ts" });
    });
});

describe("secret_files_guard — bash command substring scan", () => {
    it("blocks `cat data/<bot>/vault.json`", () => {
        denied("bash", { command: "cat data/_test_secret_guard/.secret/vault.json" });
    });
    it("blocks here-string indirection (xxd/od)", () => {
        denied("bash", { command: "xxd data/_test_secret_guard/.secret/vault.json | head" });
    });
    it("blocks node -e read", () => {
        denied("bash", { command: 'node -e "console.log(require(\\"fs\\").readFileSync(\\"./data/_test_secret_guard/.secret/vault.json\\",\\"utf-8\\"))"' });
    });
    it("blocks process substitution like $(< vault.json)", () => {
        denied("bash", { command: 'echo "$(< vault.json)"' });
    });
    it("blocks any command naming pending_actions.db", () => {
        denied("bash", { command: "sqlite3 data/_test_secret_guard/.secret/pending_actions.db .dump" });
    });
    it("allows benign commands", () => {
        allowed("bash", { command: "ls -la README.md" });
        allowed("bash", { command: "git status" });
        allowed("bash", { command: "node --version" });
    });
});

describe("secret_files_guard — non-targeted tools pass through", () => {
    it("ignores ori2-registered tools entirely (memory_save, etc.)", () => {
        // memory_save's input could mention a path string by accident — we
        // don't match against it because the guard only runs on the named
        // path-arg tools.
        allowed("memory_save", { content: "Note: see vault.json for context" });
    });
    it("ignores read of non-bot-state files", () => {
        allowed("read", { path: "src/index.ts" });
        allowed("read", { path: "/etc/hostname" });
        allowed("read", { path: "package.json" });
    });
    it("ignores edit of regular project files", () => {
        allowed("edit", { path: ".pi/extensions/persona.ts" });
    });
});

describe("secret_files_guard — case insensitivity", () => {
    it("blocks uppercase file references too", () => {
        denied("read", { path: "data/_test_secret_guard/.secret/VAULT.JSON" });
        denied("bash", { command: "CAT data/_test_secret_guard/.secret/Credentials.json" });
    });
});
