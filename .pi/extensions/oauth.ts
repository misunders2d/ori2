import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { currentOrigin } from "../../src/core/identity.js";
import {
    BUILTIN_TEMPLATES,
    extractAuthCodeFromUrl,
    getOAuth,
    OAuthAuthorizationPending,
    OAuthError,
    OAuthSlowDown,
} from "../../src/core/oauth.js";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import { getWhitelist } from "../../src/core/whitelist.js";

// =============================================================================
// oauth — Pi extension exposing OAuth slash commands and the LLM-callable
// access-token tool.
//
// All slash commands are admin-gated (the admin_gate extension's pre-dispatch
// hook funnels through whitelist roles, but slash commands themselves bypass
// that — so we explicitly check isAdmin in each handler).
//
// Auth-code flow uses paste-back: bot prints the auth URL, user opens in
// their browser, completes consent, copies the FULL redirect URL, runs
// /oauth callback <url>. We extract `code` from the URL's query string and
// exchange it for tokens. No tunnel, no callback server.
//
// Device-code flow runs a background poller. On success/failure the
// extension routes a notification back to the channel where /oauth connect
// was invoked, via the dispatcher's existing send() method.
// =============================================================================

const oauth = getOAuth();
const dispatcher = getDispatcher();
const whitelist = getWhitelist();

// In-memory state for in-flight Device Code polls + Auth Code+PKCE handoffs.
// Lost on process restart — that's fine; device codes expire quickly anyway,
// the operator just retries.
interface PendingDeviceFlow {
    platformId: string;
    deviceCode: string;
    expiresAt: number;
    interval: number;     // seconds, may be bumped on slow_down
    originPlatform: string;
    originChannelId: string;
    timer: NodeJS.Timeout | null;
}
interface PendingAuthCodeFlow {
    platformId: string;
    verifier: string;
    state: string;
    redirectUri: string;
    expiresAt: number;
}
const pendingDevice = new Map<string, PendingDeviceFlow>();
const pendingAuthCode = new Map<string, PendingAuthCodeFlow>();

function isAdminCaller(ctx: { sessionManager: import("@mariozechner/pi-coding-agent").ExtensionContext["sessionManager"] }): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI fallback — operator at terminal
    return whitelist.isAdmin(origin.platform, origin.senderId);
}

async function notifyOriginatingChannel(
    originPlatform: string,
    originChannelId: string,
    text: string,
): Promise<void> {
    if (originPlatform === "cli") {
        // CLI runs in foreground TUI; just log.
        console.log(`[oauth] ${text}`);
        return;
    }
    try {
        await dispatcher.send(originPlatform, originChannelId, { text });
    } catch (e) {
        // Use dynamic require — the oauth extension loads early and this is
        // only reached at OAuth completion/failure, so no perf concern.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { logError } = require("../../src/core/errorLog.js") as typeof import("../../src/core/errorLog.js");
        logError("oauth", `failed to notify ${originPlatform}:${originChannelId}`, { err: e instanceof Error ? e.message : String(e) });
    }
}

// ---------- Device Code polling ----------

function schedulePoll(flow: PendingDeviceFlow): void {
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = setTimeout(() => { void runPoll(flow); }, flow.interval * 1000);
}

