process.env["BOT_NAME"] = "_test_github_ext";

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./core/paths.js";
import { getCredentials } from "./core/credentials.js";
import { __setFetchForTests } from "./core/githubClient.js";

// -----------------------------------------------------------------------------
// Tests for the github extension's five tools. Covers:
//   - no-PAT short-circuit (fetch never fires, guidance text returned)
//   - happy-path formatting for each of the 5 tools
//   - rate-limit error path → clean tool result with reset_at
// No live network; fetch is mocked via __setFetchForTests.
// -----------------------------------------------------------------------------

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function primeCred(): void {
    cleanTestDir();
    getCredentials().reset();
    getCredentials().add({ id: "github", secret: "ghp_testtoken", addedBy: "_test" });
}

function clearCred(): void {
    cleanTestDir();
    getCredentials().reset();
}

interface CapturedTool {
    name: string;
    execute: (
        id: string,
        params: Record<string, unknown>,
        signal: unknown,
        onUpdate: unknown,
        ctx: unknown,
    ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
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
    const factory = (await import("../.pi/extensions/github.js")).default;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    factory(api as any);
    return tools;
}

function mockJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        statusText: status === 403 ? "Forbidden" : status === 404 ? "Not Found" : "OK",
        headers: { "content-type": "application/json", ...headers },
    });
}

// -----------------------------------------------------------------------------
// No-PAT guidance — all 5 tools
// -----------------------------------------------------------------------------

describe("github extension — no-PAT guidance", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(clearCred);

    const names = ["github_search_code", "github_search_repos", "github_search_issues", "github_read", "github_read_issue"];
    for (const name of names) {
        it(`${name}: returns no-PAT guidance when credential is missing, never fires fetch`, async () => {
            let fetchCalls = 0;
            __setFetchForTests(async () => {
                fetchCalls++;
                return mockJson(200, {});
            });
            const tools = await loadTools();
            const tool = tools.get(name);
            assert.ok(tool, `tool ${name} not registered`);
            const out = await tool!.execute(
                "id",
                name === "github_read" || name === "github_read_issue"
                    ? { owner: "x", repo: "y", ...(name === "github_read_issue" ? { number: 1 } : {}) }
                    : { query: "q" },
                null, null, null,
            );
            assert.equal(fetchCalls, 0, "no HTTP should fire");
            assert.equal(out.details["needs_setup"], true);
            assert.equal(out.details["credential_id"], "github");
            assert.ok(/credentials add github/.test(out.content[0]!.text), "should include /credentials add github");
            assert.ok(new RegExp(name).test(out.content[0]!.text), "should name the tool the user was trying to call");
        });
    }
});

// -----------------------------------------------------------------------------
// Happy path — one per tool (with mocked PAT + mocked fetch)
// -----------------------------------------------------------------------------

