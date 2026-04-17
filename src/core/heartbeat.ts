import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// Heartbeat service — subsystems write a tiny timestamped file whenever they
// prove they're alive (Telegram poller after each successful getUpdates, A2A
// tunnel manager when cloudflared reports a URL, etc). Health checks read
// these to detect stalled subsystems — if the Telegram poller hasn't written
// in >60s, it's probably wedged on a socket or network error and the operator
// should know.
//
// Files: data/<bot>/.heartbeat.<name> — one line of JSON: {at, note?}.
// Atomic write (tmp + rename) so a reader never sees a half-written file.
// =============================================================================

export interface HeartbeatEntry {
    at: number;
    note?: string;
}

export interface HeartbeatStatus {
    present: boolean;
    at?: number;
    age_ms?: number;
    stale: boolean;
    note?: string;
}

export const DEFAULT_STALE_MS = 60_000;

function fileFor(name: string): string {
    // Primitive sanitiser so a malicious name can't escape botDir().
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
    return path.join(botDir(), `.heartbeat.${safe}`);
}

/**
 * Write a heartbeat for the named subsystem. Never throws — a failing
 * heartbeat write must not take down the subsystem itself.
 */
export function writeHeartbeat(name: string, note?: string): void {
    try {
        ensureDir(botDir());
        const file = fileFor(name);
        const entry: HeartbeatEntry = { at: Date.now(), ...(note !== undefined ? { note } : {}) };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 });
        fs.renameSync(tmp, file);
    } catch {
        // Silent — this is a liveness marker, not a logged event.
    }
}

/**
 * Read a heartbeat. Returns present=false if no file; if present, includes
 * age_ms and stale (default threshold 60s) so callers can branch without
 * recomputing.
 */
export function readHeartbeat(name: string, staleMs: number = DEFAULT_STALE_MS): HeartbeatStatus {
    const file = fileFor(name);
    if (!fs.existsSync(file)) return { present: false, stale: false };
    let raw: string;
    try { raw = fs.readFileSync(file, "utf-8"); } catch { return { present: false, stale: false }; }
    let parsed: Partial<HeartbeatEntry>;
    try { parsed = JSON.parse(raw) as Partial<HeartbeatEntry>; } catch { return { present: false, stale: false }; }
    if (typeof parsed.at !== "number") return { present: false, stale: false };
    const ageMs = Date.now() - parsed.at;
    const out: HeartbeatStatus = { present: true, at: parsed.at, age_ms: ageMs, stale: ageMs > staleMs };
    if (typeof parsed.note === "string") out.note = parsed.note;
    return out;
}

/**
 * List all heartbeats present under botDir. Useful for health aggregator to
 * discover dynamically-registered subsystems without a hardcoded list.
 */
export function listHeartbeats(): string[] {
    const dir = botDir();
    if (!fs.existsSync(dir)) return [];
    try {
        return fs.readdirSync(dir)
            .filter((f) => f.startsWith(".heartbeat.") && !f.endsWith(".tmp"))
            .map((f) => f.slice(".heartbeat.".length));
    } catch { return []; }
}

/** Test helper. */
export function clearHeartbeatsForTests(): void {
    for (const name of listHeartbeats()) {
        try { fs.unlinkSync(fileFor(name)); } catch { /* ignore */ }
    }
}
