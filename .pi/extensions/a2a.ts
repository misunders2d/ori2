import { randomBytes, randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getBotName } from "../../src/core/paths.js";
import { getVault } from "../../src/core/vault.js";
import { getFriends } from "../../src/a2a/friends.js";
import {
    getA2AServerHandle,
    type A2AServerHandle,
} from "../../src/a2a/server.js";
import {
    callFriend,
    callAgent,
    cancelFriendTask,
    discoverAgentCard,
} from "../../src/a2a/client.js";
import {
    encodeInvitationToken,
    decodeInvitationToken,
    isInvitationExpired,
    INVITATION_TTL_MS,
} from "../../src/a2a/invitations.js";
import { broadcastAddressUpdate } from "../../src/a2a/broadcaster.js";
import { currentOrigin } from "../../src/core/identity.js";
import { getWhitelist } from "../../src/core/whitelist.js";

// =============================================================================
// .pi/extensions/a2a.ts — operator + LLM surface for A2A.
//
// Server lifecycle (start/stop, port allocation, tunnel management) lives in
// src/index.ts during bootstrap. This extension only registers the LLM tools
// and slash commands that operate on already-running infrastructure.
//
// Tool ACLs default per src/core/toolAcl.ts DEFAULTS — most A2A tools land
// in admin (add_friend, accept_invitation, call_agent, broadcast, etc.);
// reads (list_friends, call_friend, get_agent_identity) are user-level.
// =============================================================================

function genKey(): string {
    return randomBytes(32).toString("hex");
}

function requireServer(): A2AServerHandle {
    const h = getA2AServerHandle();
    if (!h) {
        throw new Error("A2A server is not running — check /a2a status (likely cloudflared missing or A2A_TUNNEL_MODE=disabled)");
    }
    return h;
}

function callerLabel(ctx: ExtensionContext): string {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return "cli";
    return `${origin.platform}:${origin.senderId}`;
}

function isAdminCaller(ctx: ExtensionContext): boolean {
    const origin = currentOrigin(ctx.sessionManager);
    if (!origin) return true; // CLI is implicit admin
    return getWhitelist().isAdmin(origin.platform, origin.senderId);
}

