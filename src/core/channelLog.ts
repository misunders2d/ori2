import path from "node:path";
import Database from "better-sqlite3";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// Channel logger — SQLite-backed audit trail of every inbound message that
// reached the dispatcher (delivered or blocked).
//
// Why we need this:
//   - "who told the bot to do X?" accountability for multi-user chats
//   - post-incident review of what was attempted vs what was blocked
//   - debugging traffic patterns (rate-limit tuning, abuse triage)
//   - role-revocation impact assessment
//
// What's logged:
//   - ALL inbound from network transports (Telegram, Slack-future, Synapse-future)
//   - delivered AND blocked (blacklist, whitelist-miss, rate-limit, etc.)
//   - text is stored truncated to 4000 chars to keep DB reasonable
//   - attachments stored as count (not contents — that'd balloon the DB)
//
// What's NOT logged:
//   - CLI input (operator owns the process; logging would be redundant)
//   - Secret-handling commands intercepted UPSTREAM at the credentials
//     dispatcher pre-hook. By the time the channel logger sees a message,
//     credential commands have ALREADY been handled and short-circuited.
//     Defense-in-depth: this module ALSO redacts /credentials add/rotate
//     and /init <passcode> patterns just in case routing changes.
//
// Storage:
//   data/<bot>/channel_log.db (mode inherits from data dir)
//   Single SQLite file, WAL journal, lazy init on first write.
// =============================================================================

const MAX_TEXT_LEN = 4000;

export interface LogEntry {
    id: number;
    platform: string;
    channel_id: string;
    thread_id: string | null;
    sender_id: string;
    sender_display_name: string;
    timestamp: number;
    text: string;
    attachment_count: number;
    delivered: boolean;
    block_reason: string | null;
}

