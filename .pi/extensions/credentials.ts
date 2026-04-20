import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getCredentials, type CredentialAuthType, type CredentialInfo } from "../../src/core/credentials.js";
import { currentOrigin } from "../../src/core/identity.js";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { registerActionDescriber } from "./admin_gate.js";

// =============================================================================
// credentials — Pi extension exposing the `/credentials` slash commands and
// dispatcher pre-hook for chat-side secret entry.
//
// Security model:
//   - Mutating subcommands require admin (whitelist.isAdmin).
//   - `/credentials get` returns the secret value; admin-only AND chat-aware
//     (rejects in non-CLI contexts since the secret would land in chat logs).
//   - Chat-based `/credentials add|add-basic|add-header|rotate` is intercepted
//     at the dispatcher pre-hook BEFORE the message reaches Pi. The secret
//     never enters the LLM context. CLI-typed commands skip the dispatcher
//     and go straight through Pi's command router (terminal owner is trusted).
// =============================================================================

const creds = getCredentials();
const dispatcher = getDispatcher();
const whitelist = getWhitelist();

// ---------------- helpers ----------------

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI fallback — operator owns the process
    return whitelist.isAdmin(origin.platform, origin.senderId);
}

function isCliCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    return origin === null || origin.platform === "cli";
}

function fmtAuthDetail(c: CredentialInfo): string {
    switch (c.auth_type) {
        case "bearer": return "bearer";
        case "basic":  return `basic (user=${c.username ?? "?"})`;
        case "header": return `header (${c.header_name ?? "?"})`;
        case "raw":    return "raw";
    }
}