export default function (pi: ExtensionAPI) {
    // -------------------------- LLM tools --------------------------

    pi.registerTool({
        name: "add_friend",
        label: "Add A2A Friend (one-side)",
        description:
            "One-sided manual add. Discovers the peer's agent card, generates the bearer key " +
            "they will present when calling us, and stores them in the friend registry. The OPERATOR " +
            "must convey the returned key to the peer's operator out-of-band, AND obtain their key for " +
            "calling them (set via update_friend_key on this side, after receiving). Prefer accept_invitation " +
            "(token-based) when both sides are coordinated — it's a single step instead of two.",
        parameters: Type.Object({
            url: Type.String({ description: "Peer's public base URL (e.g. https://peer.example.com)" }),
            name: Type.String({ description: "Local nickname for the peer (used in /a2a list, call_friend(name, ...), etc.)" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const card = await discoverAgentCard(params.url);
            const inboundKey = genKey();
            const friends = getFriends();
            friends.add(params.name, {
                url: card.url,
                agent_id: card.id,
                added_by: callerLabel(ctx),
                ...(card.skills?.length ? { card_skills: card.skills.map((s) => s.id) } : {}),
            });
            friends.setKey(params.name, inboundKey);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Friend "${params.name}" added.\n\n` +
                            `THEIR INBOUND KEY (give this to ${params.name}'s operator):\n  ${inboundKey}\n\n` +
                            `Once you receive their key for us, run /a2a set-their-key ${params.name} <key> ` +
                            `(or call update_friend_key).`,
                    },
                ],
                details: { name: params.name, agent_id: card.id, url: card.url },
            };
        },
    });

    pi.registerTool({
        name: "accept_invitation",
        label: "Accept A2A Invitation Token",
        description:
            "Accept a base64url invitation token from a peer. Decodes the token, discovers the peer's " +
            "card, generates our return key, registers them as a friend, and calls back to /a2a/friend-accept " +
            "to finalise mutual trust. Single-step UX vs. add_friend.",
        parameters: Type.Object({
            token: Type.String({ description: "Base64url invitation token from peer's /a2a invite" }),
        }),
        async execute(_id, params, _signal, _onUpdate, ctx) {
            const handle = requireServer();
            const payload = decodeInvitationToken(params.token);
            if (!payload) throw new Error("invalid invitation token (could not decode)");
            if (isInvitationExpired(payload)) throw new Error("invitation token expired");
            const card = await discoverAgentCard(payload.inviter_url);
            const acceptingKey = genKey();
            const friends = getFriends();
            friends.add(payload.inviter_name, {
                url: payload.inviter_url,
                agent_id: card.id,
                added_by: callerLabel(ctx),
                ...(card.skills?.length ? { card_skills: card.skills.map((s) => s.id) } : {}),
            });
            friends.setKey(payload.inviter_name, acceptingKey);
            friends.setOutboundKey(payload.inviter_name, payload.inviter_key);
            // Callback — authenticated via the inviter_key from the token.
            const cbUrl = `${payload.inviter_url.replace(/\/+$/, "")}/a2a/friend-accept`;
            const res = await fetch(cbUrl, {
                method: "POST",
                headers: { "content-type": "application/json", "x-a2a-api-key": payload.inviter_key },
                body: JSON.stringify({
                    accepting_name: getBotName(),
                    accepting_url: handle.baseUrl,
                    accepting_key: acceptingKey,
                }),
            });
            if (!res.ok) {
                throw new Error(`friend-accept callback failed: HTTP ${res.status}`);
            }
            return {
                content: [
                    { type: "text", text: `Accepted invitation from "${payload.inviter_name}". Mutual trust established.` },
                ],
                details: { name: payload.inviter_name, agent_id: card.id },
            };
        },
    });

    pi.registerTool({
        name: "list_friends",
        label: "List A2A Friends",
        description: "List registered A2A peers. Returns names, URLs, last-seen timestamps, and discovered skills. Never returns bearer keys.",
        parameters: Type.Object({}),
        async execute() {
            const all = getFriends().list();
            if (all.length === 0) {
                return { content: [{ type: "text", text: "No A2A friends registered." }], details: { count: 0 } };
            }
            const lines = all.map((f) => {
                const lastSeen = f.last_seen_at ? new Date(f.last_seen_at).toISOString() : "never";
                const skills = f.card_skills?.length ? ` skills=[${f.card_skills.join(", ")}]` : "";
                return `  ${f.name.padEnd(20)} ${f.base_url}  last_seen=${lastSeen}${skills}`;
            });
            return {
                content: [{ type: "text", text: `Friends (${all.length}):\n\n${lines.join("\n")}` }],
                details: { count: all.length, names: all.map((f) => f.name) },
            };
        },
    });

    pi.registerTool({
        name: "call_friend",
        label: "Call A2A Friend",
        description:
            "Send a message to a registered A2A peer and wait for the response. Use when the user " +
            "asks the bot to coordinate with a known peer (e.g. 'ask WebAgent for the latest signups').",
        parameters: Type.Object({
            name: Type.String({ description: "Friend's local name (from list_friends)" }),
            message: Type.String({ description: "Text to send to the friend's agent" }),
        }),
        async execute(_id, params) {
            const result = await callFriend(params.name, params.message);
            return {
                content: [{ type: "text", text: result.text || "(empty response)" }],
                details: { task_id: result.task.id, friend: params.name },
            };
        },
    });

    pi.registerTool({
        name: "call_agent",
        label: "Call Unregistered A2A Agent (one-off)",
        description:
            "One-off call to an A2A-spec agent that ISN'T in the friend registry. Operator must " +
            "supply the URL and bearer key directly. Use for testing or transient peers.",
        parameters: Type.Object({
            url: Type.String({ description: "Peer's public base URL" }),
            message: Type.String({ description: "Text to send" }),
            api_key: Type.String({ description: "Bearer key the peer expects in x-a2a-api-key" }),
        }),
        async execute(_id, params) {
            const result = await callAgent(params.url, params.message, params.api_key);
            return {
                content: [{ type: "text", text: result.text || "(empty response)" }],
                details: { task_id: result.task.id },
            };
        },
    });

    pi.registerTool({
        name: "cancel_friend_task",
        label: "Cancel A2A Friend Task",
        description: "Abort a running task on a peer.",
        parameters: Type.Object({
            name: Type.String({ description: "Friend's local name" }),
            task_id: Type.String({ description: "Task ID to cancel" }),
        }),
        async execute(_id, params) {
            const task = await cancelFriendTask(params.name, params.task_id);
            return {
                content: [{ type: "text", text: `cancel_task → state=${task.status.state}` }],
                details: { task_id: task.id, state: task.status.state },
            };
        },
    });

    pi.registerTool({
        name: "broadcast_address_update",
        label: "Broadcast Address Update",
        description:
            "Push our current public URL to every registered friend's /a2a/address-update endpoint. " +
            "Auto-fired when the tunnel URL changes. Manual run is for recovery from a missed broadcast.",
        parameters: Type.Object({}),
        async execute() {
            const handle = requireServer();
            const report = await broadcastAddressUpdate({
                senderName: getBotName(),
                newBaseUrl: handle.baseUrl,
            });
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Broadcast complete: ${report.succeeded.length} succeeded, ` +
                            `${report.failed.length} failed, ${report.skippedNoKey.length} skipped (no key).`,
                    },
                ],
                details: report as unknown as Record<string, unknown>,
            };
        },
    });

    pi.registerTool({
        name: "get_agent_identity",
        label: "Get Our Agent Identity",
        description: "Returns this bot's A2A identity — agent card minus secret material. For 'who am I' queries.",
        parameters: Type.Object({}),
        async execute() {
            const handle = getA2AServerHandle();
            if (!handle) {
                return {
                    content: [{ type: "text", text: "A2A server is not running." }],
                    details: { running: false },
                };
            }
            const card = handle.agentCard;
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Agent: ${card.name} (${card.id})\nURL: ${card.url}\n` +
                            `Skills: ${card.skills.map((s) => s.id).join(", ")}`,
                    },
                ],
                details: { agentCard: card as unknown as Record<string, unknown> },
            };
        },
    });

    pi.registerTool({
        name: "update_friend_address",
        label: "Update Friend Address",
        description: "Manually overwrite a friend's stored URL (when their broadcast was missed).",
        parameters: Type.Object({
            name: Type.String({ description: "Friend's local name" }),
            new_url: Type.String({ description: "New base URL" }),
        }),
        async execute(_id, params) {
            const ok = getFriends().updateUrl(params.name, params.new_url);
            return {
                content: [{ type: "text", text: ok ? `Updated ${params.name} → ${params.new_url}` : `Friend ${params.name} not found.` }],
                details: { name: params.name, updated: ok },
            };
        },
    });

    pi.registerTool({
        name: "update_friend_key",
        label: "Update Friend Key (their inbound)",
        description:
            "Generate a new key for this friend (the key they present when calling us). Returns the new key. " +
            "Operator must convey it to the peer out-of-band — there is no auto-propagation of key changes.",
        parameters: Type.Object({
            name: Type.String({ description: "Friend's local name" }),
        }),
        async execute(_id, params) {
            const friends = getFriends();
            if (!friends.get(params.name)) throw new Error(`unknown friend: ${params.name}`);
            const key = genKey();
            friends.setKey(params.name, key);
            return {
                content: [
                    {
                        type: "text",
                        text:
                            `New inbound key for "${params.name}":\n  ${key}\n\n` +
                            "Send this to their operator. Their old key is now invalid for calling us.",
                    },
                ],
                details: { name: params.name },
            };
        },
    });

    // -------------------------- slash commands --------------------------

    pi.registerCommand("a2a", {
        description:
            "A2A protocol. Run /a2a help for the full reference. Common: /a2a status | list | invite <name> | accept <token>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "status").toLowerCase();
            switch (sub) {
                case "help":             return doHelp(ctx);
                case "status":           return doStatus(ctx);
                case "list":             return doList(ctx);
                case "card":             return doCard(ctx);
                case "invite":           return doInvite(ctx, parts);
                case "accept":           return doAccept(ctx, args ?? "");
                case "add-friend":       return doAddFriend(ctx, parts);
                case "set-their-key":    return doSetTheirKey(ctx, parts);
                case "remove-friend":    return doRemoveFriend(ctx, parts);
                case "rotate-key":       return doRotateKey(ctx);
                case "broadcast-address": return doBroadcast(ctx);
                default:
                    ctx.ui.notify(`Unknown /a2a subcommand: ${sub}. Run /a2a help.`, "error");
            }
        },
    });
}

