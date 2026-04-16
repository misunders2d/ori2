import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { botDir, ensureDir } from "./paths.js";

// =============================================================================
// OAuth2 service — universal Device Code (RFC 8628) + Authorization Code+PKCE
// (RFC 7636) flows. Headless-VPS-first: Device Code is the recommended path,
// requires no callback URL and no browser on the bot's machine.
//
// Operator-bring-your-own-credentials: this codebase is OSS and we cannot
// ship shared client_id/client_secret values for Google/GitHub/etc. The
// operator creates an OAuth app on the provider's side, then runs
// `/oauth register <id> <client_id> [<client_secret>]` to register it here.
// Built-in TEMPLATES define the endpoints + default scopes for known
// providers so the operator only supplies their own credentials.
//
// Two storage files (atomic write, mode 0600, fail-loud on corruption):
//   data/<bot>/oauth_platforms.json — registered platforms (client_id/secret + endpoints)
//   data/<bot>/oauth_tokens.json    — per-platform access/refresh tokens + expiry
//
// Tokens auto-refresh on getAccessToken() if within 60s of expiry, IF the
// platform supports refresh. Otherwise, expired tokens force the operator
// to reconnect.
//
// SECURITY:
//   - Platform/token files are mode 0600.
//   - PKCE verifier is generated per-flow with crypto.randomBytes (not Math.random).
//   - state parameter on Auth Code flows uses crypto.randomBytes.
//   - All HTTP requests use POST with form-urlencoded body (not query string)
//     where applicable, to keep secrets out of access logs.
//   - Tokens are NEVER logged. Errors mention provider names but not values.
// =============================================================================

const FILE_VERSION = 1;
const REFRESH_BUFFER_MS = 60_000; // refresh if token expires within 60s

export type OAuthFlow = "device_code" | "auth_code_pkce";

export interface OAuthPlatformConfig {
    /** Stable identifier (e.g., "google", "github"). */
    id: string;
    /** Human-readable name. */
    name: string;
    flow: OAuthFlow;
    /** Public OAuth client ID. */
    client_id: string;
    /** Optional confidential-client secret. Many Device Code clients are public-only. */
    client_secret?: string;

    /** Required for device_code flow. */
    device_authorization_endpoint?: string;
    /** Required for auth_code_pkce flow. */
    authorization_endpoint?: string;
    /** Required for both. */
    token_endpoint: string;

    /** Scopes to request by default if /oauth connect doesn't specify. */
    default_scope: string[];
    /** True if the provider supports refresh_token grant. */
    refresh_supported: boolean;

    /**
     * For auth_code_pkce only. Use "urn:ietf:params:oauth:2.0:oob" for the
     * paste-back flow we recommend on headless VPS, OR a public callback
     * URL backed by a tunnel/server the operator has configured.
     */
    redirect_uri?: string;

    /** Free-form note for the operator (created when, why). */
    note?: string;
}

export interface OAuthTokens {
    access_token: string;
    refresh_token?: string;
    token_type: string;       // typically "Bearer"
    scope?: string;            // space-separated scopes that were granted
    expires_at: number | null; // epoch ms; null if no expiry advertised
    obtained_at: number;       // epoch ms
}

export interface PlatformStatus {
    id: string;
    name: string;
    flow: OAuthFlow;
    registered: true;
    connected: boolean;
    expires_in_seconds: number | null;
    refresh_supported: boolean;
    scope: string | undefined;
}

interface PlatformsFile {
    version: number;
    updated_at: number;
    platforms: Record<string, OAuthPlatformConfig>;
}

interface TokensFile {
    version: number;
    updated_at: number;
    tokens: Record<string, OAuthTokens>;
}

// ----- Built-in templates -----

interface OAuthPlatformTemplate {
    name: string;
    flow: OAuthFlow;
    device_authorization_endpoint?: string;
    authorization_endpoint?: string;
    token_endpoint: string;
    default_scope: string[];
    refresh_supported: boolean;
    redirect_uri?: string;
    note?: string;
}

