import Database from "better-sqlite3";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";
import { getOrCreate, setSingleton } from "./singletons.js";

// =============================================================================
// Generic key-value cache with TTL + namespaces. Backed by a single SQLite
// file at data/<bot>/kv-cache.db.
//
// Why this exists:
//   Several use cases keep reinventing the same thing — per-ASIN Keepa
//   snapshots, per-tool rate-limit counters, transient tool outputs,
//   short-term model-response memos. Without a shared primitive, each
//   extension builds a brittle version using fs + setTimeout.
//
// Scope:
//   - Key-value only (not search; for semantic/text search use `memory.ts`).
//   - JSON-serializable values (enforced at set-time).
//   - TTL in seconds; absent = no expiry.
//   - Namespaces so different extensions don't step on each other's keys.
//   - Lazy expiry: a get() on an expired key returns undefined AND deletes
//     the row opportunistically. Call sweep() periodically if you want
//     eager cleanup (small wins on disk space for high-churn namespaces).
//
// Not-scope:
//   - Multi-process locking. SQLite's built-in WAL handles concurrent
//     readers + one writer. If two ori2 processes share the same data dir
//     (shouldn't happen — instanceLock prevents it), writes would serialize
//     via SQLite's file lock — correct but slow.
//   - Watermarking / change feeds. Use a proper event bus for that.
// =============================================================================

export interface KVCache {
    get<T>(ns: string, key: string): T | undefined;
    set<T>(ns: string, key: string, value: T, ttlSec?: number): void;
    has(ns: string, key: string): boolean;
    delete(ns: string, key: string): boolean;
    keys(ns: string): string[];
    clearNamespace(ns: string): number;
    sweep(): number;
    close(): void;
}

function dbPath(): string {
    return path.join(botDir(), "kv-cache.db");
}

const CREATE_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS kv_cache (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER,
        set_at INTEGER NOT NULL,
        PRIMARY KEY (ns, key)
    ) WITHOUT ROWID
`;
const CREATE_INDEX_SQL = `CREATE INDEX IF NOT EXISTS kv_cache_expires ON kv_cache(expires_at)`;

class SqliteKVCache implements KVCache {
    private _db: Database.Database | null = null;

    private db(): Database.Database {
        if (this._db) return this._db;
        ensureDir(path.dirname(dbPath()));
        const d = new Database(dbPath());
        // WAL: concurrent reads + single writer, survives crashes cleanly.
        d.pragma("journal_mode = WAL");
        d.pragma("synchronous = NORMAL");
        d.prepare(CREATE_TABLE_SQL).run();
        d.prepare(CREATE_INDEX_SQL).run();
        this._db = d;
        return d;
    }

    get<T>(ns: string, key: string): T | undefined {
        const row = this.db()
            .prepare("SELECT value, expires_at FROM kv_cache WHERE ns = ? AND key = ?")
            .get(ns, key) as { value: string; expires_at: number | null } | undefined;
        if (!row) return undefined;
        if (row.expires_at !== null && row.expires_at <= Date.now()) {
            // Expired — lazy-delete and return nothing.
            this.db().prepare("DELETE FROM kv_cache WHERE ns = ? AND key = ?").run(ns, key);
            return undefined;
        }
        try {
            return JSON.parse(row.value) as T;
        } catch {
            // Corrupt row — delete + return undefined rather than throw.
            this.db().prepare("DELETE FROM kv_cache WHERE ns = ? AND key = ?").run(ns, key);
            return undefined;
        }
    }

    set<T>(ns: string, key: string, value: T, ttlSec?: number): void {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            // JSON.stringify returns undefined for functions / symbols / raw undefined.
            throw new Error(`[kvCache] value for ${ns}:${key} is not JSON-serializable`);
        }
        const now = Date.now();
        const expiresAt = typeof ttlSec === "number" && ttlSec > 0 ? now + ttlSec * 1000 : null;
        this.db()
            .prepare(
                `INSERT INTO kv_cache (ns, key, value, expires_at, set_at)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(ns, key) DO UPDATE SET
                   value = excluded.value,
                   expires_at = excluded.expires_at,
                   set_at = excluded.set_at`,
            )
            .run(ns, key, serialized, expiresAt, now);
    }

    has(ns: string, key: string): boolean {
        return this.get(ns, key) !== undefined;
    }

    delete(ns: string, key: string): boolean {
        const info = this.db().prepare("DELETE FROM kv_cache WHERE ns = ? AND key = ?").run(ns, key);
        return info.changes > 0;
    }

    /** Non-expired keys in a namespace. Sorted lexicographically. */
    keys(ns: string): string[] {
        const now = Date.now();
        const rows = this.db()
            .prepare(
                "SELECT key FROM kv_cache WHERE ns = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key",
            )
            .all(ns, now) as { key: string }[];
        return rows.map((r) => r.key);
    }

    clearNamespace(ns: string): number {
        const info = this.db().prepare("DELETE FROM kv_cache WHERE ns = ?").run(ns);
        return info.changes;
    }

    /** Drop every expired row across all namespaces. Returns number deleted. */
    sweep(): number {
        const info = this.db()
            .prepare("DELETE FROM kv_cache WHERE expires_at IS NOT NULL AND expires_at <= ?")
            .run(Date.now());
        return info.changes;
    }

    close(): void {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }

    /** Test-only. */
    static __resetForTests(): void {
        const inst = getOrCreate("kvCache", () => new SqliteKVCache()) as SqliteKVCache;
        inst.close();
        setSingleton("kvCache", null);
    }
}

/** Process-wide singleton. Shared across tsx/jiti graphs via globalThis. */
export function getKVCache(): KVCache {
    return getOrCreate("kvCache", () => new SqliteKVCache());
}

/** Test-only reset. */
export function __resetKVCacheForTests(): void {
    SqliteKVCache.__resetForTests();
}
