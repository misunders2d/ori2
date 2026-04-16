import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";
import { getVault } from "./vault.js";

// =============================================================================
// Whitelist / blacklist with flexible named roles.
//
// Model:
//   - A "user" is a (platform, senderId) pair. Same person on Telegram and
//     Slack is TWO separate records — intentional, since we can't verify
//     cross-platform identity.
//   - Every whitelisted user gets an implicit `user` role.
//   - Admins additionally get `admin` role, which is an implicit superuser:
//     it satisfies any role check in the ACL.
//   - Custom roles are free-form strings — no upfront registration. Created
//     on first assignment, destroyed when no one holds them and no tool
//     requires them. `/role list` enumerates by walking whitelist + ACL.
//
// Admin bootstrap:
//   Vault entry `ADMIN_USER_IDS` (comma-separated) is ALWAYS honored as
//   admin, regardless of whitelist state. This prevents lockout if the
//   whitelist file is corrupted or the bot owner's Telegram ID was wrong.
//   The format in vault is `<platform>:<senderId>` per entry when you know
//   the platform (e.g. `telegram:123456,slack:U0ABC`), or plain senderId
//   for platform-agnostic (treats the id as matching on ANY platform — used
//   for the CLI admin during onboarding when senderId is the OS username).
//
// File locations:
//   data/<bot>/whitelist.json, data/<bot>/blacklist.json
//
// Fail-loud: corrupt file throws on read. Callers decide whether to swallow.
// =============================================================================

interface UserRecord {
    platform: string;
    senderId: string;
    displayName?: string;
    roles: string[];
    addedBy: string;        // "vault:ADMIN_USER_IDS" or "<platform>:<senderId>"
    addedAt: number;
}

interface BlacklistRecord {
    platform: string;
    senderId: string;
    displayName?: string;
    reason?: string;
    addedBy: string;
    addedAt: number;
}

interface WhitelistFile {
    version: number;
    updated_at: number;
    users: UserRecord[];
}

interface BlacklistFile {
    version: number;
    updated_at: number;
    users: BlacklistRecord[];
}

const FILE_VERSION = 1;

function whitelistPath(): string {
    return path.join(botDir(), "whitelist.json");
}
function blacklistPath(): string {
    return path.join(botDir(), "blacklist.json");
}

function keyOf(platform: string, senderId: string): string {
    return `${platform}:${senderId}`;
}

