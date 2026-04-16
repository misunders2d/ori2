import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// Credentials — paste-a-token store for service integrations.
//
// Sibling to the OAuth service. OAuth handles flow-based delegated
// authorization (Device Code, Auth Code+PKCE) with refresh. Credentials
// handles the long tail of services where the user generates a token in
// a web UI and pastes it into the bot — GitHub PATs, ClickUp tokens,
// Slack bot tokens, Notion integration tokens, Linear keys, Stripe keys,
// SendGrid/Mailgun keys, etc. No flow, no refresh, no provider negotiation.
//
// Storage: data/<bot>/credentials.json (mode 0600, atomic writes, fail-loud).
//
// Mental-model split between vault and credentials:
//   - VAULT: platform plumbing the operator usually doesn't touch
//     (admin IDs, init passcode, OAuth client_id/secret, model API keys,
//     Telegram bot token).
//   - CREDENTIALS: operational service tokens the operator manages over
//     time. Audit trail, structured metadata, rotation as first-class op.
//
// Access pattern from evolved tools:
//
//     import { getCredentials } from "../../src/core/credentials.js";
//     const auth = await getCredentials().getAuthHeader("github_pat");
//     // auth = { Authorization: "Bearer ghp_..." }
//     await fetch(url, { headers: { ...auth, "Content-Type": "application/json" } });
//
// Tools that need raw secret access can call get(id) — returns the secret
// string. Prefer getAuthHeader() because the credential's auth_type is
// metadata baked into the credential, so the tool author doesn't need to
// remember per-provider header conventions.
//
// SECURITY NOTES:
//   - File is mode 0600.
//   - list() returns metadata only, NEVER secrets.
//   - get() returns the secret — admin-only at the slash-command layer.
//   - Chat-based `/credentials add` is intercepted at the dispatcher
//     pre-hook (see .pi/extensions/credentials.ts) so the secret never
//     enters the LLM's context. CLI add bypasses this (the operator owns
//     the terminal).
// =============================================================================

const FILE_VERSION = 1;

export type CredentialAuthType = "bearer" | "basic" | "header" | "raw";

export interface Credential {
    id: string;
    secret: string;
    provider: string;
    auth_type: CredentialAuthType;
    /** Required for `header` type — name of the header to set (e.g. "X-API-Key"). */
    header_name?: string;
    /** Required for `basic` type — username for HTTP Basic auth. */
    username?: string;
    note?: string;
    added_at: number;
    added_by: string;
    rotated_at?: number;
}

/** Metadata-only view safe to surface in chat / logs. NEVER includes the secret. */
export interface CredentialInfo {
    id: string;
    provider: string;
    auth_type: CredentialAuthType;
    header_name?: string;
    username?: string;
    note?: string;
    added_at: number;
    added_by: string;
    rotated_at?: number;
}

interface CredentialsFile {
    version: number;
    updated_at: number;
    credentials: Record<string, Credential>;
}

