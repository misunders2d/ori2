import fs from "node:fs";
import path from "node:path";
import { botSubdir, ensureDir } from "./paths.js";

// =============================================================================
// Pending hand-off summaries — side-channel between hand_off_session (tool) and
// session_handoff (extension's before_agent_start hook).
//
// Why a side-channel? Pi SDK's SessionManager holds writes in memory until the
// first assistant message lands (session-manager.js:549-557). That means we
// can't reliably seed a custom-message entry into a FRESH session JSONL — it
// stays in memory and gets lost if the SessionManager instance is discarded
// before the first assistant turn.
//
// Solution: hand_off_session writes the summary to a small JSON file keyed by
// (platform, channelId). On the next inbound for that channel, ChannelRuntime
// lazy-creates the AgentSession, and the session_handoff extension fires in
// before_agent_start — reads the pending file, injects the summary as a
// display=true custom message, and deletes the file. Zero reliance on Pi's
// lazy-flush behavior.
//
// File layout:
//   data/<bot>/handoff-pending/<platform>__<channelId>.json
// =============================================================================

interface PendingHandoff {
    platform: string;
    channelId: string;
    summary: string;
    /** Unix ms */
    createdAt: number;
    /** Prior session file path — purely informational (for logs / recovery). */
    previousSessionFile?: string;
}

function dirPath(): string {
    return botSubdir("handoff-pending");
}

/**
 * (platform, channelId) keying. channelIds can contain any characters; we
 * sanitize to filename-safe form. Using __ as separator so we can invert
 * (never do — we only ever look up by given params) but mostly for clarity.
 */
function fileOf(platform: string, channelId: string): string {
    const safeChannelId = channelId.replace(/[^A-Za-z0-9._-]/g, "_");
    const safePlatform = platform.replace(/[^A-Za-z0-9._-]/g, "_");
    return path.join(dirPath(), `${safePlatform}__${safeChannelId}.json`);
}

/**
 * Atomic write: tmp + rename. Never leaves a partially-written file even if
 * the process dies mid-write.
 */
export function writePendingHandoff(
    platform: string,
    channelId: string,
    summary: string,
    previousSessionFile?: string,
): void {
    ensureDir(dirPath());
    const payload: PendingHandoff = {
        platform,
        channelId,
        summary,
        createdAt: Date.now(),
        ...(previousSessionFile !== undefined ? { previousSessionFile } : {}),
    };
    const file = fileOf(platform, channelId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
    fs.renameSync(tmp, file);
}

/**
 * Read the pending hand-off for a channel. Returns null if none / if the file
 * is corrupt or unparseable (we never let a bad file block the agent).
 */
export function readPendingHandoff(
    platform: string,
    channelId: string,
): PendingHandoff | null {
    const file = fileOf(platform, channelId);
    if (!fs.existsSync(file)) return null;
    try {
        const raw = fs.readFileSync(file, "utf-8");
        const parsed = JSON.parse(raw) as Partial<PendingHandoff>;
        if (typeof parsed.summary !== "string") return null;
        if (typeof parsed.platform !== "string") return null;
        if (typeof parsed.channelId !== "string") return null;
        return {
            platform: parsed.platform,
            channelId: parsed.channelId,
            summary: parsed.summary,
            createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
            ...(typeof parsed.previousSessionFile === "string"
                ? { previousSessionFile: parsed.previousSessionFile }
                : {}),
        };
    } catch {
        // Corrupt file: treat as absent. Extension will log at clear time.
        return null;
    }
}

/**
 * Remove the pending hand-off for a channel after it's been consumed.
 * Idempotent — no-op if the file already gone.
 */
export function clearPendingHandoff(platform: string, channelId: string): void {
    const file = fileOf(platform, channelId);
    if (fs.existsSync(file)) {
        fs.unlinkSync(file);
    }
}