export interface LogQuery {
    limit?: number;
    platform?: string;
    senderId?: string;
    sinceMs?: number;
    deliveredOnly?: boolean;
    blockedOnly?: boolean;
}

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS channel_log (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        platform            TEXT NOT NULL,
        channel_id          TEXT NOT NULL,
        thread_id           TEXT,
        sender_id           TEXT NOT NULL,
        sender_display_name TEXT NOT NULL,
        timestamp           INTEGER NOT NULL,
        text                TEXT NOT NULL,
        attachment_count    INTEGER NOT NULL DEFAULT 0,
        delivered           INTEGER NOT NULL,
        block_reason        TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_log_timestamp ON channel_log (timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_log_sender ON channel_log (platform, sender_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_log_channel ON channel_log (platform, channel_id, timestamp DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_log_blocked ON channel_log (delivered, timestamp DESC)`,
];

function dbPath(): string {
    return path.join(botDir(), "channel_log.db");
}

function redactKnownSecretPatterns(text: string): string {
    // Defense-in-depth in case a credential command somehow reaches here
    // (the credentials dispatcher pre-hook should have handled it already).
    let out = text;
    out = out.replace(/(\/credentials\s+(?:add|add-basic|add-header|rotate)\s+\S+(?:\s+\S+){0,2}\s+)\S+/gi, "$1<REDACTED>");
    out = out.replace(/(\/init\s+)\S+/gi, "$1<REDACTED>");
    out = out.replace(/(\/connect-telegram\s+)\S+/gi, "$1<REDACTED>");
    out = out.replace(/(\/oauth\s+(?:register|register-custom|callback)\s+\S+\s+)\S+/gi, "$1<REDACTED>");
    return out;
}

function truncate(s: string): string {
    if (s.length <= MAX_TEXT_LEN) return s;
    return s.slice(0, MAX_TEXT_LEN) + `…(+${s.length - MAX_TEXT_LEN} chars)`;
}

export class ChannelLog {
    private db: Database.Database | null = null;

    private open(): Database.Database {
        if (this.db) return this.db;
        ensureDir(botDir());
        const db = new Database(dbPath());
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        for (const stmt of SCHEMA_STATEMENTS) {
            db.prepare(stmt).run();
        }
        this.db = db;
        return db;
    }

    log(entry: {
        platform: string;
        channelId: string;
        threadId?: string;
        senderId: string;
        senderDisplayName: string;
        timestamp?: number;
        text: string;
        attachmentCount?: number;
        delivered: boolean;
        blockReason?: string;
    }): number {
        const db = this.open();
        const safeText = truncate(redactKnownSecretPatterns(entry.text));
        const result = db.prepare(`
            INSERT INTO channel_log
                (platform, channel_id, thread_id, sender_id, sender_display_name,
                 timestamp, text, attachment_count, delivered, block_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            entry.platform,
            entry.channelId,
            entry.threadId ?? null,
            entry.senderId,
            entry.senderDisplayName,
            entry.timestamp ?? Date.now(),
            safeText,
            entry.attachmentCount ?? 0,
            entry.delivered ? 1 : 0,
            entry.blockReason ?? null,
        );
        return Number(result.lastInsertRowid);
    }

    recent(opts: LogQuery = {}): LogEntry[] {
        const db = this.open();
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (opts.platform) { clauses.push("platform = ?"); params.push(opts.platform); }
        if (opts.senderId) { clauses.push("sender_id = ?"); params.push(opts.senderId); }
        if (opts.sinceMs)  { clauses.push("timestamp >= ?"); params.push(opts.sinceMs); }
        if (opts.deliveredOnly) clauses.push("delivered = 1");
        if (opts.blockedOnly)   clauses.push("delivered = 0");
        const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
        const rows = db.prepare(`
            SELECT id, platform, channel_id, thread_id, sender_id, sender_display_name,
                   timestamp, text, attachment_count, delivered, block_reason
            FROM channel_log
            ${where}
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(...params, limit) as Array<Record<string, unknown>>;
        return rows.map(this.rowToEntry);
    }

    /** Substring search over text. Case-insensitive. */
    search(query: string, opts: { limit?: number; platform?: string } = {}): LogEntry[] {
        if (!query) return [];
        const db = this.open();
        const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
        const clauses = ["text LIKE ?"];
        const params: unknown[] = [`%${query.replace(/[%_]/g, "\\$&")}%`];
        if (opts.platform) { clauses.push("platform = ?"); params.push(opts.platform); }
        const rows = db.prepare(`
            SELECT id, platform, channel_id, thread_id, sender_id, sender_display_name,
                   timestamp, text, attachment_count, delivered, block_reason
            FROM channel_log
            WHERE ${clauses.join(" AND ")} ESCAPE '\\'
            ORDER BY timestamp DESC
            LIMIT ?
        `).all(...params, limit) as Array<Record<string, unknown>>;
        return rows.map(this.rowToEntry);
    }

    count(): number {
        const db = this.open();
        return (db.prepare(`SELECT COUNT(*) AS c FROM channel_log`).get() as { c: number }).c;
    }

    stats(): {
        total: number;
        delivered: number;
        blocked: number;
        oldest_ms: number | null;
        newest_ms: number | null;
        platforms: Array<{ platform: string; count: number }>;
        top_senders: Array<{ platform: string; sender_id: string; count: number }>;
        top_block_reasons: Array<{ reason: string; count: number }>;
        db_size_bytes: number;
    } {
        const db = this.open();
        const total = (db.prepare(`SELECT COUNT(*) AS c FROM channel_log`).get() as { c: number }).c;
        const delivered = (db.prepare(`SELECT COUNT(*) AS c FROM channel_log WHERE delivered = 1`).get() as { c: number }).c;
        const blocked = total - delivered;
        const minMax = db.prepare(`SELECT MIN(timestamp) AS o, MAX(timestamp) AS n FROM channel_log`).get() as { o: number | null; n: number | null };
        const platforms = db.prepare(`
            SELECT platform, COUNT(*) AS count FROM channel_log GROUP BY platform ORDER BY count DESC
        `).all() as Array<{ platform: string; count: number }>;
        const topSenders = db.prepare(`
            SELECT platform, sender_id, COUNT(*) AS count FROM channel_log
            GROUP BY platform, sender_id ORDER BY count DESC LIMIT 10
        `).all() as Array<{ platform: string; sender_id: string; count: number }>;
        const topBlockReasons = db.prepare(`
            SELECT block_reason AS reason, COUNT(*) AS count FROM channel_log
            WHERE delivered = 0 AND block_reason IS NOT NULL AND block_reason != ''
            GROUP BY block_reason ORDER BY count DESC LIMIT 10
        `).all() as Array<{ reason: string; count: number }>;

        let dbSizeBytes = 0;
        try {
            const fs = require("node:fs") as typeof import("node:fs");
            dbSizeBytes = fs.statSync(dbPath()).size;
        } catch { /* missing file */ }

        return {
            total,
            delivered,
            blocked,
            oldest_ms: minMax.o,
            newest_ms: minMax.n,
            platforms,
            top_senders: topSenders,
            top_block_reasons: topBlockReasons,
            db_size_bytes: dbSizeBytes,
        };
    }

    /** Wipe all log entries. Returns count deleted. Use with --confirm at the slash layer. */
    clear(): number {
        const db = this.open();
        const before = this.count();
        db.prepare(`DELETE FROM channel_log`).run();
        return before;
    }

    close(): void {
        if (this.db) { this.db.close(); this.db = null; }
    }

    private rowToEntry(row: Record<string, unknown>): LogEntry {
        return {
            id: row["id"] as number,
            platform: row["platform"] as string,
            channel_id: row["channel_id"] as string,
            thread_id: (row["thread_id"] as string | null) ?? null,
            sender_id: row["sender_id"] as string,
            sender_display_name: row["sender_display_name"] as string,
            timestamp: row["timestamp"] as number,
            text: row["text"] as string,
            attachment_count: row["attachment_count"] as number,
            delivered: (row["delivered"] as number) === 1,
            block_reason: (row["block_reason"] as string | null) ?? null,
        };
    }
}

import { getOrCreate } from "./singletons.js";
export function getChannelLog(): ChannelLog {
    return getOrCreate("channelLog", () => new ChannelLog());
}
