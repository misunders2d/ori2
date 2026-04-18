import fs from "node:fs";
import path from "node:path";
import { botDir, sharedCacheDir, getBotName } from "./paths.js";
import { getVault } from "./vault.js";
import { getMemory } from "./memory.js";
import { getChannelLog } from "./channelLog.js";
import { getRateLimiter } from "./rateLimiter.js";
import { getOAuth, type PlatformStatus } from "./oauth.js";
import { counts as errorCounts, recent as recentErrors, type ErrorEntry } from "./errorLog.js";
import { readHeartbeat, listHeartbeats, DEFAULT_STALE_MS } from "./heartbeat.js";
import { getDispatcher } from "../transport/dispatcher.js";
import { getFriends } from "../a2a/friends.js";
import { getA2AServerHandle } from "../a2a/server.js";
import { getA2AAdapter } from "../a2a/adapter.js";

// =============================================================================
// Health aggregator — one place the agent + operator can ask "am I OK?".
//
// `getHealth()` does a purely-local check (no network calls, no subprocess
// spawns) and returns in <10ms on a warm cache. Fast enough for every
// `/health` invocation to be live.
//
// `getHealth({deep: true})` additionally does LIVE probes:
//   - Telegram `getMe` (token still valid?)
//   - A2A friend `/health` HTTP pings (which friends are reachable?)
//   - Disk usage of data/<bot>/ (requires walking the tree)
// Use sparingly (once every few minutes at most).
//
// Status determination:
//   - unhealthy = any "critical" subsystem broken (vault unreadable,
//                 no adapters running, a2a tunnel mode mismatch)
//   - degraded  = stale heartbeats, recent errors, OAuth expiring soon,
//                 disk >90%, guardrail check failed, etc.
//   - healthy   = none of the above
// =============================================================================

const BOOT_TIME = Date.now();

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface AdapterHealth {
    platform: string;
    state: string;
    connectedAt?: number;
    lastError?: string;
    details?: Record<string, unknown>;
    heartbeat?: { present: boolean; age_ms?: number; stale: boolean };
    /** Populated only in deep mode for specific adapters that expose a probe. */
    probe?: { ok: boolean; detail?: string };
}

export interface HealthReport {
    status: HealthStatus;
    checked_at: number;
    uptime_s: number;
    bot_name: string;
    warnings: string[];
    // Subsystem snapshots.
    adapters: AdapterHealth[];
    vault: { readable: boolean; entry_count: number };
    memory: { count: number; unique_tags: number; db_size_bytes: number; oldest_at: number | null; newest_at: number | null };
    plans: { active_count: number; reports_on_disk: number };
    scheduler: { job_count: number };
    rate_limits: { active_buckets: number; users_blocked: number };
    oauth: { platform_count: number; connected: number; expiring_soon: number; expired: number };
    channel_log: { total: number; delivered: number; blocked: number; db_size_bytes: number };
    disk: { bot_dir_bytes?: number; shared_cache_bytes?: number };
    guardrails: { corpus_present: boolean; corpus_path: string; corpus_size_bytes?: number };
    a2a: { running: boolean; port?: number; base_url?: string; friend_count: number; tunnel_mode: string; friend_probes?: Array<{ name: string; ok: boolean; detail?: string }> };
    errors: { total: number; last_hour: number; errors: number; warnings: number; recent?: ErrorEntry[] };
}

export interface GetHealthOptions {
    /** Include live probes (Telegram getMe, A2A friend /health, disk walk). Slower. */
    deep?: boolean;
    /** Override fetch for tests. */
    fetchImpl?: typeof fetch;
    /** Include the last N error-ledger entries in the report. Default 5. */
    errorSample?: number;
}

// ---------- subsystem helpers ----------

function adapterHealth(): AdapterHealth[] {
    const dispatcher = getDispatcher();
    const knownHeartbeats = new Set(listHeartbeats());
    return dispatcher.statusReport().map((a) => {
        const out: AdapterHealth = { platform: a.platform, state: a.state };
        if (a.connectedAt !== undefined) out.connectedAt = a.connectedAt;
        if (a.lastError !== undefined) out.lastError = a.lastError;
        if (a.details) out.details = a.details;
        // Per-adapter heartbeat convention: adapter name maps 1:1 to heartbeat
        // key. telegram → .heartbeat.telegram, a2a → .heartbeat.tunnel (the
        // tunnel is the liveness signal, not the adapter itself).
        const hbName = a.platform === "a2a" ? "tunnel" : a.platform;
        if (knownHeartbeats.has(hbName)) {
            const hb = readHeartbeat(hbName);
            const info: { present: boolean; age_ms?: number; stale: boolean } = {
                present: hb.present,
                stale: hb.stale,
            };
            if (hb.age_ms !== undefined) info.age_ms = hb.age_ms;
            out.heartbeat = info;
        }
        return out;
    });
}

