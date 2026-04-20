process.env["BOT_NAME"] = "_test_github_client";

import { describe, it, before, after, beforeEach } from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { botDir } from "./paths.js";
import { getCredentials } from "./credentials.js";
import {
    __setFetchForTests,
    getGithubAuthHeader,
    githubFetch,
    githubSearch,
    githubReadIssueWithComments,
    githubReadContents,
    GithubRateLimitError,
} from "./githubClient.js";

function cleanTestDir(): void {
    const dir = botDir();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function mockJson(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        statusText: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status >= 500 ? "Server Error" : "OK",
        headers: { "content-type": "application/json", ...headers },
    });
}

function primeGithubCredential(): void {
    cleanTestDir();
    getCredentials().reset();
    getCredentials().add({ id: "github", secret: "ghp_testtoken", addedBy: "_test" });
}

// ---------------------------------------------------------------------------
// getGithubAuthHeader
// ---------------------------------------------------------------------------

describe("githubClient — getGithubAuthHeader", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(() => { cleanTestDir(); getCredentials().reset(); });

    it("returns null when no github credential exists", () => {
        assert.equal(getGithubAuthHeader(), null);
    });

    it("returns Bearer auth header when github credential exists", () => {
        getCredentials().add({ id: "github", secret: "ghp_xyz", addedBy: "_test" });
        assert.deepEqual(getGithubAuthHeader(), { Authorization: "Bearer ghp_xyz" });
    });
});

// ---------------------------------------------------------------------------
// githubFetch — error mapping + header construction
// ---------------------------------------------------------------------------

describe("githubFetch — error mapping", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(primeGithubCredential);

    it("throws PAT-invalid error on 401", async () => {
        __setFetchForTests(async () => mockJson(401, { message: "Bad credentials" }));
        await assert.rejects(
            () => githubFetch("/user"),
            (e: unknown) => e instanceof Error && /PAT invalid or revoked/.test(e.message),
        );
    });

    it("throws GithubRateLimitError on 403 with remaining=0", async () => {
        const resetEpoch = Math.floor(Date.now() / 1000) + 180;
        __setFetchForTests(async () => mockJson(403, { message: "rate limit" }, {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(resetEpoch),
        }));
        await assert.rejects(
            () => githubFetch("/search/code"),
            (e: unknown) =>
                e instanceof GithubRateLimitError &&
                e.remaining === 0 &&
                e.resetAt.getTime() === resetEpoch * 1000,
        );
    });

    it("throws plain forbidden (NOT GithubRateLimitError) on 403 without rate-limit headers", async () => {
        __setFetchForTests(async () => mockJson(403, { message: "abuse detected" }));
        await assert.rejects(
            () => githubFetch("/repos/a/b"),
            (e: unknown) =>
                e instanceof Error &&
                !(e instanceof GithubRateLimitError) &&
                /forbidden/i.test(e.message) &&
                /abuse detected/.test(e.message),
        );
    });

    it("throws not-found error on 404", async () => {
        __setFetchForTests(async () => mockJson(404, { message: "Not Found" }));
        await assert.rejects(
            () => githubFetch("/repos/a/b/contents/c"),
            (e: unknown) => e instanceof Error && /not found/i.test(e.message),
        );
    });

    it("throws on 500", async () => {
        __setFetchForTests(async () => new Response("boom", { status: 500, statusText: "Internal Server Error" }));
        await assert.rejects(
            () => githubFetch("/repos/a/b"),
            (e: unknown) => e instanceof Error && /500/.test(e.message),
        );
    });

    it("returns parsed JSON on 200", async () => {
        __setFetchForTests(async () => mockJson(200, { login: "octocat", id: 1 }));
        const out = await githubFetch<{ login: string; id: number }>("/user");
        assert.equal(out.login, "octocat");
        assert.equal(out.id, 1);
    });

    it("sends Authorization, Accept, User-Agent, X-GitHub-Api-Version headers on every request", async () => {
        let captured: Headers | undefined;
        let calledWith: string | undefined;
        __setFetchForTests(async (input, init) => {
            calledWith = typeof input === "string" ? input : input.toString();
            captured = new Headers(init?.headers);
            return mockJson(200, {});
        });
        await githubFetch("/user");
        assert.ok(calledWith?.startsWith("https://api.github.com/user"), `called with ${calledWith}`);
        assert.equal(captured?.get("authorization"), "Bearer ghp_testtoken");
        assert.equal(captured?.get("accept"), "application/vnd.github+json");
        assert.equal(captured?.get("x-github-api-version"), "2022-11-28");
        assert.equal(captured?.get("user-agent"), "ori2");
    });

    it("omits Authorization when no github credential is configured", async () => {
        // Wipe BOTH disk file and in-memory state — reset() alone just clears
        // the cached flag, which triggers reload from the still-existing file.
        cleanTestDir();
        getCredentials().reset();
        let captured: Headers | undefined;
        __setFetchForTests(async (_input, init) => { captured = new Headers(init?.headers); return mockJson(200, {}); });
        await githubFetch("/user");
        assert.equal(captured?.get("authorization"), null);
    });

    it("encodes query params into the URL", async () => {
        let calledWith: string | undefined;
        __setFetchForTests(async (input) => { calledWith = typeof input === "string" ? input : input.toString(); return mockJson(200, {}); });
        await githubFetch("/search/code", { query: { q: "foo bar", per_page: 30 } });
        const u = new URL(calledWith!);
        assert.equal(u.searchParams.get("q"), "foo bar");
        assert.equal(u.searchParams.get("per_page"), "30");
    });
});

