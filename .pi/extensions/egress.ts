import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { getEgressAllowlist } from "../../src/core/egressAllowlist.js";

// =============================================================================
// egress — admin slash command that controls the per-credential / per-platform
// egress allowlist. This is the missing piece referenced by the error text in
// credentials.ts:253 and oauth.ts:213, which already tells users to "run
// /egress-allow …" — but the command itself was never registered. This
// extension fills the gap.
//
// The allowlist ENFORCEMENT is unchanged and lives in EgressAllowlist /
// credentials_authenticated_fetch / oauth_authenticated_fetch. We only expose
// admin-facing CRUD here; every HTTP call with a stored token still passes
// through allowsCredential / allowsPlatform and gets refused on miss.
//
// Shapes (match the error-message text exactly so operators can copy-paste):
//   /egress-allow                                   → help
//   /egress-allow help                              → help
//   /egress-allow list                              → list all platforms + credentials
//   /egress-allow platform <name> <host>            → add host to platform
//   /egress-allow credential <id> <host>            → add host to credential
//   /egress-allow remove platform <name> <host>     → remove host from platform
//   /egress-allow remove credential <id> <host>     → remove host from credential
// =============================================================================

const whitelist = getWhitelist();

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI fallback — operator owns the process
    return whitelist.isAdmin(origin.platform, origin.senderId);
}

