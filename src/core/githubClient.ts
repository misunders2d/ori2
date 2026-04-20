// Thin wrapper around GitHub's REST API for Ori's five read tools
// (github_search_code/repos/issues, github_read, github_read_issue).
//
// Stateless: no caching, no retries, no background scheduling. Callers (the
// five tools) get typed errors on rate-limit exhaustion so they can surface
// the reset window without the helper papering over it.

import { getCredentials } from "./credentials.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export class GithubRateLimitError extends Error {
    readonly resetAt: Date;
    readonly remaining: number;
    constructor(resetAt: Date, remaining: number) {
        super(`GitHub rate limit exhausted. Resets at ${resetAt.toISOString()}.`);
        this.name = "GithubRateLimitError";
        this.resetAt = resetAt;
        this.remaining = remaining;
    }
}

export interface GithubSearchPage<T> {
    items: T[];
    total_count: number;
    truncated: boolean;
}

export interface GithubIssueCommentPublic {
    author: string;
    created_at: string;
    body: string;
}

export interface GithubIssueWithComments {
    title: string;
    number: number;
    state: string;
    author: string;
    labels: string[];
    created_at: string;
    updated_at: string;
    body: string;
    comments: GithubIssueCommentPublic[];
    html_url: string;
    is_pull_request: boolean;
    total_comments: number;
    comments_truncated?: true;
}

export type GithubReadResult =
    | { kind: "dir"; path: string; ref: string; entries: Array<{ name: string; type: string; size: number; sha: string; path: string }> }
    | { kind: "file"; path: string; ref: string; size: number; encoding: "utf8"; text: string; truncated: boolean }
    | { kind: "binary"; path: string; ref: string; size: number }
    | { kind: "not_found"; path: string };

// -----------------------------------------------------------------------------
// Auth helper
// -----------------------------------------------------------------------------

// Returns the Authorization header for the "github" credential, or null if
// the operator hasn't pasted a PAT yet. Null signals the tools to emit
// setup-guidance text WITHOUT firing an HTTP request.
export function getGithubAuthHeader(): Record<string, string> | null {
    const creds = getCredentials();
    if (!creds.has("github")) return null;
    // For auth_type=bearer (default on /credentials add), returns
    // { Authorization: "Bearer <pat>" }. Also records to secretAccessLog.
    return creds.getAuthHeader("github");
}

// -----------------------------------------------------------------------------
// Fetch mock hook (same pattern as src/core/contentModerator.ts)
// -----------------------------------------------------------------------------

let _testFetch: typeof fetch | null = null;
export function __setFetchForTests(fn: typeof fetch | null): void {
    _testFetch = fn;
}
function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    if (_testFetch) return _testFetch(input, init);
    return fetch(input, init);
}

// -----------------------------------------------------------------------------
// Core authenticated fetch
// -----------------------------------------------------------------------------

interface FetchOpts {
    signal?: AbortSignal;
    query?: Record<string, string | number>;
    /** Override the default Accept header (for search's text-match variant). */
    accept?: string;
}

export async function githubFetch<T = unknown>(
    path: string,
    opts: FetchOpts = {},
): Promise<T> {
    const url = new URL("https://api.github.com" + path);
    if (opts.query) {
        for (const [k, v] of Object.entries(opts.query)) {
            url.searchParams.set(k, String(v));
        }
    }

    const headers: Record<string, string> = {
        Accept: opts.accept ?? "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ori2",
    };
    const auth = getGithubAuthHeader();
    if (auth) Object.assign(headers, auth);

    const res = await doFetch(url.toString(), {
        headers,
        ...(opts.signal ? { signal: opts.signal } : {}),
    });

    if (res.status === 401) {
        throw new Error("GitHub auth failed — PAT invalid or revoked. Rotate via /credentials rotate github.");
    }
    if (res.status === 403) {
        const remaining = res.headers.get("x-ratelimit-remaining");
        const reset = res.headers.get("x-ratelimit-reset");
        if (remaining === "0" && reset) {
            throw new GithubRateLimitError(new Date(Number(reset) * 1000), 0);
        }
        let message = "forbidden";
        try {
            const body = await res.text();
            const j = JSON.parse(body) as { message?: string };
            if (j?.message) message = j.message;
        } catch {
            // body wasn't JSON or couldn't be read — stick with generic message
        }
        throw new Error(`GitHub forbidden: ${message}`);
    }
    if (res.status === 404) {
        throw new Error(`GitHub not found: ${path}`);
    }
    if (!res.ok) {
        throw new Error(`GitHub HTTP ${res.status}: ${res.statusText || "error"}`);
    }

    return (await res.json()) as T;
}

// -----------------------------------------------------------------------------
// Search helper — paginates up to `limit` results
// -----------------------------------------------------------------------------

export async function githubSearch<T>(
    endpoint: "/search/code" | "/search/repositories" | "/search/issues",
    query: string,
    limit: number,
    signal?: AbortSignal,
): Promise<GithubSearchPage<T>> {
    const per_page = Math.min(Math.max(limit, 1), 100);
    const items: T[] = [];
    let total_count = 0;
    let page = 1;
    while (items.length < limit) {
        const res = await githubFetch<{ items: T[]; total_count: number }>(endpoint, {
            ...(signal ? { signal } : {}),
            query: { q: query, per_page, page },
            accept: "application/vnd.github.text-match+json",
        });
        total_count = res.total_count;
        items.push(...res.items);
        if (res.items.length < per_page) break;
        page++;
    }
    return {
        items: items.slice(0, limit),
        total_count,
        truncated: items.length < total_count || total_count > limit,
    };
}