// ---------------------------------------------------------------------------
// githubSearch — paging + text-match accept
// ---------------------------------------------------------------------------

describe("githubSearch", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(primeGithubCredential);

    it("returns a single page when results <= limit", async () => {
        __setFetchForTests(async () => mockJson(200, {
            total_count: 3,
            items: [{ id: 1 }, { id: 2 }, { id: 3 }],
        }));
        const res = await githubSearch<{ id: number }>("/search/code", "q", 10);
        assert.equal(res.items.length, 3);
        assert.equal(res.total_count, 3);
        assert.equal(res.truncated, false);
    });

    it("paginates when limit > 100 items", async () => {
        const pages = [
            Array.from({ length: 100 }, (_, i) => ({ id: i })),
            Array.from({ length: 50 }, (_, i) => ({ id: 100 + i })),
        ];
        let callNum = 0;
        __setFetchForTests(async () => {
            const batch = pages[callNum++] ?? [];
            return mockJson(200, { total_count: 150, items: batch });
        });
        const res = await githubSearch<{ id: number }>("/search/code", "q", 150);
        assert.equal(res.items.length, 150);
        assert.equal(res.total_count, 150);
        assert.equal(res.truncated, false);
        assert.equal(callNum, 2);
    });

    it("marks truncated=true when total_count exceeds limit", async () => {
        __setFetchForTests(async () => mockJson(200, {
            total_count: 500,
            items: Array.from({ length: 30 }, (_, i) => ({ id: i })),
        }));
        const res = await githubSearch<{ id: number }>("/search/code", "q", 30);
        assert.equal(res.items.length, 30);
        assert.equal(res.truncated, true);
    });

    it("sends text-match Accept header on search endpoints", async () => {
        let captured: Headers | undefined;
        __setFetchForTests(async (_input, init) => { captured = new Headers(init?.headers); return mockJson(200, { total_count: 0, items: [] }); });
        await githubSearch("/search/code", "q", 10);
        assert.equal(captured?.get("accept"), "application/vnd.github.text-match+json");
    });
});

// ---------------------------------------------------------------------------
// githubReadIssueWithComments — paging + cap
// ---------------------------------------------------------------------------

describe("githubReadIssueWithComments", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(primeGithubCredential);

    const issueStub = (comments: number, isPR = false) => ({
        title: "Test issue",
        number: 42,
        state: "open",
        user: { login: "alice" },
        labels: [{ name: "bug" }, "priority"],
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-04-19T00:00:00Z",
        body: "hello",
        html_url: "https://github.com/x/y/issues/42",
        comments,
        ...(isPR ? { pull_request: {} } : {}),
    });

    it("fetches issue + no comments when comment_count=0", async () => {
        let n = 0;
        __setFetchForTests(async (input) => {
            const url = typeof input === "string" ? input : input.toString();
            n++;
            if (n === 1) {
                assert.ok(url.includes("/issues/42"));
                return mockJson(200, issueStub(0));
            }
            assert.ok(url.includes("/comments"));
            return mockJson(200, []);
        });
        const res = await githubReadIssueWithComments("x", "y", 42);
        assert.ok(res);
        assert.equal(res!.title, "Test issue");
        assert.equal(res!.comments.length, 0);
        assert.equal(res!.total_comments, 0);
        assert.equal(res!.is_pull_request, false);
        assert.deepEqual(res!.labels, ["bug", "priority"]);
    });

    it("aggregates comments across pages", async () => {
        const commentsPage1 = Array.from({ length: 100 }, (_, i) => ({
            user: { login: `u${i}` }, created_at: "2026-04-10T00:00:00Z", body: `c${i}`,
        }));
        const commentsPage2 = Array.from({ length: 5 }, (_, i) => ({
            user: { login: `u${100 + i}` }, created_at: "2026-04-11T00:00:00Z", body: `c${100 + i}`,
        }));
        let calls = 0;
        __setFetchForTests(async (input) => {
            calls++;
            const url = typeof input === "string" ? input : input.toString();
            if (calls === 1) return mockJson(200, issueStub(105));
            if (url.includes("page=2")) return mockJson(200, commentsPage2);
            return mockJson(200, commentsPage1);
        });
        const res = await githubReadIssueWithComments("x", "y", 42);
        assert.ok(res);
        assert.equal(res!.comments.length, 100); // capped at COMMENT_CAP
        assert.equal(res!.total_comments, 105);
        assert.equal(res!.comments_truncated, true);
    });

    it("detects pull requests", async () => {
        let calls = 0;
        __setFetchForTests(async () => {
            calls++;
            return calls === 1 ? mockJson(200, issueStub(0, true)) : mockJson(200, []);
        });
        const res = await githubReadIssueWithComments("x", "y", 42);
        assert.equal(res!.is_pull_request, true);
    });

    it("returns null on not-found", async () => {
        __setFetchForTests(async () => mockJson(404, { message: "Not Found" }));
        const res = await githubReadIssueWithComments("x", "y", 999);
        assert.equal(res, null);
    });
});

