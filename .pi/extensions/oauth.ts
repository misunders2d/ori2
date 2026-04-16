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
        console.error(`[oauth] failed to notify ${originPlatform}:${originChannelId}:`, e);
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
            "OAuth integration management. Subcommands: list | register <id> <client_id> [<client_secret>] | " +
            "register-custom <id> <flow> <token_url> <client_id> [...] | connect <id> [scope1 scope2 ...] | " +
            "callback <full_redirect_url> | disconnect <id> | status <id> | scopes <id>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();

            // All mutations require admin. `list` and `status` are read-only — let any caller see them.
            const mutating = !["list", "status", "scopes"].includes(sub);
            if (mutating && !isAdminCaller(ctx)) {
                ctx.ui.notify("Only admins can run /oauth " + sub + ".", "error");
                return;
            }

            switch (sub) {
                case "list":      return doList(ctx);
                case "register":  return doRegister(ctx, parts);
                case "register-custom": return doRegisterCustom(ctx, parts);
                case "connect":   return doConnect(ctx, parts);
                case "callback":  return doCallback(ctx, parts);
                case "disconnect": return doDisconnect(ctx, parts);
                case "status":    return doStatus(ctx, parts);
                case "scopes":    return doScopes(ctx, parts);
                default:
                    ctx.ui.notify(`Unknown /oauth subcommand: ${sub}. Try /oauth list.`, "error");
            }
        },
    });

    // Tool the LLM can call to fetch an access token (for tools that wrap an
    // OAuth-protected API). Admin-only by default — evolved tools that need
    // user-level access should set their own ACL.
    //
    // NOTE: this tool returns the access token directly to the LLM context.
    // For high-security platforms, prefer wrapping the API call in a dedicated
    // tool that uses oauth.getAccessToken() internally so the token never
    // enters the LLM's view.
    pi.registerTool({
        name: "oauth_get_access_token",
        label: "Get OAuth Access Token",
        description:
            "Fetch a fresh access token for a registered OAuth platform (auto-refreshes if expired). " +
            "Returns the token verbatim — caller must use it in an Authorization header. " +
            "Prefer wrapping the API call in a dedicated tool to keep tokens out of LLM context.",
        parameters: Type.Object({
            platform: Type.String({ description: "Platform id (e.g. 'google', 'github')" }),
        }),
        async execute(_id, params) {
            const token = await oauth.getAccessToken(params.platform);
            return {
                content: [{ type: "text", text: `OAuth access_token for ${params.platform}: ${token}` }],
                details: { platform: params.platform, token_length: token.length },
            };
        },
    });
}

// ---------- subcommand handlers ----------

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

function doRegisterCustom(
    ctx: import("@mariozechner/pi-coding-agent").ExtensionContext,
    parts: string[],
): void {
    // Minimal version — full custom registration is verbose. Prompt the
    // operator to edit data/<bot>/oauth_platforms.json directly for now.
    void parts;
    ctx.ui.notify(
        "Custom OAuth registration via slash command is not implemented yet.\n" +
        "For now, edit data/<BOT>/oauth_platforms.json directly. Required fields:\n" +
        "  id, name, flow ('device_code' or 'auth_code_pkce'), client_id, token_endpoint,\n" +
        "  default_scope: [...], refresh_supported,\n" +
        "  device_authorization_endpoint (for device_code) OR authorization_endpoint (for auth_code_pkce),\n" +
        "  redirect_uri (auth_code_pkce; recommended 'urn:ietf:params:oauth:2.0:oob' for paste-back).\n" +
        "After saving, /reload and /oauth connect <id>.",
        "info",
    );
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
