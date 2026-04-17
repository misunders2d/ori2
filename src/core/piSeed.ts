import fs from "node:fs";
import path from "node:path";
import { getVault } from "./vault.js";
import { ensureDir } from "./paths.js";

// =============================================================================
// Pi-native file seeders — migrate installations that predate the wizard
// writing auth.json / settings.json directly. Idempotent; respect values the
// operator set via /login or /settings.
//
// Extracted from src/index.ts for testability. The boot path in index.ts
// calls these after hydrateEnvFromVault() so the mirrored env vars are
// already in place if any downstream code needs them.
// =============================================================================

/** Vault key name → Pi provider name in auth.json / settings.json. */
export const VAULT_TO_PI_PROVIDER: Record<string, string> = {
    GEMINI_API_KEY: "google",
    ANTHROPIC_API_KEY: "anthropic",
    OPENAI_API_KEY: "openai",
};

/**
 * One-shot vault key rename: GOOGLE_API_KEY → GEMINI_API_KEY. Safe to run on
 * every boot; no-op once complete. Pi SDK's @mariozechner/pi-ai env-api-keys
 * maps provider "google" to env var GEMINI_API_KEY (not GOOGLE_API_KEY).
 *
 * Also cleans up GOOGLE_API_KEY when BOTH keys exist — happened on
 * installs migrated mid-Phase-1 where the migration ran but the wizard had
 * also already seeded both. One copy of the secret in vault is enough.
 */
export function migrateLegacyVaultKeys(): boolean {
    const vault = getVault();
    const legacy = vault.get("GOOGLE_API_KEY");
    const canonical = vault.get("GEMINI_API_KEY");
    if (legacy && !canonical) {
        vault.set("GEMINI_API_KEY", legacy);
        vault.delete("GOOGLE_API_KEY");
        return true;
    }
    if (legacy && canonical) {
        // Both present — drop the legacy copy. Same value (we wrote both from
        // one wizard run, or hydrated a legacy→canonical migration on one
        // boot and a fresh wizard on another).
        vault.delete("GOOGLE_API_KEY");
        return true;
    }
    return false;
}

/**
 * Seed Pi's auth.json at `<piDir>/auth.json` with any API keys present in
 * vault that aren't already in auth.json. Respects operator's /login state.
 * Returns true if the file was written.
 */
export function ensurePiAuthJsonSeeded(piDir: string): boolean {
    const file = path.join(piDir, "auth.json");
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
        try { existing = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; }
        catch { /* malformed — overwrite */ }
    }
    const vault = getVault();
    let changed = false;
    for (const [vaultKey, provider] of Object.entries(VAULT_TO_PI_PROVIDER)) {
        if (existing[provider]) continue;
        const apiKey = vault.get(vaultKey);
        if (!apiKey) continue;
        existing[provider] = { type: "api_key", key: apiKey };
        changed = true;
    }
    if (!changed) return false;
    ensureDir(piDir);
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(existing, null, 2));
        fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    return true;
}

/**
 * Seed Pi's settings.json with defaultProvider if missing. Picks the first
 * provider (Gemini → Anthropic → OpenAI) that has a vault API key.
 */
export function ensurePiSettingsJsonSeeded(piDir: string): boolean {
    const file = path.join(piDir, "settings.json");
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(file)) {
        try { existing = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>; }
        catch { /* overwrite */ }
    }
    if (existing["defaultProvider"]) return false;
    const vault = getVault();
    let chosen: string | null = null;
    for (const [vaultKey, provider] of Object.entries(VAULT_TO_PI_PROVIDER)) {
        if (vault.get(vaultKey)) { chosen = provider; break; }
    }
    if (!chosen) return false;
    existing["defaultProvider"] = chosen;
    ensureDir(piDir);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2));
    fs.renameSync(tmp, file);
    return true;
}
