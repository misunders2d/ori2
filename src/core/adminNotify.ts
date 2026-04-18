import type { Message } from "../transport/types.js";
import { getDispatcher } from "../transport/dispatcher.js";
import { getVault } from "./vault.js";
import { getWhitelist } from "./whitelist.js";
import { getOrCreate } from "./singletons.js";

// =============================================================================
// adminNotify — DM the bot operator(s) when an unwhitelisted user pings the bot.
//
// Trigger:
//   admin_gate's pre-dispatch hook calls notifyUnknownUser(msg) at the
//   silent-block branch (sender not in whitelist, not in an allowlisted
//   channel). The hook's other branches (blacklisted, /init) are NOT
//   notified — blacklisted is intentionally silent, /init is its own flow.
//
// Cross-platform notify:
//   For each admin we can address — whitelist entries with role "admin"
//   plus vault ADMIN_USER_IDS keyed entries — we DM via the registered
//   adapter for that platform. Telegram DMs use chat_id === user_id (so
//   admin.senderId doubles as channelId). Platforms without that 1:1
//   convention (or with no adapter loaded) fall through to a console.warn
//   line, which is what the CLI operator and journalctl-watching VPS
//   admins actually consume.
//
// Dedupe:
//   In-memory Map keyed on STRANGER's (platform, senderId). 1-hour cooldown
//   between notifications about the same stranger — matches amazon_manager's
//   _last_notified semantics. State resets on process restart by design;
//   if the operator is rebooting, they're paying attention.
//
// Garbage collection:
//   Walked once per call. Drops entries older than 24h. Bounds memory at
//   "strangers seen in the last day," which for any normal bot is trivial.
// =============================================================================

const COOLDOWN_MS = 60 * 60 * 1000;       // 1h between alerts for same stranger
const GC_TTL_MS = 24 * 60 * 60 * 1000;    // drop dedupe entries older than 24h
const MAX_MSG_PREVIEW = 200;              // truncate stranger message in alert

interface ParsedVaultAdmin {
    platform: string;
    senderId: string;
}

export class AdminNotifier {
    private lastNotified: Map<string, number> = new Map();

    /**
     * Notify all reachable admins about an inbound from an unwhitelisted user.
     * Idempotent within the cooldown window. Errors per-admin are swallowed
     * (one unreachable admin must not block the others); a single console.warn
     * line is always emitted so the operator sees the alert in logs.
     */
    async notifyUnknownUser(strangerMsg: Message): Promise<void> {
        const key = `${strangerMsg.platform}:${strangerMsg.senderId}`;
        const now = Date.now();

        this.gc(now);

        const last = this.lastNotified.get(key);
        if (last !== undefined && now - last < COOLDOWN_MS) return;
        this.lastNotified.set(key, now);

        const text = formatNotification(strangerMsg);

        // Always log — operator-on-terminal/journalctl sees it even if no
        // chat-DM-able admin exists.
        console.warn(`[adminNotify] ${text.replace(/\n/g, " ⏎ ")}`);

        const recipients = this.resolveAdminRecipients();
        const dispatcher = getDispatcher();

        for (const r of recipients) {
            const adapter = dispatcher.getAdapter(r.platform);
            if (!adapter) continue; // no adapter loaded for this admin's platform — log was enough
            const channelId = adminChannelIdFor(r.platform, r.senderId);
            if (channelId === null) continue; // platform doesn't have a DM convention we know
            try {
                await dispatcher.send(r.platform, channelId, { text });
            } catch (e) {
                console.warn(
                    `[adminNotify] failed to DM ${r.platform}:${r.senderId} about ${key}: ${e instanceof Error ? e.message : String(e)}`,
                );
            }
        }
    }

    /** Test-only — clears dedupe state. */
    reset(): void {
        this.lastNotified.clear();
    }

    private gc(now: number): void {
        for (const [k, ts] of this.lastNotified.entries()) {
            if (now - ts > GC_TTL_MS) this.lastNotified.delete(k);
        }
    }

    /**
     * Union of (whitelist entries with admin role) + (vault ADMIN_USER_IDS
     * keyed entries). Plain (non-keyed) vault admins are intentionally
     * skipped — they have no concrete platform we can route to. Deduplicated
     * by (platform, senderId).
     */
    private resolveAdminRecipients(): ParsedVaultAdmin[] {
        const out = new Map<string, ParsedVaultAdmin>();

        for (const u of getWhitelist().list()) {
            if (u.roles.includes("admin")) {
                out.set(`${u.platform}:${u.senderId}`, { platform: u.platform, senderId: u.senderId });
            }
        }

        for (const v of parseVaultKeyedAdmins()) {
            out.set(`${v.platform}:${v.senderId}`, v);
        }

        return Array.from(out.values());
    }
}

/**
 * Per-platform DM-channel resolution. Returns the channelId an outbound
 * adapter.send() should target to reach this admin in private, or null
 * when the platform has no general DM convention (CLI — operator owns
 * stdout) or we just don't know yet (Slack, future adapters).
 */
function adminChannelIdFor(platform: string, senderId: string): string | null {
    switch (platform) {
        case "telegram":
            // Telegram: in private chats chat_id === user_id. The admin's
            // senderId IS their DM chatId.
            return senderId;
        case "cli":
            // CLI: no DM concept; the console.warn fallback already reaches
            // the operator's terminal / journalctl.
            return null;
        default:
            return null;
    }
}

function parseVaultKeyedAdmins(): ParsedVaultAdmin[] {
    const raw = getVault().get("ADMIN_USER_IDS") ?? "";
    const out: ParsedVaultAdmin[] = [];
    for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
        const colon = entry.indexOf(":");
        if (colon < 1 || colon === entry.length - 1) continue; // plain senderId — skip
        out.push({
            platform: entry.slice(0, colon),
            senderId: entry.slice(colon + 1),
        });
    }
    return out;
}

function formatNotification(m: Message): string {
    const preview = m.text.length > MAX_MSG_PREVIEW
        ? m.text.slice(0, MAX_MSG_PREVIEW) + "…"
        : m.text;
    const body = preview || "(no text — message contained only attachments)";
    const lines = [
        "🔔 Unknown user wants to reach the bot",
        "",
        `From:    ${m.senderDisplayName} (${m.senderId}) on ${m.platform}`,
        `Channel: ${m.channelId}`,
        `Message: ${body}`,
        "",
        "To allow:",
        `  /whitelist add ${m.platform} ${m.senderId}`,
        "To allow as admin:",
        `  /whitelist add ${m.platform} ${m.senderId} admin`,
        "To block:",
        `  /blacklist add ${m.platform} ${m.senderId} unsolicited`,
    ];
    return lines.join("\n");
}

export function getAdminNotifier(): AdminNotifier {
    return getOrCreate("adminNotifier", () => new AdminNotifier());
}