async function runPoll(flow: PendingDeviceFlow): Promise<void> {
    flow.timer = null;
    if (Date.now() > flow.expiresAt) {
        pendingDevice.delete(flow.platformId);
        await notifyOriginatingChannel(
            flow.originPlatform,
            flow.originChannelId,
            `❌ /oauth connect ${flow.platformId}: device code expired before authorization completed. Try /oauth connect ${flow.platformId} again.`,
        );
        return;
    }
    try {
        const tokens = await oauth.pollDeviceFlow(flow.platformId, flow.deviceCode);
        pendingDevice.delete(flow.platformId);
        const expIn = tokens.expires_at != null
            ? Math.round((tokens.expires_at - Date.now()) / 1000) + "s"
            : "(no expiry)";
        await notifyOriginatingChannel(
            flow.originPlatform,
            flow.originChannelId,
            `✅ /oauth connect ${flow.platformId}: connected. ` +
            `Scopes granted: ${tokens.scope ?? "(none reported)"}. ` +
            `Access token expires: ${expIn}.`,
        );
    } catch (e) {
        if (e instanceof OAuthAuthorizationPending) {
            // Still waiting on the user — keep polling.
            schedulePoll(flow);
            return;
        }
        if (e instanceof OAuthSlowDown) {
            flow.interval = Math.min(flow.interval + 5, 30);
            schedulePoll(flow);
            return;
        }
        pendingDevice.delete(flow.platformId);
        const reason = e instanceof OAuthError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
        await notifyOriginatingChannel(
            flow.originPlatform,
            flow.originChannelId,
            `❌ /oauth connect ${flow.platformId}: ${reason}`,
        );
    }
}

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
    pi.registerCommand("oauth", {
        description:
            "OAuth integration management. Run /oauth help for full subcommand reference + examples.",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "help").toLowerCase();

            // All mutations require admin. `list`, `status`, `scopes`, `help` are read-only.
            const mutating = !["list", "status", "scopes", "help"].includes(sub);
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /oauth " + sub + ".", "error");
                return;
            }

            switch (sub) {
                case "help":      return doHelp(ctx);
                case "list":      return doList(ctx);
                case "register":  return doRegister(ctx, parts);
                case "register-custom": return doRegisterCustom(ctx, parts);
                case "connect":   return doConnect(ctx, parts);
                case "callback":  return doCallback(ctx, parts);
                case "disconnect": return doDisconnect(ctx, parts);
                case "status":    return doStatus(ctx, parts);
                case "scopes":    return doScopes(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /oauth subcommand: ${sub}. Run /oauth help.`, "error");
            }
        },
    });

    // LLM-callable HTTP tool — performs the request with the OAuth access token
    // injected as Authorization: Bearer in the Node process. Token is auto-
    // refreshed if expired. The LLM never sees the token bytes. Replaces the
    // legacy oauth_get_access_token, which returned the token to LLM context.
    pi.registerTool({
        name: "oauth_authenticated_fetch",
        label: "Authenticated HTTP Fetch (OAuth)",
        description:
            "Make an HTTP request authenticated with a stored OAuth access token. The Bearer " +
            "header is injected server-side and auto-refreshed if expired; the LLM never sees " +
            "the raw token bytes. Returns the response body as text (truncated to 64KB) " +
            "plus status + headers.",
        parameters: Type.Object({
            platform: Type.String({ description: "Platform id (e.g. 'google', 'github')" }),
            url: Type.String({ description: "Absolute URL — must be https://" }),
            method: Type.Optional(Type.String({ description: "HTTP method (default GET)" })),
            body: Type.Optional(Type.String({ description: "Request body. Pass JSON as a stringified object." })),
            extra_headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Additional headers (Content-Type, Accept, etc.)" })),
        }),
        async execute(_id, params) {
            if (!/^https?:\/\//i.test(params.url)) {
                return { content: [{ type: "text", text: `URL must start with http(s)://` }], isError: true };
            }
            const token = await oauth.getAccessToken(params.platform);
            const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(params.extra_headers ?? {}) };
            const init: RequestInit = {
                method: params.method ?? "GET",
                headers,
                ...(params.body !== undefined ? { body: params.body } : {}),
            };
            const res = await fetch(params.url, init);
            const buf = await res.arrayBuffer();
            const text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
            const truncated = text.length > 64_000 ? text.slice(0, 64_000) + `\n…[truncated, full size ${text.length} chars]` : text;
            const respHeaders: Record<string, string> = {};
            res.headers.forEach((v, k) => { respHeaders[k] = v; });
            return {
                content: [{ type: "text", text: `HTTP ${res.status} ${res.statusText}\n\n${truncated}` }],
                details: { status: res.status, platform: params.platform, url: params.url, method: init.method, response_headers: respHeaders, response_bytes: buf.byteLength },
            };
        },
    });
}

// ---------- subcommand handlers ----------

