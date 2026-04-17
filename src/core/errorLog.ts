import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// Error ledger — append-only JSONL at data/<bot>/errors.jsonl.
//
// Complements channel_log.db (which audits inbound chat traffic). The error
// ledger captures INTERNAL system events: Telegram poll 401, cloudflared
// crash, guardrail init failure, vault corruption, scheduler fire exception,
// etc. The LLM-callable `read_error_ledger` tool surfaces these so Ori can
// self-diagnose ("am I OK?") without the operator having to SSH in.
//
// Format per line:
//   {"at": <epoch_ms>, "subsystem": "telegram", "severity": "error",
//    "message": "...", "details"?: {...}}
//
// Rotation: when the file exceeds 5MB we rename to errors.jsonl.1 (single
// backup, old one discarded). Simple, predictable, no log4j-style surprises.
// =============================================================================

export type ErrorSeverity = "error" | "warning" | "info";

export interface ErrorEntry {
    at: number;
    subsystem: string;
    severity: ErrorSeverity;
    message: string;
    details?: Record<string, unknown>;
}

const FILE_NAME = "errors.jsonl";
const ROTATED_NAME = "errors.jsonl.1";
const MAX_BYTES_BEFORE_ROTATE = 5 * 1024 * 1024;

function filePath(): string {
    return path.join(botDir(), FILE_NAME);
}

function rotatedPath(): string {
    return path.join(botDir(), ROTATED_NAME);
}

function maybeRotate(file: string): void {
    try {
        const stat = fs.statSync(file);
        if (stat.size >= MAX_BYTES_BEFORE_ROTATE) {
            const rot = rotatedPath();
            try { fs.unlinkSync(rot); } catch { /* no prior rotation */ }
            fs.renameSync(file, rot);
        }
    } catch {
        // File doesn't exist yet — nothing to rotate.
    }
}

/**
 * Append an error entry to the ledger. Fire-and-forget — never throws.
 * Also mirrors the message to console.error so stdout still shows it
 * (deploy logs + journalctl stay informative).
 */
export function logError(subsystem: string, message: string, details?: Record<string, unknown>): void {
    writeLedger("error", subsystem, message, details);
    console.error(`[${subsystem}] ${message}`, details ?? "");
}

/**
 * Record a warning (non-fatal but worth surfacing — e.g., rate-limit config
 * fell back to default, OAuth token expiring soon, friend unreachable).
 * Mirrors to console.warn.
 */
export function logWarning(subsystem: string, message: string, details?: Record<string, unknown>): void {
    writeLedger("warning", subsystem, message, details);
    console.warn(`[${subsystem}] ${message}`, details ?? "");
}

/**
 * Record an informational event (successful recovery, first-time init, etc).
 * Does NOT mirror to stdout — this is purely for the ledger.
 */
export function logInfo(subsystem: string, message: string, details?: Record<string, unknown>): void {
    writeLedger("info", subsystem, message, details);
}

function writeLedger(severity: ErrorSeverity, subsystem: string, message: string, details?: Record<string, unknown>): void {
    try {
        const dir = botDir();
        ensureDir(dir);
        const file = filePath();
        maybeRotate(file);
        const entry: ErrorEntry = {
            at: Date.now(),
            subsystem,
            severity,
            message,
            ...(details !== undefined ? { details } : {}),
        };
        fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
    } catch (e) {
        // Don't let a logging failure cascade. We already printed the
        // original message via console.error; this is belt-and-suspenders.
        console.error(`[errorLog] failed to write ledger entry: ${e instanceof Error ? e.message : String(e)}`);
    }
}

export interface RecentOptions {
    limit?: number;
    subsystem?: string;
    severity?: ErrorSeverity;
    sinceMinutes?: number;
    /** Include the rotated .1 file in the scan when the current file has fewer entries. */
    includeRotated?: boolean;
}

/**
 * Read recent ledger entries, newest first. Filters by subsystem/severity/age.
 * Returns at most `limit` entries (default 50). Robust to malformed lines
 * (skips them silently — one corrupt line shouldn't poison the whole query).
 */
export function recent(opts: RecentOptions = {}): ErrorEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const sinceMs = opts.sinceMinutes != null ? Date.now() - opts.sinceMinutes * 60_000 : 0;
    const subsystem = opts.subsystem;
    const severity = opts.severity;

    const files: string[] = [filePath()];
    if (opts.includeRotated) files.push(rotatedPath());

    const all: ErrorEntry[] = [];
    for (const f of files) {
        if (!fs.existsSync(f)) continue;
        let raw: string;
        try { raw = fs.readFileSync(f, "utf-8"); } catch { continue; }
        for (const line of raw.split("\n")) {
            if (!line.trim()) continue;
            let parsed: unknown;
            try { parsed = JSON.parse(line); } catch { continue; }
            if (!parsed || typeof parsed !== "object") continue;
            const e = parsed as Partial<ErrorEntry>;
            if (typeof e.at !== "number" || typeof e.subsystem !== "string" ||
                typeof e.message !== "string" ||
                (e.severity !== "error" && e.severity !== "warning" && e.severity !== "info")) continue;
            if (sinceMs > 0 && e.at < sinceMs) continue;
            if (subsystem && e.subsystem !== subsystem) continue;
            if (severity && e.severity !== severity) continue;
            all.push(e as ErrorEntry);
        }
    }
    // Newest-first.
    all.sort((a, b) => b.at - a.at);
    return all.slice(0, limit);
}

export interface Counts {
    total: number;
    errors: number;
    warnings: number;
    info: number;
    /** Count within the last 60 minutes. */
    last_hour: number;
    /** Newest entry's timestamp (ms), or undefined if empty. */
    newest_at?: number;
}

/** Aggregate counts for health status — cheap, used by getHealth(). */
export function counts(): Counts {
    let total = 0, errors = 0, warnings = 0, info = 0, lastHour = 0;
    let newestAt: number | undefined;
    const since = Date.now() - 60 * 60_000;
    const f = filePath();
    if (!fs.existsSync(f)) return { total, errors, warnings, info, last_hour: lastHour };
    let raw: string;
    try { raw = fs.readFileSync(f, "utf-8"); } catch { return { total, errors, warnings, info, last_hour: lastHour }; }
    for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let e: Partial<ErrorEntry>;
        try { e = JSON.parse(line) as Partial<ErrorEntry>; } catch { continue; }
        if (typeof e.at !== "number") continue;
        total++;
        if (e.severity === "error") errors++;
        else if (e.severity === "warning") warnings++;
        else if (e.severity === "info") info++;
        if (e.at >= since) lastHour++;
        if (newestAt === undefined || e.at > newestAt) newestAt = e.at;
    }
    const out: Counts = { total, errors, warnings, info, last_hour: lastHour };
    if (newestAt !== undefined) out.newest_at = newestAt;
    return out;
}

/** Test helper — wipe the ledger. */
export function clearForTests(): void {
    for (const p of [filePath(), rotatedPath()]) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
}
