import path from "node:path";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { botDir, ensureDir } from "./paths.js";
import { cosineSim, embedQuery, EMBED_DIM } from "./embeddings.js";

// =============================================================================
// Long-term semantic memory — local SQLite + vector search.
//
// Single file at data/<bot>/memory.db. Two tables:
//   - memories: human-readable record (content, tags JSON, metadata JSON, audit)
//   - memory_vectors: sqlite-vec virtual table holding the BGE-small-en-v1.5
//                     embedding of each memory's content (dim 384, float32)
//
// Records and vectors share the same primary key. Save = insert into both.
// Search = vec0 KNN against query embedding, then JOIN back to memories,
// optional filter by tag containment.
//
// Embeddings come from src/core/embeddings.ts (shared with guardrails — one
// FlagEmbedding instance per process). First save triggers fastembed init
// (model download on first install, ~130MB into data/<bot>/.fastembed_cache).
//
// LOCAL-ONLY at baseline. The data is private to this VPS, never shipped to
// any external service. Pinecone or other hosted vector DBs are reserved for
// optional future upgrades — the swappable backend interface lives in this
// module so it can be subbed in cleanly.
//
// SECURITY:
//   - Memory file inherits data/<bot>/ permissions (owned by the bot user).
//   - Tools are role-gated (memory_save / memory_search default to `user` role).
//   - Saved content is searchable verbatim — DO NOT save secrets here. The
//     LLM persona reinforces "use vault/credentials for secrets, memory for
//     facts/preferences/decisions".
// =============================================================================

export interface MemoryRecord {
    id: number;
    content: string;
    tags: string[];
    metadata: Record<string, unknown> | null;
    added_at: number;
    added_by: string | null;
    source: string | null;
}

export interface SearchResult {
    record: MemoryRecord;
    similarity: number;  // 0..1, higher = more similar
}

export interface SaveOptions {
    content: string;
    tags?: string[];
    metadata?: Record<string, unknown>;
    addedBy?: string;
    source?: string;
}

export interface SearchOptions {
    topK?: number;
    filterTags?: string[];   // OR-of, record matches if it has ANY of these tags
    minSimilarity?: number;  // skip results below this threshold
}

export interface MemoryStats {
    count: number;
    uniqueTags: number;
    oldestAt: number | null;
    newestAt: number | null;
    dbSizeBytes: number;
}

function dbPath(): string {
    return path.join(botDir(), "memory.db");
}

function vecToBuffer(v: number[]): Buffer {
    const buf = Buffer.alloc(v.length * 4);
    for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i]!, i * 4);
    return buf;
}

function bufferToVec(buf: Buffer): number[] {
    const out = new Array<number>(buf.length / 4);
    for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
    return out;
}