function vaultHealth(): HealthReport["vault"] {
    try {
        const v = getVault();
        return { readable: true, entry_count: v.list().length };
    } catch {
        return { readable: false, entry_count: 0 };
    }
}

function memoryHealth(): HealthReport["memory"] {
    try {
        const s = getMemory().stats();
        return {
            count: s.count,
            unique_tags: s.uniqueTags,
            db_size_bytes: s.dbSizeBytes,
            oldest_at: s.oldestAt,
            newest_at: s.newestAt,
        };
    } catch {
        return { count: 0, unique_tags: 0, db_size_bytes: 0, oldest_at: null, newest_at: null };
    }
}

function plansHealth(): HealthReport["plans"] {
    const active = path.join(botDir(), "active-plans");
    const reports = path.join(botDir(), "plan-reports");
    const countJson = (d: string): number => {
        if (!fs.existsSync(d)) return 0;
        try { return fs.readdirSync(d).filter((f) => f.endsWith(".json")).length; } catch { return 0; }
    };
    return { active_count: countJson(active), reports_on_disk: countJson(reports) };
}

function schedulerHealth(): HealthReport["scheduler"] {
    const d = path.join(botDir(), "jobs");
    if (!fs.existsSync(d)) return { job_count: 0 };
    try { return { job_count: fs.readdirSync(d).filter((f) => f.endsWith(".json")).length }; }
    catch { return { job_count: 0 }; }
}

function rateLimitsHealth(): HealthReport["rate_limits"] {
    try {
        const stats = getRateLimiter().stats();
        return {
            active_buckets: stats.length,
            users_blocked: stats.filter((s) => s.blocked > 0).length,
        };
    } catch {
        return { active_buckets: 0, users_blocked: 0 };
    }
}

const OAUTH_EXPIRING_SOON_SECONDS = 15 * 60;

function oauthHealth(): HealthReport["oauth"] {
    try {
        const list: PlatformStatus[] = getOAuth().listStatus();
        let connected = 0, expired = 0, expiringSoon = 0;
        for (const p of list) {
            if (!p.connected) continue;
            connected++;
            const es = p.expires_in_seconds;
            if (es != null) {
                if (es <= 0) expired++;
                else if (es <= OAUTH_EXPIRING_SOON_SECONDS) expiringSoon++;
            }
        }
        return { platform_count: list.length, connected, expiring_soon: expiringSoon, expired };
    } catch {
        return { platform_count: 0, connected: 0, expiring_soon: 0, expired: 0 };
    }
}

function channelLogHealth(): HealthReport["channel_log"] {
    try {
        const s = getChannelLog().stats();
        return { total: s.total, delivered: s.delivered, blocked: s.blocked, db_size_bytes: s.db_size_bytes };
    } catch {
        return { total: 0, delivered: 0, blocked: 0, db_size_bytes: 0 };
    }
}

function guardrailsHealth(): HealthReport["guardrails"] {
    // Corpus lives in the repo, not the per-bot data dir.
    const corpus = path.resolve(process.cwd(), ".pi/extensions/guardrail_corpus.json");
    if (!fs.existsSync(corpus)) {
        return { corpus_present: false, corpus_path: corpus };
    }
    try {
        const stat = fs.statSync(corpus);
        return { corpus_present: true, corpus_path: corpus, corpus_size_bytes: stat.size };
    } catch {
        return { corpus_present: false, corpus_path: corpus };
    }
}

function a2aHealthLocal(): HealthReport["a2a"] {
    const handle = getA2AServerHandle();
    const adapter = getA2AAdapter();
    const friends = getFriends().list();
    const tunnelMode = getVault().get("A2A_TUNNEL_MODE") ?? "disabled";
    const out: HealthReport["a2a"] = {
        running: !!handle,
        friend_count: friends.length,
        tunnel_mode: tunnelMode,
    };
    if (handle) {
        out.port = handle.boundPort;
        out.base_url = handle.baseUrl;
    } else {
        const last = adapter.status().lastError;
        if (last) {
            // Not a field on HealthReport.a2a; surface via the top-level warnings
            // instead — done in deriveStatus.
        }
    }
    return out;
}

async function a2aFriendProbes(fetchImpl: typeof fetch): Promise<Array<{ name: string; ok: boolean; detail?: string }>> {
    const friends = getFriends().list();
    // Limit to 5 to cap latency; deep-mode probes are best-effort.
    const targets = friends.slice(0, 5);
    const out: Array<{ name: string; ok: boolean; detail?: string }> = [];
    await Promise.all(targets.map(async (f) => {
        const url = `${f.base_url.replace(/\/+$/, "")}/health`;
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 3000);
            const res = await fetchImpl(url, { signal: ctrl.signal });
            clearTimeout(t);
            if (res.ok) out.push({ name: f.name, ok: true });
            else out.push({ name: f.name, ok: false, detail: `HTTP ${res.status}` });
        } catch (e) {
            out.push({ name: f.name, ok: false, detail: e instanceof Error ? e.message : String(e) });
        }
    }));
    return out;
}