// -------------------------- slash command handlers --------------------------

function doHelp(ctx: ExtensionContext): void {
    ctx.ui.notify([
        "═════════════════════════════════════════════════════════════",
        "  /a2a — Agent-to-Agent protocol",
        "═════════════════════════════════════════════════════════════",
        "",
        "STATUS + INSPECTION",
        "  /a2a status                       — server state, port, public URL",
        "  /a2a list                         — registered friends + last-seen",
        "  /a2a card                         — print our agent card",
        "",
        "ESTABLISHING TRUST (preferred — token flow)",
        "  /a2a invite <name>                — generate invitation token (admin)",
        "  /a2a accept <token>               — accept an invitation (admin)",
        "",
        "MANUAL TRUST (out-of-band key swap)",
        "  /a2a add-friend <url> <name>      — discover + register, get THEIR key (admin)",
        "  /a2a set-their-key <name> <key>   — store the key WE present when calling them (admin)",
        "  /a2a remove-friend <name>         — drop friend + wipe both keys (admin)",
        "",
        "OPERATIONS",
        "  /a2a rotate-key                   — rotate OUR API key (admin)  [TODO: not yet implemented]",
        "  /a2a broadcast-address            — re-fire URL broadcast to all friends (admin)",
        "",
        "═════════════════════════════════════════════════════════════",
    ].join("\n"), "info");
}

