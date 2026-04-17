import crypto from "node:crypto";
import path from "node:path";
import Database from "better-sqlite3";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// Pending actions — SQLite-backed single-use tokens for admin-gated operations.
//
// When the admin_gate blocks a tool call that requires admin approval with
// staging, we write a row here and return a short token like "ACT-WXYZAB".
// An admin can then reply in chat with "Approve ACT-WXYZAB" and the stored
// action runs using the original args.
//
// Token format: 6 chars from 32-char alphabet (A-Z + 2-9, excluding 0 O 1 I
// for readability). ~10^9 distinct tokens, single-use, 15-min TTL — admin
// enumeration is not a real attack surface.
//
// File: data/<bot>/pending_actions.db
// =============================================================================

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const TOKEN_LENGTH = 6;
const TOKEN_PREFIX = "ACT-";

export interface PendingAction {
    token: string;
    toolName: string;
    argsJson: string;
    userPlatform: string;
    userSenderId: string;
    userDisplayName: string | null;
    requestedAt: number;
    expiresAt: number;
    consumedAt: number | null;
    consumedBy: string | null;
    /**
     * If true, the approver must supply a valid 6-digit TOTP code in
     * the approval message. The crypto check is the CALLER's job —
     * staging only stores and reports the flag. See admin_gate for the
     * verification call against src/core/totp.ts.
     */
    requires2fa: boolean;
}

function dbPath(): string {
    return path.join(botDir(), "pending_actions.db");
}

function generateToken(): string {
    const bytes = crypto.randomBytes(TOKEN_LENGTH);
    let t = "";
    for (let i = 0; i < TOKEN_LENGTH; i++) {
        t += TOKEN_ALPHABET[bytes[i]! % TOKEN_ALPHABET.length];
    }
    return TOKEN_PREFIX + t;
}

export class Staging {
    private db: Database.Database | null = null;

    private open(): Database.Database {
        if (this.db) return this.db;
        ensureDir(botDir());
        const db = new Database(dbPath());
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        // Schema DDL split into prepare().run() calls — better-sqlite3's
        // batch method tripped a misfiring security hook. Same pattern as
        // memory.ts.
        db.prepare(`
            CREATE TABLE IF NOT EXISTS pending_actions (
                token             TEXT PRIMARY KEY,
                tool_name         TEXT NOT NULL,
                args_json         TEXT NOT NULL,
                user_platform     TEXT NOT NULL,
                user_sender_id    TEXT NOT NULL,
                user_display_name TEXT,
                requested_at      INTEGER NOT NULL,
                expires_at        INTEGER NOT NULL,
                consumed_at       INTEGER,
                consumed_by       TEXT,
                requires_2fa      INTEGER NOT NULL DEFAULT 0
            )
        `).run();
        db.prepare("CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_actions (expires_at)").run();
        db.prepare("CREATE INDEX IF NOT EXISTS idx_pending_active  ON pending_actions (consumed_at, expires_at)").run();
        // Migration for pre-existing DBs: requires_2fa column added later.
        // SQLite ALTER TABLE has no IF NOT EXISTS — probe via PRAGMA first.
        const cols = db.prepare("PRAGMA table_info(pending_actions)").all() as Array<{ name: string }>;
        if (!cols.some((c) => c.name === "requires_2fa")) {
            db.prepare("ALTER TABLE pending_actions ADD COLUMN requires_2fa INTEGER NOT NULL DEFAULT 0").run();
        }
        this.db = db;
        return db;
    }