export const BUILTIN_TEMPLATES: Record<string, OAuthPlatformTemplate> = {
    google: {
        name: "Google",
        flow: "device_code",
        device_authorization_endpoint: "https://oauth2.googleapis.com/device/code",
        token_endpoint: "https://oauth2.googleapis.com/token",
        default_scope: ["openid", "email", "profile"],
        refresh_supported: true,
        note:
            "Create a Desktop App OAuth client at https://console.cloud.google.com/apis/credentials. " +
            "Default scopes are openid+email+profile; add Drive/Gmail/Calendar scopes per /oauth connect.",
    },
    github: {
        name: "GitHub",
        flow: "device_code",
        device_authorization_endpoint: "https://github.com/login/device/code",
        token_endpoint: "https://github.com/login/oauth/access_token",
        default_scope: ["repo"],
        refresh_supported: false,
        note:
            "Create a GitHub OAuth App at https://github.com/settings/developers (NOT a GitHub App). " +
            "Tick 'Enable Device Flow'. Standard tokens don't refresh — to rotate, /oauth disconnect + /oauth connect.",
    },
};

// ----- File helpers -----

function platformsPath(): string { return path.join(botDir(), "oauth_platforms.json"); }
function tokensPath(): string { return path.join(botDir(), "oauth_tokens.json"); }

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

// ----- Errors -----

export class OAuthError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = "OAuthError";
    }
}
export class OAuthAuthorizationPending extends OAuthError {
    constructor() { super("authorization_pending", "User has not yet completed authorization"); }
}
export class OAuthSlowDown extends OAuthError {
    constructor() { super("slow_down", "Polling too fast — increase interval"); }
}

// ----- Service -----

export class OAuthService {
    private platforms: Map<string, OAuthPlatformConfig> = new Map();
    private tokens: Map<string, OAuthTokens> = new Map();
    private platformsLoaded = false;
    private tokensLoaded = false;

    // ---------- file load/save ----------

    private loadPlatforms(): void {
        if (this.platformsLoaded) return;
        if (fs.existsSync(platformsPath())) {
            const raw = fs.readFileSync(platformsPath(), "utf-8");
            let parsed: unknown;
            try { parsed = JSON.parse(raw); }
            catch (e) { throw new Error(`[oauth] FATAL: oauth_platforms.json corrupt: ${e instanceof Error ? e.message : String(e)}`); }
            const file = parsed as Partial<PlatformsFile>;
            if (!file.platforms || typeof file.platforms !== "object") {
                throw new Error("[oauth] FATAL: oauth_platforms.json missing 'platforms' object");
            }
            for (const [id, cfg] of Object.entries(file.platforms)) {
                if (cfg && typeof cfg === "object" && typeof (cfg as { client_id?: unknown }).client_id === "string") {
                    this.platforms.set(id, cfg as OAuthPlatformConfig);
                }
            }
        }
        this.platformsLoaded = true;
    }

