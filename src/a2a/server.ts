import http from "node:http";
import { randomUUID } from "node:crypto";
import express, { type Request, type Response, type NextFunction, type Express } from "express";
import {
    DefaultRequestHandler,
    InMemoryTaskStore,
    type User,
    UnauthenticatedUser,
} from "@a2a-js/sdk/server";
import { jsonRpcHandler, agentCardHandler } from "@a2a-js/sdk/server/express";
import { getFriends, type Friends } from "./friends.js";
import { buildAgentCard, type BuildAgentCardInput } from "./agentCard.js";
import { allocatePort } from "./portAlloc.js";
import { getA2AAdapter, type A2AAdapter } from "./adapter.js";
import { A2AAgentExecutor } from "./agentExecutor.js";
import type { AgentCard } from "./types.js";

// =============================================================================
// A2A HTTP server — assembles Express + the @a2a-js/sdk JSON-RPC handler
// behind our x-a2a-api-key middleware, mounts custom routes (/health,
// /a2a/address-update, /a2a/friend-accept), and wires the dispatcher bridge
// via A2AAdapter. Does NOT manage cloudflared — that's tunnel.ts in Phase 3.
//
// Boot order from src/index.ts (Phase 3 will wire this):
//   const server = await startA2AServer({ ... });
//   server.url is the base URL; share with peers via address-update broadcast.
// =============================================================================

export interface A2AServerOptions {
    /** Bot identity. Required. */
    botName: string;
    agentId: string;
    description: string;
    version?: string;
    /** Local bind. */
    host?: string;
    preferredPort?: number;
    /** Public URL (cloudflared tunnel or operator-provided). Drives the agent card. */
    baseUrl: string;
    /** OUR bearer key — peers must present this. */
    apiKey: string;
    providerName?: string;
    providerUrl?: string;
    /** Operator-curated additions to the skill list. Parsed from A2A_SKILLS_JSON. */
    additionalSkills?: BuildAgentCardInput["additionalSkills"];
    /** DNA features auto-rendered as `dna:*` skills. Wired in Phase 4. */
    dnaFeatures?: BuildAgentCardInput["dnaFeatures"];
}

export interface A2AServerHandle {
    httpServer: http.Server;
    expressApp: Express;
    boundPort: number;
    baseUrl: string;
    /** Snapshot of the agent card at boot. Regenerate via `refreshAgentCard()`. */
    agentCard: AgentCard;
    /** Re-render the agent card (e.g., after the tunnel URL changes). */
    refreshAgentCard(input?: Partial<A2AServerOptions>): AgentCard;
    /** Hand a pending invitation to the server so /a2a/friend-accept can validate it. */
    registerPendingInvitation(invite: PendingInvitation): void;
    stop(): Promise<void>;
}

export interface PendingInvitation {
    invite_id: string;
    /** Name we assigned this prospective friend locally. */
    inviter_local_name: string;
    /** The bearer key we generated for them — what they'll present on the callback. */
    inviter_key: string;
    /** Wallclock ms after which the invitation must be rejected. */
    expires_at: number;
}

/**
 * Express middleware that validates the `x-a2a-api-key` header against the
 * friend registry. Attaches the resolved friend name to `req.a2aFriend` for
 * downstream handlers and the SDK UserBuilder. Rejects 401 otherwise.
 *
 * Special-cases `/a2a/friend-accept` — the invitee presents the inviter_key
 * from the invitation token, which is NOT yet a registered friend. The route
 * handler does its own validation against the in-memory pending-invitation
 * map.
 */
export function makeAuthMiddleware(friends: Friends, isPublicPath: (path: string) => boolean) {
    return (req: Request, res: Response, next: NextFunction): void => {
        if (isPublicPath(req.path)) {
            next();
            return;
        }
        // /a2a/friend-accept does its own auth (against pending invitations,
        // not registered friends).
        if (req.path === "/a2a/friend-accept") {
            next();
            return;
        }
        const presented = req.headers["x-a2a-api-key"];
        if (typeof presented !== "string" || !presented) {
            res.status(401).json({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Unauthorized: missing x-a2a-api-key header" },
                id: null,
            });
            return;
        }
        const friendName = friends.resolveByKey(presented);
        if (!friendName) {
            res.status(401).json({
                jsonrpc: "2.0",
                error: { code: -32001, message: "Unauthorized: unknown x-a2a-api-key" },
                id: null,
            });
            return;
        }
        // Mark inbound traffic seen — informational, used by /a2a list.
        try { friends.setLastSeen(friendName); } catch { /* best-effort */ }
        (req as Request & { a2aFriend?: string }).a2aFriend = friendName;
        next();
    };
}

