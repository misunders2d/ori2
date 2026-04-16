import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// Tool ACL — maps toolName → requiredRoles[] (any-of semantics).
//
// A user may invoke a tool if they hold AT LEAST ONE of the required roles.
// The `admin` role (checked upstream by Whitelist.hasAnyRole) is an implicit
// superuser — this module doesn't need to special-case it; the whitelist check
// short-circuits.
//
// Default for tools not explicitly listed: `["admin"]` — lock-down by default.
// A newly-evolved tool needs explicit ACL before non-admins can invoke it.
//
// File: data/<bot>/tool_acl.json
//
// SEEDED DEFAULTS:
//   Shipped tools have sensible initial ACLs so the platform is immediately
//   usable by an admin + a few allowed users without manual ACL setup:
//     admin: bash, edit, write, grep, find, ls, read (file-system access);
//            verify_and_commit, secure_npm_install (code mutation);
//            a2a_send, a2a_broadcast (inter-agent);
//            schedule_* (persistent scheduling);
//            plan_create, plan_cancel (plan authoring);
//            connect-telegram-style config changes live in slash commands,
//              which don't go through tool ACL.
//     user:  web_search, web_fetch (research);
//            memory_save, memory_search (bot memory);
//            plan_get_next_step, plan_complete_step, plan_fail_step,
//              plan_get_status (executing a plan once the admin has
//              authored/seeded one).
// =============================================================================

interface AclEntry {
    toolName: string;
    requiredRoles: string[];
    updatedAt: number;
    updatedBy: string;
}

interface AclFile {
    version: number;
    updated_at: number;
    entries: AclEntry[];
}

const FILE_VERSION = 1;

const DEFAULTS: Record<string, string[]> = {
    // Built-in Pi tools
    bash: ["admin"],
    edit: ["admin"],
    write: ["admin"],
    read: ["admin"],
    grep: ["admin"],
    find: ["admin"],
    ls: ["admin"],
    // Our extensions
    verify_and_commit: ["admin"],
    secure_npm_install: ["admin"],
    a2a_send: ["admin"],
    a2a_broadcast: ["admin"],
    schedule_recurring_task: ["admin"],
    schedule_reminder: ["admin"],
    cancel_scheduled_task: ["admin"],
    update_scheduled_task: ["admin"],
    list_scheduled_tasks: ["user"],
    plan_create: ["admin"],
    plan_cancel: ["admin"],
    plan_get_next_step: ["user"],
    plan_complete_step: ["user"],
    plan_fail_step: ["user"],
    plan_get_status: ["user"],
    web_search: ["user"],
    web_fetch: ["user"],
    memory_save: ["user"],
    memory_search: ["user"],
};

const FALLBACK_DEFAULT: string[] = ["admin"];

function aclPath(): string {
    return path.join(botDir(), "tool_acl.json");
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

export class ToolAcl {
    private entries: Map<string, AclEntry> = new Map();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;
        if (fs.existsSync(aclPath())) {
            const raw = fs.readFileSync(aclPath(), "utf-8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new Error(`[tool_acl] FATAL: tool_acl.json corrupt: ${e instanceof Error ? e.message : String(e)}`);
            }
            const file = parsed as Partial<AclFile>;
            if (!Array.isArray(file.entries)) {
                throw new Error("[tool_acl] FATAL: tool_acl.json missing 'entries' array");
            }
            for (const e of file.entries) {
                if (typeof e.toolName === "string" && Array.isArray(e.requiredRoles)) {
                    this.entries.set(e.toolName, {
                        toolName: e.toolName,
                        requiredRoles: e.requiredRoles.filter((r): r is string => typeof r === "string"),
                        updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : Date.now(),
                        updatedBy: typeof e.updatedBy === "string" ? e.updatedBy : "unknown",
                    });
                }
            }
        }
        // Seed defaults for any tools not already explicitly configured. Does NOT
        // overwrite admin-customised entries on subsequent boots.
        for (const [tool, roles] of Object.entries(DEFAULTS)) {
            if (!this.entries.has(tool)) {
                this.entries.set(tool, {
                    toolName: tool,
                    requiredRoles: [...roles],
                    updatedAt: Date.now(),
                    updatedBy: "default",
                });
            }
        }
        this.loaded = true;
        this.save(); // Persist the seeded entries so admin can edit tool_acl.json directly if they prefer.
    }

    private save(): void {
        const data: AclFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            entries: Array.from(this.entries.values()).sort((a, b) => a.toolName.localeCompare(b.toolName)),
        };
        atomicWriteJson(aclPath(), data);
    }

    /** Required roles for a tool. Returns ["admin"] for unlisted tools (lock-down-by-default). */
    requiredRoles(toolName: string): string[] {
        this.load();
        const entry = this.entries.get(toolName);
        return entry ? [...entry.requiredRoles] : [...FALLBACK_DEFAULT];
    }

    /** Explicitly listed (non-default) tools. For /tool-acl list. */
    listConfigured(): AclEntry[] {
        this.load();
        return Array.from(this.entries.values()).sort((a, b) => a.toolName.localeCompare(b.toolName));
    }

    /** All roles referenced by any ACL entry — used by /role list to enumerate. */
    allReferencedRoles(): string[] {
        this.load();
        const roles = new Set<string>();
        for (const e of this.entries.values()) {
            for (const r of e.requiredRoles) roles.add(r);
        }
        return Array.from(roles).sort();
    }

    set(toolName: string, requiredRoles: string[], updatedBy: string): void {
        this.load();
        this.entries.set(toolName, {
            toolName,
            requiredRoles: [...requiredRoles],
            updatedAt: Date.now(),
            updatedBy,
        });
        this.save();
    }

    unset(toolName: string): boolean {
        this.load();
        const removed = this.entries.delete(toolName);
        if (removed) this.save();
        return removed;
    }

    reset(): void {
        this.loaded = false;
        this.entries.clear();
    }
}

let _instance: ToolAcl | null = null;

export function getToolAcl(): ToolAcl {
    if (!_instance) _instance = new ToolAcl();
    return _instance;
}
