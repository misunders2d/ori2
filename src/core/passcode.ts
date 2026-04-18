import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getVault } from "./vault.js";
import { secretSubdir } from "./paths.js";

// =============================================================================
// Init passcode — one-time bootstrap token for claiming admin over chat.
//
// Flow:
//   1. First boot: ensureInitPasscode() generates a 16-char random hex if no
//      passcode has been set AND no admin has claimed yet (vault marker
//      INIT_PASSCODE_CONSUMED). Passcode stored in vault as INIT_PASSCODE.
//   2. Bootstrap logs the passcode ONCE to the terminal so the operator
//      running `npm start` sees it. If the operator missed it, they can
//      read it from vault directly.
//   3. Any chat user can run `/init <passcode>`. First match wins:
//        - Passcode is verified against vault (constant-time)
//        - Sender is promoted to admin in the whitelist
//        - INIT_PASSCODE is deleted from vault
//        - INIT_PASSCODE_CONSUMED marker is set (prevents re-generation)
//   4. Subsequent /init attempts fail — admin must be promoted via vault
//      edit or by another admin using /role grant ... admin.
//
// This solves the bootstrap problem: the bot deploys to a VPS, the admin
// sees the passcode in the initial boot log, DMs the bot /init <passcode>
// from Telegram, and becomes admin WITHOUT needing to know their Telegram
// user_id in advance (which would be required for the vault ADMIN_USER_IDS
// approach alone).
// =============================================================================

const VAULT_PASSCODE = "INIT_PASSCODE";
const VAULT_CONSUMED = "INIT_PASSCODE_CONSUMED";

/**
 * Returns the existing passcode if set, generates one if this is a fresh
 * install with no prior admin claim, or returns null if a passcode was
 * already consumed (admin already claimed — no new passcode will be minted).
 */
export function ensureInitPasscode(): string | null {
    const vault = getVault();
    if (vault.get(VAULT_CONSUMED)) return null;
    const existing = vault.get(VAULT_PASSCODE);
    if (existing) return existing;
    // 8 bytes → 16 hex chars. Not cryptographically critical since it's
    // one-time and visible only to whoever has access to the boot log or
    // the vault file, but crypto.randomBytes is effectively free.
    const passcode = crypto.randomBytes(8).toString("hex");
    vault.set(VAULT_PASSCODE, passcode);
    return passcode;
}

/**
 * Verify a candidate passcode against the one stored in vault. Uses a
 * constant-time comparison so timing can't leak which prefix is correct.
 * Returns true on success AND consumes the passcode atomically.
 */
export function consumeInitPasscode(candidate: string): boolean {
    const vault = getVault();
    const stored = vault.get(VAULT_PASSCODE);
    if (!stored) return false;
    const a = Buffer.from(stored, "utf-8");
    const b = Buffer.from(candidate, "utf-8");
    if (a.length !== b.length) return false;
    if (!crypto.timingSafeEqual(a, b)) return false;
    // Atomic swap: delete passcode, set consumed marker.
    vault.delete(VAULT_PASSCODE);
    vault.set(VAULT_CONSUMED, new Date().toISOString());
    // Clean up the operator-facing recovery file written by setup.ts. Best-
    // effort — if it's already gone (operator deleted, fresh install never
    // wrote one, etc.) we don't care.
    try {
        const recovery = path.join(secretSubdir(), "INIT_PASSCODE.txt");
        if (fs.existsSync(recovery)) fs.unlinkSync(recovery);
    } catch { /* ignore */ }
    return true;
}

/** True if any admin has successfully claimed via /init in the past. */
export function isPasscodeConsumed(): boolean {
    return !!getVault().get(VAULT_CONSUMED);
}

/** The passcode, if still available (for /init-status admin command). */
export function peekInitPasscode(): string | null {
    return getVault().get(VAULT_PASSCODE) ?? null;
}
