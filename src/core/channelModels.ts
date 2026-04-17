import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";
import { getOrCreate, setSingleton } from "./singletons.js";
import { logWarning } from "./errorLog.js";

// =============================================================================
// Per-channel model preference.
//
// Users in chat say "switch to Opus for this group" or "use a cheaper model
// here". We honor that by storing a (platform, channelId) → {provider, modelId,
// thinkingLevel?} binding. channelRouter reads this before spawning and passes
// `--model <provider>/<modelId>` to `pi -p`, so the subprocess runs on the
// requested model.
//
// Scope: affects future subprocesses in that channel. Can't retroactively
// swap the model on a turn that's already in progress — Pi's AgentSession
// is committed to its model at spawn time.
//
// File: data/<bot>/channel-models.json
//   {
//     "version": 1,
//     "bindings": [
//       { "platform": "telegram", "channelId": "-100abc",
//         "provider": "anthropic", "modelId": "claude-opus-4-5",
//         "thinkingLevel": "medium", "setAt": 1700000000000, "setBy": "..." }
//     ]
//   }
// =============================================================================

export interface ChannelModelBinding {
    platform: string;
    channelId: string;
    provider: string;
    modelId: string;
    /** Optional — when absent the subprocess uses Pi's default for this model. */
    thinkingLevel?: string;
    setAt: number;
    /** Stable-ish origin of the setter ("<platform>:<senderId>"). */
    setBy: string;
}

interface MapFile {
    version: number;
    updatedAt: number;
    bindings: ChannelModelBinding[];
}

const FILE_VERSION = 1;

function mapFilePath(): string {
    return path.join(botDir(), "channel-models.json");
}

function keyOf(platform: string, channelId: string): string {
    return `${platform}:${channelId}`;
}

function atomicWriteJson(file: string, data: unknown): void {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
}

export class ChannelModels {
    private bindings = new Map<string, ChannelModelBinding>();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;
        this.loaded = true;

        const file = mapFilePath();
        if (!fs.existsSync(file)) return;

        try {
            const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<MapFile>;
            if (!Array.isArray(raw.bindings)) return;
            for (const b of raw.bindings) {
                if (typeof b.platform !== "string" || typeof b.channelId !== "string") continue;
                if (typeof b.provider !== "string" || typeof b.modelId !== "string") continue;
                this.bindings.set(keyOf(b.platform, b.channelId), {
                    platform: b.platform,
                    channelId: b.channelId,
                    provider: b.provider,
                    modelId: b.modelId,
                    ...(typeof b.thinkingLevel === "string" ? { thinkingLevel: b.thinkingLevel } : {}),
                    setAt: typeof b.setAt === "number" ? b.setAt : Date.now(),
                    setBy: typeof b.setBy === "string" ? b.setBy : "unknown",
                });
            }
        } catch (e) {
            logWarning("channelModels", "map file corrupt — starting empty", {
                err: e instanceof Error ? e.message : String(e),
            });
        }
    }

    private persist(): void {
        atomicWriteJson(mapFilePath(), {
            version: FILE_VERSION,
            updatedAt: Date.now(),
            bindings: Array.from(this.bindings.values()),
        });
    }

    /** Get the model preference for a channel. Undefined = use Pi default. */
    get(platform: string, channelId: string): ChannelModelBinding | undefined {
        this.load();
        return this.bindings.get(keyOf(platform, channelId));
    }

    /** Set or replace a channel's model preference. */
    set(
        platform: string,
        channelId: string,
        opts: { provider: string; modelId: string; thinkingLevel?: string; setBy: string },
    ): ChannelModelBinding {
        this.load();
        const record: ChannelModelBinding = {
            platform,
            channelId,
            provider: opts.provider,
            modelId: opts.modelId,
            ...(opts.thinkingLevel !== undefined ? { thinkingLevel: opts.thinkingLevel } : {}),
            setAt: Date.now(),
            setBy: opts.setBy,
        };
        this.bindings.set(keyOf(platform, channelId), record);
        this.persist();
        return record;
    }

    /** Clear a channel's preference — future subprocesses use Pi default. */
    clear(platform: string, channelId: string): boolean {
        this.load();
        const removed = this.bindings.delete(keyOf(platform, channelId));
        if (removed) this.persist();
        return removed;
    }

    /** All bindings, for diagnostics. */
    all(): ChannelModelBinding[] {
        this.load();
        return Array.from(this.bindings.values());
    }

    /** Test-only. */
    static __resetForTests(): void {
        setSingleton("channelModels", null);
    }
}

export function getChannelModels(): ChannelModels {
    return getOrCreate("channelModels", () => new ChannelModels());
}