function atomicWriteJson(file: string, data: unknown): void {
    const dir = path.dirname(file);
    ensureDir(dir);
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

export class Whitelist {
    private users: Map<string, UserRecord> = new Map();
    private blacklisted: Map<string, BlacklistRecord> = new Map();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;

        if (fs.existsSync(whitelistPath())) {
            const raw = fs.readFileSync(whitelistPath(), "utf-8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new Error(`[whitelist] FATAL: whitelist.json corrupt: ${e instanceof Error ? e.message : String(e)}`);
            }
            const file = parsed as Partial<WhitelistFile>;
            if (!Array.isArray(file.users)) {
                throw new Error("[whitelist] FATAL: whitelist.json missing 'users' array");
            }
            for (const u of file.users) {
                if (typeof u.platform === "string" && typeof u.senderId === "string" && Array.isArray(u.roles)) {
                    this.users.set(keyOf(u.platform, u.senderId), {
                        platform: u.platform,
                        senderId: u.senderId,
                        ...(typeof u.displayName === "string" ? { displayName: u.displayName } : {}),
                        roles: u.roles.filter((r): r is string => typeof r === "string"),
                        addedBy: typeof u.addedBy === "string" ? u.addedBy : "unknown",
                        addedAt: typeof u.addedAt === "number" ? u.addedAt : Date.now(),
                    });
                }
            }
        }

        if (fs.existsSync(blacklistPath())) {
            const raw = fs.readFileSync(blacklistPath(), "utf-8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new Error(`[whitelist] FATAL: blacklist.json corrupt: ${e instanceof Error ? e.message : String(e)}`);
            }
            const file = parsed as Partial<BlacklistFile>;
            if (!Array.isArray(file.users)) {
                throw new Error("[whitelist] FATAL: blacklist.json missing 'users' array");
            }
            for (const u of file.users) {
                if (typeof u.platform === "string" && typeof u.senderId === "string") {
                    this.blacklisted.set(keyOf(u.platform, u.senderId), {
                        platform: u.platform,
                        senderId: u.senderId,
                        ...(typeof u.displayName === "string" ? { displayName: u.displayName } : {}),
                        ...(typeof u.reason === "string" ? { reason: u.reason } : {}),
                        addedBy: typeof u.addedBy === "string" ? u.addedBy : "unknown",
                        addedAt: typeof u.addedAt === "number" ? u.addedAt : Date.now(),
                    });
                }
            }
        }

        this.loaded = true;
    }

    private saveWhitelist(): void {
        const data: WhitelistFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            users: Array.from(this.users.values()),
        };
        atomicWriteJson(whitelistPath(), data);
    }

    private saveBlacklist(): void {
        const data: BlacklistFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            users: Array.from(this.blacklisted.values()),
        };
        atomicWriteJson(blacklistPath(), data);
    }

    /** Parse vault's ADMIN_USER_IDS into a set of keys. */
    private vaultAdmins(): { keyed: Set<string>; senderIdOnly: Set<string> } {
        const raw = getVault().get("ADMIN_USER_IDS") ?? "";
        const keyed = new Set<string>();        // `<platform>:<senderId>` exact matches
        const senderIdOnly = new Set<string>(); // plain senderId matches (any platform)
        for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
            if (entry.includes(":")) {
                keyed.add(entry);
            } else {
                senderIdOnly.add(entry);
            }
        }
        return { keyed, senderIdOnly };
    }

    // ------------- queries -------------

    isAdmin(platform: string, senderId: string): boolean {
        this.load();
        // 1. Bootstrap admins from vault — always honored.
        const admins = this.vaultAdmins();
        if (admins.keyed.has(keyOf(platform, senderId))) return true;
        if (admins.senderIdOnly.has(senderId)) return true;
        // 2. Whitelist users with `admin` role.
        const u = this.users.get(keyOf(platform, senderId));
        return !!u && u.roles.includes("admin");
    }

    isBlacklisted(platform: string, senderId: string): boolean {
        this.load();
        return this.blacklisted.has(keyOf(platform, senderId));
    }

    /** Primary access gate — blacklist overrides, admin always allowed, whitelist otherwise. */
    isAllowed(platform: string, senderId: string): boolean {
        if (this.isBlacklisted(platform, senderId)) return false;
        if (this.isAdmin(platform, senderId)) return true;
        this.load();
        return this.users.has(keyOf(platform, senderId));
    }

    /** Returns the roles this user holds — including implicit `user` + `admin` where applicable. */
    rolesOf(platform: string, senderId: string): string[] {
        this.load();
        if (this.isBlacklisted(platform, senderId)) return [];
        const isAdmin = this.isAdmin(platform, senderId);
        const record = this.users.get(keyOf(platform, senderId));
        const base = new Set<string>();
        if (record) {
            base.add("user");
            for (const r of record.roles) base.add(r);
        } else if (isAdmin) {
            // Vault-bootstrap admin that's not in the whitelist yet — synthesize roles.
            base.add("user");
        }
        if (isAdmin) base.add("admin");
        return Array.from(base).sort();
    }

    /** True if user holds any of the required roles. `admin` role implicitly satisfies anything. */
    hasAnyRole(platform: string, senderId: string, requiredRoles: string[]): boolean {
        if (requiredRoles.length === 0) return true;
        const have = new Set(this.rolesOf(platform, senderId));
        if (have.has("admin")) return true;
        for (const r of requiredRoles) {
            if (have.has(r)) return true;
        }
        return false;
    }

    get(platform: string, senderId: string): UserRecord | undefined {
        this.load();
        return this.users.get(keyOf(platform, senderId));
    }

    list(): UserRecord[] {
        this.load();
        return Array.from(this.users.values());
    }

    listBlacklist(): BlacklistRecord[] {
        this.load();
        return Array.from(this.blacklisted.values());
    }

    /** Enumerate distinct roles in use (whitelist assignments + tool ACL requirements). */
    allRoles(extraRoles: string[] = []): string[] {
        this.load();
        const roles = new Set<string>(["admin", "user"]);
        for (const u of this.users.values()) {
            for (const r of u.roles) roles.add(r);
        }
        for (const r of extraRoles) roles.add(r);
        return Array.from(roles).sort();
    }

    // ------------- mutations -------------

    add(
        platform: string,
        senderId: string,
        opts: { roles?: string[]; displayName?: string; addedBy: string },
    ): UserRecord {
        this.load();
        if (this.blacklisted.delete(keyOf(platform, senderId))) this.saveBlacklist();
        const existing = this.users.get(keyOf(platform, senderId));
        const roleSet = new Set<string>(existing?.roles ?? []);
        // Implicit "user" role — not stored explicitly to keep files clean, but
        // treat it as present for intent-clarity when adding.
        for (const r of opts.roles ?? []) {
            if (r !== "user") roleSet.add(r);
        }
        const record: UserRecord = {
            platform,
            senderId,
            ...(opts.displayName !== undefined ? { displayName: opts.displayName } :
                existing?.displayName !== undefined ? { displayName: existing.displayName } : {}),
            roles: Array.from(roleSet).sort(),
            addedBy: existing?.addedBy ?? opts.addedBy,
            addedAt: existing?.addedAt ?? Date.now(),
        };
        this.users.set(keyOf(platform, senderId), record);
        this.saveWhitelist();
        return record;
    }

    remove(platform: string, senderId: string): boolean {
        this.load();
        const removed = this.users.delete(keyOf(platform, senderId));
        if (removed) this.saveWhitelist();
        return removed;
    }

    /** Grant a role. Returns true if it was newly granted, false if already held. */
    grantRole(platform: string, senderId: string, role: string): boolean {
        this.load();
        const u = this.users.get(keyOf(platform, senderId));
        if (!u) return false;
        if (u.roles.includes(role)) return false;
        u.roles = [...u.roles, role].sort();
        this.saveWhitelist();
        return true;
    }

    revokeRole(platform: string, senderId: string, role: string): boolean {
        this.load();
        const u = this.users.get(keyOf(platform, senderId));
        if (!u) return false;
        const idx = u.roles.indexOf(role);
        if (idx < 0) return false;
        u.roles.splice(idx, 1);
        this.saveWhitelist();
        return true;
    }

    blacklist(
        platform: string,
        senderId: string,
        opts: { reason?: string; displayName?: string; addedBy: string },
    ): void {
        this.load();
        if (this.users.delete(keyOf(platform, senderId))) this.saveWhitelist();
        this.blacklisted.set(keyOf(platform, senderId), {
            platform,
            senderId,
            ...(opts.displayName !== undefined ? { displayName: opts.displayName } : {}),
            ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
            addedBy: opts.addedBy,
            addedAt: Date.now(),
        });
        this.saveBlacklist();
    }

    unblacklist(platform: string, senderId: string): boolean {
        this.load();
        const removed = this.blacklisted.delete(keyOf(platform, senderId));
        if (removed) this.saveBlacklist();
        return removed;
    }

    /** Test-only. */
    reset(): void {
        this.loaded = false;
        this.users.clear();
        this.blacklisted.clear();
    }
}

let _instance: Whitelist | null = null;

export function getWhitelist(): Whitelist {
    if (!_instance) _instance = new Whitelist();
    return _instance;
}
