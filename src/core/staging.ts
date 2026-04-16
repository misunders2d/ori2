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
        db.exec(`
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
                consumed_by       TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_actions (expires_at);
            CREATE INDEX IF NOT EXISTS idx_pending_active  ON pending_actions (consumed_at, expires_at);
        `);
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
    }): PendingAction {
        const db = this.open();
        const now = Date.now();
        const ttlMs = (opts.ttlMinutes ?? 15) * 60 * 1000;

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
            };
            db.prepare(`
                INSERT INTO pending_actions
                    (token, tool_name, args_json, user_platform, user_sender_id, user_display_name, requested_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                record.token,
                record.toolName,
                record.argsJson,
                record.userPlatform,
                record.userSenderId,
                record.userDisplayName,
                record.requestedAt,
                record.expiresAt,
            );
            return record;
        }
        throw new Error("[staging] failed to generate unique token after 5 attempts");
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
                   requested_at, expires_at, consumed_at, consumed_by
            FROM pending_actions
            WHERE token = ?
        `).get(token) as Record<string, unknown> | undefined;

        if (!row) return null;
        const action: PendingAction = {
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
        };

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
                   requested_at, expires_at, consumed_at, consumed_by
            FROM pending_actions
            WHERE consumed_at IS NULL AND expires_at > ?
            ORDER BY requested_at DESC
        `).all(Date.now()) as Array<Record<string, unknown>>;
        return rows.map((r) => ({
            token: r["token"] as string,
            toolName: r["tool_name"] as string,
            argsJson: r["args_json"] as string,
            userPlatform: r["user_platform"] as string,
            userSenderId: r["user_sender_id"] as string,
            userDisplayName: (r["user_display_name"] as string | null) ?? null,
            requestedAt: r["requested_at"] as number,
            expiresAt: r["expires_at"] as number,
            consumedAt: (r["consumed_at"] as number | null) ?? null,
            consumedBy: (r["consumed_by"] as string | null) ?? null,
        }));
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

let _instance: Staging | null = null;

export function getStaging(): Staging {
    if (!_instance) _instance = new Staging();
    return _instance;
}

/** Pattern matching "Approve ACT-WXYZAB" or "approve act-wxyzab" etc. */
const APPROVE_REGEX = /^\s*approve\s+(ACT-[A-Z0-9]{6})\s*$/i;

/** Extracts the canonical token from a user message if it matches approve syntax, else null. */
export function parseApproval(text: string): string | null {
    const m = text.match(APPROVE_REGEX);
    if (!m) return null;
    return m[1]!.toUpperCase();
}
