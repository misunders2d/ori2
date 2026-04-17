import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { botDir, botSubdir, ensureDir } from "./paths.js";
import { getOrCreate, setSingleton } from "./singletons.js";
import { logWarning } from "./errorLog.js";

// =============================================================================
// Channel → session mapping.
//
// Multi-user-chat architecture: every (platform, channelId) pair gets its own
// Pi session file. Group chats, DMs, and channel posts all live in isolated
// session JSONLs so a conversation in one chat never contaminates another.
//
// The mapping is persistent — re-resolves to the same session file across bot
// restarts, so conversation history continues.
//
// Session files are created via Pi's SessionManager.create(cwd, sessionDir).
// We pass sessionDir = data/<bot>/channel-sessions/ explicitly — otherwise
// Pi would default-encode into $PI_CODING_AGENT_DIR/sessions/--<enc cwd>--/,
// which buries channel JSONLs next to the main TUI's sessions and makes
// operator cleanup annoying. Verified at
// node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js
// (`static create(cwd, sessionDir)` at line 970, default in
// `getDefaultSessionDir` at line 212).
//
// File layout:
//   data/<bot>/
//     channel-sessions.json              ← the map (authoritative runtime state)
//     channel-sessions/
//       <session-uuid>.jsonl             ← one per (platform, channelId)
//
// Keying: `${platform}:${channelId}`. Channel IDs can contain ':' on some
// platforms (e.g. A2A peer names are normally safe, Slack channel ids like
// "C0123456" are safe, Telegram chat ids are numeric). We do NOT round-trip
// the key — it's only used as an index into our own JSON file.
// =============================================================================

/** A single channel→session binding. Value in the persisted map. */
interface ChannelBinding {
    platform: string;
    channelId: string;
    sessionFile: string;
    /** Unix ms of first bind, for diagnostics. */
    createdAt: number;
}

interface MapFile {
    version: number;
    updatedAt: number;
    bindings: ChannelBinding[];
}

const FILE_VERSION = 1;

function mapFilePath(): string {
    return path.join(botDir(), "channel-sessions.json");
}

function sessionsDirPath(): string {
    return botSubdir("channel-sessions");
}

function keyOf(platform: string, channelId: string): string {
    return `${platform}:${channelId}`;
}

/**
 * Atomic write: tmp file + rename. Avoids half-written JSON if process dies
 * mid-write. Other file-backed stores in the project (vault, whitelist) use
 * the same pattern.
 */
function atomicWriteJson(file: string, data: unknown): void {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

export class ChannelSessions {
    /** In-memory map by `${platform}:${channelId}` key. Authoritative at runtime. */
    private bindings = new Map<string, ChannelBinding>();
    private loaded = false;

    /** Read the persisted map from disk into memory. Idempotent. */
    private load(): void {
        if (this.loaded) return;
        this.loaded = true;

        const file = mapFilePath();
        if (!fs.existsSync(file)) return;

        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<MapFile>;
            if (!Array.isArray(raw.bindings)) return;
            for (const b of raw.bindings) {
                if (typeof b.platform !== "string") continue;
                if (typeof b.channelId !== "string") continue;
                if (typeof b.sessionFile !== "string") continue;
                const createdAt = typeof b.createdAt === "number" ? b.createdAt : Date.now();
                this.bindings.set(keyOf(b.platform, b.channelId), {
                    platform: b.platform,
                    channelId: b.channelId,
                    sessionFile: b.sessionFile,
                    createdAt,
                });
            }
        } catch (e) {
            // Corrupt map → log and start fresh. The individual session
            // JSONLs are untouched — operator can re-populate from a backup
            // or accept context loss.
            logWarning("channelSessions", "map file corrupt — starting empty", {
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    private persist(): void {
        const out: MapFile = {
            version: FILE_VERSION,
            updatedAt: Date.now(),
            bindings: Array.from(this.bindings.values()),
        };
        atomicWriteJson(mapFilePath(), out);
    }

    /**
     * Look up an existing binding without creating one. Returns undefined if
     * this (platform, channelId) has never had a session.
     */
    get(platform: string, channelId: string): string | undefined {
        this.load();
        return this.bindings.get(keyOf(platform, channelId))?.sessionFile;
    }

    /**
     * Get the session file path for a channel, creating a fresh Pi session
     * on first call. Subsequent calls return the same path — conversation
     * history continues across bot restarts.
     *
     * Side effect: on first call creates an empty session.jsonl under
     * data/<bot>/channel-sessions/ and persists the (platform, channelId →
     * sessionFile) binding to the on-disk map.
     */
    getOrCreateSessionFile(platform: string, channelId: string): string {
        this.load();
        const k = keyOf(platform, channelId);
        const existing = this.bindings.get(k);
        if (existing) return existing.sessionFile;

        const dir = sessionsDirPath();
        ensureDir(dir);

        // SessionManager.create(cwd, sessionDir): cwd is stored in the session
        // header (we use process.cwd() — the project root — so ops like
        // `pi --session <file>` resolve relative paths sensibly); sessionDir
        // controls where the .jsonl physically lives. We do NOT keep the
        // SessionManager instance — callers open their own handle with
        // SessionManager.open(sessionFile) so parent-append and
        // subprocess-append don't share mutable in-memory state.
        const sm = SessionManager.create(process.cwd(), dir);
        const sessionFile = sm.getSessionFile();
        if (!sessionFile) {
            throw new Error(`[channelSessions] SessionManager.create returned no sessionFile (dir=${dir})`);
        }

        this.bindings.set(k, {
            platform,
            channelId,
            sessionFile,
            createdAt: Date.now(),
        });
        this.persist();
        return sessionFile;
    }

    /** All bindings, for diagnostics / admin inspection. */
    all(): ChannelBinding[] {
        this.load();
        return Array.from(this.bindings.values());
    }

    /**
     * Drop a binding from the map. Does NOT delete the on-disk session
     * JSONL — operator can clean those up manually if desired. After this,
     * the next inbound on (platform, channelId) starts a fresh session.
     */
    remove(platform: string, channelId: string): boolean {
        this.load();
        const removed = this.bindings.delete(keyOf(platform, channelId));
        if (removed) this.persist();
        return removed;
    }

    /** Test-only: drop all state. */
    static __resetForTests(): void {
        setSingleton("channelSessions", null);
    }
}

/** Process-wide singleton. Shared across tsx/jiti module graphs via globalThis. */
export function getChannelSessions(): ChannelSessions {
    return getOrCreate("channelSessions", () => new ChannelSessions());
}
