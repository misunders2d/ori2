import { getHealth, formatHealth, type HealthReport } from "./health.js";
import { getVault } from "./vault.js";
import { getDispatcher } from "../transport/dispatcher.js";
import { logWarning, logInfo } from "./errorLog.js";

// =============================================================================
// Proactive diagnostics — after boot + periodically, snapshot health and DM
// admins when things aren't healthy. The point is minimal operator overhead:
// the operator shouldn't have to know to ask. If something's wrong, Ori tells
// them.
//
// Schedule:
//   - 10s after bootstrap completes: first check (gives Telegram long-poll
//     time to write its first heartbeat, tunnel time to detect its URL, etc.)
//   - Every PROACTIVE_DIAGNOSTICS_INTERVAL_MIN minutes thereafter (default 30)
//
// Trigger: deliver a DM if status != "healthy". Skip delivery when status
// has already been reported and hasn't changed (avoid spamming the admin
// with the same warning every 30 minutes).
//
// Routing:
//   1. Parse ADMIN_USER_IDS from vault. Entries may be:
//      - "platform:senderId"  (e.g. "telegram:12345") — preferred
//      - "senderId"           — bare; try in order of platform preference
//   2. For each admin, try dispatcher.send() via preferred adapter list:
//      telegram > any-running-adapter > stdout fallback.
//   3. Log info to the error ledger whether we delivered or not (so a later
//      `read_error_ledger` tool call surfaces the alert even if Telegram was
//      down at the time).
//
// Opt-out: vault PROACTIVE_DIAGNOSTICS=false disables entirely.
// =============================================================================

const DEFAULT_INTERVAL_MIN = 30;
const INITIAL_DELAY_MS = 10_000;
const PLATFORM_PREFERENCE = ["telegram", "a2a"];

let timer: NodeJS.Timeout | null = null;
let lastStatus: HealthReport["status"] | null = null;
let lastWarningsFingerprint = "";

interface AdminTarget {
    platform: string;
    senderId: string;
}

/** Parse ADMIN_USER_IDS from vault into [{platform, senderId}, ...]. */
export function parseAdmins(raw: string | undefined): AdminTarget[] {
    if (!raw) return [];
    const out: AdminTarget[] = [];
    for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const idx = entry.indexOf(":");
        if (idx > 0) {
            const platform = entry.slice(0, idx).trim();
            const senderId = entry.slice(idx + 1).trim();
            if (platform && senderId) out.push({ platform, senderId });
            // `platform:` (empty senderId) or `platform:   ` — skip silently.
        } else if (idx < 0) {
            // Bare senderId — assume preferred adapters in order.
            for (const p of PLATFORM_PREFERENCE) out.push({ platform: p, senderId: entry });
        }
        // idx === 0 → entry starts with ":" → malformed, drop.
    }
    return out;
}

/**
 * Compose a compact DM body from a HealthReport. Keep it short enough to fit
 * in one Telegram message (<4000 chars) and actionable — surface warnings +
 * top-3 recent errors.
 */
export function composeAlert(r: HealthReport): string {
    const icon = r.status === "healthy" ? "✅" : r.status === "degraded" ? "⚠️" : "🚨";
    const lines = [
        `${icon} ori2 [${r.bot_name}] status: ${r.status.toUpperCase()} (uptime ${r.uptime_s}s)`,
    ];
    if (r.warnings.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        for (const w of r.warnings.slice(0, 10)) lines.push(`  • ${w}`);
        if (r.warnings.length > 10) lines.push(`  (+${r.warnings.length - 10} more — run /health for full report)`);
    }
    if (r.errors.recent && r.errors.recent.length > 0) {
        lines.push("");
        lines.push(`Recent ${r.errors.errors > 0 ? "errors" : "events"} (from error ledger):`);
        for (const e of r.errors.recent.slice(0, 3)) {
            const ts = new Date(e.at).toISOString().slice(11, 19);
            lines.push(`  [${ts}] ${e.subsystem}: ${e.message}`);
        }
    }
    lines.push("");
    lines.push("Tools: run `/health` for the full report, or `/health deep` for live probes.");
    return lines.join("\n");
}

/**
 * Attempt to DM every admin via their preferred platform. Returns the list
 * of successfully-delivered targets.
 */