function credentialsPath(): string {
    return path.join(botDir(), "credentials.json");
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

function toInfo(c: Credential): CredentialInfo {
    const out: CredentialInfo = {
        id: c.id,
        provider: c.provider,
        auth_type: c.auth_type,
        added_at: c.added_at,
        added_by: c.added_by,
    };
    if (c.header_name !== undefined) out.header_name = c.header_name;
    if (c.username !== undefined) out.username = c.username;
    if (c.note !== undefined) out.note = c.note;
    if (c.rotated_at !== undefined) out.rotated_at = c.rotated_at;
    return out;
}

export class Credentials {
    private store: Map<string, Credential> = new Map();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;
        if (fs.existsSync(credentialsPath())) {
            const raw = fs.readFileSync(credentialsPath(), "utf-8");
            let parsed: unknown;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                throw new Error(`[credentials] FATAL: credentials.json corrupt: ${e instanceof Error ? e.message : String(e)}`);
            }
            const file = parsed as Partial<CredentialsFile>;
            if (!file.credentials || typeof file.credentials !== "object") {
                throw new Error("[credentials] FATAL: credentials.json missing 'credentials' object");
            }
            for (const [id, cred] of Object.entries(file.credentials)) {
                if (cred && typeof cred === "object" && typeof (cred as { secret?: unknown }).secret === "string") {
                    this.store.set(id, cred as Credential);
                }
            }
        }
        this.loaded = true;
    }

    private save(): void {
        const data: CredentialsFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            credentials: Object.fromEntries(this.store.entries()),
        };
        atomicWriteJson(credentialsPath(), data);
    }

    /** Add or replace a credential. */
    add(opts: {
        id: string;
        secret: string;
        provider?: string;
        auth_type?: CredentialAuthType;
        header_name?: string;
        username?: string;
        note?: string;
        addedBy: string;
    }): Credential {
        this.load();

        if (!opts.id || typeof opts.id !== "string") {
            throw new Error("[credentials] add: id is required");
        }
        if (!opts.secret || typeof opts.secret !== "string") {
            throw new Error("[credentials] add: secret is required");
        }
        const auth_type = opts.auth_type ?? "bearer";
        if (auth_type === "header" && !opts.header_name) {
            throw new Error("[credentials] add: header_name is required for auth_type=header");
        }
        if (auth_type === "basic" && !opts.username) {
            throw new Error("[credentials] add: username is required for auth_type=basic");
        }

        const cred: Credential = {
            id: opts.id,
            secret: opts.secret,
            provider: opts.provider ?? opts.id,
            auth_type,
            ...(opts.header_name !== undefined ? { header_name: opts.header_name } : {}),
            ...(opts.username !== undefined ? { username: opts.username } : {}),
            ...(opts.note !== undefined ? { note: opts.note } : {}),
            added_at: Date.now(),
            added_by: opts.addedBy,
        };
        this.store.set(opts.id, cred);
        this.save();
        return cred;
    }

    /** Replace just the secret of an existing credential. Logs rotation timestamp. */
    rotate(id: string, newSecret: string, _rotatedBy: string): Credential {
        this.load();
        const existing = this.store.get(id);
        if (!existing) throw new Error(`[credentials] rotate: "${id}" not found`);
        if (!newSecret) throw new Error(`[credentials] rotate: secret is required`);
        const updated: Credential = {
            ...existing,
            secret: newSecret,
            rotated_at: Date.now(),
        };
        this.store.set(id, updated);
        this.save();
        return updated;
    }

    /** Update note. Returns true if changed. */
    setNote(id: string, note: string | undefined): boolean {
        this.load();
        const existing = this.store.get(id);
        if (!existing) return false;
        const updated: Credential = { ...existing };
        if (note === undefined || note === "") {
            delete updated.note;
        } else {
            updated.note = note;
        }
        this.store.set(id, updated);
        this.save();
        return true;
    }

    /** Update provider tag. Returns true if changed. */
    setProvider(id: string, provider: string): boolean {
        this.load();
        const existing = this.store.get(id);
        if (!existing) return false;
        const updated: Credential = { ...existing, provider };
        this.store.set(id, updated);
        this.save();
        return true;
    }

    remove(id: string): boolean {
        this.load();
        const removed = this.store.delete(id);
        if (removed) this.save();
        return removed;
    }

    /** Returns the secret. Throws if not found. */
    get(id: string): string {
        this.load();
        const cred = this.store.get(id);
        if (!cred) throw new Error(`[credentials] "${id}" not found`);
        return cred.secret;
    }

    /** Returns metadata only — NO secret. Safe to log/display. */
    info(id: string): CredentialInfo | null {
        this.load();
        const cred = this.store.get(id);
        return cred ? toInfo(cred) : null;
    }

    /** All credentials' metadata (no secrets). */
    list(): CredentialInfo[] {
        this.load();
        return Array.from(this.store.values()).map(toInfo).sort((a, b) => a.id.localeCompare(b.id));
    }

    has(id: string): boolean {
        this.load();
        return this.store.has(id);
    }

    /**
     * Build the HTTP header(s) the credential's auth_type implies. Tool
     * authors call this and spread the result into their fetch headers.
     *
     *     const auth = await getCredentials().getAuthHeader("github_pat");
     *     await fetch(url, { headers: { ...auth, ... } });
     *
     * For auth_type === "raw", returns {} — caller handles authentication
     * however they need (e.g. signed query params).
     */
    getAuthHeader(id: string): Record<string, string> {
        this.load();
        const cred = this.store.get(id);
        if (!cred) throw new Error(`[credentials] "${id}" not found`);
        switch (cred.auth_type) {
            case "bearer":
                return { Authorization: `Bearer ${cred.secret}` };
            case "basic": {
                const username = cred.username ?? "";
                const encoded = Buffer.from(`${username}:${cred.secret}`, "utf-8").toString("base64");
                return { Authorization: `Basic ${encoded}` };
            }
            case "header": {
                if (!cred.header_name) {
                    throw new Error(`[credentials] "${id}" auth_type=header missing header_name`);
                }
                return { [cred.header_name]: cred.secret };
            }
            case "raw":
                return {};
            default:
                throw new Error(`[credentials] "${id}" has unknown auth_type: ${cred.auth_type as string}`);
        }
    }

    /** Test-only. */
    reset(): void {
        this.loaded = false;
        this.store.clear();
    }
}

let _instance: Credentials | null = null;

export function getCredentials(): Credentials {
    if (!_instance) _instance = new Credentials();
    return _instance;
}