// -----------------------------------------------------------------------------
// Issue + comments helper
// -----------------------------------------------------------------------------

interface GithubIssueRaw {
    title: string;
    number: number;
    state: string;
    user: { login: string };
    labels: Array<{ name: string } | string>;
    created_at: string;
    updated_at: string;
    body: string | null;
    html_url: string;
    pull_request?: object;
    comments: number;
}
interface GithubCommentRaw {
    user: { login: string };
    created_at: string;
    body: string;
}

const COMMENT_CAP = 100;

export async function githubReadIssueWithComments(
    owner: string,
    repo: string,
    number: number,
    signal?: AbortSignal,
): Promise<GithubIssueWithComments | null> {
    let issue: GithubIssueRaw;
    try {
        issue = await githubFetch<GithubIssueRaw>(
            `/repos/${owner}/${repo}/issues/${number}`,
            signal ? { signal } : {},
        );
    } catch (e) {
        if (e instanceof Error && e.message.startsWith("GitHub not found")) return null;
        throw e;
    }

    const comments: GithubCommentRaw[] = [];
    let page = 1;
    const per_page = 100;
    while (comments.length < COMMENT_CAP) {
        const batch = await githubFetch<GithubCommentRaw[]>(
            `/repos/${owner}/${repo}/issues/${number}/comments`,
            {
                ...(signal ? { signal } : {}),
                query: { per_page, page },
            },
        );
        comments.push(...batch);
        if (batch.length < per_page) break;
        page++;
    }
    const capped = comments.slice(0, COMMENT_CAP);
    const truncated = issue.comments > COMMENT_CAP;

    return {
        title: issue.title,
        number: issue.number,
        state: issue.state,
        author: issue.user.login,
        labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        body: issue.body ?? "",
        comments: capped.map((c) => ({
            author: c.user.login,
            created_at: c.created_at,
            body: c.body,
        })),
        html_url: issue.html_url,
        is_pull_request: !!issue.pull_request,
        total_comments: issue.comments,
        ...(truncated ? { comments_truncated: true as const } : {}),
    };
}

// -----------------------------------------------------------------------------
// Contents helper (file or directory)
// -----------------------------------------------------------------------------

interface GithubContentFile {
    type: "file";
    size: number;
    content?: string;
    encoding: "base64" | "none";
    download_url: string | null;
    path: string;
    sha: string;
}
interface GithubContentDirEntry {
    type: string;
    name: string;
    size: number;
    sha: string;
    path: string;
}

const TEXT_CAP = 25_000;

export async function githubReadContents(
    owner: string,
    repo: string,
    path: string = "",
    ref?: string,
    signal?: AbortSignal,
): Promise<GithubReadResult> {
    let response: GithubContentFile | GithubContentDirEntry[];
    try {
        response = await githubFetch<GithubContentFile | GithubContentDirEntry[]>(
            `/repos/${owner}/${repo}/contents/${path}`,
            {
                ...(signal ? { signal } : {}),
                ...(ref ? { query: { ref } } : {}),
            },
        );
    } catch (e) {
        if (e instanceof Error && e.message.startsWith("GitHub not found")) {
            return { kind: "not_found", path };
        }
        throw e;
    }

    const resolvedRef = ref ?? "default";

    if (Array.isArray(response)) {
        return {
            kind: "dir",
            path,
            ref: resolvedRef,
            entries: response.map((e) => ({
                name: e.name,
                type: e.type,
                size: e.size,
                sha: e.sha,
                path: e.path,
            })),
        };
    }

    const file = response;
    if (file.type !== "file") {
        return { kind: "binary", path, ref: resolvedRef, size: file.size };
    }

    let bytes: Buffer;
    if (file.encoding === "base64" && typeof file.content === "string") {
        bytes = Buffer.from(file.content, "base64");
    } else if (file.download_url) {
        const rawRes = await doFetch(file.download_url, signal ? { signal } : {});
        if (!rawRes.ok) {
            throw new Error(`GitHub raw fetch failed: ${rawRes.status} ${rawRes.statusText || "error"}`);
        }
        bytes = Buffer.from(await rawRes.arrayBuffer());
    } else {
        return { kind: "binary", path, ref: resolvedRef, size: file.size };
    }

    const scanLen = Math.min(bytes.length, 8192);
    for (let i = 0; i < scanLen; i++) {
        if (bytes[i] === 0) {
            return { kind: "binary", path, ref: resolvedRef, size: file.size };
        }
    }

    const text = bytes.toString("utf-8");
    const truncated = text.length > TEXT_CAP;
    return {
        kind: "file",
        path,
        ref: resolvedRef,
        size: file.size,
        encoding: "utf8",
        text: truncated ? text.slice(0, TEXT_CAP) + "\n...(truncated)" : text,
        truncated,
    };
}