function doStatus(ctx: ExtensionContext): void {
    const handle = getA2AServerHandle();
    if (!handle) {
        ctx.ui.notify("A2A server: NOT RUNNING (disabled or boot failed). See logs.", "warning");
        return;
    }
    const friends = getFriends().list();
    ctx.ui.notify([
        "A2A server status:",
        `  bound port:   ${handle.boundPort}`,
        `  public URL:   ${handle.baseUrl}`,
        `  agent card:   ${handle.agentCard.name} (${handle.agentCard.id})`,
        `  skill count:  ${handle.agentCard.skills.length}`,
        `  friends:      ${friends.length}`,
    ].join("\n"), "info");
}

function doList(ctx: ExtensionContext): void {
    const all = getFriends().list();
    if (all.length === 0) { ctx.ui.notify("No A2A friends registered.", "info"); return; }
    const lines = ["Friends:", ""];
    for (const f of all) {
        const lastSeen = f.last_seen_at ? new Date(f.last_seen_at).toISOString() : "never";
        const skills = f.card_skills?.length ? ` skills=[${f.card_skills.slice(0, 3).join(", ")}${f.card_skills.length > 3 ? ", …" : ""}]` : "";
        lines.push(`  ${f.name.padEnd(20)} ${f.base_url}  last_seen=${lastSeen}${skills}`);
    }
    ctx.ui.notify(lines.join("\n"), "info");
}

function doCard(ctx: ExtensionContext): void {
    const handle = getA2AServerHandle();
    if (!handle) { ctx.ui.notify("A2A server is not running.", "warning"); return; }
    ctx.ui.notify(JSON.stringify(handle.agentCard, null, 2), "info");
}

function doInvite(ctx: ExtensionContext, parts: string[]): void {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a invite is admin-only.", "error"); return; }
    const handle = getA2AServerHandle();
    if (!handle) { ctx.ui.notify("A2A server is not running — can't generate invitations.", "error"); return; }
    const name = parts[1];
    if (!name) { ctx.ui.notify("Usage: /a2a invite <name>   (the local nickname for this peer)", "error"); return; }
    const inviter_key = genKey();
    const invite_id = randomUUID();
    handle.registerPendingInvitation({
        invite_id,
        inviter_local_name: name,
        inviter_key,
        expires_at: Date.now() + INVITATION_TTL_MS,
    });
    const token = encodeInvitationToken({
        inviter_name: getBotName(),
        inviter_url: handle.baseUrl,
        inviter_key,
        invite_id,
        expires_at: Date.now() + INVITATION_TTL_MS,
    });
    ctx.ui.notify([
        `Invitation token for "${name}" (expires in ${Math.round(INVITATION_TTL_MS / 60_000)} minutes):`,
        "",
        token,
        "",
        `Send the token to the peer's operator. They run /a2a accept <token>.`,
        "Mutual trust is established when their callback completes.",
    ].join("\n"), "info");
}

