import type { InvitationTokenPayload } from "./types.js";

// =============================================================================
// Invitation token codec.
//
// Tokens are base64url-encoded JSON. The format is intentionally human-
// inspectable (an operator can `echo <token> | base64 -d` to see what's in
// it before pasting it elsewhere). They carry no authentication value on
// their own — the inviter_key inside is the actual secret.
//
// TTL is enforced at validation time on the accepting side (the server
// rejects expired tokens at /a2a/friend-accept). We default to 1 hour;
// override per-invite by passing a custom expires_at into encode().
// =============================================================================

export const INVITATION_TTL_MS = 60 * 60 * 1000; // 1 hour

export function encodeInvitationToken(payload: InvitationTokenPayload): string {
    const json = JSON.stringify(payload);
    return Buffer.from(json, "utf-8").toString("base64url");
}

export function decodeInvitationToken(token: string): InvitationTokenPayload | null {
    try {
        const json = Buffer.from(token, "base64url").toString("utf-8");
        const parsed = JSON.parse(json) as Partial<InvitationTokenPayload>;
        if (
            typeof parsed?.inviter_name !== "string" ||
            typeof parsed?.inviter_url !== "string" ||
            typeof parsed?.inviter_key !== "string" ||
            typeof parsed?.invite_id !== "string" ||
            typeof parsed?.expires_at !== "number"
        ) {
            return null;
        }
        return parsed as InvitationTokenPayload;
    } catch {
        return null;
    }
}

export function isInvitationExpired(payload: InvitationTokenPayload, now = Date.now()): boolean {
    return payload.expires_at < now;
}
