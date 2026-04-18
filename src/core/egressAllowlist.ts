import fs from "node:fs";
import path from "node:path";
import { secretSubdir, ensureSecretDir } from "./paths.js";
import { getOrCreate } from "./singletons.js";

// =============================================================================
// egressAllowlist — per-credential URL allowlist for authenticated-fetch tools.
//
// Threat model:
//   The LLM has admin role but admin "trust" doesn't mean the agent is being
//   driven by an honest admin every turn (compromised admin account, prompt
//   injection that flips behaviour, evolved extension that goes rogue).
//   With alwaysConfirm:true, every authenticated_fetch DOES ping a real admin
//   for "Approve ACT-XXXXXX" — but a sleepy admin who just sees the URL might
//   miss that it's `https://api-googleapis.evil.com/...` instead of
//   `googleapis.com`.
//
//   The egress allowlist is the second eye: regardless of admin approval,
//   refuse the call if the URL host isn't on the allowlist for that
//   credential / OAuth platform.
//
// Layout:
//   data/<bot>/.secret/egress_allowlist.json
//   {
//     "version": 1,
//     "platforms": {
//       "google":  ["googleapis.com", "google.com"],
//       "github":  ["api.github.com", "uploads.github.com"]
//     },
//     "credentials": {
//       "stripe_live": ["api.stripe.com"],
//       "clickup":     ["api.clickup.com"]
//     }
//   }
//
// Defaults: built-in platforms (google, github) ship with sensible defaults;
// custom platforms / credentials require an admin to explicitly add hosts via
// /egress-allow before any authenticated fetch will work.
//
// Match semantics:
//   url.host (lowercase) MUST equal an entry exactly OR end with `.<entry>`.
//   So "googleapis.com" allows "googleapis.com" and "*.googleapis.com" (any
//   subdomain depth) but NOT "evil-googleapis.com".
// =============================================================================

const FILE_VERSION = 1;

const BUILTIN_PLATFORM_HOSTS: Record<string, string[]> = {
    google: ["googleapis.com", "google.com", "accounts.google.com"],
    github: ["api.github.com", "uploads.github.com", "github.com"],
};

interface EgressAllowlistFile {
    version: number;
    platforms: Record<string, string[]>;
    credentials: Record<string, string[]>;
}

function allowlistPath(): string {
    return path.join(secretSubdir(), "egress_allowlist.json");
}

export class EgressAllowlist {
    private platforms: Map<string, Set<string>> = new Map();
    private credentials: Map<string, Set<string>> = new Map();
    private loaded = false;

    private load(): void {
        if (this.loaded) return;
        if (fs.existsSync(allowlistPath())) {
            const raw = fs.readFileSync(allowlistPath(), "utf-8");
            const parsed = JSON.parse(raw) as Partial<EgressAllowlistFile>;
            for (const [k, v] of Object.entries(parsed.platforms ?? {})) {
                if (Array.isArray(v)) this.platforms.set(k, new Set(v.map((h) => h.toLowerCase())));
            }
            for (const [k, v] of Object.entries(parsed.credentials ?? {})) {
                if (Array.isArray(v)) this.credentials.set(k, new Set(v.map((h) => h.toLowerCase())));
            }
        }
        // Seed built-in platform hosts where the admin hasn't already configured.
        for (const [platform, hosts] of Object.entries(BUILTIN_PLATFORM_HOSTS)) {
            if (!this.platforms.has(platform)) {
                this.platforms.set(platform, new Set(hosts.map((h) => h.toLowerCase())));
            }
        }
        this.loaded = true;
        this.save();
    }

    private save(): void {
        const data: EgressAllowlistFile = {
            version: FILE_VERSION,
            platforms: Object.fromEntries(
                Array.from(this.platforms.entries()).map(([k, v]) => [k, Array.from(v).sort()]),
            ),
            credentials: Object.fromEntries(
                Array.from(this.credentials.entries()).map(([k, v]) => [k, Array.from(v).sort()]),
            ),
        };
        ensureSecretDir(secretSubdir());
        const tmp = allowlistPath() + ".tmp";
        const fd = fs.openSync(tmp, "w", 0o600);
        try {
            fs.writeSync(fd, JSON.stringify(data, null, 2));
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, allowlistPath());
    }

    /** True if `url`'s host is permitted for the given OAuth platform. */
    allowsPlatform(platform: string, url: string): boolean {
        this.load();
        return matchesAny(this.platforms.get(platform), url);
    }

    /** True if `url`'s host is permitted for the given credential id. */
    allowsCredential(credentialId: string, url: string): boolean {
        this.load();
        return matchesAny(this.credentials.get(credentialId), url);
    }

    addPlatformHost(platform: string, host: string): void {
        this.load();
        const set = this.platforms.get(platform) ?? new Set<string>();
        set.add(host.toLowerCase());
        this.platforms.set(platform, set);
        this.save();
    }

    addCredentialHost(credentialId: string, host: string): void {
        this.load();
        const set = this.credentials.get(credentialId) ?? new Set<string>();
        set.add(host.toLowerCase());
        this.credentials.set(credentialId, set);
        this.save();
    }

    removePlatformHost(platform: string, host: string): boolean {
        this.load();
        const set = this.platforms.get(platform);
        if (!set) return false;
        const ok = set.delete(host.toLowerCase());
        if (ok) this.save();
        return ok;
    }

    removeCredentialHost(credentialId: string, host: string): boolean {
        this.load();
        const set = this.credentials.get(credentialId);
        if (!set) return false;
        const ok = set.delete(host.toLowerCase());
        if (ok) this.save();
        return ok;
    }

    listPlatformHosts(platform: string): string[] {
        this.load();
        return Array.from(this.platforms.get(platform) ?? []).sort();
    }

    listCredentialHosts(credentialId: string): string[] {
        this.load();
        return Array.from(this.credentials.get(credentialId) ?? []).sort();
    }

    listAllPlatforms(): Array<{ platform: string; hosts: string[] }> {
        this.load();
        return Array.from(this.platforms.entries())
            .map(([platform, hosts]) => ({ platform, hosts: Array.from(hosts).sort() }))
            .sort((a, b) => a.platform.localeCompare(b.platform));
    }

    listAllCredentials(): Array<{ credential: string; hosts: string[] }> {
        this.load();
        return Array.from(this.credentials.entries())
            .map(([credential, hosts]) => ({ credential, hosts: Array.from(hosts).sort() }))
            .sort((a, b) => a.credential.localeCompare(b.credential));
    }

    /** Test-only — clears in-memory state. */
    reset(): void {
        this.loaded = false;
        this.platforms.clear();
        this.credentials.clear();
    }
}

function matchesAny(allowedHosts: Set<string> | undefined, url: string): boolean {
    if (!allowedHosts || allowedHosts.size === 0) return false;
    let host: string;
    try {
        const u = new URL(url);
        host = u.hostname.toLowerCase();
        // Reject non-https (defense against http:// + man-in-the-middle leaking
        // the auth header). Allow http://localhost for development.
        if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
            return false;
        }
    } catch {
        return false;
    }
    for (const allowed of allowedHosts) {
        if (host === allowed) return true;
        if (host.endsWith("." + allowed)) return true;
    }
    return false;
}

export function getEgressAllowlist(): EgressAllowlist {
    return getOrCreate("egressAllowlist", () => new EgressAllowlist());
}