/**
 * Custom User implementation the SDK threads into ServerCallContext.user.
 * Our AgentExecutor reads userName off this to know which friend made the
 * call.
 */
export class AuthenticatedFriend implements User {
    constructor(private readonly _name: string) {}
    get isAuthenticated(): boolean { return true; }
    get userName(): string { return this._name; }
    /** Convenience getter — agentExecutor.ts looks for `user.name` first, falls back to userName. */
    get name(): string { return this._name; }
}

/** UserBuilder for the SDK's jsonRpcHandler. Auth already happened upstream. */
function makeUserBuilder() {
    return async (req: Request): Promise<User> => {
        const friend = (req as Request & { a2aFriend?: string }).a2aFriend;
        if (!friend) return new UnauthenticatedUser();
        return new AuthenticatedFriend(friend);
    };
}

const PUBLIC_PATHS = new Set([
    "/health",
    "/.well-known/agent.json",
    "/.well-known/agent-card.json",
]);

export async function startA2AServer(opts: A2AServerOptions): Promise<A2AServerHandle> {
    const friends = getFriends();
    const adapter = getA2AAdapter();
    const host = opts.host ?? "127.0.0.1";
    const preferredPort = opts.preferredPort ?? 8085;

    const boundPort = await allocatePort({ preferred: preferredPort, host });

    let agentCard = buildAgentCard({
        botName: opts.botName,
        agentId: opts.agentId,
        version: opts.version ?? "1.0.0",
        description: opts.description,
        baseUrl: opts.baseUrl,
        ...(opts.providerName !== undefined ? { providerName: opts.providerName } : {}),
        ...(opts.providerUrl !== undefined ? { providerUrl: opts.providerUrl } : {}),
        ...(opts.additionalSkills !== undefined ? { additionalSkills: opts.additionalSkills } : {}),
        ...(opts.dnaFeatures !== undefined ? { dnaFeatures: opts.dnaFeatures } : {}),
        hasApiKey: true,
    });

    // Pending invitations — in-memory only. If the bot restarts mid-handshake,
    // the operator just runs /a2a invite again. Cheap to regenerate.
    const pendingInvitations = new Map<string, PendingInvitation>();

    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "1mb" })); // JSON-RPC bodies are small; 1MB is generous

    app.use(makeAuthMiddleware(friends, (p) => PUBLIC_PATHS.has(p)));

    // -------------------- public routes --------------------

    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            bot_name: opts.botName,
            uptime_s: Math.round(process.uptime()),
            friend_count: friends.list().length,
        });
    });

    app.get("/.well-known/agent.json", (_req, res) => res.json(agentCard));
    app.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard));

    // -------------------- authenticated custom routes --------------------

    /**
     * POST /a2a/address-update
     * Body: { sender_name: string, new_base_url: string }
     * Auth: regular x-a2a-api-key (must be a registered friend's inbound key).
     * Match priority: 1) bearer key → friend name (already done in middleware);
     *                 2) sender_name match (case-insensitive). Update friend's URL.
     */
    app.post("/a2a/address-update", (req, res) => {
        const body = req.body as { sender_name?: unknown; new_base_url?: unknown } | undefined;
        const senderName = typeof body?.sender_name === "string" ? body.sender_name : "";
        const newUrl = typeof body?.new_base_url === "string" ? body.new_base_url.replace(/\/+$/, "") : "";
        if (!senderName || !newUrl) {
            res.status(400).json({ status: "error", message: "Missing sender_name or new_base_url" });
            return;
        }
        const authenticatedAs = (req as Request & { a2aFriend?: string }).a2aFriend;
        // Match by key first (already resolved), fall back to name match (case-insensitive).
        let target = authenticatedAs;
        if (!target || !friends.get(target)) {
            const lower = senderName.toLowerCase();
            target = friends.list().find((f) => f.name.toLowerCase() === lower)?.name;
        }
        if (!target) {
            res.json({ status: "ignored", message: `Unknown sender: ${senderName}` });
            return;
        }
        const ok = friends.updateUrl(target, newUrl);
        res.json(
            ok
                ? { status: "success", message: `Updated ${target} → ${newUrl}` }
                : { status: "error", message: `Friend ${target} not found at update time` },
        );
    });

    /**
     * POST /a2a/friend-accept
     * Body: { accepting_name: string, accepting_url: string, accepting_key: string }
     * Auth: bearer key matches a pending invitation's inviter_key. Once the
     * accept is recorded the invitation is consumed (removed from the map).
     */
    app.post("/a2a/friend-accept", (req, res) => {
        const presented = req.headers["x-a2a-api-key"];
        if (typeof presented !== "string" || !presented) {
            res.status(401).json({ status: "error", message: "Missing x-a2a-api-key" });
            return;
        }
        // Find pending invitation whose inviter_key matches.
        let matched: PendingInvitation | undefined;
        const now = Date.now();
        for (const [id, inv] of pendingInvitations) {
            if (inv.expires_at < now) {
                pendingInvitations.delete(id);
                continue;
            }
            if (inv.inviter_key === presented) {
                matched = inv;
                break;
            }
        }
        if (!matched) {
            res.status(401).json({ status: "error", message: "No matching pending invitation" });
            return;
        }
        const body = req.body as
            | { accepting_name?: unknown; accepting_url?: unknown; accepting_key?: unknown }
            | undefined;
        const accName = typeof body?.accepting_name === "string" ? body.accepting_name : "";
        const accUrl = typeof body?.accepting_url === "string" ? body.accepting_url.replace(/\/+$/, "") : "";
        const accKey = typeof body?.accepting_key === "string" ? body.accepting_key : "";
        if (!accName || !accUrl || !accKey) {
            res.status(400).json({
                status: "error",
                message: "Missing accepting_name, accepting_url, or accepting_key",
            });
            return;
        }
        // Materialise the friend record. The local name comes from the
        // invitation (operator chose it at /a2a invite time), not from the
        // accepting peer — peers don't get to rename themselves in our registry.
        const localName = matched.inviter_local_name;
        friends.add(localName, {
            url: accUrl,
            agent_id: accName,
            added_by: "invitation-callback",
            displayName: accName,
        });
        // Promote the bearer keys: their inbound key was already set when we
        // generated the invitation; now we record their outbound key so we
        // can call them.
        friends.setOutboundKey(localName, accKey);
        pendingInvitations.delete(matched.invite_id);
        res.json({ status: "accepted", local_name: localName });
    });

    // -------------------- A2A SDK JSON-RPC handler --------------------

    const taskStore = new InMemoryTaskStore();
    const executor = new A2AAgentExecutor(adapter);
    const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

    // Mount the agent card handler at /.well-known/agent-card.json AND register
    // the JSON-RPC POST handler at root. We've already registered the agent
    // card routes above with our snapshot — the SDK's agentCardHandler is
    // redundant but doesn't conflict because it serves the same path.
    app.use(
        "/",
        jsonRpcHandler({
            requestHandler,
            userBuilder: makeUserBuilder(),
        }),
    );
    // Suppress unused-import linter noise — we're keeping the import available
    // for future use (e.g., serving an alternate /.well-known path).
    void agentCardHandler;

    // -------------------- bind + return --------------------

    const httpServer = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
        const onError = (e: Error) => reject(e);
        httpServer.once("error", onError);
        httpServer.listen(boundPort, host, () => {
            httpServer.removeListener("error", onError);
            resolve();
        });
    });

    adapter.markRunning(boundPort, opts.baseUrl);

    const handle: A2AServerHandle = {
        httpServer,
        expressApp: app,
        boundPort,
        baseUrl: opts.baseUrl,
        agentCard,
        refreshAgentCard(patch) {
            const merged: A2AServerOptions = { ...opts, ...(patch ?? {}) };
            agentCard = buildAgentCard({
                botName: merged.botName,
                agentId: merged.agentId,
                version: merged.version ?? "1.0.0",
                description: merged.description,
                baseUrl: merged.baseUrl,
                ...(merged.providerName !== undefined ? { providerName: merged.providerName } : {}),
                ...(merged.providerUrl !== undefined ? { providerUrl: merged.providerUrl } : {}),
                ...(merged.additionalSkills !== undefined
                    ? { additionalSkills: merged.additionalSkills }
                    : {}),
                ...(merged.dnaFeatures !== undefined ? { dnaFeatures: merged.dnaFeatures } : {}),
                hasApiKey: true,
            });
            handle.agentCard = agentCard;
            handle.baseUrl = merged.baseUrl;
            return agentCard;
        },
        registerPendingInvitation(invite) {
            pendingInvitations.set(invite.invite_id, invite);
        },
        async stop() {
            await new Promise<void>((resolve, reject) => {
                httpServer.close((err) => (err ? reject(err) : resolve()));
            });
            await adapter.stop();
        },
    };
    return handle;
}

/** Generate a random invitation id (URL-safe). */
export function generateInviteId(): string {
    return randomUUID();
}

/** Re-export the adapter for tests + callers that need to wire the dispatcher. */
export { type A2AAdapter };