/** Strip accidental scheme / path / port. Lowercase. Reject obvious garbage. */
function normalizeHost(input: string): string | null {
    let h = input.trim().toLowerCase();
    if (!h) return null;
    // Strip scheme if the operator pasted a full URL.
    const schemeMatch = h.match(/^[a-z][a-z0-9+.-]*:\/\//);
    if (schemeMatch) h = h.slice(schemeMatch[0].length);
    // Strip path — keep only authority.
    const slashIdx = h.indexOf("/");
    if (slashIdx >= 0) h = h.slice(0, slashIdx);
    // Strip port — allowlist matches by hostname only.
    const colonIdx = h.indexOf(":");
    if (colonIdx >= 0) h = h.slice(0, colonIdx);
    // After trimming, re-validate: must look like a hostname.
    if (!/^[a-z0-9.-]+$/.test(h)) return null;
    if (h.startsWith(".") || h.endsWith(".") || h.includes("..")) return null;
    if (!h.includes(".") && h !== "localhost") return null;
    return h;
}

function help(): string {
    return [
        "/egress-allow — per-credential / per-platform host allowlist for",
        "authenticated fetches. Admin-only. Without an entry, attempts to",
        "use a stored credential against a host are refused BEFORE the",
        "Authorization header is sent — defense against prompt-injection or",
        "rogue-extension attempts to exfiltrate tokens to an attacker URL.",
        "",
        "Subcommands:",
        "  /egress-allow list",
        "      Show every platform and credential with its allowed hosts.",
        "",
        "  /egress-allow platform <name> <host>",
        "      Grant an OAuth platform (e.g. 'google', 'github') permission",
        "      to reach <host>.  Example:",
        "        /egress-allow platform github api.github.com",
        "",
        "  /egress-allow credential <id> <host>",
        "      Grant a pasted-token credential (from /credentials add) the",
        "      same permission.  Example:",
        "        /egress-allow credential github api.github.com",
        "",
        "  /egress-allow remove platform <name> <host>",
        "  /egress-allow remove credential <id> <host>",
        "      Revoke a previously-granted host.",
        "",
        "Host matching: <host> matches itself AND any subdomain. So",
        "'api.github.com' covers 'api.github.com' but NOT",
        "'evil-api.github.com'.  HTTPS is required (localhost exempt).",
    ].join("\n");
}

function listAll(): string {
    const al = getEgressAllowlist();
    const platforms = al.listAllPlatforms();
    const creds = al.listAllCredentials();
    const lines = ["EGRESS ALLOWLIST", "================", ""];
    lines.push("Platforms (OAuth):");
    if (platforms.length === 0) {
        lines.push("  (none)");
    } else {
        for (const { platform, hosts } of platforms) {
            lines.push(`  ${platform}: ${hosts.length > 0 ? hosts.join(", ") : "(empty)"}`);
        }
    }
    lines.push("");
    lines.push("Credentials (pasted tokens):");
    if (creds.length === 0) {
        lines.push("  (none)");
    } else {
        for (const { credential, hosts } of creds) {
            lines.push(`  ${credential}: ${hosts.length > 0 ? hosts.join(", ") : "(empty)"}`);
        }
    }
    return lines.join("\n");
}

function addPlatform(name: string | undefined, hostRaw: string | undefined): { ok: boolean; msg: string } {
    if (!name || !hostRaw) return { ok: false, msg: "Usage: /egress-allow platform <name> <host>" };
    const host = normalizeHost(hostRaw);
    if (!host) return { ok: false, msg: `Rejected host: "${hostRaw}". Pass a bare hostname like api.github.com.` };
    getEgressAllowlist().addPlatformHost(name, host);
    return { ok: true, msg: `Added "${host}" to platform "${name}".` };
}

function addCredential(id: string | undefined, hostRaw: string | undefined): { ok: boolean; msg: string } {
    if (!id || !hostRaw) return { ok: false, msg: "Usage: /egress-allow credential <id> <host>" };
    const host = normalizeHost(hostRaw);
    if (!host) return { ok: false, msg: `Rejected host: "${hostRaw}". Pass a bare hostname like api.github.com.` };
    getEgressAllowlist().addCredentialHost(id, host);
    return { ok: true, msg: `Added "${host}" to credential "${id}".` };
}

function removeEntry(parts: string[]): { ok: boolean; msg: string } {
    const scope = (parts[0] ?? "").toLowerCase();
    const name = parts[1];
    const hostRaw = parts[2];
    if (!["platform", "credential"].includes(scope) || !name || !hostRaw) {
        return { ok: false, msg: "Usage: /egress-allow remove platform|credential <name> <host>" };
    }
    const host = normalizeHost(hostRaw);
    if (!host) return { ok: false, msg: `Rejected host: "${hostRaw}". Pass a bare hostname.` };
    const al = getEgressAllowlist();
    const removed = scope === "platform"
        ? al.removePlatformHost(name, host)
        : al.removeCredentialHost(name, host);
    return removed
        ? { ok: true, msg: `Removed "${host}" from ${scope} "${name}".` }
        : { ok: false, msg: `No matching entry: ${scope} "${name}" does not list "${host}".` };
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("egress-allow", {
        description:
            "Manage the per-credential / per-platform egress allowlist. Admin only. Run /egress-allow help for subcommands.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();

            // help + list are read-only but still admin-only — the list of
            // allowed hosts is itself sensitive (leaks the integration surface).
            if (!isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /egress-allow.", "error");
                return;
            }

            switch (sub) {
                case "help":
                    ctx.ui.notify(help(), "info");
                    return;
                case "list":
                    ctx.ui.notify(listAll(), "info");
                    return;
                case "platform": {
                    const res = addPlatform(parts[1], parts[2]);
                    ctx.ui.notify(res.msg, res.ok ? "info" : "error");
                    return;
                }
                case "credential": {
                    const res = addCredential(parts[1], parts[2]);
                    ctx.ui.notify(res.msg, res.ok ? "info" : "error");
                    return;
                }
                case "remove": {
                    const res = removeEntry(parts.slice(1));
                    ctx.ui.notify(res.msg, res.ok ? "info" : "error");
                    return;
                }
                default:
                    ctx.ui.notify(`Unknown /egress-allow subcommand: ${sub}. Run /egress-allow help.`, "error");
            }
        },
    });
}

// Export pure handler pieces for unit testing.
export const __test = { normalizeHost, help, listAll, addPlatform, addCredential, removeEntry };