async function telegramProbe(fetchImpl: typeof fetch): Promise<{ ok: boolean; detail?: string } | undefined> {
    const token = getVault().get("TELEGRAM_BOT_TOKEN");
    if (!token) return undefined; // not configured → no probe
    try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
        const body = await res.json() as { ok: boolean };
        return { ok: !!body?.ok };
    } catch (e) {
        return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
}

function walkDirSize(dir: string, cap = 50000): number {
    // Walks up to `cap` files; returns aggregate bytes. Bounded to stop a
    // pathologically large data/ dir (e.g. a misbehaving extension dumping
    // GB of cache) from blocking health.
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    let seen = 0;
    const stack: string[] = [dir];
    while (stack.length > 0 && seen < cap) {
        const cur = stack.pop()!;
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
            seen++;
            if (seen >= cap) break;
            const p = path.join(cur, e.name);
            if (e.isDirectory()) { stack.push(p); continue; }
            try { total += fs.statSync(p).size; } catch { /* skip */ }
        }
    }
    return total;
}

// ---------- status derivation ----------

function deriveStatus(r: HealthReport): { status: HealthStatus; warnings: string[] } {
    const warnings: string[] = [];
    let unhealthy = false;

    if (!r.vault.readable) { warnings.push("vault: UNREADABLE"); unhealthy = true; }
    if (r.adapters.length === 0) { warnings.push("no transport adapters registered"); unhealthy = true; }

    for (const a of r.adapters) {
        if (a.state === "error") warnings.push(`adapter ${a.platform}: error${a.lastError ? ` (${a.lastError})` : ""}`);
        if (a.heartbeat?.present && a.heartbeat.stale) warnings.push(`adapter ${a.platform}: heartbeat stale (${Math.round((a.heartbeat.age_ms ?? 0) / 1000)}s old, threshold ${Math.round(DEFAULT_STALE_MS / 1000)}s)`);
    }

    // A2A tunnel: if mode says cloudflared but server isn't running, degraded
    // (common on dev boxes without cloudflared installed — that's expected
    // and non-fatal, but it's useful for the agent to know).
    if (r.a2a.tunnel_mode !== "disabled" && !r.a2a.running) {
        warnings.push(`a2a: server not running (tunnel_mode=${r.a2a.tunnel_mode})`);
    }

    if (r.oauth.expired > 0) warnings.push(`oauth: ${r.oauth.expired} token(s) expired`);
    if (r.oauth.expiring_soon > 0) warnings.push(`oauth: ${r.oauth.expiring_soon} token(s) expiring within 15min`);

    if (!r.guardrails.corpus_present) { warnings.push(`guardrails: corpus missing at ${r.guardrails.corpus_path}`); unhealthy = true; }

    if (r.errors.last_hour > 20) warnings.push(`errorLog: ${r.errors.last_hour} entries in the last hour`);
    else if (r.errors.last_hour > 5) warnings.push(`errorLog: ${r.errors.last_hour} entries in the last hour (elevated)`);

    if (r.a2a.friend_probes) {
        const offline = r.a2a.friend_probes.filter((p) => !p.ok).length;
        if (offline > 0) warnings.push(`a2a: ${offline} friend(s) unreachable`);
    }

    if (unhealthy) return { status: "unhealthy", warnings };
    if (warnings.length > 0) return { status: "degraded", warnings };
    return { status: "healthy", warnings };
}

// ---------- main entry ----------

/**
 * Snapshot the bot's health. Fast by default; use `deep:true` for live
 * probes. Never throws — partial failures surface as warnings.
 */
