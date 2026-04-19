import path from "node:path";
import { botDir } from "./paths.js";

// =============================================================================
// secretFilesDeny — single source of truth for "this path points to bot-private
// state that must never leave the process."
//
// Used by:
//   - .pi/extensions/secret_files_guard.ts — denies read/edit/write/grep/find/
//     ls/bash on matching paths (structural defense against LLM leaking vault
//     contents into chat via generic file tools).
//   - .pi/extensions/attach_file.ts — refuses to enqueue matching paths for
//     transport delivery (so a confused agent can't telegram_attach
//     vault.json).
//   - Future features that touch file paths visible to the LLM should also
//     consult this.
//
// Two checks:
//   - resolvedUnderBotDir(p): path resolves inside data/<bot>/ (handles ..
//     traversal correctly via path.relative).
//   - containsSensitiveSubstring(s): case-insensitive substring match for
//     .secret/ and ori2's sensitive filenames. Catches absolute paths to
//     other bots' state, bash commands with here-docs, grep/find patterns,
//     etc.
//
// Both are intentionally conservative — false positives (legitimate user
// files named "vault.json") are preferable to false negatives. A false
// positive is fixable with a per-operator tool_acl rule; a false negative
// means a credential leak.
// =============================================================================

/** Substrings that mark a path/command/pattern as credential-bearing.
 *  Kept lowercase; callers must compare case-insensitively. */
export const SENSITIVE_SUBSTRINGS: readonly string[] = Object.freeze([
    "/.secret/",          // any path under .secret/
    "data/",              // bot data dir prefix; combined with file names below
    "vault.json",
    "credentials.json",
    "oauth_tokens.json",
    "oauth_platforms.json",
    "pending_actions.db",
    "channel_log.db",
    "memory.db",
    ".pi-state",
    "auth.json",          // Pi SDK's own secret store
]);

/** True if `p` resolves to somewhere inside data/<bot>/. Handles `..`
 *  traversal via path.relative (reliable cross-platform). */
export function resolvedUnderBotDir(p: string): boolean {
    const absTarget = path.resolve(process.cwd(), p);
    const absBot = botDir();
    const rel = path.relative(absBot, absTarget);
    if (rel === "" || rel === ".") return true;
    return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** True if `s` contains any sensitive substring (case-insensitive).
 *  Works on paths, patterns, and bash commands uniformly. */
export function containsSensitiveSubstring(s: string): boolean {
    const lower = s.toLowerCase();
    for (const sub of SENSITIVE_SUBSTRINGS) {
        if (lower.includes(sub.toLowerCase())) return true;
    }
    return false;
}

/** Convenience: either check trips → path is deny-worthy.
 *  Use this in new call-sites (like attach_file) for the full guard. */
export function containsSensitivePath(p: string): boolean {
    return resolvedUnderBotDir(p) || containsSensitiveSubstring(p);
}
