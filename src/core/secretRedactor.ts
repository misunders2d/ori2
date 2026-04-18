import { getVault } from "./vault.js";
import { getCredentials } from "./credentials.js";
import { getOAuth } from "./oauth.js";

// =============================================================================
// secretRedactor — scrubs known-secret values from any text before it reaches
// the LLM. Final-line defense: even if a tool/file/env path leaks a value,
// this catches it on the way back into the conversation context.
//
// What's redacted (sources):
//   - Every value currently stored in the vault (API keys, ADMIN_USER_IDS,
//     TOTP secrets, friend keys, init passcode, etc.).
//   - Every credential blob in credentials.json (raw bearers, basic-auth
//     passwords, custom header values).
//   - Every OAuth access_token + refresh_token currently held.
//
// Why values, not patterns: regex-based redaction misses non-typical
// shapes (a 16-hex INIT_PASSCODE looks like nothing in particular). We
// know the literal bytes — value-based redaction is exhaustive against
// any text that contains them, regardless of context (env dumps, log
// snippets, web responses that reflect headers, anything).
//
// Min length: short values cause false positives (a 4-char "abcd" key
// would redact every English word containing it). 8-char floor matches
// the smallest credential we'd ever generate; anything shorter wasn't
// actually a secret.
//
// Performance: cached, recomputed on demand. The vault changes rarely;
// redaction is per-tool-result so a few hundred ops/sec at worst. We
// rebuild the value set lazily when called.
// =============================================================================

const MIN_REDACTABLE_LENGTH = 8;

/**
 * Public entry point. Returns the input text with every known secret
 * value replaced by `[REDACTED:<source>]`. Stable across calls.
 */
export function redactKnownSecrets(text: string): string {
    if (!text || text.length === 0) return text;
    const targets = collectRedactionTargets();
    if (targets.length === 0) return text;
    let out = text;
    for (const t of targets) {
        // Use split+join (literal replacement, no regex escaping needed,
        // multiple occurrences caught). Cheap; secrets are not regexes.
        if (out.includes(t.value)) {
            out = out.split(t.value).join(`[REDACTED:${t.source}]`);
        }
    }
    return out;
}

interface RedactionTarget {
    /** Literal secret bytes to scrub. */
    value: string;
    /** Human-readable origin: "vault:GEMINI_API_KEY", "cred:github", "oauth:google:access". */
    source: string;
}

/**
 * Build the set of (value, source) pairs to scrub from text. Skips values
 * shorter than MIN_REDACTABLE_LENGTH (false-positive risk) and dedupes
 * (multiple keys may share a value).
 */
function collectRedactionTargets(): RedactionTarget[] {
    const out: RedactionTarget[] = [];
    const seen = new Set<string>();

    const push = (value: string, source: string) => {
        if (typeof value !== "string") return;
        if (value.length < MIN_REDACTABLE_LENGTH) return;
        if (seen.has(value)) return;
        seen.add(value);
        out.push({ value, source });
    };

    // 1. Vault values.
    try {
        const vault = getVault();
        for (const key of vault.list()) {
            const v = vault.get(key);
            if (v !== undefined) push(v, `vault:${key}`);
        }
    } catch {
        // Vault not yet initialized — fail open (no redaction available).
        // Better than throwing here and breaking every tool result.
    }

    // 2. Credentials store. `get(id)` returns the raw secret bytes.
    try {
        const creds = getCredentials();
        for (const info of creds.list()) {
            try {
                const secret = creds.get(info.id);
                push(secret, `cred:${info.id}`);
            } catch { /* missing entry — skip */ }
        }
    } catch { /* fail open */ }

    // 3. OAuth tokens. `getTokensRaw` includes access + refresh.
    try {
        const oauth = getOAuth();
        for (const platform of oauth.listPlatforms()) {
            const tokens = oauth.getTokensRaw(platform.id);
            if (!tokens) continue;
            push(tokens.access_token, `oauth:${platform.id}:access`);
            if (tokens.refresh_token) push(tokens.refresh_token, `oauth:${platform.id}:refresh`);
        }
    } catch { /* fail open */ }

    return out;
}

/** Test-only: expose target collection so tests can assert what's being scrubbed. */
export function _testCollectTargets(): RedactionTarget[] {
    return collectRedactionTargets();
}