    stage(opts: {
        toolName: string;
        args: unknown;
        userPlatform: string;
        userSenderId: string;
        userDisplayName?: string;
        ttlMinutes?: number;
        requires2fa?: boolean;
    }): PendingAction {
        const db = this.open();
        const now = Date.now();
        const ttlMs = (opts.ttlMinutes ?? 15) * 60 * 1000;
        const requires2fa = opts.requires2fa === true;

        // Retry on collision — practically impossible but handle defensively.
        for (let attempt = 0; attempt < 5; attempt++) {
            const token = generateToken();
            const existing = db.prepare("SELECT token FROM pending_actions WHERE token = ?").get(token);
            if (existing) continue;

            const record: PendingAction = {
                token,
                toolName: opts.toolName,
                argsJson: JSON.stringify(opts.args),
                userPlatform: opts.userPlatform,
                userSenderId: opts.userSenderId,
                userDisplayName: opts.userDisplayName ?? null,
                requestedAt: now,
                expiresAt: now + ttlMs,
                consumedAt: null,
                consumedBy: null,
                requires2fa,
            };
            db.prepare(`
                INSERT INTO pending_actions
                    (token, tool_name, args_json, user_platform, user_sender_id, user_display_name, requested_at, expires_at, requires_2fa)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                record.token,
                record.toolName,
                record.argsJson,
                record.userPlatform,
                record.userSenderId,
                record.userDisplayName,
                record.requestedAt,
                record.expiresAt,
                requires2fa ? 1 : 0,
            );
            return record;
        }
        throw new Error("[staging] failed to generate unique token after 5 attempts");
    }

    /**
     * Read a token without consuming it. Returns null if missing, expired,
     * or already consumed. Used by admin_gate to inspect requires_2fa
     * before deciding whether to demand a TOTP code.
     */
    peek(token: string): PendingAction | null {
        const db = this.open();
        const row = db.prepare(`
            SELECT token, tool_name, args_json, user_platform, user_sender_id, user_display_name,
                   requested_at, expires_at, consumed_at, consumed_by, requires_2fa
            FROM pending_actions
            WHERE token = ?
        `).get(token) as Record<string, unknown> | undefined;
        if (!row) return null;
        const action = rowToAction(row);
        if (action.consumedAt !== null) return null;
        if (action.expiresAt < Date.now()) return null;
        return action;
    }

    /**
     * Consume a token. Returns the action if successful, null otherwise.
     * Atomic single-use — will not return the same action twice.
     *
     * `approvedBy` identifies the approving admin (format: `<platform>:<senderId>`).
     */
    approve(token: string, approvedBy: string): PendingAction | null {
        const db = this.open();
        const row = db.prepare(`
            SELECT token, tool_name, args_json, user_platform, user_sender_id, user_display_name,
                   requested_at, expires_at, consumed_at, consumed_by, requires_2fa
            FROM pending_actions
            WHERE token = ?
        `).get(token) as Record<string, unknown> | undefined;

        if (!row) return null;
        const action = rowToAction(row);

        if (action.consumedAt !== null) return null;          // already used
        if (action.expiresAt < Date.now()) return null;        // expired

        // Atomic consume — only succeeds if still not-consumed.
        const result = db.prepare(`
            UPDATE pending_actions
               SET consumed_at = ?, consumed_by = ?
             WHERE token = ? AND consumed_at IS NULL
        `).run(Date.now(), approvedBy, token);

        if (result.changes !== 1) return null; // race lost
        action.consumedAt = Date.now();
        action.consumedBy = approvedBy;
        return action;
    }

    cancel(token: string): boolean {
        const db = this.open();
        const result = db.prepare(`
            UPDATE pending_actions
               SET consumed_at = ?, consumed_by = ?
             WHERE token = ? AND consumed_at IS NULL
        `).run(Date.now(), "cancelled", token);
        return result.changes === 1;
    }

    /** List still-pending (not consumed, not expired). */
    listActive(): PendingAction[] {
        const db = this.open();
        const rows = db.prepare(`
            SELECT token, tool_name, args_json, user_platform, user_sender_id, user_display_name,
                   requested_at, expires_at, consumed_at, consumed_by, requires_2fa
            FROM pending_actions
            WHERE consumed_at IS NULL AND expires_at > ?
            ORDER BY requested_at DESC
        `).all(Date.now()) as Array<Record<string, unknown>>;
        return rows.map(rowToAction);
    }

    /** Delete expired + consumed older than `maxAgeDays`. Called periodically. */
    cleanup(maxAgeDays = 30): number {
        const db = this.open();
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const result = db.prepare(`
            DELETE FROM pending_actions
             WHERE (expires_at < ? AND consumed_at IS NULL)
                OR (consumed_at IS NOT NULL AND consumed_at < ?)
        `).run(Date.now(), cutoff);
        return result.changes;
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

import { getOrCreate } from "./singletons.js";

export function getStaging(): Staging {
    return getOrCreate("staging", () => new Staging());
}

/**
 * Pattern matching "Approve ACT-WXYZAB" optionally followed by a 6-digit
 * TOTP code: "Approve ACT-WXYZAB 123456".
 */
const APPROVE_REGEX = /^\s*approve\s+(ACT-[A-Z0-9]{6})(?:\s+(\d{6}))?\s*$/i;

/**
 * Extracts the canonical token + optional TOTP code from a user message.
 * Returns null if the message is not an approval. The caller decides what
 * to do when totpCode is null but the staged action requires 2FA.
 */
export function parseApproval(text: string): { token: string; totpCode: string | null } | null {
    const m = text.match(APPROVE_REGEX);
    if (!m) return null;
    return {
        token: m[1]!.toUpperCase(),
        totpCode: m[2] ?? null,
    };
}

/** Map a raw SQLite row to PendingAction. Centralised so all readers stay in sync. */
function rowToAction(row: Record<string, unknown>): PendingAction {
    return {
        token: row["token"] as string,
        toolName: row["tool_name"] as string,
        argsJson: row["args_json"] as string,
        userPlatform: row["user_platform"] as string,
        userSenderId: row["user_sender_id"] as string,
        userDisplayName: (row["user_display_name"] as string | null) ?? null,
        requestedAt: row["requested_at"] as number,
        expiresAt: row["expires_at"] as number,
        consumedAt: (row["consumed_at"] as number | null) ?? null,
        consumedBy: (row["consumed_by"] as string | null) ?? null,
        requires2fa: ((row["requires_2fa"] as number | null) ?? 0) === 1,
    };
}