// ---------------------------------------------------------------------------
// githubReadContents — file / dir / binary / not-found / large-file download
// ---------------------------------------------------------------------------

describe("githubReadContents", () => {
    before(cleanTestDir);
    after(() => { __setFetchForTests(null); cleanTestDir(); });
    beforeEach(primeGithubCredential);

    it("returns directory listing for array response", async () => {
        __setFetchForTests(async () => mockJson(200, [
            { type: "file", name: "README.md", size: 120, sha: "abc", path: "README.md" },
            { type: "dir", name: "src", size: 0, sha: "def", path: "src" },
        ]));
        const res = await githubReadContents("x", "y", "");
        assert.equal(res.kind, "dir");
        if (res.kind !== "dir") return;
        assert.equal(res.entries.length, 2);
        assert.equal(res.entries[0]!.name, "README.md");
        assert.equal(res.entries[1]!.type, "dir");
    });

    it("returns decoded utf-8 text for file with base64 content", async () => {
        const content = Buffer.from("hello world\nfrom github", "utf-8").toString("base64");
        __setFetchForTests(async () => mockJson(200, {
            type: "file", size: 22, content, encoding: "base64", download_url: null, path: "README.md", sha: "abc",
        }));
        const res = await githubReadContents("x", "y", "README.md");
        assert.equal(res.kind, "file");
        if (res.kind !== "file") return;
        assert.equal(res.text, "hello world\nfrom github");
        assert.equal(res.truncated, false);
    });

    it("flags binary when a null byte appears in decoded content", async () => {
        const content = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]).toString("base64");
        __setFetchForTests(async () => mockJson(200, {
            type: "file", size: 7, content, encoding: "base64", download_url: null, path: "logo.png", sha: "abc",
        }));
        const res = await githubReadContents("x", "y", "logo.png");
        assert.equal(res.kind, "binary");
    });

    it("truncates files larger than TEXT_CAP (25_000 bytes)", async () => {
        const big = "A".repeat(30_000);
        const content = Buffer.from(big, "utf-8").toString("base64");
        __setFetchForTests(async () => mockJson(200, {
            type: "file", size: 30_000, content, encoding: "base64", download_url: null, path: "big.txt", sha: "abc",
        }));
        const res = await githubReadContents("x", "y", "big.txt");
        assert.equal(res.kind, "file");
        if (res.kind !== "file") return;
        assert.equal(res.truncated, true);
        assert.ok(res.text.endsWith("...(truncated)"), "should end with truncation marker");
        assert.ok(res.text.length <= 25_000 + 20, `got ${res.text.length}`);
    });

    it("follows download_url when encoding=none (large files over 1MB)", async () => {
        let calls = 0;
        __setFetchForTests(async (input) => {
            calls++;
            if (calls === 1) {
                return mockJson(200, {
                    type: "file", size: 1_500_000, encoding: "none", download_url: "https://raw.githubusercontent.com/x/y/main/big.txt", path: "big.txt", sha: "abc",
                });
            }
            assert.ok(typeof input === "string" && input.includes("raw.githubusercontent.com"));
            return new Response("raw content bytes\nhere", { status: 200 });
        });
        const res = await githubReadContents("x", "y", "big.txt");
        assert.equal(res.kind, "file");
        if (res.kind !== "file") return;
        assert.equal(res.text, "raw content bytes\nhere");
        assert.equal(calls, 2);
    });

    it("returns not_found kind on 404", async () => {
        __setFetchForTests(async () => mockJson(404, { message: "Not Found" }));
        const res = await githubReadContents("x", "y", "does-not-exist.md");
        assert.equal(res.kind, "not_found");
    });

    it("passes ref as query param when provided", async () => {
        let calledUrl: string | undefined;
        __setFetchForTests(async (input) => {
            calledUrl = typeof input === "string" ? input : input.toString();
            return mockJson(200, []);
        });
        await githubReadContents("x", "y", "src", "main");
        const u = new URL(calledUrl!);
        assert.equal(u.searchParams.get("ref"), "main");
    });
});