describe("github extension — happy paths", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(primeCred);

    it("github_search_code formats hits with repo, path, URL, and context fragment", async () => {
        __setFetchForTests(async () => mockJson(200, {
            total_count: 1,
            items: [{
                name: "index.ts",
                path: "src/index.ts",
                html_url: "https://github.com/badlogic/pi-mom/blob/main/src/index.ts",
                repository: { full_name: "badlogic/pi-mom" },
                text_matches: [{ fragment: "export function foo() {}" }],
            }],
        }));
        const tools = await loadTools();
        const out = await tools.get("github_search_code")!.execute("id", { query: "foo" }, null, null, null);
        assert.ok(/badlogic\/pi-mom/.test(out.content[0]!.text));
        assert.ok(/src\/index\.ts/.test(out.content[0]!.text));
        assert.ok(/export function foo/.test(out.content[0]!.text));
        assert.equal(out.details["total_count"], 1);
    });

    it("github_search_repos formats name, description, stars, lang, date", async () => {
        __setFetchForTests(async () => mockJson(200, {
            total_count: 1,
            items: [{
                full_name: "badlogic/pi-mom",
                description: "Pi Slack bot",
                html_url: "https://github.com/badlogic/pi-mom",
                stargazers_count: 42,
                language: "TypeScript",
                updated_at: "2026-04-15T00:00:00Z",
            }],
        }));
        const tools = await loadTools();
        const out = await tools.get("github_search_repos")!.execute("id", { query: "slack" }, null, null, null);
        const text = out.content[0]!.text;
        assert.ok(/badlogic\/pi-mom/.test(text));
        assert.ok(/★42/.test(text));
        assert.ok(/TypeScript/.test(text));
        assert.ok(/2026-04-15/.test(text));
    });

    it("github_search_issues labels issues vs PRs correctly", async () => {
        __setFetchForTests(async () => mockJson(200, {
            total_count: 2,
            items: [
                {
                    number: 10, title: "bug A", state: "open",
                    html_url: "https://github.com/x/y/issues/10",
                    user: { login: "alice" }, body: "repro steps: ...",
                    updated_at: "2026-04-18T00:00:00Z",
                    repository_url: "https://api.github.com/repos/x/y",
                },
                {
                    number: 11, title: "feature PR", state: "merged",
                    html_url: "https://github.com/x/y/pull/11",
                    user: { login: "bob" }, body: "adds thing",
                    updated_at: "2026-04-19T00:00:00Z",
                    repository_url: "https://api.github.com/repos/x/y",
                    pull_request: {},
                },
            ],
        }));
        const tools = await loadTools();
        const out = await tools.get("github_search_issues")!.execute("id", { query: "q" }, null, null, null);
        const text = out.content[0]!.text;
        assert.ok(/\[ISSUE\]/.test(text));
        assert.ok(/\[PR\]/.test(text));
        assert.ok(/x\/y #10/.test(text));
        assert.ok(/x\/y #11/.test(text));
    });

    it("github_read: directory branch", async () => {
        __setFetchForTests(async () => mockJson(200, [
            { type: "file", name: "README.md", size: 120, sha: "a", path: "README.md" },
            { type: "dir", name: "src", size: 0, sha: "b", path: "src" },
        ]));
        const tools = await loadTools();
        const out = await tools.get("github_read")!.execute("id", { owner: "x", repo: "y" }, null, null, null);
        const text = out.content[0]!.text;
        assert.ok(/Directory listing/.test(text));
        assert.ok(/README\.md \(file, 120 bytes\)/.test(text));
        assert.ok(/src \(dir\)/.test(text));
        assert.equal(out.details["kind"], "dir");
    });

    it("github_read: file branch returns decoded text", async () => {
        const content = Buffer.from("hello ori", "utf-8").toString("base64");
        __setFetchForTests(async () => mockJson(200, {
            type: "file", size: 9, content, encoding: "base64", download_url: null, path: "hi.txt", sha: "a",
        }));
        const tools = await loadTools();
        const out = await tools.get("github_read")!.execute("id", { owner: "x", repo: "y", path: "hi.txt" }, null, null, null);
        assert.equal(out.content[0]!.text, "hello ori");
        assert.equal(out.details["kind"], "file");
    });

    it("github_read: binary branch reports size without bytes", async () => {
        const content = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString("base64");
        __setFetchForTests(async () => mockJson(200, {
            type: "file", size: 4, content, encoding: "base64", download_url: null, path: "a.bin", sha: "a",
        }));
        const tools = await loadTools();
        const out = await tools.get("github_read")!.execute("id", { owner: "x", repo: "y", path: "a.bin" }, null, null, null);
        assert.ok(/Non-text file/.test(out.content[0]!.text));
        assert.equal(out.details["kind"], "binary");
    });

    it("github_read: not-found branch", async () => {
        __setFetchForTests(async () => mockJson(404, { message: "Not Found" }));
        const tools = await loadTools();
        const out = await tools.get("github_read")!.execute("id", { owner: "x", repo: "y", path: "nope.md" }, null, null, null);
        assert.ok(/Not found/.test(out.content[0]!.text));
        assert.equal(out.details["not_found"], true);
    });

    it("github_read_issue: renders title, body, and all comments", async () => {
        let calls = 0;
        __setFetchForTests(async () => {
            calls++;
            if (calls === 1) return mockJson(200, {
                title: "Bug report",
                number: 42,
                state: "open",
                user: { login: "alice" },
                labels: [{ name: "bug" }, { name: "priority" }],
                created_at: "2026-04-01T00:00:00Z",
                updated_at: "2026-04-19T00:00:00Z",
                body: "steps to reproduce: ...",
                html_url: "https://github.com/x/y/issues/42",
                comments: 2,
            });
            return mockJson(200, [
                { user: { login: "bob" }, created_at: "2026-04-02T00:00:00Z", body: "repro'd here too" },
                { user: { login: "carol" }, created_at: "2026-04-03T00:00:00Z", body: "fixed in #43" },
            ]);
        });
        const tools = await loadTools();
        const out = await tools.get("github_read_issue")!.execute("id", { owner: "x", repo: "y", number: 42 }, null, null, null);
        const text = out.content[0]!.text;
        assert.ok(/Bug report/.test(text));
        assert.ok(/bug, priority/.test(text));
        assert.ok(/steps to reproduce/.test(text));
        assert.ok(/repro'd here too/.test(text));
        assert.ok(/fixed in #43/.test(text));
        assert.equal(out.details["total_comments"], 2);
    });

    it("github_read_issue: not-found", async () => {
        __setFetchForTests(async () => mockJson(404, { message: "Not Found" }));
        const tools = await loadTools();
        const out = await tools.get("github_read_issue")!.execute("id", { owner: "x", repo: "y", number: 999 }, null, null, null);
        assert.ok(/Not found/.test(out.content[0]!.text));
        assert.equal(out.details["not_found"], true);
    });
});

// -----------------------------------------------------------------------------
// Rate-limit → clean tool result
// -----------------------------------------------------------------------------

describe("github extension — rate limit handling", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(primeCred);

    it("returns a readable rate_limited result when GithubRateLimitError is thrown", async () => {
        const resetEpoch = Math.floor(Date.now() / 1000) + 420;
        __setFetchForTests(async () => new Response(JSON.stringify({ message: "rate limit" }), {
            status: 403,
            headers: {
                "content-type": "application/json",
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(resetEpoch),
            },
        }));
        const tools = await loadTools();
        const out = await tools.get("github_search_code")!.execute("id", { query: "q" }, null, null, null);
        assert.equal(out.details["rate_limited"], true);
        assert.ok(typeof out.details["reset_at"] === "string");
        assert.ok(/Resets at/.test(out.content[0]!.text));
        assert.equal(out.details["error"], undefined);
    });
});