function fmtAge(epoch: number): string {
    const sec = Math.round((Date.now() - epoch) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h`;
    return `${Math.round(sec / 86400)}d`;
}

function tokenizeRespectingQuotes(input: string): string[] {
    const tokens: string[] = [];
    let i = 0;
    while (i < input.length) {
        while (i < input.length && /\s/.test(input[i]!)) i++;
        if (i >= input.length) break;
        if (input[i] === '"') {
            i++;
            let buf = "";
            while (i < input.length && input[i] !== '"') {
                if (input[i] === "\\" && i + 1 < input.length) { buf += input[i + 1]; i += 2; continue; }
                buf += input[i]!;
                i++;
            }
            if (i < input.length) i++;
            tokens.push(buf);
        } else {
            let buf = "";
            while (i < input.length && !/\s/.test(input[i]!)) { buf += input[i]!; i++; }
            tokens.push(buf);
        }
    }
    return tokens;
}

// ---------------- dispatcher pre-hook for chat-based secret commands ----------------

const SECRET_SUBCOMMANDS = new Set(["add", "add-basic", "add-header", "rotate"]);

dispatcher.addPreDispatchHook((msg) => {
    // Only intercept /credentials commands — let everything else through.
    const m = msg.text.match(/^\s*\/credentials\s+(\S+)\b\s*([\s\S]*)$/i);
    if (!m) return { block: false };
    const sub = m[1]!.toLowerCase();
    if (!SECRET_SUBCOMMANDS.has(sub)) return { block: false };

    // Verify admin BEFORE handling — non-admin chat secret-add is a clear no.
    if (!whitelist.isAdmin(msg.platform, msg.senderId)) {
        return { block: true, reason: `Only admins can run /credentials ${sub}.` };
    }

    // Process the secret command HERE so the secret never enters Pi's session
    // (and therefore never enters the LLM context, channel logs, etc.).
    const rest = (m[2] ?? "").trim();
    const tokens = tokenizeRespectingQuotes(rest);
    const addedBy = `${msg.platform}:${msg.senderId}`;

    try {
        switch (sub) {
            case "add": {
                const [id, secret, ...flags] = tokens;
                if (!id || !secret) {
                    return { block: true, reason: "Usage: /credentials add <id> <secret> [--provider <p>] [--note \"...\"]" };
                }
                const opts = parseAddFlags(flags);
                creds.add({ id, secret, addedBy, ...opts });
                return { block: true, reason: `✅ Added credential "${id}" (provider=${opts.provider ?? id}, auth_type=bearer). Secret has NOT been logged.` };
            }
            case "add-basic": {
                const [id, username, secret, ...flags] = tokens;
                if (!id || !username || !secret) {
                    return { block: true, reason: "Usage: /credentials add-basic <id> <username> <secret> [--provider <p>] [--note \"...\"]" };
                }
                const opts = parseAddFlags(flags);
                creds.add({ id, secret, username, auth_type: "basic", addedBy, ...opts });
                return { block: true, reason: `✅ Added credential "${id}" (auth_type=basic, user=${username}). Secret has NOT been logged.` };
            }
            case "add-header": {
                const [id, headerName, secret, ...flags] = tokens;
                if (!id || !headerName || !secret) {
                    return { block: true, reason: "Usage: /credentials add-header <id> <header-name> <secret> [--provider <p>] [--note \"...\"]" };
                }
                const opts = parseAddFlags(flags);
                creds.add({ id, secret, header_name: headerName, auth_type: "header", addedBy, ...opts });
                return { block: true, reason: `✅ Added credential "${id}" (auth_type=header, ${headerName}: ***). Secret has NOT been logged.` };
            }
            case "rotate": {
                const [id, secret] = tokens;
                if (!id || !secret) {
                    return { block: true, reason: "Usage: /credentials rotate <id> <new-secret>" };
                }
                if (!creds.has(id)) {
                    return { block: true, reason: `Credential "${id}" not found.` };
                }
                creds.rotate(id, secret, addedBy);
                return { block: true, reason: `✅ Rotated credential "${id}". New secret has NOT been logged.` };
            }
        }
    } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        return { block: true, reason: `Failed: ${errMsg}` };
    }
    return { block: false };
});

interface AddFlags {
    provider?: string;
    note?: string;
}

function parseAddFlags(flags: string[]): AddFlags {
    const out: AddFlags = {};
    for (let i = 0; i < flags.length; i++) {
        const f = flags[i];
        if (f === "--provider" && i + 1 < flags.length) {
            out.provider = flags[i + 1]!;
            i++;
        } else if (f === "--note" && i + 1 < flags.length) {
            out.note = flags[i + 1]!;
            i++;
        }
    }
    return out;
}

// ---------------- extension entry ----------------

export default function (pi: ExtensionAPI) {
    pi.registerCommand("credentials", {
        description: "Service-token store for non-OAuth integrations. Run /credentials help for full reference.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();

            const mutating = !["help", "list", "info"].includes(sub);
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /credentials " + sub + ".", "error");
                return;
            }

            switch (sub) {
                case "help":          return doHelp(ctx);
                case "list":          return doList(ctx);
                case "info":          return doInfo(ctx, parts);
                case "get":           return doGet(ctx, parts);
                case "add":           return doAddBearer(ctx, args ?? "");
                case "add-basic":     return doAddBasic(ctx, args ?? "");
                case "add-header":    return doAddHeader(ctx, args ?? "");
                case "rotate":        return doRotate(ctx, args ?? "");
                case "remove":        return doRemove(ctx, parts);
                case "set-note":      return doSetNote(ctx, args ?? "");
                case "set-provider":  return doSetProvider(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /credentials subcommand: ${sub}. Run /credentials help.`, "error");
            }
        },
    });

    // Action describer so the admin sees what URL + method + credential id
    // they're approving when this fetch is staged. Without it the admin
    // would see only "Approve ACT-XXXXXX for credentials_authenticated_fetch".
    registerActionDescriber("credentials_authenticated_fetch", (args) => {
        const a = args as { credential_id?: string; url?: string; method?: string };
        if (!a.credential_id || !a.url) return null;
        return `Credential:  ${a.credential_id}\n` +
               `Method:      ${a.method ?? "GET"}\n` +
               `URL:         ${a.url}`;
    });

    // LLM-callable HTTP tool — performs the request with the stored credential
    // injected as Authorization header in the Node process. The LLM never
    // sees the secret bytes. Replaces the legacy credentials_get_auth_header
    // tool, which returned the bearer token directly to LLM context (a leak
    // surface even with the output-redactor backstop).
    pi.registerTool({
        name: "credentials_authenticated_fetch",
        label: "Authenticated HTTP Fetch (credential)",
        description:
            "Make an HTTP request authenticated with a stored credential. The credential's " +
            "auth header is injected server-side; the LLM never sees the raw token bytes. " +
            "Returns the response body as text (truncated to 64KB) plus status + headers.",
        parameters: Type.Object({
            credential_id: Type.String({ description: "Credential id. For GitHub use exactly 'github' — that's the fixed id the built-in github_search_* / github_read / github_read_issue tools look up via getCredentials().has('github'). Other services: 'clickup', 'stripe', etc. — match whatever id was used when running /credentials add." }),
            url: Type.String({ description: "Absolute URL — must be https:// for any external host" }),
            method: Type.Optional(Type.String({ description: "HTTP method (default GET)" })),
            body: Type.Optional(Type.String({ description: "Request body. Pass JSON as a stringified object." })),
            extra_headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional headers to send (Content-Type, Accept, etc.)" })),
        }),
        async execute(_id, params) {
            const url = params.url;
            if (!/^https?:\/\//i.test(url)) {
                return { content: [{ type: "text", text: `URL must start with http(s)://` }], isError: true };
            }
            // Egress allowlist — refuse to send credential-bearing request to
            // a host the admin hasn't pre-approved. Defends against the agent
            // being tricked into sending bearer headers to attacker URLs even
            // when the admin reflexively approves the staging prompt.
            const { getEgressAllowlist } = await import("../../src/core/egressAllowlist.js");
            if (!getEgressAllowlist().allowsCredential(params.credential_id, url)) {
                const allowed = getEgressAllowlist().listCredentialHosts(params.credential_id);
                return {
                    content: [{
                        type: "text",
                        text:
                            `URL host is not on the egress allowlist for credential "${params.credential_id}". ` +
                            `Allowed hosts: [${allowed.join(", ") || "(none — admin must add)"}]. ` +
                            `An admin can add via /egress-allow credential ${params.credential_id} <host>.`,
                    }],
                    isError: true,
                };
            }
            const auth = creds.getAuthHeader(params.credential_id);
            const headers: Record<string, string> = { ...auth, ...(params.extra_headers ?? {}) };
            const init: RequestInit = {
                method: params.method ?? "GET",
                headers,
                ...(params.body !== undefined ? { body: params.body } : {}),
            };
            const res = await fetch(url, init);
            const buf = await res.arrayBuffer();
            const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
            const truncated = text.length > 64_000 ? text.slice(0, 64_000) + `\n…[truncated, full size ${text.length} chars]` : text;
            const respHeaders: Record<string, string> = {};
            res.headers.forEach((v, k) => { respHeaders[k] = v; });
            return {
                content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n\n${truncated}` }],
                details: { status: res.status, url, method: init.method, response_headers: respHeaders, response_bytes: buf.byteLength },
            };
        },
    });
}

// ---------------- subcommand handlers ----------------

function doHelp(ctx: ExtensionContext): void {
    const lines = [
        "═════════════════════════════════════════════════════════════",
        "  /credentials — service-token store",
        "═════════════════════════════════════════════════════════════",
        "",
        "WHAT THIS DOES",
        "  Stores paste-a-token credentials for service integrations that",
        "  don't use OAuth (or where the operator prefers not to). Examples:",
        "  GitHub PATs, ClickUp tokens, Slack bot tokens, Notion integration",
        "  tokens, Linear keys, Stripe keys, SendGrid/Mailgun keys.",
        "",
        "  Companion to /oauth: OAuth handles flow-based delegated access",
        "  with refresh; credentials handles static secrets the user just",
        "  pastes in. Tools call getCredentials().getAuthHeader(id) and the",
        "  right Authorization header is built automatically.",
        "",
        "STORAGE",
        "  data/<BOT>/credentials.json (mode 0600, atomic writes, gitignored).",
        "",
        "AUTH TYPES",
        "  bearer  — Authorization: Bearer <secret>             (most APIs)",
        "  basic   — Authorization: Basic base64(user:secret)   (legacy APIs)",
        "  header  — <custom-header>: <secret>                  (e.g. X-API-Key)",
        "  raw     — no header, caller does its own thing       (signed URLs etc.)",
        "",
        "SECURITY MODEL",
        "  - All mutating subcommands require admin role.",
        "  - Chat-based add/rotate is INTERCEPTED at the transport layer:",
        "    the secret is processed and stored without ever entering Pi's",
        "    LLM context or session log. Confirmation goes back via the",
        "    same chat channel.",
        "  - /credentials get prints the secret to chat — admin-only AND",
        "    rejected from non-CLI contexts. Use /credentials info for",
        "    metadata only.",
        "",
        "QUICK START — GITHUB PAT",
        "  1. Generate a token at https://github.com/settings/tokens",
        "     (classic or fine-grained). Copy.",
        "  2. /credentials add github ghp_xxxxxxxxxxxxxxxxx --provider github --note \"marketing repo\"",
        "     NOTE: the credential id MUST be 'github' — that's the fixed key the",
        "     built-in github_search_* / github_read / github_read_issue tools read.",
        "     Using any other id (e.g. 'github_pat', 'my_token') makes those tools",
        "     return the no-PAT guidance and refuse to fetch.",
        "  3. Confirm: /credentials info github",
        "  4. Future evolved tools call:",
        "       const auth = await getCredentials().getAuthHeader(\"github\");",
        "       await fetch(url, { headers: { ...auth, ... } });",
        "",
        "QUICK START — CLICKUP",
        "  1. https://app.clickup.com/settings/apps → Generate Personal Token. Copy.",
        "  2. /credentials add clickup pk_xxxxxxx --provider clickup",
        "",
        "QUICK START — STRIPE",
        "  1. https://dashboard.stripe.com/apikeys → reveal Secret key. Copy.",
        "  2. /credentials add stripe sk_live_xxxxxxx --provider stripe --note \"prod\"",
        "",
        "QUICK START — CUSTOM HEADER (e.g. SendGrid uses Bearer too — but if you had",
        "an X-API-Key style API):",
        "  /credentials add-header internal_api X-API-Key abcdef123 --provider internal_api",
        "",
        "ALL SUBCOMMANDS",
        "  /credentials help                                            — this message",
        "  /credentials list                                            — metadata-only listing (no secrets)",
        "  /credentials info <id>                                       — single credential's metadata",
        "  /credentials get <id>                                        — print secret (admin + CLI only)",
        "  /credentials add <id> <secret> [--provider P] [--note \"...\"] — bearer credential",
        "  /credentials add-basic <id> <username> <secret> [flags]      — HTTP Basic credential",
        "  /credentials add-header <id> <header-name> <secret> [flags]  — custom-header credential",
        "  /credentials rotate <id> <new-secret>                        — replace secret only",
        "  /credentials remove <id>                                     — delete the credential",
        "  /credentials set-note <id> <text...>                         — update the note",
        "  /credentials set-provider <id> <provider>                    — update the provider tag",
        "",
        "WHO CAN RUN WHAT",
        "  Read-only (any whitelisted user): help, list, info.",
        "  Admin: add, add-basic, add-header, rotate, remove, set-note, set-provider.",
        "  Admin + CLI-only: get.",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

function doList(ctx: ExtensionContext): void {
    const items = creds.list();
    if (items.length === 0) {
        ctx.ui.notify("No credentials stored. Run /credentials help for examples.", "info");
        return;
    }
    const lines = ["Credentials (metadata only — secrets never logged):", ""];
    for (const c of items) {
        const ageStr = `added ${fmtAge(c.added_at)} ago by ${c.added_by}`;
        const rotateStr = c.rotated_at ? `, rotated ${fmtAge(c.rotated_at)} ago` : "";
        const noteStr = c.note ? `  note: "${c.note}"` : "";
        lines.push(`  ${c.id.padEnd(20)} provider=${c.provider.padEnd(14)} ${fmtAuthDetail(c).padEnd(28)} ${ageStr}${rotateStr}${noteStr}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doInfo(ctx: ExtensionContext, parts: string[]): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /credentials info <id>", "error"); return; }
    const info = creds.info(id);
    if (!info) { ctx.ui.notify(`"${id}" not found.`, "error"); return; }
    const lines = [
        `Credential: ${info.id}`,
        `  provider:   ${info.provider}`,
        `  auth_type:  ${fmtAuthDetail(info)}`,
        `  added:      ${new Date(info.added_at).toISOString()} by ${info.added_by}`,
    ];
    if (info.rotated_at) lines.push(`  rotated:    ${new Date(info.rotated_at).toISOString()}`);
    if (info.note)       lines.push(`  note:       ${info.note}`);
    lines.push(`  secret:     <stored — use /credentials get ${info.id} from CLI to view>`);
    ctx.ui.notify(lines.join("\n"), "info");
}

function doGet(ctx: ExtensionContext, parts: string[]): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /credentials get <id>", "error"); return; }
    if (!isAdminCaller(ctx)) { ctx.ui.notify("Only admins can run /credentials get.", "error"); return; }
    if (!isCliCaller(ctx)) {
        ctx.ui.notify(
            "/credentials get only runs from the CLI to keep the secret out of chat logs. " +
            "SSH into the bot and run it from the terminal.",
            "error",
        );
        return;
    }
    try {
        const secret = creds.get(id);
        ctx.ui.notify(`Secret for ${id}:\n${secret}`, "info");
    } catch (e) {
        ctx.ui.notify(e instanceof Error ? e.message : String(e), "error");
    }
}

// CLI-side add handlers. Chat-side is intercepted by the dispatcher pre-hook above.
function doAddBearer(ctx: ExtensionContext, args: string): void {
    if (!isCliCaller(ctx)) {
        // Shouldn't happen — dispatcher pre-hook handles chat. Defensive.
        ctx.ui.notify("Chat-side /credentials add is handled at the transport layer; reaching here means a wiring bug.", "error");
        return;
    }
    const tokens = tokenizeRespectingQuotes(args).slice(1); // drop the "add" subcommand
    const [id, secret, ...flags] = tokens;
    if (!id || !secret) {
        ctx.ui.notify("Usage: /credentials add <id> <secret> [--provider <p>] [--note \"...\"]", "error");
        return;
    }
    const opts = parseAddFlags(flags);
    creds.add({ id, secret, addedBy: "cli", ...opts });
    ctx.ui.notify(`✅ Added credential "${id}" (provider=${opts.provider ?? id}, auth_type=bearer).`, "info");
}

function doAddBasic(ctx: ExtensionContext, args: string): void {
    if (!isCliCaller(ctx)) {
        ctx.ui.notify("Chat-side /credentials add-basic is handled at the transport layer; reaching here means a wiring bug.", "error");
        return;
    }
    const tokens = tokenizeRespectingQuotes(args).slice(1);
    const [id, username, secret, ...flags] = tokens;
    if (!id || !username || !secret) {
        ctx.ui.notify("Usage: /credentials add-basic <id> <username> <secret> [--provider <p>] [--note \"...\"]", "error");
        return;
    }
    const opts = parseAddFlags(flags);
    creds.add({ id, secret, username, auth_type: "basic", addedBy: "cli", ...opts });
    ctx.ui.notify(`✅ Added credential "${id}" (auth_type=basic, user=${username}).`, "info");
}

function doAddHeader(ctx: ExtensionContext, args: string): void {
    if (!isCliCaller(ctx)) {
        ctx.ui.notify("Chat-side /credentials add-header is handled at the transport layer; reaching here means a wiring bug.", "error");
        return;
    }
    const tokens = tokenizeRespectingQuotes(args).slice(1);
    const [id, headerName, secret, ...flags] = tokens;
    if (!id || !headerName || !secret) {
        ctx.ui.notify("Usage: /credentials add-header <id> <header-name> <secret> [--provider <p>] [--note \"...\"]", "error");
        return;
    }
    const opts = parseAddFlags(flags);
    creds.add({ id, secret, header_name: headerName, auth_type: "header", addedBy: "cli", ...opts });
    ctx.ui.notify(`✅ Added credential "${id}" (auth_type=header, ${headerName}: ***).`, "info");
}

function doRotate(ctx: ExtensionContext, args: string): void {
    if (!isCliCaller(ctx)) {
        ctx.ui.notify("Chat-side /credentials rotate is handled at the transport layer; reaching here means a wiring bug.", "error");
        return;
    }
    const tokens = tokenizeRespectingQuotes(args).slice(1);
    const [id, secret] = tokens;
    if (!id || !secret) {
        ctx.ui.notify("Usage: /credentials rotate <id> <new-secret>", "error");
        return;
    }
    if (!creds.has(id)) {
        ctx.ui.notify(`"${id}" not found.`, "error");
        return;
    }
    creds.rotate(id, secret, "cli");
    ctx.ui.notify(`✅ Rotated credential "${id}".`, "info");
}

function doRemove(ctx: ExtensionContext, parts: string[]): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /credentials remove <id>", "error"); return; }
    const ok = creds.remove(id);
    ctx.ui.notify(ok ? `Removed "${id}".` : `"${id}" not found.`, "info");
}

function doSetNote(ctx: ExtensionContext, args: string): void {
    const tokens = tokenizeRespectingQuotes(args).slice(1);
    const [id, ...rest] = tokens;
    if (!id) { ctx.ui.notify("Usage: /credentials set-note <id> <text...>", "error"); return; }
    const note = rest.join(" ");
    const ok = creds.setNote(id, note || undefined);
    ctx.ui.notify(ok ? `Updated note for "${id}".` : `"${id}" not found.`, "info");
}

function doSetProvider(ctx: ExtensionContext, parts: string[]): void {
    const id = parts[1];
    const provider = parts[2];
    if (!id || !provider) { ctx.ui.notify("Usage: /credentials set-provider <id> <provider>", "error"); return; }
    const ok = creds.setProvider(id, provider);
    ctx.ui.notify(ok ? `Set provider for "${id}" to "${provider}".` : `"${id}" not found.`, "info");
}