function doHelp(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext): void {
    const builtins = Object.keys(BUILTIN_TEMPLATES);
    const lines = [
        "═════════════════════════════════════════════════════════════",
        "  OAuth integration help",
        "═════════════════════════════════════════════════════════════",
        "",
        "WHAT THIS DOES",
        "  Connects ori2 to OAuth-protected services (Google, GitHub,",
        "  etc.) so evolved tools can call APIs on your behalf. Tokens",
        "  are stored encrypted-at-rest-by-permission (mode 0600) under",
        "  data/<bot>/oauth_tokens.json and auto-refreshed on use.",
        "",
        "DO I NEED TO CREATE AN OAUTH APP MYSELF?",
        "  Yes for now — OAuth providers (Google/GitHub/etc.) require",
        "  the requesting app to be registered. ori2 is open-source and",
        "  can't ship shared client credentials.",
        "",
        "  Workarounds:",
        "    • Personal Access Tokens (PATs): many services support",
        "      simple paste-a-token auth — GitHub PATs, ClickUp tokens,",
        "      Slack bot tokens, Notion integration tokens, Linear keys,",
        "      Stripe keys, Mailgun/SendGrid keys. No OAuth dance needed.",
        "      A `/credentials` slash command for managing these is",
        "      planned for a follow-up sprint. Until then, store them",
        "      in the vault directly: vault entries are read by tools",
        "      via the existing getVault() API.",
        "    • Google specifically requires a Google Cloud project. The",
        "      project is free, one-time, and takes ~5 minutes:",
        "        1. https://console.cloud.google.com → Create project",
        "        2. APIs & Services → Credentials → Create Credentials",
        "           → OAuth client ID → Desktop App",
        "        3. Copy the client_id (and client_secret if shown).",
        "    • GitHub: https://github.com/settings/developers → New OAuth",
        "      App. Tick 'Enable Device Flow'. ~2 minutes.",
        "",
        "TWO OAUTH FLOWS SUPPORTED",
        "",
        "  1. DEVICE CODE flow (default, recommended for headless VPS)",
        "     • Bot prints a code + URL.",
        "     • You open the URL on any device (phone, laptop) and enter",
        "       the code. No browser needed on the bot's machine.",
        "     • Bot polls in the background until you complete consent.",
        "     • Used automatically when the platform's `flow` is",
        "       'device_code' (Google + GitHub built-in templates use this).",
        "",
        "  2. AUTHORIZATION CODE + PKCE flow (fallback)",
        "     • Bot prints an auth URL.",
        "     • You open it in any browser, sign in, approve.",
        "     • You get redirected to a URL (may show 'page not found' —",
        "       that's expected for the paste-back redirect_uri).",
        "     • Copy the FULL redirect URL from the address bar and run",
        "       /oauth callback <full_url>.",
        "     • Bot extracts the code and exchanges it for tokens.",
        "     • No callback server, no Cloudflare tunnel needed.",
        "",
        "BUILT-IN PLATFORM TEMPLATES",
        `  Available: ${builtins.join(", ")}`,
        "  Each template has the endpoint URLs + default scopes baked in,",
        "  so you only supply credentials. For other providers, edit",
        "  data/<BOT>/oauth_platforms.json directly (full schema in",
        "  src/core/oauth.ts:OAuthPlatformConfig).",
        "",
        "QUICK START — GOOGLE GMAIL + DRIVE",
        "  1. Create a Google Cloud OAuth Desktop App (link above), copy",
        "     client_id + client_secret.",
        "  2. /oauth register google <client_id> <client_secret>",
        "  3. /oauth connect google \\",
        "       https://www.googleapis.com/auth/gmail.send \\",
        "       https://www.googleapis.com/auth/drive.file",
        "  4. Bot prints: 'Visit https://www.google.com/device, code WXYZ-ABCD'.",
        "     Open it on your phone, sign in to your Google account, approve.",
        "  5. Bot posts confirmation in this channel when authorization completes.",
        "  6. Future evolved tools (gmail_send, drive_upload) call",
        "     getOAuth().getAccessToken('google') internally — auto-refresh.",
        "",
        "QUICK START — GITHUB",
        "  1. Create a GitHub OAuth App at github.com/settings/developers,",
        "     tick 'Enable Device Flow'. Copy client_id (+ secret if shown).",
        "  2. /oauth register github <client_id> [<client_secret>]",
        "  3. /oauth connect github repo workflow",
        "  4. Bot prints: 'Visit https://github.com/login/device, code XXXX-XXXX'.",
        "  5. Approve, bot posts confirmation.",
        "",
        "QUICK START — CUSTOM PROVIDER",
        "  Run /oauth register-custom (no args) for the full field reference.",
        "  Short form:",
        "    /oauth register-custom id=<x> name=<X> flow=<device_code|auth_code_pkce> \\",
        "      client_id=... token_endpoint=https://... default_scope=s1,s2 \\",
        "      refresh_supported=true \\",
        "      device_authorization_endpoint=...   OR authorization_endpoint=...",
        "  Then: /oauth connect <id>",
        "",
        "ALL SUBCOMMANDS",
        "  /oauth help                                — this message",
        "  /oauth list                                — show registered platforms + connection state",
        "  /oauth register <id> <client_id> [<secret>] — register from a built-in template",
        "  /oauth register-custom <key=value...>      — register a non-built-in provider",
        "  /oauth connect <id> [scope1 scope2 ...]    — start the platform's flow",
        "  /oauth callback <full_redirect_url>        — paste back for Auth Code flow",
        "  /oauth disconnect <id>                     — clear tokens (keeps registration)",
        "  /oauth status <id>                         — flow type, expiry, scope, refresh state",
        "  /oauth scopes <id>                         — list granted scopes",
        "",
        "WHO CAN RUN WHAT",
        "  Read-only (anyone whitelisted can run): list, status, scopes, help.",
        "  Mutations (admin only): register, register-custom, connect,",
        "    callback, disconnect.",
        "",
        "TOKEN STORAGE",
        "  data/<BOT>/oauth_platforms.json — registrations (mode 0600)",
        "  data/<BOT>/oauth_tokens.json    — tokens (mode 0600)",
        "  Both atomic-write, fail-loud on corruption. Both gitignored.",
        "",
        "═════════════════════════════════════════════════════════════",
    ];
    ctx.ui.notify(lines.join("\n"), "info");
}