async function doAccept(ctx: ExtensionContext, args: string): Promise<void> {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a accept is admin-only.", "error"); return; }
    const m = args.trim().match(/^accept\s+(\S+)\s*$/i);
    if (!m) { ctx.ui.notify("Usage: /a2a accept <token>", "error"); return; }
    const token = m[1]!;
    const handle = getA2AServerHandle();
    if (!handle) { ctx.ui.notify("A2A server is not running — can't accept invitations.", "error"); return; }
    const payload = decodeInvitationToken(token);
    if (!payload) { ctx.ui.notify("Invalid invitation token (could not decode).", "error"); return; }
    if (isInvitationExpired(payload)) { ctx.ui.notify("Invitation token has expired.", "error"); return; }
    let card;
    try {
        card = await discoverAgentCard(payload.inviter_url);
    } catch (e) {
        ctx.ui.notify(`agent card discovery failed: ${e instanceof Error ? e.message : String(e)}`, "error");
        return;
    }
    const acceptingKey = genKey();
    const friends = getFriends();
    friends.add(payload.inviter_name, {
        url: payload.inviter_url,
        agent_id: card.id,
        added_by: callerLabel(ctx),
        ...(card.skills?.length ? { card_skills: card.skills.map((s) => s.id) } : {}),
    });
    friends.setKey(payload.inviter_name, acceptingKey);
    friends.setOutboundKey(payload.inviter_name, payload.inviter_key);
    try {
        const res = await fetch(`${payload.inviter_url.replace(/\/+$/, "")}/a2a/friend-accept`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-a2a-api-key": payload.inviter_key },
            body: JSON.stringify({
                accepting_name: getBotName(),
                accepting_url: handle.baseUrl,
                accepting_key: acceptingKey,
            }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
        ctx.ui.notify(`callback failed: ${e instanceof Error ? e.message : String(e)} — local record was created but mutual trust is not finalised.`, "error");
        return;
    }
    ctx.ui.notify(`✅ Accepted invitation from "${payload.inviter_name}". Mutual trust established.`, "info");
}

async function doAddFriend(ctx: ExtensionContext, parts: string[]): Promise<void> {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a add-friend is admin-only.", "error"); return; }
    const url = parts[1]; const name = parts[2];
    if (!url || !name) { ctx.ui.notify("Usage: /a2a add-friend <url> <name>", "error"); return; }
    let card;
    try { card = await discoverAgentCard(url); }
    catch (e) { ctx.ui.notify(`agent card discovery failed: ${e instanceof Error ? e.message : String(e)}`, "error"); return; }
    const inboundKey = genKey();
    const friends = getFriends();
    friends.add(name, {
        url: card.url,
        agent_id: card.id,
        added_by: callerLabel(ctx),
        ...(card.skills?.length ? { card_skills: card.skills.map((s) => s.id) } : {}),
    });
    friends.setKey(name, inboundKey);
    ctx.ui.notify([
        `✅ Friend "${name}" added.`,
        "",
        `THEIR INBOUND KEY (give this to ${name}'s operator):`,
        `  ${inboundKey}`,
        "",
        `Once you receive their key for us, run:`,
        `  /a2a set-their-key ${name} <their-key>`,
    ].join("\n"), "info");
}

function doSetTheirKey(ctx: ExtensionContext, parts: string[]): void {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a set-their-key is admin-only.", "error"); return; }
    const name = parts[1]; const key = parts[2];
    if (!name || !key) { ctx.ui.notify("Usage: /a2a set-their-key <name> <key>", "error"); return; }
    const friends = getFriends();
    if (!friends.get(name)) { ctx.ui.notify(`Friend "${name}" not found. /a2a add-friend first.`, "error"); return; }
    friends.setOutboundKey(name, key);
    ctx.ui.notify(`Set outbound key for ${name}. We can now call them.`, "info");
}

function doRemoveFriend(ctx: ExtensionContext, parts: string[]): void {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a remove-friend is admin-only.", "error"); return; }
    const name = parts[1];
    if (!name) { ctx.ui.notify("Usage: /a2a remove-friend <name>", "error"); return; }
    const ok = getFriends().remove(name);
    ctx.ui.notify(ok ? `Removed friend "${name}" (keys wiped).` : `Friend "${name}" not found.`, "info");
}

function doRotateKey(ctx: ExtensionContext): void {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a rotate-key is admin-only.", "error"); return; }
    // OUR api key — the one all peers present when calling us — is currently
    // a process-wide secret stored in vault. Rotating it requires telling
    // every friend the new value, which means every friend's vault entry
    // a2a:friend_outbound_key:<our-name> needs to be updated on THEIR side.
    // We don't have a wire mechanism for that yet; deferring to a follow-up.
    ctx.ui.notify(
        "/a2a rotate-key is not yet implemented — peers can't auto-receive new server keys (no wire path). " +
            "Workaround: run /a2a remove-friend <name> + re-invite each affected peer.",
        "warning",
    );
    void getVault(); // suppress unused-import warning until rotation lands
}

async function doBroadcast(ctx: ExtensionContext): Promise<void> {
    if (!isAdminCaller(ctx)) { ctx.ui.notify("/a2a broadcast-address is admin-only.", "error"); return; }
    const handle = getA2AServerHandle();
    if (!handle) { ctx.ui.notify("A2A server is not running.", "error"); return; }
    const report = await broadcastAddressUpdate({
        senderName: getBotName(),
        newBaseUrl: handle.baseUrl,
    });
    ctx.ui.notify([
        `Broadcast complete:`,
        `  succeeded:    ${report.succeeded.length}  [${report.succeeded.join(", ")}]`,
        `  failed:       ${report.failed.length}     [${report.failed.map((f) => `${f.name}:${f.lastError}`).join(", ")}]`,
        `  skipped (no key): ${report.skippedNoKey.length}  [${report.skippedNoKey.join(", ")}]`,
    ].join("\n"), "info");
}
