import { authenticator } from "otplib";
import { getVault } from "./vault.js";
import { getBotName } from "./paths.js";

// =============================================================================
// TOTP — per-admin RFC 6238 time-based one-time passwords.
//
// Storage: vault keys `totp:<platform>:<senderId>` → JSON of TotpRecord.
// Why vault: secret is as sensitive as any credential; lives with API keys.
// Why per-admin: ori2 supports multiple admins (init passcode + chat claims
// + ADMIN_USER_IDS). A single shared secret would mean all admins log in as
// each other's 2FA — undermines the accountability the feature is meant to
// provide.
//
// Flow (mirrors any password manager):
//   1. /totp setup → enroll() generates secret, returns otpauthUri for QR.
//      Record written with enrolledAt set, lastVerifiedAt null.
//   2. Admin scans URI in Authenticator app, types /totp verify <code>.
//      verify() checks the code against the stored secret with ±1-step window
//      tolerance (otplib default). On success, lastVerifiedAt updated.
//   3. At any future 2FA-required action: same verify() call on the
//      admin-supplied code.
//   4. /totp disable → delete() removes the record.
//
// Once enrolled, the secret stays valid until disable() — we do NOT require
// the admin to re-verify on every session or rotate automatically. If a
// record exists with lastVerifiedAt=null, staging flows still accept a valid
// code (verification happens at first 2FA-protected action either way).
// =============================================================================

export interface TotpRecord {
    secret: string;       // base32-encoded shared secret
    enrolledAt: number;   // ms epoch
    lastVerifiedAt: number | null;
}

export interface TotpStatus {
    enrolled: boolean;
    enrolledAt: number | null;
    lastVerifiedAt: number | null;
}

export interface EnrollResult {
    secret: string;
    otpauthUri: string;
}

function vaultKey(platform: string, senderId: string): string {
    return `totp:${platform}:${senderId}`;
}

function readRecord(platform: string, senderId: string): TotpRecord | null {
    const raw = getVault().get(vaultKey(platform, senderId));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<TotpRecord>;
        if (typeof parsed.secret !== "string" || parsed.secret === "") return null;
        return {
            secret: parsed.secret,
            enrolledAt: typeof parsed.enrolledAt === "number" ? parsed.enrolledAt : Date.now(),
            lastVerifiedAt: typeof parsed.lastVerifiedAt === "number" ? parsed.lastVerifiedAt : null,
        };
    } catch {
        // Corrupt JSON → treat as un-enrolled. Admin can /totp setup again
        // to repair. We don't throw because the vault as a whole might still
        // be fine; only this one TOTP record is unreadable.
        return null;
    }
}

function writeRecord(platform: string, senderId: string, rec: TotpRecord): void {
    getVault().set(vaultKey(platform, senderId), JSON.stringify(rec));
}

/**
 * Enroll an identity. Overwrites any existing record (re-enrollment) —
 * that's the intended way to rotate: /totp setup again.
 *
 * Returns the secret AND the otpauth URI. The URI is what the admin feeds
 * to their Authenticator app (QR code or manual entry); the bare secret is
 * shown as a fallback for apps that won't parse URIs.
 */
export function enroll(platform: string, senderId: string, displayName?: string): EnrollResult {
    const secret = authenticator.generateSecret();
    const account = displayName && displayName !== senderId ? `${displayName} (${senderId})` : senderId;
    const issuer = `ori2:${getBotName()}`;
    const otpauthUri = authenticator.keyuri(account, issuer, secret);
    const rec: TotpRecord = {
        secret,
        enrolledAt: Date.now(),
        lastVerifiedAt: null,
    };
    writeRecord(platform, senderId, rec);
    return { secret, otpauthUri };
}

/**
 * Verify a 6-digit code against the enrolled secret. Updates lastVerifiedAt
 * on success. Returns false if un-enrolled or code doesn't match.
 *
 * otplib.authenticator.check has a default window of ±1 step (30s), so a
 * code that just expired or is about to roll will still verify. That's
 * intentional — prevents clock-skew frustration.
 */
export function verify(platform: string, senderId: string, code: string): boolean {
    const rec = readRecord(platform, senderId);
    if (!rec) return false;
    if (!/^\d{6}$/.test(code)) return false;
    let ok = false;
    try {
        ok = authenticator.check(code, rec.secret);
    } catch {
        return false;
    }
    if (ok) {
        rec.lastVerifiedAt = Date.now();
        writeRecord(platform, senderId, rec);
    }
    return ok;
}

export function isEnrolled(platform: string, senderId: string): boolean {
    return readRecord(platform, senderId) !== null;
}

export function disable(platform: string, senderId: string): boolean {
    return getVault().delete(vaultKey(platform, senderId));
}

export function status(platform: string, senderId: string): TotpStatus {
    const rec = readRecord(platform, senderId);
    if (!rec) return { enrolled: false, enrolledAt: null, lastVerifiedAt: null };
    return { enrolled: true, enrolledAt: rec.enrolledAt, lastVerifiedAt: rec.lastVerifiedAt };
}