function doList(ctx: import("@mariozechner/pi-coding-agent").ExtensionContext): void {
    const platforms = oauth.listStatus();
    if (platforms.length === 0) {
        const builtins = Object.keys(BUILTIN_TEMPLATES).join(", ");
        ctx.ui.notify(
            `No OAuth platforms registered.\n\nBuilt-in templates available: ${builtins}\n` +
            `Register one with: /oauth register <id> <client_id> [<client_secret>]`,
            "info",
        );
        return;
    }
    const lines = ["OAuth platforms:", ""];
    for (const p of platforms) {
        const conn = p.connected ? "✓ connected" : "○ not connected";
        const expiry = p.expires_in_seconds != null
            ? (p.expires_in_seconds > 0 ? `expires in ${p.expires_in_seconds}s` : `EXPIRED ${-p.expires_in_seconds}s ago`)
            : "(no expiry)";
        lines.push(`  ${p.id.padEnd(14)} ${p.flow.padEnd(16)} ${conn}${p.connected ? `  ${expiry}` : ""}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doRegister(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): void {
    const id = parts[1];
    const clientId = parts[2];
    const clientSecret = parts[3];
    if (!id || !clientId) {
        const builtins = Object.keys(BUILTIN_TEMPLATES).join(", ");
        ctx.ui.notify(
            `Usage: /oauth register <id> <client_id> [<client_secret>]\n` +
            `Built-in templates: ${builtins}\n` +
            `For custom platforms use /oauth register-custom.`,
            "error",
        );
        return;
    }
    const tmpl = BUILTIN_TEMPLATES[id];
    if (!tmpl) {
        ctx.ui.notify(
            `No built-in template for "${id}". Built-in: ${Object.keys(BUILTIN_TEMPLATES).join(", ")}. ` +
            `Use /oauth register-custom for other providers.`,
            "error",
        );
        return;
    }
    try {
        oauth.register({
            id,
            client_id: clientId,
            ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
        });
        ctx.ui.notify(
            `Registered ${tmpl.name} (id=${id}, flow=${tmpl.flow}).\n` +
            (tmpl.note ? `Note: ${tmpl.note}\n` : "") +
            `Now run: /oauth connect ${id} [optional scopes]`,
            "info",
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Registration failed: ${msg}`, "error");
    }
}