    private savePlatforms(): void {
        const data: PlatformsFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            platforms: Object.fromEntries(this.platforms.entries()),
        };
        atomicWriteJson(platformsPath(), data);
    }

    private loadTokens(): void {
        if (this.tokensLoaded) return;
        if (fs.existsSync(tokensPath())) {
            const raw = fs.readFileSync(tokensPath(), "utf-8");
            let parsed: unknown;
            try { parsed = JSON.parse(raw); }
            catch (e) { throw new Error(`[oauth] FATAL: oauth_tokens.json corrupt: ${e instanceof Error ? e.message : String(e)}`); }
            const file = parsed as Partial<TokensFile>;
            if (!file.tokens || typeof file.tokens !== "object") {
                throw new Error("[oauth] FATAL: oauth_tokens.json missing 'tokens' object");
            }
            for (const [id, tok] of Object.entries(file.tokens)) {
                if (tok && typeof tok === "object" && typeof (tok as { access_token?: unknown }).access_token === "string") {
                    this.tokens.set(id, tok as OAuthTokens);
                }
            }
        }
        this.tokensLoaded = true;
    }

    private saveTokens(): void {
        const data: TokensFile = {
            version: FILE_VERSION,
            updated_at: Date.now(),
            tokens: Object.fromEntries(this.tokens.entries()),
        };
        atomicWriteJson(tokensPath(), data);
    }

    // ---------- platform registry ----------

    /**
     * Register a platform from a built-in template (just supply credentials).
     * If the operator wants a non-built-in provider, use registerCustom.
     */
    register(opts: {
        id: string;
        client_id: string;
        client_secret?: string;
        scope?: string[];
        note?: string;
    }): OAuthPlatformConfig {
        const tmpl = BUILTIN_TEMPLATES[opts.id];
        if (!tmpl) {
            throw new OAuthError(
                "no_template",
                `No built-in template for "${opts.id}". Use registerCustom() or pick from: ${Object.keys(BUILTIN_TEMPLATES).join(", ")}`,
            );
        }
        return this.registerCustom({
            id: opts.id,
            name: tmpl.name,
            flow: tmpl.flow,
            client_id: opts.client_id,
            ...(opts.client_secret !== undefined ? { client_secret: opts.client_secret } : {}),
            ...(tmpl.device_authorization_endpoint !== undefined ? { device_authorization_endpoint: tmpl.device_authorization_endpoint } : {}),
            ...(tmpl.authorization_endpoint !== undefined ? { authorization_endpoint: tmpl.authorization_endpoint } : {}),
            token_endpoint: tmpl.token_endpoint,
            default_scope: opts.scope ?? tmpl.default_scope,
            refresh_supported: tmpl.refresh_supported,
            ...(tmpl.redirect_uri !== undefined ? { redirect_uri: tmpl.redirect_uri } : {}),
            ...(opts.note !== undefined ? { note: opts.note } : tmpl.note !== undefined ? { note: tmpl.note } : {}),
        });
    }

    registerCustom(cfg: OAuthPlatformConfig): OAuthPlatformConfig {
        this.loadPlatforms();
        if (cfg.flow === "device_code" && !cfg.device_authorization_endpoint) {
            throw new OAuthError("missing_endpoint", `device_code flow requires device_authorization_endpoint`);
        }
        if (cfg.flow === "auth_code_pkce" && !cfg.authorization_endpoint) {
            throw new OAuthError("missing_endpoint", `auth_code_pkce flow requires authorization_endpoint`);
        }
        this.platforms.set(cfg.id, cfg);
        this.savePlatforms();
        return cfg;
    }

    unregister(id: string): boolean {
        this.loadPlatforms();
        this.loadTokens();
        const removed = this.platforms.delete(id);
        if (this.tokens.delete(id)) this.saveTokens();
        if (removed) this.savePlatforms();
        return removed;
    }

    getPlatform(id: string): OAuthPlatformConfig | undefined {
        this.loadPlatforms();
        return this.platforms.get(id);
    }

    listPlatforms(): OAuthPlatformConfig[] {
        this.loadPlatforms();
        return Array.from(this.platforms.values());
    }

    listStatus(): PlatformStatus[] {
        this.loadPlatforms();
        this.loadTokens();
        const out: PlatformStatus[] = [];
        for (const p of this.platforms.values()) {
            const tok = this.tokens.get(p.id);
            const expiresIn = tok?.expires_at != null ? Math.round((tok.expires_at - Date.now()) / 1000) : null;
            out.push({
                id: p.id,
                name: p.name,
                flow: p.flow,
                registered: true,
                connected: !!tok,
                expires_in_seconds: expiresIn,
                refresh_supported: p.refresh_supported,
                scope: tok?.scope,
            });
        }
        return out.sort((a, b) => a.id.localeCompare(b.id));
    }

    // ---------- token operations ----------

    getTokensRaw(id: string): OAuthTokens | undefined {
        this.loadTokens();
        return this.tokens.get(id);
    }

    setTokens(id: string, tokens: OAuthTokens): void {
        this.loadTokens();
        this.tokens.set(id, tokens);
        this.saveTokens();
    }

    clearTokens(id: string): boolean {
        this.loadTokens();
        const removed = this.tokens.delete(id);
        if (removed) this.saveTokens();
        return removed;
    }

    /**
     * Fresh access token for `id`. Auto-refreshes if expired. Throws
     * OAuthError("not_connected") if no tokens; OAuthError("refresh_failed")
     * if refresh failed. Caller (typically a tool implementation) should
     * surface the error so the admin knows to reconnect.
     */
    async getAccessToken(id: string): Promise<string> {
        this.loadPlatforms();
        this.loadTokens();
        const platform = this.platforms.get(id);
        if (!platform) throw new OAuthError("not_registered", `Platform "${id}" is not registered. Use /oauth register first.`);
        const tok = this.tokens.get(id);
        if (!tok) throw new OAuthError("not_connected", `Platform "${id}" has no tokens. Use /oauth connect ${id}.`);

        const needsRefresh = tok.expires_at != null && tok.expires_at - REFRESH_BUFFER_MS < Date.now();
        if (!needsRefresh) return tok.access_token;

        if (!platform.refresh_supported || !tok.refresh_token) {
            throw new OAuthError(
                "expired_no_refresh",
                `"${id}" tokens expired and refresh isn't supported. Run /oauth disconnect ${id} && /oauth connect ${id}.`,
            );
        }
        try {
            const refreshed = await this.refresh(id);
            return refreshed.access_token;
        } catch (e) {
            throw new OAuthError(
                "refresh_failed",
                `Refresh for "${id}" failed: ${e instanceof Error ? e.message : String(e)}. Run /oauth disconnect ${id} && /oauth connect ${id}.`,
            );
        }
    }

    /** Force a refresh. Returns new tokens (and saves them). */
    async refresh(id: string): Promise<OAuthTokens> {
        const platform = this.platforms.get(id);
        if (!platform) throw new OAuthError("not_registered", `"${id}" not registered`);
        const tok = this.tokens.get(id);
        if (!tok || !tok.refresh_token) throw new OAuthError("no_refresh_token", `"${id}" has no refresh_token`);

        const body = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: tok.refresh_token,
            client_id: platform.client_id,
        });
        if (platform.client_secret) body.set("client_secret", platform.client_secret);

        const res = await fetch(platform.token_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
            body: body.toString(),
        });
        const json = await this.parseTokenResponse(res, id);

        // Some providers omit refresh_token on refresh — preserve the old one.
        const newTokens: OAuthTokens = {
            access_token: json["access_token"] as string,
            ...(typeof json["refresh_token"] === "string" ? { refresh_token: json["refresh_token"] } : { refresh_token: tok.refresh_token }),
            token_type: typeof json["token_type"] === "string" ? json["token_type"] : "Bearer",
            ...(typeof json["scope"] === "string" ? { scope: json["scope"] } : tok.scope !== undefined ? { scope: tok.scope } : {}),
            expires_at: typeof json["expires_in"] === "number" ? Date.now() + json["expires_in"] * 1000 : null,
            obtained_at: Date.now(),
        };
        this.setTokens(id, newTokens);
        return newTokens;
    }

    // ---------- Device Code flow (RFC 8628) ----------

    /**
     * Step 1 of Device Code flow. Returns the user_code to show the user
     * and the device_code to poll with.
     */
    async startDeviceFlow(id: string, scope?: string[]): Promise<{
        device_code: string;
        user_code: string;
        verification_uri: string;
        verification_uri_complete?: string;
        expires_in: number;
        interval: number;
    }> {
        this.loadPlatforms();
        const platform = this.platforms.get(id);
        if (!platform) throw new OAuthError("not_registered", `"${id}" not registered`);
        if (platform.flow !== "device_code") {
            throw new OAuthError("wrong_flow", `"${id}" is configured for ${platform.flow}, not device_code`);
        }
        if (!platform.device_authorization_endpoint) {
            throw new OAuthError("missing_endpoint", `"${id}" has no device_authorization_endpoint`);
        }

        const scopes = (scope && scope.length > 0 ? scope : platform.default_scope).join(" ");
        const body = new URLSearchParams({
            client_id: platform.client_id,
            scope: scopes,
        });

        const res = await fetch(platform.device_authorization_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
            body: body.toString(),
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new OAuthError(
                "device_auth_failed",
                `Device authorization endpoint returned HTTP ${res.status}: ${text.slice(0, 300)}`,
            );
        }
        const json = (await res.json()) as Record<string, unknown>;
        if (typeof json["device_code"] !== "string" || typeof json["user_code"] !== "string") {
            throw new OAuthError("malformed_response", `Device authorization response missing device_code/user_code`);
        }
        return {
            device_code: json["device_code"] as string,
            user_code: json["user_code"] as string,
            verification_uri: (json["verification_uri"] as string) ?? (json["verification_url"] as string) ?? "(missing)",
            ...(typeof json["verification_uri_complete"] === "string" ? { verification_uri_complete: json["verification_uri_complete"] } : {}),
            expires_in: typeof json["expires_in"] === "number" ? json["expires_in"] : 600,
            interval: typeof json["interval"] === "number" ? json["interval"] : 5,
        };
    }

    /**
     * Step 2 of Device Code flow. Single poll attempt. Returns tokens on
     * success, throws OAuthAuthorizationPending if the user hasn't yet
     * approved (caller should keep polling), OAuthSlowDown if requested
     * to back off, or OAuthError("...") for terminal errors (expired,
     * denied, etc.).
     */
    async pollDeviceFlow(id: string, deviceCode: string): Promise<OAuthTokens> {
        const platform = this.platforms.get(id);
        if (!platform) throw new OAuthError("not_registered", `"${id}" not registered`);

        const body = new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            device_code: deviceCode,
            client_id: platform.client_id,
        });
        if (platform.client_secret) body.set("client_secret", platform.client_secret);

        const res = await fetch(platform.token_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
            body: body.toString(),
        });
        const json = await this.parseTokenResponse(res, id, /*allowError*/ true);

        // RFC 8628 error responses come back with HTTP 400 + error field.
        if (typeof json["error"] === "string") {
            const code = json["error"] as string;
            if (code === "authorization_pending") throw new OAuthAuthorizationPending();
            if (code === "slow_down") throw new OAuthSlowDown();
            const desc = (json["error_description"] as string) ?? code;
            throw new OAuthError(code, desc);
        }

        const tokens: OAuthTokens = {
            access_token: json["access_token"] as string,
            ...(typeof json["refresh_token"] === "string" ? { refresh_token: json["refresh_token"] } : {}),
            token_type: typeof json["token_type"] === "string" ? json["token_type"] : "Bearer",
            ...(typeof json["scope"] === "string" ? { scope: json["scope"] } : {}),
            expires_at: typeof json["expires_in"] === "number" ? Date.now() + json["expires_in"] * 1000 : null,
            obtained_at: Date.now(),
        };
        this.setTokens(id, tokens);
        return tokens;
    }

    // ---------- Authorization Code + PKCE flow (RFC 7636) ----------

    /**
     * Step 1 of Auth Code+PKCE: returns the URL the user opens in a browser
     * AND the verifier to remember for step 2. Caller stashes the verifier
     * (and state) somewhere keyed by `id` until /oauth callback runs.
     */
    startAuthCodeFlow(id: string, scope?: string[]): {
        url: string;
        verifier: string;
        state: string;
        redirect_uri: string;
    } {
        this.loadPlatforms();
        const platform = this.platforms.get(id);
        if (!platform) throw new OAuthError("not_registered", `"${id}" not registered`);
        if (platform.flow !== "auth_code_pkce") {
            throw new OAuthError("wrong_flow", `"${id}" is configured for ${platform.flow}, not auth_code_pkce`);
        }
        if (!platform.authorization_endpoint) {
            throw new OAuthError("missing_endpoint", `"${id}" has no authorization_endpoint`);
        }

        // PKCE verifier: 43 bytes → 43-char base64url (no padding).
        const verifier = base64url(crypto.randomBytes(32));
        const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
        const state = base64url(crypto.randomBytes(16));
        const redirect_uri = platform.redirect_uri ?? "urn:ietf:params:oauth:2.0:oob";
        const scopes = (scope && scope.length > 0 ? scope : platform.default_scope).join(" ");

        const params = new URLSearchParams({
            response_type: "code",
            client_id: platform.client_id,
            redirect_uri,
            scope: scopes,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
        });
        const url = `${platform.authorization_endpoint}?${params.toString()}`;
        return { url, verifier, state, redirect_uri };
    }

    /**
     * Step 2 of Auth Code+PKCE: exchange the auth code (extracted from the
     * redirect URL the user pasted) for tokens.
     */
    async exchangeAuthCode(id: string, opts: {
        code: string;
        verifier: string;
        redirect_uri: string;
    }): Promise<OAuthTokens> {
        const platform = this.platforms.get(id);
        if (!platform) throw new OAuthError("not_registered", `"${id}" not registered`);

        const body = new URLSearchParams({
            grant_type: "authorization_code",
            code: opts.code,
            redirect_uri: opts.redirect_uri,
            client_id: platform.client_id,
            code_verifier: opts.verifier,
        });
        if (platform.client_secret) body.set("client_secret", platform.client_secret);

        const res = await fetch(platform.token_endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
            body: body.toString(),
        });
        const json = await this.parseTokenResponse(res, id);

        const tokens: OAuthTokens = {
            access_token: json["access_token"] as string,
            ...(typeof json["refresh_token"] === "string" ? { refresh_token: json["refresh_token"] } : {}),
            token_type: typeof json["token_type"] === "string" ? json["token_type"] : "Bearer",
            ...(typeof json["scope"] === "string" ? { scope: json["scope"] } : {}),
            expires_at: typeof json["expires_in"] === "number" ? Date.now() + json["expires_in"] * 1000 : null,
            obtained_at: Date.now(),
        };
        this.setTokens(id, tokens);
        return tokens;
    }

    // ---------- internal ----------

    private async parseTokenResponse(
        res: Response,
        id: string,
        allowError = false,
    ): Promise<Record<string, unknown>> {
        let json: Record<string, unknown>;
        try {
            json = (await res.json()) as Record<string, unknown>;
        } catch (e) {
            const text = await res.text().catch(() => "");
            throw new OAuthError(
                "malformed_response",
                `${id} token endpoint returned non-JSON (HTTP ${res.status}): ${text.slice(0, 300)}`,
            );
        }
        if (!res.ok && !allowError) {
            const code = (json["error"] as string) ?? "http_error";
            const desc = (json["error_description"] as string) ?? `HTTP ${res.status}`;
            throw new OAuthError(code, desc);
        }
        return json;
    }
}

function base64url(buf: Buffer): string {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

let _instance: OAuthService | null = null;
export function getOAuth(): OAuthService {
    if (!_instance) _instance = new OAuthService();
    return _instance;
}

/**
 * Helper for chat-driven Auth Code flow: extract the `code` and `state`
 * query params from a full redirect URL the user pasted back.
 */
export function extractAuthCodeFromUrl(url: string): { code: string; state: string | null } | null {
    try {
        const u = new URL(url);
        const code = u.searchParams.get("code");
        const state = u.searchParams.get("state");
        if (!code) return null;
        return { code, state };
    } catch {
        return null;
    }
}
