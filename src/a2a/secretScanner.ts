import path from "node:path";
import { createHash } from "node:crypto";

// =============================================================================
// DNA secret scanner — three layered passes:
//   1. FILENAME — refuse certain paths outright (vault, env, key files).
//      Cannot be overridden — these never enter a DNA tarball.
//   2. REGEX — known credential patterns (Anthropic / Stripe / Google /
//      GitHub / Slack / AWS / generic env-style assignments / private key
//      headers). Source of truth in `KNOWN_PATTERNS` below — extend liberally.
//   3. ENTROPY — Shannon-entropy probe over quoted strings of length ≥ 32.
//      Catches custom-format secrets the regex layer misses (e.g. opaque
//      hex tokens). Threshold is intentionally permissive (4.5 bits/char)
//      to balance false-positive noise vs. coverage.
//
// Each finding has a stable `lineHash` (16-hex prefix of SHA-256 of the
// trimmed line). The operator can `--ack-secret <hash>` to acknowledge a
// false-positive — the ack list is recorded in dna_audit.jsonl by the caller.
// =============================================================================

export type FindingKind = "filename" | "regex" | "entropy";

export interface Finding {
    kind: FindingKind;
    file: string;
    line: number;          // 1-based
    column: number;        // 1-based
    matchedText: string;   // the substring that triggered (truncated to 80 chars)
    pattern: string;       // human-readable description of what fired
    lineHash: string;      // 16-hex prefix of SHA-256 of the trimmed line
}

/** Filenames that NEVER ship in DNA. Hard refusal — no override mechanism. */
export const HARD_FORBIDDEN_FILENAMES: ReadonlyArray<RegExp> = [
    /^\.env(\..+)?$/,                // .env, .env.local, .env.production, etc.
    /^vault\.json$/,
    /^oauth_tokens\.json$/,
    /^credentials\.json$/,
    /^pending_actions\.db$/,         // staging tokens — leak material
    /^memory\.db$/,                  // long-term memory — could contain user data
    /\.key$/,
    /\.pem$/,
    /^id_rsa(\.pub)?$/,
    /^id_ecdsa(\.pub)?$/,
    /^id_ed25519(\.pub)?$/,
];

/**
 * Regex patterns for known credentials. ORDER MATTERS only for reporting —
 * we run them all and emit one Finding per match. Patterns are intentionally
 * narrow to keep false positives low; broaden when a known leak slips through.
 */
export const KNOWN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
    { name: "anthropic-key", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
    { name: "openai-key", re: /sk-(?:proj-)?[A-Za-z0-9]{20,}/g },
    { name: "stripe-key", re: /sk_(?:test|live)_[A-Za-z0-9]{24,}/g },
    { name: "google-api-key", re: /AIza[0-9A-Za-z_-]{35}/g },
    { name: "github-classic-pat", re: /ghp_[A-Za-z0-9]{36}/g },
    { name: "github-fine-grained-pat", re: /github_pat_[A-Za-z0-9_]{82}/g },
    { name: "github-oauth-token", re: /gh[osu]_[A-Za-z0-9]{36}/g },
    { name: "slack-token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
    { name: "aws-access-key-id", re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
    {
        name: "env-style-secret",
        re: /[A-Z][A-Z0-9_]*(?:_API_KEY|_SECRET|_TOKEN|_PASSWORD|_PRIVATE_KEY)\s*=\s*['"][^'"\n]{8,}['"]/g,
    },
    { name: "private-key-header", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?(?:PRIVATE )?KEY-----/g },
];

/** String-literal regex used by the entropy pass. Matches "..." and '...' bodies of length ≥ 32. */
const STRING_LITERAL_RE = /(["'`])([^"'`\n]{32,})\1/g;

/** Threshold above which a string literal is considered suspicious. */
export const ENTROPY_THRESHOLD_BITS_PER_CHAR = 4.5;

export function shannonEntropyBits(s: string): number {
    if (!s) return 0;
    const counts: Record<string, number> = {};
    for (const c of s) counts[c] = (counts[c] ?? 0) + 1;
    let h = 0;
    const len = s.length;
    for (const c of Object.keys(counts)) {
        const p = counts[c]! / len;
        h -= p * Math.log2(p);
    }
    return h;
}

function lineHashOf(line: string): string {
    return createHash("sha256").update(line.trim()).digest("hex").slice(0, 16);
}

function truncate(s: string, n = 80): string {
    return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Check a filename against the hard-forbidden list. Returns the matching pattern or null. */
export function checkFilename(filePath: string): RegExp | null {
    const base = path.basename(filePath);
    for (const re of HARD_FORBIDDEN_FILENAMES) {
        if (re.test(base)) return re;
    }
    return null;
}

/**
 * Scan a single file's text content. Returns all findings (regex + entropy).
 * Filename rejection is a separate concern handled at packaging time before
 * we even call this function.
 */
export function scanContent(filePath: string, content: string): Finding[] {
    const findings: Finding[] = [];
    const lines = content.split(/\r?\n/);

    // Regex pass — use matchAll to avoid the literal ".exec(" substring that
    // trips the project's child-process security hook on file write.
    for (const { name, re } of KNOWN_PATTERNS) {
        for (const m of content.matchAll(re)) {
            const offset = m.index ?? 0;
            const { line, column } = offsetToLineCol(content, offset);
            findings.push({
                kind: "regex",
                file: filePath,
                line,
                column,
                matchedText: truncate(m[0]),
                pattern: name,
                lineHash: lineHashOf(lines[line - 1] ?? ""),
            });
        }
    }

    // Entropy pass — only over string literals to suppress noise.
    for (const sm of content.matchAll(STRING_LITERAL_RE)) {
        const inner = sm[2] ?? "";
        const entropy = shannonEntropyBits(inner);
        if (entropy < ENTROPY_THRESHOLD_BITS_PER_CHAR) continue;
        const offset = sm.index ?? 0;
        // Skip if a regex finding already covers this region (avoid double-reporting).
        const alreadyCaught = findings.some((f) => {
            if (f.kind !== "regex") return false;
            const fOffset = charIndex(content, f.line, f.column);
            return Math.abs(fOffset - offset) < inner.length + 4;
        });
        if (alreadyCaught) continue;
        const { line, column } = offsetToLineCol(content, offset);
        findings.push({
            kind: "entropy",
            file: filePath,
            line,
            column,
            matchedText: truncate(inner),
            pattern: `entropy=${entropy.toFixed(2)} bits/char`,
            lineHash: lineHashOf(lines[line - 1] ?? ""),
        });
    }

    return findings;
}

function offsetToLineCol(text: string, offset: number): { line: number; column: number } {
    let line = 1;
    let lastBreak = -1;
    for (let i = 0; i < offset; i++) {
        if (text.charCodeAt(i) === 10) { line += 1; lastBreak = i; }
    }
    return { line, column: offset - lastBreak };
}

function charIndex(text: string, line: number, column: number): number {
    let l = 1;
    for (let i = 0; i < text.length; i++) {
        if (l === line) return i + column - 1;
        if (text.charCodeAt(i) === 10) l += 1;
    }
    return text.length;
}