/**
 * Parse `key=value key=value ...` arg syntax. Values never contain spaces in
 * practice for OAuth platform fields (URLs, scope names, ids), so a simple
 * whitespace split is sufficient. Commas inside a value are preserved — the
 * caller decides whether to split (we split `default_scope` on commas; other
 * fields stay as-is).
 */
function parseKeyValueArgs(parts: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const raw of parts) {
        const eq = raw.indexOf("=");
        if (eq <= 0) continue;
        const key = raw.slice(0, eq).trim();
        const value = raw.slice(eq + 1).trim();
        if (key && value) out[key] = value;
    }
    return out;
}

function parseBoolean(v: string | undefined, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    const lower = v.toLowerCase();
    if (["true", "yes", "y", "1"].includes(lower)) return true;
    if (["false", "no", "n", "0"].includes(lower)) return false;
    return fallback;
}

function doRegisterCustom(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): void {
    // parts[0] is "register-custom"; skip it.
    const args = parseKeyValueArgs(parts.slice(1));

    // Short-help when no args.
    if (Object.keys(args).length === 0) {
        const lines = [
            "Usage: /oauth register-custom key=value key=value ...",
            "",
            "REQUIRED fields (both flows):",
            "  id=<stable-identifier>                e.g. id=clickup",
            "  name=<human-readable-name>            e.g. name=ClickUp",
            "  flow=<device_code|auth_code_pkce>",
            "  client_id=<oauth-client-id>",
            "  token_endpoint=<https://...>          e.g. https://api.clickup.com/api/v2/oauth/token",
            "  default_scope=<scope1,scope2,...>     comma-separated, no spaces",
            "  refresh_supported=<true|false>",
            "",
            "DEVICE-CODE FLOW additionally requires:",
            "  device_authorization_endpoint=<https://...>",
            "",
            "AUTH-CODE+PKCE FLOW additionally requires:",
            "  authorization_endpoint=<https://...>",
            "  redirect_uri=<urn:ietf:params:oauth:2.0:oob|https://...>   (recommend urn:... for headless)",
            "",
            "OPTIONAL:",
            "  client_secret=<oauth-client-secret>    omit for public-client Device Code flows",
            "  note=<free-form-note>                  metadata for the operator",
            "",
            "EXAMPLE (auth_code_pkce, paste-back):",
            "  /oauth register-custom id=clickup name=ClickUp flow=auth_code_pkce \\",
            "    client_id=ABC client_secret=xyz \\",
            "    authorization_endpoint=https://app.clickup.com/api \\",
            "    token_endpoint=https://api.clickup.com/api/v2/oauth/token \\",
            "    default_scope=read,write refresh_supported=false \\",
            "    redirect_uri=urn:ietf:params:oauth:2.0:oob",
            "",
            "After registration → /oauth connect <id>",
        ];
        ctx.ui.notify(lines.join("\n"), "info");
        return;
    }

    // Validate required fields.
    const required = ["id", "name", "flow", "client_id", "token_endpoint", "default_scope"];
    const missing = required.filter((k) => !args[k]);
    if (missing.length > 0) {
        ctx.ui.notify(
            `Missing required field(s): ${missing.join(", ")}. Run /oauth register-custom (no args) for the full reference.`,
            "error",
        );
        return;
    }
    const flow = args["flow"]!;
    if (flow !== "device_code" && flow !== "auth_code_pkce") {
        ctx.ui.notify(`flow must be 'device_code' or 'auth_code_pkce' (got '${flow}').`, "error");
        return;
    }
    if (flow === "device_code" && !args["device_authorization_endpoint"]) {
        ctx.ui.notify("device_code flow requires device_authorization_endpoint=<url>.", "error");
        return;
    }
    if (flow === "auth_code_pkce" && !args["authorization_endpoint"]) {
        ctx.ui.notify("auth_code_pkce flow requires authorization_endpoint=<url>.", "error");
        return;
    }

    const id = args["id"]!;
    if (BUILTIN_TEMPLATES[id]) {
        ctx.ui.notify(
            `id='${id}' collides with a built-in template. Use /oauth register ${id} <client_id> instead, ` +
            "or pick a different id for your custom registration.",
            "error",
        );
        return;
    }

    const defaultScope = args["default_scope"]!.split(",").map((s) => s.trim()).filter(Boolean);
    if (defaultScope.length === 0) {
        ctx.ui.notify("default_scope must contain at least one scope (comma-separated).", "error");
        return;
    }

    const cfg = {
        id,
        name: args["name"]!,
        flow: flow as "device_code" | "auth_code_pkce",
        client_id: args["client_id"]!,
        token_endpoint: args["token_endpoint"]!,
        default_scope: defaultScope,
        refresh_supported: parseBoolean(args["refresh_supported"], false),
        ...(args["client_secret"] !== undefined ? { client_secret: args["client_secret"] } : {}),
        ...(args["device_authorization_endpoint"] !== undefined
            ? { device_authorization_endpoint: args["device_authorization_endpoint"] }
            : {}),
        ...(args["authorization_endpoint"] !== undefined
            ? { authorization_endpoint: args["authorization_endpoint"] }
            : {}),
        ...(args["redirect_uri"] !== undefined ? { redirect_uri: args["redirect_uri"] } : {}),
        ...(args["note"] !== undefined ? { note: args["note"] } : {}),
    };

    try {
        oauth.registerCustom(cfg);
        ctx.ui.notify(
            `✅ Registered custom platform "${cfg.name}" (id=${cfg.id}, flow=${cfg.flow}).\n` +
            `   Now run: /oauth connect ${cfg.id}`,
            "info",
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Registration failed: ${msg}`, "error");
    }
}

async function doConnect(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): Promise<void> {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /oauth connect <id> [scope1 scope2 ...]", "error"); return; }
    const platform = oauth.getPlatform(id);
    if (!platform) {
        ctx.ui.notify(`"${id}" is not registered. Run /oauth register ${id} <client_id> first.`, "error");
        return;
    }
    const scope = parts.slice(2).filter(Boolean);

    const origin = currentOrigin(ctx.sessionManager);
    const originPlatform = origin?.platform ?? "cli";
    const originChannelId = origin?.channelId ?? "cli:default";

    if (platform.flow === "device_code") {
        try {
            const flow = await oauth.startDeviceFlow(id, scope.length > 0 ? scope : undefined);
            const verifyUri = flow.verification_uri_complete ?? flow.verification_uri;
            ctx.ui.notify(
                `📱 ${platform.name} OAuth — Device Code flow started.\n\n` +
                `   Open this URL in any browser:\n     ${flow.verification_uri}\n\n` +
                `   Enter this code:\n     ${flow.user_code}\n` +
                (flow.verification_uri_complete ? `\n   Or use the combined URL (skips manual entry):\n     ${verifyUri}\n` : "") +
                `\n   Background polling started (interval=${flow.interval}s, expires in ${flow.expires_in}s).\n` +
                `   You'll receive a confirmation in this channel when authorization completes.`,
                "info",
            );
            const pending: PendingDeviceFlow = {
                platformId: id,
                deviceCode: flow.device_code,
                expiresAt: Date.now() + flow.expires_in * 1000,
                interval: flow.interval,
                originPlatform,
                originChannelId,
                timer: null,
            };
            pendingDevice.set(id, pending);
            schedulePoll(pending);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctx.ui.notify(`Device flow start failed: ${msg}`, "error");
        }
        return;
    }

    // Auth Code+PKCE
    try {
        const flow = oauth.startAuthCodeFlow(id, scope.length > 0 ? scope : undefined);
        pendingAuthCode.set(id, {
            platformId: id,
            verifier: flow.verifier,
            state: flow.state,
            redirectUri: flow.redirect_uri,
            expiresAt: Date.now() + 15 * 60 * 1000, // 15 min to complete consent + paste back
        });
        ctx.ui.notify(
            `🌐 ${platform.name} OAuth — Authorization Code+PKCE flow.\n\n` +
            `   Open this URL in any browser:\n     ${flow.url}\n\n` +
            `   Sign in and approve. After consent you'll be redirected to a URL ` +
            `(it may show as a 'page not found' depending on the redirect_uri).\n` +
            `   Copy the FULL redirect URL from your browser's address bar and paste it back here:\n` +
            `     /oauth callback <FULL_URL>\n\n` +
            `   You have 15 minutes to complete the paste-back.`,
            "info",
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Auth code flow start failed: ${msg}`, "error");
    }
}

async function doCallback(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): Promise<void> {
    const url = parts.slice(1).join(" ");
    if (!url) {
        ctx.ui.notify("Usage: /oauth callback <full_redirect_url>", "error");
        return;
    }
    const extracted = extractAuthCodeFromUrl(url);
    if (!extracted) {
        ctx.ui.notify("Could not parse a `code` query parameter from that URL.", "error");
        return;
    }

    // Find which platform this callback is for. Match on state if present
    // (more secure), otherwise fall back to the most recently started flow.
    let target: PendingAuthCodeFlow | null = null;
    if (extracted.state) {
        for (const pending of pendingAuthCode.values()) {
            if (pending.state === extracted.state) { target = pending; break; }
        }
    }
    if (!target) {
        // Fallback: pick the only pending flow if exactly one.
        const open = Array.from(pendingAuthCode.values()).filter((p) => p.expiresAt > Date.now());
        if (open.length === 1) target = open[0]!;
    }
    if (!target) {
        ctx.ui.notify(
            "No matching pending Auth Code flow. Did you /oauth connect first? Was it within the last 15 minutes?",
            "error",
        );
        return;
    }
    if (target.expiresAt < Date.now()) {
        pendingAuthCode.delete(target.platformId);
        ctx.ui.notify(`Auth code flow for "${target.platformId}" expired. Run /oauth connect ${target.platformId} again.`, "error");
        return;
    }

    try {
        const tokens = await oauth.exchangeAuthCode(target.platformId, {
            code: extracted.code,
            verifier: target.verifier,
            redirect_uri: target.redirectUri,
        });
        pendingAuthCode.delete(target.platformId);
        const expIn = tokens.expires_at != null
            ? Math.round((tokens.expires_at - Date.now()) / 1000) + "s"
            : "(no expiry)";
        ctx.ui.notify(
            `✅ ${target.platformId} connected. Scopes: ${tokens.scope ?? "(none reported)"}. Expires in: ${expIn}.`,
            "info",
        );
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`Token exchange failed: ${msg}`, "error");
    }
}

function doDisconnect(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /oauth disconnect <id>", "error"); return; }
    const ok = oauth.clearTokens(id);
    if (pendingDevice.has(id)) {
        const p = pendingDevice.get(id)!;
        if (p.timer) clearTimeout(p.timer);
        pendingDevice.delete(id);
    }
    pendingAuthCode.delete(id);
    ctx.ui.notify(
        ok ? `Disconnected ${id} (tokens cleared). Platform registration retained — /oauth connect to reconnect.`
           : `${id} had no tokens to clear.`,
        "info",
    );
}

function doStatus(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /oauth status <id>", "error"); return; }
    const platform = oauth.getPlatform(id);
    if (!platform) { ctx.ui.notify(`${id} not registered.`, "error"); return; }
    const tok = oauth.getTokensRaw(id);
    if (!tok) { ctx.ui.notify(`${platform.name} (${id}): registered, NOT connected.`, "info"); return; }
    const expiry = tok.expires_at != null
        ? new Date(tok.expires_at).toISOString() + ` (in ${Math.round((tok.expires_at - Date.now()) / 1000)}s)`
        : "(no expiry)";
    ctx.ui.notify(
        `${platform.name} (${id})\n` +
        `  flow:           ${platform.flow}\n` +
        `  connected:      yes\n` +
        `  expires:        ${expiry}\n` +
        `  scope:          ${tok.scope ?? "(not reported)"}\n` +
        `  refreshable:    ${platform.refresh_supported && !!tok.refresh_token ? "yes" : "no"}\n` +
        `  obtained:       ${new Date(tok.obtained_at).toISOString()}`,
        "info",
    );
}

function doScopes(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): void {
    const id = parts[1];
    if (!id) { ctx.ui.notify("Usage: /oauth scopes <id>", "error"); return; }
    const tok = oauth.getTokensRaw(id);
    if (!tok) { ctx.ui.notify(`${id} not connected.`, "info"); return; }
    const scopes = (tok.scope ?? "").split(/\s+/).filter(Boolean);
    if (scopes.length === 0) { ctx.ui.notify(`${id}: no scopes reported.`, "info"); return; }
    ctx.ui.notify(`${id} granted scopes:\n${scopes.map((s) => `  ${s}`).join("\n")}`, "info");
}