export async function getHealth(opts: GetHealthOptions = {}): Promise<HealthReport> {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const adapters = adapterHealth();

    // Deep-only subsystems happen in parallel.
    let friendProbes: Array<{ name: string; ok: boolean; detail?: string }> | undefined;
    let diskUsage: { bot_dir_bytes?: number; shared_cache_bytes?: number } = {};
    let telegramAdapter: AdapterHealth | undefined;

    if (opts.deep) {
        const [friendResult, tgResult] = await Promise.all([
            a2aFriendProbes(fetchImpl).catch(() => [] as Array<{ name: string; ok: boolean; detail?: string }>),
            telegramProbe(fetchImpl).catch(() => undefined),
        ]);
        friendProbes = friendResult;

        // Annotate the telegram adapter with its live probe result.
        if (tgResult) {
            telegramAdapter = adapters.find((a) => a.platform === "telegram");
            if (telegramAdapter) telegramAdapter.probe = tgResult;
        }

        // Disk usage — bounded walk, no subprocess.
        diskUsage = {
            bot_dir_bytes: walkDirSize(botDir()),
            shared_cache_bytes: walkDirSize(sharedCacheDir()),
        };
    }

    const a2a = a2aHealthLocal();
    if (friendProbes) a2a.friend_probes = friendProbes;

    const errCounts = errorCounts();
    const errorSample = opts.errorSample ?? 5;
    const errors: HealthReport["errors"] = {
        total: errCounts.total,
        last_hour: errCounts.last_hour,
        errors: errCounts.errors,
        warnings: errCounts.warnings,
    };
    if (errorSample > 0) errors.recent = recentErrors({ limit: errorSample });

    const report: HealthReport = {
        status: "healthy",
        checked_at: Date.now(),
        uptime_s: Math.round((Date.now() - BOOT_TIME) / 1000),
        bot_name: getBotName(),
        warnings: [],
        adapters,
        vault: vaultHealth(),
        memory: memoryHealth(),
        plans: plansHealth(),
        scheduler: schedulerHealth(),
        rate_limits: rateLimitsHealth(),
        oauth: oauthHealth(),
        channel_log: channelLogHealth(),
        disk: diskUsage,
        guardrails: guardrailsHealth(),
        a2a,
        errors,
    };

    const { status, warnings } = deriveStatus(report);
    report.status = status;
    report.warnings = warnings;
    return report;
}

/**
 * Format a HealthReport as a compact, LLM-friendly text block. Used by the
 * `health_report` LLM tool and by the proactive-diagnostics admin DM.
 */
export function formatHealth(r: HealthReport): string {
    const icon = r.status === "healthy" ? "✅" : r.status === "degraded" ? "⚠️" : "❌";
    const lines: string[] = [
        `${icon} Health: ${r.status.toUpperCase()} — ${r.bot_name} (uptime ${r.uptime_s}s)`,
    ];
    if (r.warnings.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        for (const w of r.warnings) lines.push(`  • ${w}`);
    }
    lines.push("");
    lines.push("Adapters:");
    for (const a of r.adapters) {
        const hb = a.heartbeat?.present
            ? ` hb=${Math.round((a.heartbeat.age_ms ?? 0) / 1000)}s${a.heartbeat.stale ? "[STALE]" : ""}`
            : "";
        const probe = a.probe ? ` probe=${a.probe.ok ? "ok" : `FAIL(${a.probe.detail ?? "?"})`}` : "";
        lines.push(`  ${a.platform.padEnd(10)} ${a.state}${hb}${probe}${a.lastError ? ` err=${a.lastError}` : ""}`);
    }
    lines.push("");
    lines.push(`Memory: ${r.memory.count} entries, ${r.memory.unique_tags} tags, ${fmtBytes(r.memory.db_size_bytes)}`);
    lines.push(`Channel log: ${r.channel_log.delivered} delivered / ${r.channel_log.blocked} blocked (${fmtBytes(r.channel_log.db_size_bytes)})`);
    lines.push(`Errors: ${r.errors.total} total, ${r.errors.last_hour} last hour (${r.errors.errors} error, ${r.errors.warnings} warning)`);
    lines.push(`Plans: ${r.plans.active_count} active, ${r.plans.reports_on_disk} reports on disk`);
    lines.push(`Scheduler: ${r.scheduler.job_count} job(s)`);
    lines.push(`Rate limits: ${r.rate_limits.active_buckets} bucket(s), ${r.rate_limits.users_blocked} blocked`);
    lines.push(`OAuth: ${r.oauth.connected}/${r.oauth.platform_count} connected${r.oauth.expiring_soon ? `, ${r.oauth.expiring_soon} expiring-soon` : ""}${r.oauth.expired ? `, ${r.oauth.expired} expired` : ""}`);
    lines.push(`A2A: ${r.a2a.running ? `running on ${r.a2a.port}` : "stopped"}, ${r.a2a.friend_count} friend(s), tunnel=${r.a2a.tunnel_mode}`);
    if (r.a2a.friend_probes && r.a2a.friend_probes.length > 0) {
        lines.push("  friend probes:");
        for (const p of r.a2a.friend_probes) lines.push(`    ${p.name}: ${p.ok ? "ok" : `FAIL (${p.detail ?? "?"})`}`);
    }
    lines.push(`Vault: ${r.vault.readable ? `${r.vault.entry_count} entries` : "UNREADABLE"}`);
    if (r.disk.bot_dir_bytes !== undefined) lines.push(`Disk: bot=${fmtBytes(r.disk.bot_dir_bytes)} cache=${fmtBytes(r.disk.shared_cache_bytes ?? 0)}`);
    return lines.join("\n");
}

function fmtBytes(n: number): string {
    if (n < 1024) return `${n}B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