async function deliverAlert(admins: AdminTarget[], body: string): Promise<AdminTarget[]> {
    const delivered: AdminTarget[] = [];
    const dispatcher = getDispatcher();
    const seen = new Set<string>();
    for (const admin of admins) {
        const key = `${admin.platform}:${admin.senderId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const adapter = dispatcher.getAdapter(admin.platform);
        if (!adapter) continue;
        if (adapter.status().state !== "running") continue;
        try {
            await adapter.send(admin.senderId, { text: body });
            delivered.push(admin);
        } catch {
            // Try the next target — don't throw out of the scheduler.
        }
    }
    return delivered;
}

/** True when health warnings have changed since the last check. */
function fingerprintChanged(r: HealthReport): boolean {
    const fp = [r.status, ...r.warnings].join("|");
    const changed = fp !== lastWarningsFingerprint;
    lastWarningsFingerprint = fp;
    return changed;
}

/**
 * Run one check cycle. If status != healthy AND the warning set has changed
 * since last check, DM admins. Always logs the snapshot summary to the
 * error ledger (severity="info") for audit.
 */
async function runCheck(): Promise<void> {
    let report: HealthReport;
    try {
        report = await getHealth({ deep: true });
    } catch (e) {
        logWarning("proactive-diagnostics", `getHealth threw`, { err: e instanceof Error ? e.message : String(e) });
        return;
    }

    const changed = fingerprintChanged(report);
    lastStatus = report.status;

    if (report.status === "healthy") {
        // Only emit a ledger entry on recovery — not every healthy tick.
        if (changed) logInfo("proactive-diagnostics", "status: healthy (recovered from prior issue or first healthy check)");
        return;
    }

    // Degraded or unhealthy → compose DM.
    if (!changed) {
        // Same warnings as last check — don't re-DM. Operator already knows.
        return;
    }

    const body = composeAlert(report);
    const admins = parseAdmins(getVault().get("ADMIN_USER_IDS"));

    if (admins.length === 0) {
        // Nobody to tell → log + stdout.
        logWarning("proactive-diagnostics", `status ${report.status} — no admins in vault ADMIN_USER_IDS to notify`, { warnings: report.warnings });
        console.warn("\n" + body + "\n");
        return;
    }

    const delivered = await deliverAlert(admins, body);
    if (delivered.length > 0) {
        logInfo("proactive-diagnostics", `alerted ${delivered.length} admin(s)`, {
            status: report.status,
            delivered: delivered.map((a) => `${a.platform}:${a.senderId}`),
            warnings_count: report.warnings.length,
        });
    } else {
        // Couldn't reach any admin (no adapter running yet, or all failed).
        // Surface the alert in stdout + ledger so journalctl / the error
        // ledger still carries it.
        logWarning("proactive-diagnostics", `status ${report.status} — no admin DM could be delivered (no running adapter for any configured admin)`, { warnings: report.warnings });
        console.warn("\n" + body + "\n");
    }
}

/**
 * Start periodic health checks. Call once at end of bootstrap. Idempotent.
 * Returns a stop() function for graceful shutdown.
 */
export function startProactiveDiagnostics(): () => void {
    if (timer) return () => stop();
    const vault = getVault();
    const enabledRaw = vault.get("PROACTIVE_DIAGNOSTICS");
    if (enabledRaw === "false" || enabledRaw === "0") {
        console.log("🩺 Proactive diagnostics: DISABLED (vault PROACTIVE_DIAGNOSTICS=false)");
        return () => { /* noop */ };
    }
    const intervalMin = Math.max(1, Number(vault.get("PROACTIVE_DIAGNOSTICS_INTERVAL_MIN") ?? DEFAULT_INTERVAL_MIN));
    console.log(`🩺 Proactive diagnostics: enabled (first check in ${Math.round(INITIAL_DELAY_MS / 1000)}s, then every ${intervalMin}min)`);

    // First check after a small grace period so adapters finish their initial
    // poll cycle and aren't mistakenly flagged stale.
    const initial = setTimeout(() => { void runCheck(); }, INITIAL_DELAY_MS);
    initial.unref?.();

    timer = setInterval(() => { void runCheck(); }, intervalMin * 60_000);
    timer.unref?.();
    return () => stop();
}

function stop(): void {
    if (timer) { clearInterval(timer); timer = null; }
    lastStatus = null;
    lastWarningsFingerprint = "";
}

/** Test helper — run one check cycle synchronously (awaits the promise). */
export async function runCheckOnceForTests(): Promise<void> {
    await runCheck();
}

/** Test helper — reset internal state. */
export function resetForTests(): void {
    stop();
    lastStatus = null;
    lastWarningsFingerprint = "";
}
