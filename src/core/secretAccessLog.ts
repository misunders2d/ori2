import { getOrCreate } from "./singletons.js";

// =============================================================================
// secretAccessLog — observability for "what's reading what secrets, how often."
//
// Every Vault.get / Credentials.get / OAuth.getAccessToken increments a
// counter and pushes a recent-reads entry. /secrets-audit shows top-N
// accessed secrets and the last K reads.
//
// Why: with the credentials surface fully closed (storage unreachable, env
// scrubbed, bash gated, fetch tools admin-staged), the remaining failure
// mode is "an extension we wrote OR an evolved extension is reading
// secrets in unexpected volume / from an unexpected caller." Without an
// access log the operator has no signal until something breaks.
//
// Storage: in-memory only. Counters reset on restart by design — anomaly
// detection compares recent rate to recent baseline, both within a single
// process lifetime. Persistent storage would let operators do longer-term
// trend analysis but adds complexity (yet another file under .secret/);
// punt to a follow-up if needed.
//
// Caller hint: best-effort. We capture the immediate stack frame at read
// time. Not foolproof (LLM-driven calls all look like "extension code")
// but lets operators distinguish "guardrails reading GEMINI_API_KEY" from
// "evolved kpi_tool reading STRIPE_KEY".
// =============================================================================

const MAX_RECENT = 500;

export interface ReadEvent {
    /** Source identifier — e.g. "vault:GEMINI_API_KEY", "cred:github_pat", "oauth:google:access". */
    source: string;
    /** Wall-clock ms when the read happened. */
    when: number;
    /** Best-effort caller hint (file:line, derived from stack). May be empty. */
    caller: string;
}

export class SecretAccessLog {
    private counts: Map<string, number> = new Map();
    private recent: ReadEvent[] = [];
    private firstSeen: Map<string, number> = new Map();

    /** Call from inside any secret accessor. Source = "vault:KEY" / "cred:ID" / "oauth:PLATFORM:access". */
    record(source: string): void {
        const now = Date.now();
        this.counts.set(source, (this.counts.get(source) ?? 0) + 1);
        if (!this.firstSeen.has(source)) this.firstSeen.set(source, now);
        const caller = inferCaller();
        this.recent.push({ source, when: now, caller });
        if (this.recent.length > MAX_RECENT) {
            // Drop oldest. Cheap because we only do this on overflow.
            this.recent.splice(0, this.recent.length - MAX_RECENT);
        }
    }

    /** Top N most-accessed secrets, descending. */
    topReads(n: number = 20): Array<{ source: string; count: number; firstSeen: number }> {
        return Array.from(this.counts.entries())
            .map(([source, count]) => ({ source, count, firstSeen: this.firstSeen.get(source) ?? 0 }))
            .sort((a, b) => b.count - a.count)
            .slice(0, n);
    }

    /** Most recent K reads, newest first. */
    recentReads(k: number = 50): ReadEvent[] {
        return this.recent.slice(-k).reverse();
    }

    /**
     * Reads-per-minute for `source` over the last `windowMs` ms. Used by
     * /secrets-audit and (potentially future) anomaly alerting.
     */
    rate(source: string, windowMs: number = 60_000): number {
        const cutoff = Date.now() - windowMs;
        let n = 0;
        for (const e of this.recent) {
            if (e.source === source && e.when >= cutoff) n++;
        }
        return n / (windowMs / 60_000);
    }

    /** Total number of secrets seen in this process lifetime. */
    distinctSources(): number {
        return this.counts.size;
    }

    /** Test-only — clears in-memory state. */
    reset(): void {
        this.counts.clear();
        this.recent.length = 0;
        this.firstSeen.clear();
    }
}

/** Walks the stack two frames up to find a caller hint. Skips this file. */
function inferCaller(): string {
    const e = new Error();
    if (!e.stack) return "";
    const lines = e.stack.split("\n").slice(1);
    for (const line of lines) {
        if (line.includes("secretAccessLog")) continue;
        // Match `    at functionName (file:line:col)` OR `    at file:line:col`
        const m = line.match(/\(([^)]+)\)/) ?? line.match(/at (.+)$/);
        if (m && m[1]) {
            return shortenCaller(m[1]);
        }
    }
    return "";
}

function shortenCaller(s: string): string {
    // Strip absolute path noise; keep the trailing `…/file:line:col` so it's recognizable.
    const idx = s.lastIndexOf("/projects/");
    if (idx >= 0) return s.slice(idx + 1);
    if (s.length > 100) return "…" + s.slice(-100);
    return s;
}

export function getSecretAccessLog(): SecretAccessLog {
    return getOrCreate("secretAccessLog", () => new SecretAccessLog());
}