const SCHEMA_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS memories (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        content   TEXT NOT NULL,
        tags      TEXT NOT NULL DEFAULT '[]',
        metadata  TEXT,
        added_at  INTEGER NOT NULL,
        added_by  TEXT,
        source    TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_memories_added_at ON memories (added_at)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
        memory_id INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBED_DIM}]
    )`,
];

export class Memory {
    private db: Database.Database | null = null;

    private open(): Database.Database {
        if (this.db) return this.db;
        ensureDir(botDir());
        const db = new Database(dbPath());
        // Load sqlite-vec extension (registers vec0 virtual table type).
        sqliteVec.load(db);
        db.pragma("journal_mode = WAL");
        db.pragma("foreign_keys = ON");
        // Schema migration via individual prepared statements (not db.exec —
        // see paths/comment elsewhere about hook false-positives on .exec).
        for (const stmt of SCHEMA_STATEMENTS) {
            db.prepare(stmt).run();
        }
        this.db = db;
        return db;
    }

    private rowToRecord(row: Record<string, unknown>): MemoryRecord {
        let tags: string[] = [];
        try {
            const parsed = JSON.parse((row["tags"] as string) ?? "[]");
            if (Array.isArray(parsed)) tags = parsed.filter((t): t is string => typeof t === "string");
        } catch { /* malformed → empty tags */ }
        let metadata: Record<string, unknown> | null = null;
        const metaRaw = row["metadata"] as string | null | undefined;
        if (metaRaw) {
            try {
                const parsed = JSON.parse(metaRaw);
                if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
            } catch { /* malformed → null */ }
        }
        return {
            id: row["id"] as number,
            content: row["content"] as string,
            tags,
            metadata,
            added_at: row["added_at"] as number,
            added_by: (row["added_by"] as string | null) ?? null,
            source: (row["source"] as string | null) ?? null,
        };
    }

    async save(opts: SaveOptions): Promise<MemoryRecord> {
        if (!opts.content || typeof opts.content !== "string") {
            throw new Error("[memory] save: content is required");
        }
        const db = this.open();
        const tags = (opts.tags ?? []).filter((t) => typeof t === "string" && t.length > 0);
        const metadata = opts.metadata ?? null;
        const addedAt = Date.now();

        const vector = await embedQuery(opts.content);
        if (vector.length !== EMBED_DIM) {
            throw new Error(`[memory] embedder returned dim=${vector.length}, expected ${EMBED_DIM}`);
        }

        const insert = db.prepare(`
            INSERT INTO memories (content, tags, metadata, added_at, added_by, source)
            VALUES (?, ?, ?, ?, ?, ?)
        `);
        const result = insert.run(
            opts.content,
            JSON.stringify(tags),
            metadata ? JSON.stringify(metadata) : null,
            addedAt,
            opts.addedBy ?? null,
            opts.source ?? null,
        );
        const id = Number(result.lastInsertRowid);

        // sqlite-vec's vec0 virtual table refuses non-INTEGER primary keys.
        // better-sqlite3 binds JS Number as REAL even for whole values.
        // Force INTEGER binding by passing BigInt.
        db.prepare(`INSERT INTO memory_vectors (memory_id, embedding) VALUES (?, ?)`).run(BigInt(id), vecToBuffer(vector));

        return {
            id,
            content: opts.content,
            tags,
            metadata,
            added_at: addedAt,
            added_by: opts.addedBy ?? null,
            source: opts.source ?? null,
        };
    }

    async search(query: string, opts: SearchOptions = {}): Promise<SearchResult[]> {
        const db = this.open();
        const topK = Math.max(1, Math.min(opts.topK ?? 5, 50));
        const minSim = opts.minSimilarity ?? 0;

        const total = (db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
        if (total === 0) return [];

        const queryVec = await embedQuery(query);
        const queryBuf = vecToBuffer(queryVec);

        // Oversample for tag-filter and min-sim headroom; rerank in JS using
        // cosine on the actual stored vectors (sqlite-vec defaults to L2).
        const oversample = Math.min(total, topK * 3 + 5);
        type VecRow = { memory_id: number; distance: number };
        const candidateRows = db.prepare(`
            SELECT memory_id, distance
            FROM memory_vectors
            WHERE embedding MATCH ?
            ORDER BY distance
            LIMIT ?
        `).all(queryBuf, oversample) as VecRow[];

        if (candidateRows.length === 0) return [];

        const ids = candidateRows.map((r) => r.memory_id);
        const placeholders = ids.map(() => "?").join(",");
        const records = db.prepare(`
            SELECT id, content, tags, metadata, added_at, added_by, source
            FROM memories
            WHERE id IN (${placeholders})
        `).all(...ids) as Array<Record<string, unknown>>;
        const byId = new Map<number, MemoryRecord>();
        for (const r of records) {
            const rec = this.rowToRecord(r);
            byId.set(rec.id, rec);
        }

        type EmbRow = { memory_id: number; embedding: Buffer };
        const embRows = db.prepare(`
            SELECT memory_id, embedding
            FROM memory_vectors
            WHERE memory_id IN (${placeholders})
        `).all(...ids) as EmbRow[];

        const out: SearchResult[] = [];
        for (const { memory_id, embedding } of embRows) {
            const record = byId.get(memory_id);
            if (!record) continue;
            if (opts.filterTags && opts.filterTags.length > 0) {
                const have = new Set(record.tags);
                let match = false;
                for (const t of opts.filterTags) if (have.has(t)) { match = true; break; }
                if (!match) continue;
            }
            const vec = bufferToVec(embedding);
            const sim = cosineSim(queryVec, vec);
            if (sim < minSim) continue;
            out.push({ record, similarity: sim });
        }
        out.sort((a, b) => b.similarity - a.similarity);
        return out.slice(0, topK);
    }

    getById(id: number): MemoryRecord | null {
        const db = this.open();
        const row = db.prepare(`
            SELECT id, content, tags, metadata, added_at, added_by, source
            FROM memories WHERE id = ?
        `).get(id) as Record<string, unknown> | undefined;
        return row ? this.rowToRecord(row) : null;
    }

    delete(id: number): boolean {
        const db = this.open();
        const txn = db.transaction((memId: number): boolean => {
            db.prepare(`DELETE FROM memory_vectors WHERE memory_id = ?`).run(memId);
            const result = db.prepare(`DELETE FROM memories WHERE id = ?`).run(memId);
            return result.changes > 0;
        });
        return txn(id);
    }

    /** Delete ALL memories. Returns number deleted. Caller must --confirm. */
    clear(): number {
        const db = this.open();
        const before = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c;
        const txn = db.transaction(() => {
            db.prepare(`DELETE FROM memory_vectors`).run();
            db.prepare(`DELETE FROM memories`).run();
        });
        txn();
        return before;
    }

    listRecent(limit = 20): MemoryRecord[] {
        const db = this.open();
        const rows = db.prepare(`
            SELECT id, content, tags, metadata, added_at, added_by, source
            FROM memories
            ORDER BY added_at DESC
            LIMIT ?
        `).all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
        return rows.map((r) => this.rowToRecord(r));
    }

    listTags(): Array<{ tag: string; count: number }> {
        const db = this.open();
        const rows = db.prepare(`SELECT tags FROM memories`).all() as Array<{ tags: string }>;
        const counts = new Map<string, number>();
        for (const r of rows) {
            try {
                const arr = JSON.parse(r.tags) as unknown;
                if (Array.isArray(arr)) {
                    for (const t of arr) {
                        if (typeof t === "string") counts.set(t, (counts.get(t) ?? 0) + 1);
                    }
                }
            } catch { /* skip */ }
        }
        return Array.from(counts.entries())
            .map(([tag, count]) => ({ tag, count }))
            .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
    }

    count(): number {
        const db = this.open();
        return (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c;
    }

    stats(): MemoryStats {
        const db = this.open();
        const c = (db.prepare(`SELECT COUNT(*) AS c FROM memories`).get() as { c: number }).c;
        const minMax = db.prepare(`SELECT MIN(added_at) AS o, MAX(added_at) AS n FROM memories`).get() as { o: number | null; n: number | null };
        let dbSizeBytes = 0;
        try {
            const fs = require("node:fs") as typeof import("node:fs");
            dbSizeBytes = fs.statSync(dbPath()).size;
        } catch { /* file may not exist yet */ }
        const tagCount = this.listTags().length;
        return {
            count: c,
            uniqueTags: tagCount,
            oldestAt: minMax.o,
            newestAt: minMax.n,
            dbSizeBytes,
        };
    }

    close(): void {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

let _instance: Memory | null = null;

export function getMemory(): Memory {
    if (!_instance) _instance = new Memory();
    return _instance;
}
