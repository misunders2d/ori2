import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "../core/paths.js";
import { getVault } from "../core/vault.js";
import type { FriendRecord, FriendsFile } from "./types.js";

// =============================================================================
// Friend registry — the local persistent view of every A2A peer we trust.
//
// File: data/<bot>/friends.json (mode 0600, atomic write).
// Vault keys (per-friend, asymmetric — a friend has TWO keys, one each way):
//   a2a:friend_key:<name>          — what THEY present when calling us
//   a2a:friend_outbound_key:<name> — what WE present when calling them
//
// Keys live in vault, not in friends.json, so a backup/leak of the friends
// file alone does not expose authentication material.
// =============================================================================

const FILE_VERSION = 1;
const KEY_PREFIX_INBOUND = "a2a:friend_key:";
const KEY_PREFIX_OUTBOUND = "a2a:friend_outbound_key:";

function friendsPath(): string {
    return path.join(botDir(), "friends.json");
}

function atomicWriteJson(file: string, data: unknown): void {
    ensureDir(path.dirname(file));
    const tmp = `${file}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
        fs.writeSync(fd, JSON.stringify(data, null, 2));
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
}

export class Friends {
    private records: Map<string, FriendRecord> = new Map();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;
        const file = friendsPath();
        if (!fs.existsSync(file)) {
            this.loaded = true;
            return;
        }
        let raw: string;
        try {
            raw = fs.readFileSync(file, "utf-8");
        } catch (e) {
            throw new Error(`[friends] FATAL: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            throw new Error(`[friends] FATAL: friends.json corrupt JSON: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (!parsed || typeof parsed !== "object") {
            throw new Error(`[friends] FATAL: friends.json wrong shape`);
        }
        const obj = parsed as Partial<FriendsFile>;
        if (!obj.friends || typeof obj.friends !== "object") {
            throw new Error(`[friends] FATAL: friends.json missing 'friends' object`);
        }
        for (const [name, rec] of Object.entries(obj.friends)) {
            if (!rec || typeof rec !== "object") continue;
            const r = rec as Partial<FriendRecord>;
            if (typeof r.base_url !== "string" || typeof r.agent_id !== "string") continue;
            this.records.set(name, {
                name,
                base_url: r.base_url,
                endpoint_url: r.endpoint_url ?? r.base_url,
                agent_id: r.agent_id,
                added_at: typeof r.added_at === "number" ? r.added_at : Date.now(),
                added_by: typeof r.added_by === "string" ? r.added_by : "unknown",
                ...(typeof r.displayName === "string" ? { displayName: r.displayName } : {}),
                ...(Array.isArray(r.card_skills)
                    ? { card_skills: r.card_skills.filter((s): s is string => typeof s === "string") }
                    : {}),
                ...(typeof r.last_seen_at === "number" ? { last_seen_at: r.last_seen_at } : {}),
                ...(typeof r.last_address_update === "number"
                    ? { last_address_update: r.last_address_update }
                    : {}),
            });
        }
        this.loaded = true;
    }

    private save(): void {
        const data: FriendsFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            friends: Object.fromEntries(this.records.entries()),
        };
        atomicWriteJson(friendsPath(), data);
    }

    add(
        name: string,
        opts: {
            url: string;
            agent_id: string;
            added_by: string;
            displayName?: string;
            card_skills?: string[];
        },
    ): FriendRecord {
        if (!name || typeof name !== "string") throw new Error("[friends] add: name required");
        this.load();
        const existing = this.records.get(name);
        const rec: FriendRecord = {
            name,
            base_url: opts.url,
            endpoint_url: opts.url,
            agent_id: opts.agent_id,
            // Re-add preserves first-add timestamp + the operator who originally trusted them.
            added_at: existing?.added_at ?? Date.now(),
            added_by: existing?.added_by ?? opts.added_by,
            ...(opts.displayName !== undefined
                ? { displayName: opts.displayName }
                : existing?.displayName !== undefined
                    ? { displayName: existing.displayName }
                    : {}),
            ...(opts.card_skills !== undefined
                ? { card_skills: [...opts.card_skills] }
                : existing?.card_skills !== undefined
                    ? { card_skills: [...existing.card_skills] }
                    : {}),
            ...(existing?.last_seen_at !== undefined ? { last_seen_at: existing.last_seen_at } : {}),
            ...(existing?.last_address_update !== undefined
                ? { last_address_update: existing.last_address_update }
                : {}),
        };
        this.records.set(name, rec);
        this.save();
        return rec;
    }

    get(name: string): FriendRecord | undefined {
        this.load();
        return this.records.get(name);
    }

    list(): FriendRecord[] {
        this.load();
        return Array.from(this.records.values());
    }

    remove(name: string): boolean {
        this.load();
        const removed = this.records.delete(name);
        if (removed) {
            this.save();
            this.removeKeys(name);
        }
        return removed;
    }

    updateUrl(name: string, newUrl: string): boolean {
        this.load();
        const rec = this.records.get(name);
        if (!rec) return false;
        rec.base_url = newUrl;
        rec.endpoint_url = newUrl;
        rec.last_address_update = Date.now();
        this.save();
        return true;
    }

    setLastSeen(name: string, at: number = Date.now()): void {
        this.load();
        const rec = this.records.get(name);
        if (!rec) return;
        rec.last_seen_at = at;
        this.save();
    }

    setCardSkills(name: string, skills: string[]): void {
        this.load();
        const rec = this.records.get(name);
        if (!rec) return;
        rec.card_skills = [...skills];
        this.save();
    }

    // -------------------- bearer keys (vault-backed) --------------------

    setKey(name: string, key: string): void {
        getVault().set(KEY_PREFIX_INBOUND + name, key);
    }

    getKey(name: string): string | undefined {
        return getVault().get(KEY_PREFIX_INBOUND + name);
    }

    setOutboundKey(name: string, key: string): void {
        getVault().set(KEY_PREFIX_OUTBOUND + name, key);
    }

    getOutboundKey(name: string): string | undefined {
        return getVault().get(KEY_PREFIX_OUTBOUND + name);
    }

    removeKeys(name: string): void {
        const v = getVault();
        v.delete(KEY_PREFIX_INBOUND + name);
        v.delete(KEY_PREFIX_OUTBOUND + name);
    }

    /**
     * Reverse-lookup: a peer presented this bearer key on an inbound request.
     * Find which friend name it maps to. Constant-time comparison would be
     * nice; we walk the vault keys but only on inbound auth, which is rate-
     * limited upstream. Returns null if no match.
     */
    resolveByKey(presentedKey: string): string | null {
        if (!presentedKey) return null;
        for (const name of getVault().list()) {
            if (!name.startsWith(KEY_PREFIX_INBOUND)) continue;
            if (getVault().get(name) === presentedKey) {
                return name.slice(KEY_PREFIX_INBOUND.length);
            }
        }
        return null;
    }

    /** Test-only — clear in-memory cache so tests see fresh state. */
    reset(): void {
        this.loaded = false;
        this.records.clear();
    }
}

import { getOrCreate } from "../core/singletons.js";

export function getFriends(): Friends {
    return getOrCreate("a2aFriends", () => new Friends());
}
