import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { currentOrigin, type InboundOrigin } from "../../src/core/identity.js";
import { consumeInitPasscode, isPasscodeConsumed, peekInitPasscode } from "../../src/core/passcode.js";
import { getStaging, parseApproval } from "../../src/core/staging.js";
import { getToolAcl } from "../../src/core/toolAcl.js";
import { getDispatcher } from "../../src/transport/dispatcher.js";
import { getWhitelist } from "../../src/core/whitelist.js";
import { evaluate as evaluatePolicy, type Decision } from "../../src/core/policy.js";
import * as totp from "../../src/core/totp.js";
import { getAdminNotifier } from "../../src/core/adminNotify.js";
import { getSecretAccessLog } from "../../src/core/secretAccessLog.js";

// =============================================================================
// admin_gate — policy enforcement tying whitelist + roles + tool ACL +
// staging + init-passcode + approval flow together.
//
// Hooks:
//   1. Dispatcher pre-dispatch hook: blacklist/whitelist check on EVERY
//      inbound message. Rejects before the LLM ever sees it.
//   2. input event: detects approval messages "Approve ACT-WXYZAB" from
//      admins and runs the staged action. Also short-circuits /init.
//   3. tool_call event: looks up the current user, checks tool ACL,
//      blocks or stages.
//
// Commands:
//   /init <passcode>           — claim admin (first match wins, one-time)
//   /whitelist list
//   /whitelist add <platform> <senderId> [role1,role2,...]
//   /whitelist remove <platform> <senderId>
//   /blacklist add <platform> <senderId> [reason]
//   /blacklist remove <platform> <senderId>
//   /blacklist list
//   /role grant <platform> <senderId> <role>
//   /role revoke <platform> <senderId> <role>
//   /role list [platform] [senderId]
//   /tool-acl list
//   /tool-acl set <toolName> <role1,role2,...>
//   /staging list
//   /staging cancel <token>
//   /init-status              — debug: is a passcode still live?
//
// CLI admin bootstrap:
//   - The operator runs `npm start` at the terminal. Their CLI sender
//     identity is their OS username. If `ADMIN_USER_IDS` in the vault
//     includes that name (or `cli:<name>`), they're admin immediately.
//   - The onboarding wizard sets ADMIN_USER_IDS to whatever the operator
//     typed — so typing your CLI username or OS user during setup
//     makes you admin at the terminal from day one.
//   - First-boot passcode logged separately for claiming admin over chat
//     from Telegram/Slack without knowing your user_id upfront.
// =============================================================================

// Staging is now driven by policy: a tool is staged when its evaluated
// decision is `require_confirm` or `require_2fa`. Pure base-role failures
// hard-block (no auto-staging surprise). Tools opt into confirmation via
// `alwaysConfirm: true` or per-rule `require_confirm`/`require_2fa` actions
// in their tool_acl.json entry. Hand-edit data/<bot>/tool_acl.json to author
// rules; use /tool-acl test to dry-run before committing them.

export default function (pi: ExtensionAPI) {
    const dispatcher = getDispatcher();
    const whitelist = getWhitelist();
    const toolAcl = getToolAcl();
    const staging = getStaging();

    // Eagerly load tool_acl on session_start so default ACLs are seeded to
    // disk. Admins can then inspect/edit data/<bot>/tool_acl.json directly
    // without triggering a tool call first.
    pi.on("session_start", async () => {
        toolAcl.requiredRoles("read"); // touching any tool triggers load() → save() chain
    });

    // Built-in Pi tool action describers — admins approving staged calls
    // need to see the command/path, not just the tool name.
    registerActionDescriber("bash", (args) => {
        const a = args as { command?: string };
        if (typeof a.command !== "string") return null;
        const truncated = a.command.length > 600 ? a.command.slice(0, 600) + "…[truncated]" : a.command;
        return `Command:\n  ${truncated}`;
    });
    registerActionDescriber("write", (args) => {
        const a = args as { path?: string; content?: string };
        if (typeof a.path !== "string") return null;
        const sizeHint = typeof a.content === "string" ? ` (${a.content.length} chars)` : "";
        return `Path:    ${a.path}${sizeHint}`;
    });
    registerActionDescriber("edit", (args) => {
        const a = args as { path?: string };
        if (typeof a.path !== "string") return null;
        return `Path:    ${a.path}`;
    });
    registerActionDescriber("read", (args) => {
        const a = args as { path?: string; file_path?: string };
        const p = a.path ?? a.file_path;
        if (typeof p !== "string") return null;
        return `Path:    ${p}`;
    });

    // ---------------- Dispatcher pre-dispatch hook ----------------

    dispatcher.addPreDispatchHook((msg) => {
        // Special case 1: /init <passcode> — chat-based admin claim.
        // Handled BEFORE the whitelist gate (the caller is unauthenticated
        // by definition) AND before pushing into Pi (the passcode must
        // never enter the LLM's context).
        const initMatch = msg.text.trim().match(/^\/init\s+(\S+)\s*$/i);
        if (initMatch) {
            const passcode = initMatch[1]!;
            if (isPasscodeConsumed()) {
                return { block: true, reason: "Init passcode already used. Ask an existing admin to add you via /whitelist." };
            }
            const ok = consumeInitPasscode(passcode);
            if (!ok) {
                console.log(
                    `[admin_gate] /init failed (bad passcode) from ${msg.platform}:${msg.senderId} (${msg.senderDisplayName})`,
                );
                return { block: true, reason: "Invalid init passcode." };
            }
            whitelist.add(msg.platform, msg.senderId, {
                roles: ["admin"],
                ...(msg.senderDisplayName ? { displayName: msg.senderDisplayName } : {}),
                addedBy: "init-passcode",
            });
            console.log(
                `[admin_gate] /init SUCCEEDED from ${msg.platform}:${msg.senderId} (${msg.senderDisplayName}) — promoted to admin`,
            );
            return { block: true, reason: `✅ You are now admin (${msg.platform}:${msg.senderId}).` };
        }

        // CLI is implicit admin (Whitelist.isAdmin → isAllowed short-circuits).
        // No explicit bypass needed here.

        if (whitelist.isBlacklisted(msg.platform, msg.senderId)) {
            console.log(
                `[admin_gate] BLOCKED blacklisted inbound from ${msg.platform}:${msg.senderId} (${msg.senderDisplayName})`,
            );
            return { block: true, reason: "You are blocked from interacting with this assistant." };
        }

        if (whitelist.isAllowed(msg.platform, msg.senderId)) return { block: false };

        // Multi-user chat: allow PASSIVE context ingestion from unlisted
        // senders IF the channel is allowlisted. That lets a group-chat
        // summary pick up what everyone said without individually
        // whitelisting every group member. Active mentions still require
        // a whitelisted sender — random users can't trigger responses.
        if (!msg.addressedToBot && whitelist.isChannelAllowed(msg.platform, msg.channelId)) {
            return { block: false };
        }

        // Unrecognized sender. Silent block — don't reply, don't even log
        // verbosely, to avoid amplifying probes. Just a single info log so
        // the admin can `/whitelist add` them later if intended.
        console.log(
            `[admin_gate] BLOCKED unlisted inbound from ${msg.platform}:${msg.senderId} (${msg.senderDisplayName}) in ${msg.channelId} — use /whitelist add ${msg.platform} ${msg.senderId} to permit, or /channel-allow ${msg.platform} ${msg.channelId} for group context`,
        );
        // Fire-and-forget admin notification. Cooldown + GC live in
        // AdminNotifier; failures must not block this pre-hook.
        void getAdminNotifier().notifyUnknownUser(msg).catch((e) => {
            console.warn(`[admin_gate] adminNotifier failed: ${e instanceof Error ? e.message : String(e)}`);
        });
        return { block: true, reason: "" }; // empty reason → dispatcher skips reply (silent); see TransportDispatcher.dispatch
    });

    // ---------------- input event ----------------
    // Intercepts messages BEFORE the LLM runs. Used to:
    //   (a) handle /init <passcode> — which isn't a slash command registered
    //       with Pi (it needs access to the inbound origin), so we do it
    //       at the input level.
    //   (b) detect "Approve ACT-XXXXXX" and run the staged action.
    // Pi's command router handles /whitelist, /role, /tool-acl, /staging.

    pi.on("input", async (event, ctx) => {
        // Strip transport_bridge's metadata header so user-typed "/init" or
        // "Approve ACT-..." at the start of the actual body still matches.
        // For terminal input (no header) this is a no-op.
        const text = stripMetadataHeader(event.text).trim();

        // /init for the CLI operator: dispatcher pre-hook only sees inbound
        // through registered adapters, and InteractiveMode bypasses that.
        // Keep a terminal-only /init handler here so the operator can run
        // /init at the TUI just like a chat user would.
        const initMatch = text.match(/^\s*\/init\s+(\S+)\s*$/i);
        if (initMatch) {
            const passcode = initMatch[1]!;
            const origin = currentOrigin(ctx.sessionManager);
            const target = origin ?? inferOriginFromCli(ctx);
            if (!target) {
                ctx.ui.notify("Could not determine sender identity for /init.", "error");
                return { action: "handled" };
            }
            if (isPasscodeConsumed()) {
                ctx.ui.notify("/init has already been used. Contact an existing admin for promotion.", "warning");
                return { action: "handled" };
            }
            const ok = consumeInitPasscode(passcode);
            if (!ok) {
                ctx.ui.notify("Invalid init passcode.", "error");
                return { action: "handled" };
            }
            whitelist.add(target.platform, target.senderId, {
                roles: ["admin"],
                ...(target.senderDisplayName ? { displayName: target.senderDisplayName } : {}),
                addedBy: "init-passcode",
            });
            ctx.ui.notify(
                `✅ ${target.senderDisplayName || target.senderId} is now admin (${target.platform}:${target.senderId}).`,
                "info",
            );
            return { action: "handled" };
        }

        // Approve ACT-XXXXXX [123456] flow.
        const approval = parseApproval(text);
        if (approval) {
            const { token, totpCode } = approval;
            const origin = currentOrigin(ctx.sessionManager);
            const approver = origin ?? inferOriginFromCli(ctx);
            if (!approver) {
                ctx.ui.notify("Could not determine approver identity.", "error");
                return { action: "handled" };
            }
            if (!whitelist.isAdmin(approver.platform, approver.senderId)) {
                ctx.ui.notify("Only admins can approve staged actions.", "error");
                return { action: "handled" };
            }
            // Peek before consume so we can demand a TOTP code if needed
            // without burning the token on the failed attempt.
            const pending = staging.peek(token);
            if (!pending) {
                ctx.ui.notify(`Token ${token} not found, already used, or expired.`, "error");
                return { action: "handled" };
            }
            if (pending.requires2fa) {
                if (!totpCode) {
                    ctx.ui.notify(
                        `Action ${token} requires 2FA. Reply: Approve ${token} <6-digit code>`,
                        "warning",
                    );
                    return { action: "handled" };
                }
                if (!totp.isEnrolled(approver.platform, approver.senderId)) {
                    ctx.ui.notify(
                        `2FA required for ${token}, but you have no TOTP enrolled. Run /totp setup first.`,
                        "error",
                    );
                    return { action: "handled" };
                }
                if (!totp.verify(approver.platform, approver.senderId, totpCode)) {
                    ctx.ui.notify(`Invalid 2FA code for ${token}.`, "error");
                    return { action: "handled" };
                }
            }
            const action = staging.approve(token, `${approver.platform}:${approver.senderId}`);
            if (!action) {
                ctx.ui.notify(`Token ${token} could not be consumed (race or expiry).`, "error");
                return { action: "handled" };
            }
            // Don't actually execute the tool here — instead, transform the
            // input into a synthetic user message that instructs the LLM to
            // re-attempt. The LLM's subsequent tool call will pass the gate
            // because we'll whitelist this (token, tool, user) tuple in
            // a short-lived allowance.
            installOneShotAllowance(action.toolName, approver);
            return {
                action: "transform",
                text:
                    `[Admin ${approver.senderDisplayName} approved action ${token}] ` +
                    `The previous attempt to call \`${action.toolName}\` has been unblocked. ` +
                    `Please re-invoke it with the original args: ${action.argsJson}`,
            };
        }

        return { action: "continue" };
    });

    // ---------------- tool_call event ----------------
    // ACL enforcement. Runs BEFORE every tool executes.

    pi.on("tool_call", async (event, ctx) => {
        const toolName = event.toolName;
        const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);

        if (!origin) {
            // Couldn't identify the caller — fail closed.
            return {
                block: true,
                reason: `[admin_gate] cannot identify inbound origin — refusing to call ${toolName}`,
            };
        }

        // One-shot admin-approved allowance short-circuits everything else.
        // The Approve flow already ran the policy + 2FA check; the LLM is
        // re-attempting the same tool that was just unblocked.
        if (consumeOneShotAllowance(toolName, origin)) return; // allow

        const callerRoles = whitelist.rolesOf(origin.platform, origin.senderId);
        const decision = evaluatePolicy(toolAcl.policyEntry(toolName), {
            callerPlatform: origin.platform,
            callerSenderId: origin.senderId,
            callerRoles,
            toolArgs: event.input,
        }).decision;

        return applyDecision(decision, toolName, event.input, origin);
    });

    function applyDecision(
        decision: Decision,
        toolName: string,
        toolArgs: unknown,
        origin: InboundOrigin,
    ): { block: true; reason: string } | undefined {
        switch (decision.kind) {
            case "allow":
                return undefined;
            case "deny":
                return { block: true, reason: `Admin gate: ${decision.reason}` };
            case "require_confirm":
            case "require_2fa": {
                try {
                    const action = staging.stage({
                        toolName,
                        args: toolArgs,
                        userPlatform: origin.platform,
                        userSenderId: origin.senderId,
                        ...(origin.senderDisplayName ? { userDisplayName: origin.senderDisplayName } : {}),
                        requires2fa: decision.kind === "require_2fa",
                    });
                    const replyHint =
                        decision.kind === "require_2fa"
                            ? `Approve ${action.token} <6-digit TOTP code>`
                            : `Approve ${action.token}`;

                    // Per-tool description hook lets extensions surface
                    // human-relevant args in the staging prompt (e.g.,
                    // apply_dna shows the manifest file list, bash shows
                    // the command, oauth_authenticated_fetch shows method+URL).
                    // Falls back to a generic args summary if no describer
                    // is registered.
                    const description = describeAction(toolName, toolArgs);

                    return {
                        block: true,
                        reason:
                            `Action staged — admin confirmation required.\n\n` +
                            `Tool: ${toolName}\n` +
                            (description ? `${description}\n\n` : `Args: ${shortArgsSummary(toolArgs)}\n\n`) +
                            `Admin reply: "${replyHint}" within 15 minutes to proceed.`,
                    };
                } catch (e) {
                    return {
                        block: true,
                        reason: `Admin gate: staging failed (${e instanceof Error ? e.message : String(e)})`,
                    };
                }
            }
        }
    }

    // ---------------- Slash commands ----------------

    pi.registerCommand("init-status", {
        description: "Show whether the init passcode is still available (admin claim unused)",
        handler: async (_args, ctx) => {
            if (isPasscodeConsumed()) {
                ctx.ui.notify("Init passcode already consumed — admin has been claimed.", "info");
                return;
            }
            const p = peekInitPasscode();
            if (!p) {
                ctx.ui.notify("No init passcode set. This shouldn't happen on a fresh install.", "warning");
                return;
            }
            ctx.ui.notify(`Init passcode is LIVE: ${p}\n\nUse /init <passcode> from any whitelisted chat to claim admin.`, "info");
        },
    });

    pi.registerCommand("whitelist", {
        description: "Manage whitelist. Usage: /whitelist list | add <platform> <senderId> [role1,role2,...] | remove <platform> <senderId>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();

            if (sub === "list") {
                const users = whitelist.list();
                if (users.length === 0) {
                    ctx.ui.notify("Whitelist is empty. Admins are defined via ADMIN_USER_IDS in vault or by /init claim.", "info");
                    return;
                }
                const lines = ["Whitelisted users:", ""];
                for (const u of users) {
                    const name = u.displayName ? `${u.displayName} ` : "";
                    lines.push(`  ${u.platform}:${u.senderId} ${name}roles=[${u.roles.join(", ")}]`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (sub === "add") {
                const platform = parts[1];
                const senderId = parts[2];
                const rolesCsv = parts[3] ?? "user";
                if (!platform || !senderId) {
                    ctx.ui.notify("Usage: /whitelist add <platform> <senderId> [role1,role2,...]", "error");
                    return;
                }
                const roles = rolesCsv.split(",").map((r) => r.trim()).filter(Boolean);
                const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
                const addedBy = origin ? `${origin.platform}:${origin.senderId}` : "unknown";
                if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                    ctx.ui.notify("Only admins can modify the whitelist.", "error");
                    return;
                }
                whitelist.add(platform, senderId, { roles, addedBy });
                ctx.ui.notify(`Added ${platform}:${senderId} with roles [${roles.join(", ")}].`, "info");
                return;
            }

            if (sub === "remove") {
                const platform = parts[1];
                const senderId = parts[2];
                if (!platform || !senderId) {
                    ctx.ui.notify("Usage: /whitelist remove <platform> <senderId>", "error");
                    return;
                }
                const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
                if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                    ctx.ui.notify("Only admins can modify the whitelist.", "error");
                    return;
                }
                const ok = whitelist.remove(platform, senderId);
                ctx.ui.notify(ok ? `Removed ${platform}:${senderId}.` : `${platform}:${senderId} not found.`, "info");
                return;
            }

            ctx.ui.notify("Usage: /whitelist list | add <platform> <senderId> [roles] | remove <platform> <senderId>", "info");
        },
    });

    pi.registerCommand("channel-allow", {
        description:
            "Manage the channel allowlist for multi-user passive-context ingestion. " +
            "Allowed channels have all speakers' messages absorbed into per-channel " +
            "Pi sessions so future @mentions see the conversation. Does NOT grant " +
            "random speakers the right to trigger responses — that's still per-user. " +
            "Usage: /channel-allow list | add <platform> <channelId> [note...] | remove <platform> <channelId>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();
            const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);

            if (sub === "list") {
                const channels = whitelist.listChannels();
                if (channels.length === 0) {
                    ctx.ui.notify("No channels allowlisted. Group chats will be silently ignored until you /channel-allow add them.", "info");
                    return;
                }
                const lines = ["Allowlisted channels (passive context only):", ""];
                for (const c of channels) {
                    const note = c.note ? `  (${c.note})` : "";
                    lines.push(`  ${c.platform}:${c.channelId}${note}  added by ${c.addedBy}`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                ctx.ui.notify("Only admins can modify the channel allowlist.", "error");
                return;
            }

            if (sub === "add") {
                const platform = parts[1];
                const channelId = parts[2];
                if (!platform || !channelId) {
                    ctx.ui.notify("Usage: /channel-allow add <platform> <channelId> [note...]", "error");
                    return;
                }
                const note = parts.slice(3).join(" ").trim();
                const addedBy = origin ? `${origin.platform}:${origin.senderId}` : "unknown";
                whitelist.allowChannel(platform, channelId, { addedBy, ...(note ? { note } : {}) });
                ctx.ui.notify(`Allowed ${platform}:${channelId}${note ? ` (${note})` : ""}.`, "info");
                return;
            }

            if (sub === "remove") {
                const platform = parts[1];
                const channelId = parts[2];
                if (!platform || !channelId) {
                    ctx.ui.notify("Usage: /channel-allow remove <platform> <channelId>", "error");
                    return;
                }
                const ok = whitelist.removeChannel(platform, channelId);
                ctx.ui.notify(ok ? `Removed ${platform}:${channelId}.` : `${platform}:${channelId} not found.`, "info");
                return;
            }

            ctx.ui.notify("Usage: /channel-allow list | add <platform> <channelId> [note...] | remove <platform> <channelId>", "info");
        },
    });

    pi.registerCommand("blacklist", {
        description: "Manage blacklist. Usage: /blacklist list | add <platform> <senderId> [reason] | remove <platform> <senderId>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();
            const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
            if (sub !== "list" && origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                ctx.ui.notify("Only admins can modify the blacklist.", "error");
                return;
            }

            if (sub === "list") {
                const users = whitelist.listBlacklist();
                if (users.length === 0) { ctx.ui.notify("Blacklist is empty.", "info"); return; }
                const lines = ["Blacklisted users:", ""];
                for (const u of users) {
                    const name = u.displayName ? `${u.displayName} ` : "";
                    const reason = u.reason ? ` reason="${u.reason}"` : "";
                    lines.push(`  ${u.platform}:${u.senderId} ${name}${reason}`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (sub === "add") {
                const platform = parts[1];
                const senderId = parts[2];
                const reason = parts.slice(3).join(" ") || undefined;
                if (!platform || !senderId) { ctx.ui.notify("Usage: /blacklist add <platform> <senderId> [reason]", "error"); return; }
                whitelist.blacklist(platform, senderId, {
                    ...(reason !== undefined ? { reason } : {}),
                    addedBy: origin ? `${origin.platform}:${origin.senderId}` : "unknown",
                });
                ctx.ui.notify(`Blacklisted ${platform}:${senderId}.`, "info");
                return;
            }

            if (sub === "remove") {
                const platform = parts[1];
                const senderId = parts[2];
                if (!platform || !senderId) { ctx.ui.notify("Usage: /blacklist remove <platform> <senderId>", "error"); return; }
                const ok = whitelist.unblacklist(platform, senderId);
                ctx.ui.notify(ok ? `Unblacklisted ${platform}:${senderId}.` : `${platform}:${senderId} not on blacklist.`, "info");
                return;
            }

            ctx.ui.notify("Usage: /blacklist list | add <platform> <senderId> [reason] | remove <platform> <senderId>", "info");
        },
    });

    pi.registerCommand("role", {
        description: "Manage user roles. Usage: /role grant|revoke|list <args>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();

            if (sub === "list") {
                if (parts.length >= 3) {
                    const platform = parts[1]!;
                    const senderId = parts[2]!;
                    const roles = whitelist.rolesOf(platform, senderId);
                    ctx.ui.notify(
                        roles.length > 0
                            ? `${platform}:${senderId} has roles [${roles.join(", ")}].`
                            : `${platform}:${senderId} has no roles (not whitelisted, or blacklisted).`,
                        "info",
                    );
                    return;
                }
                const refd = toolAcl.allReferencedRoles();
                const all = whitelist.allRoles(refd);
                const lines = ["Roles in use:", ""];
                for (const role of all) {
                    const holders = whitelist.list().filter((u) => u.roles.includes(role));
                    const tools = toolAcl.listConfigured().filter((t) => t.requiredRoles.includes(role));
                    lines.push(`  ${role}: ${holders.length} holder(s), ${tools.length} tool(s)`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
            if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                ctx.ui.notify("Only admins can grant/revoke roles.", "error");
                return;
            }

            if (sub === "grant") {
                const platform = parts[1];
                const senderId = parts[2];
                const role = parts[3];
                if (!platform || !senderId || !role) { ctx.ui.notify("Usage: /role grant <platform> <senderId> <role>", "error"); return; }
                if (!whitelist.get(platform, senderId)) {
                    ctx.ui.notify(`${platform}:${senderId} is not in the whitelist. Use /whitelist add first.`, "error");
                    return;
                }
                const changed = whitelist.grantRole(platform, senderId, role);
                ctx.ui.notify(
                    changed ? `Granted ${role} to ${platform}:${senderId}.` : `${platform}:${senderId} already has ${role}.`,
                    "info",
                );
                return;
            }

            if (sub === "revoke") {
                const platform = parts[1];
                const senderId = parts[2];
                const role = parts[3];
                if (!platform || !senderId || !role) { ctx.ui.notify("Usage: /role revoke <platform> <senderId> <role>", "error"); return; }
                const changed = whitelist.revokeRole(platform, senderId, role);
                ctx.ui.notify(
                    changed ? `Revoked ${role} from ${platform}:${senderId}.` : `${platform}:${senderId} does not have ${role}.`,
                    "info",
                );
                return;
            }

            ctx.ui.notify("Usage: /role grant|revoke|list", "info");
        },
    });

    pi.registerCommand("tool-acl", {
        description: "Manage tool ACLs. Usage: /tool-acl list | set <toolName> <roles> | test <toolName> <platform>:<senderId> [argsJson]",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();

            if (sub === "list") {
                const entries = toolAcl.listConfigured();
                if (entries.length === 0) { ctx.ui.notify("No tool ACLs configured. Defaults apply (admin-only for unlisted tools).", "info"); return; }
                const lines = ["Tool ACLs:", ""];
                for (const e of entries) {
                    const flags: string[] = [];
                    if (e.alwaysConfirm) flags.push("alwaysConfirm");
                    if (e.rules && e.rules.length > 0) flags.push(`${e.rules.length} rule(s)`);
                    const tail = flags.length > 0 ? `  [${flags.join(", ")}]` : "";
                    lines.push(`  ${e.toolName.padEnd(28)} requires=[${e.requiredRoles.join(", ")}]${tail}`);
                }
                lines.push("", "Hand-edit data/<bot>/tool_acl.json to author rules / alwaysConfirm.");
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (sub === "set") {
                const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
                if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                    ctx.ui.notify("Only admins can modify tool ACLs.", "error");
                    return;
                }
                const toolName = parts[1];
                const rolesCsv = parts[2];
                if (!toolName || !rolesCsv) { ctx.ui.notify("Usage: /tool-acl set <toolName> <role1,role2,...>", "error"); return; }
                const roles = rolesCsv.split(",").map((r) => r.trim()).filter(Boolean);
                toolAcl.set(toolName, roles, origin ? `${origin.platform}:${origin.senderId}` : "unknown");
                ctx.ui.notify(`Set ${toolName} → requires [${roles.join(", ")}]. (rules + alwaysConfirm preserved.)`, "info");
                return;
            }

            if (sub === "test") {
                const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
                if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                    ctx.ui.notify("Only admins can dry-run tool ACL evaluation.", "error");
                    return;
                }
                // Match `test <toolName> <platform>:<senderId> [optional rest treated as JSON]`.
                // JSON may contain whitespace, so we anchor on the first three tokens then
                // grab everything after as a single string.
                const m = (args ?? "").trim().match(/^test\s+(\S+)\s+(\S+)(?:\s+([\s\S]+))?$/i);
                if (!m) {
                    ctx.ui.notify('Usage: /tool-acl test <toolName> <platform>:<senderId> [argsJson]', "error");
                    return;
                }
                const toolName = m[1]!;
                const userStr = m[2]!;
                const argsJsonRaw = m[3] ?? "{}";
                const colon = userStr.indexOf(":");
                if (colon < 1 || colon === userStr.length - 1) {
                    ctx.ui.notify('User must be "<platform>:<senderId>" (e.g. telegram:12345).', "error");
                    return;
                }
                const platform = userStr.slice(0, colon);
                const senderId = userStr.slice(colon + 1);
                let toolArgs: unknown;
                try { toolArgs = JSON.parse(argsJsonRaw); } catch (e) {
                    ctx.ui.notify(`Invalid JSON for args: ${e instanceof Error ? e.message : String(e)}`, "error");
                    return;
                }
                const callerRoles = whitelist.rolesOf(platform, senderId);
                const trace = evaluatePolicy(toolAcl.policyEntry(toolName), {
                    callerPlatform: platform,
                    callerSenderId: senderId,
                    callerRoles,
                    toolArgs,
                });
                const lines = [
                    `Policy dry-run for tool=${toolName}`,
                    `  caller:    ${platform}:${senderId}`,
                    `  roles:     [${callerRoles.join(", ") || "(none)"}]`,
                    `  args:      ${argsJsonRaw}`,
                    `  decision:  ${trace.decision.kind}` + (trace.decision.kind === "deny" ? ` — ${trace.decision.reason}` : ""),
                    `  via:       ${trace.explanation}`,
                ];
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            ctx.ui.notify("Usage: /tool-acl list | set <toolName> <roles> | test <toolName> <platform>:<senderId> [argsJson]", "info");
        },
    });

    pi.registerCommand("totp", {
        description: "Per-admin TOTP enrollment for 2FA. Usage: /totp setup | verify <code> | status | disable",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "status").toLowerCase();

            const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
            if (!origin) {
                ctx.ui.notify("Could not determine your identity for TOTP.", "error");
                return;
            }
            if (!whitelist.isAdmin(origin.platform, origin.senderId)) {
                ctx.ui.notify("Only admins can manage their own TOTP enrollment.", "error");
                return;
            }

            if (sub === "setup") {
                const wasEnrolled = totp.isEnrolled(origin.platform, origin.senderId);
                const result = totp.enroll(origin.platform, origin.senderId, origin.senderDisplayName);
                const lines = [
                    wasEnrolled
                        ? "⚠️  TOTP RE-ENROLLED — your previous secret has been replaced."
                        : "✅ TOTP enrolled. Scan the URI below in your Authenticator app.",
                    "",
                    `otpauth URI: ${result.otpauthUri}`,
                    `Bare secret: ${result.secret}`,
                    "",
                    "Then verify your setup with: /totp verify <6-digit code>",
                    "Until verified, the secret is stored but never been confirmed to match your app.",
                ];
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (sub === "verify") {
                const code = parts[1];
                if (!code) { ctx.ui.notify("Usage: /totp verify <6-digit code>", "error"); return; }
                if (!totp.isEnrolled(origin.platform, origin.senderId)) {
                    ctx.ui.notify("You are not enrolled. Run /totp setup first.", "error");
                    return;
                }
                const ok = totp.verify(origin.platform, origin.senderId, code);
                ctx.ui.notify(
                    ok ? "✅ Code valid. TOTP is working." : "❌ Code did not verify. Check device clock and re-enter, or /totp setup again to re-enroll.",
                    ok ? "info" : "error",
                );
                return;
            }

            if (sub === "status") {
                const s = totp.status(origin.platform, origin.senderId);
                if (!s.enrolled) {
                    ctx.ui.notify(`TOTP NOT enrolled for ${origin.platform}:${origin.senderId}. Run /totp setup.`, "info");
                    return;
                }
                const last = s.lastVerifiedAt ? new Date(s.lastVerifiedAt).toISOString() : "never";
                const enrolled = s.enrolledAt ? new Date(s.enrolledAt).toISOString() : "unknown";
                ctx.ui.notify(
                    `TOTP enrolled for ${origin.platform}:${origin.senderId}.\n  enrolled at:        ${enrolled}\n  last verified at:   ${last}`,
                    "info",
                );
                return;
            }

            if (sub === "disable") {
                const ok = totp.disable(origin.platform, origin.senderId);
                ctx.ui.notify(
                    ok ? "TOTP disabled. Re-enroll via /totp setup." : "You were not enrolled.",
                    "info",
                );
                return;
            }

            ctx.ui.notify("Usage: /totp setup | verify <code> | status | disable", "info");
        },
    });

    pi.registerCommand("secrets-audit", {
        description:
            "Show secret-access stats: top-N most-accessed secrets, recent reads, " +
            "current per-secret reads-per-minute. Admin only. Usage: /secrets-audit [recent N]",
        handler: async (args, ctx) => {
            const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
            if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                ctx.ui.notify("Only admins can view secret access audit.", "error");
                return;
            }
            const log = getSecretAccessLog();
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const recentMode = parts[0]?.toLowerCase() === "recent";
            const recentN = recentMode ? Number(parts[1] ?? "20") : 0;

            if (recentMode) {
                const recent = log.recentReads(Number.isFinite(recentN) && recentN > 0 ? recentN : 20);
                if (recent.length === 0) { ctx.ui.notify("No secret reads recorded this session.", "info"); return; }
                const lines = ["Recent secret reads (newest first):", ""];
                for (const r of recent) {
                    const ago = Math.round((Date.now() - r.when) / 1000);
                    lines.push(`  ${ago.toString().padStart(5)}s ago  ${r.source.padEnd(40)} caller=${r.caller || "(unknown)"}`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            const top = log.topReads(50);
            if (top.length === 0) {
                ctx.ui.notify("No secret reads recorded yet this process lifetime.\n(/secrets-audit recent N for raw event log.)", "info");
                return;
            }
            const lines = [
                `Secret access audit — ${log.distinctSources()} distinct secret(s) read this session.`,
                "",
                "  reads  rpm60s   secret",
                "  -----  ------   ------",
            ];
            for (const t of top) {
                const rpm = log.rate(t.source, 60_000).toFixed(2);
                lines.push(`  ${String(t.count).padStart(5)}  ${rpm.padStart(6)}   ${t.source}`);
            }
            lines.push("", "Try: /secrets-audit recent 20  for the raw event log + caller hints.");
            ctx.ui.notify(lines.join("\n"), "info");
        },
    });

    pi.registerCommand("staging", {
        description: "Pending action management. Usage: /staging list | cancel <token>",
        handler: async (args, ctx) => {
            const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
            const sub = (parts[0] ?? "list").toLowerCase();

            if (sub === "list") {
                const actions = staging.listActive();
                if (actions.length === 0) { ctx.ui.notify("No pending actions.", "info"); return; }
                const lines = ["Pending actions:", ""];
                for (const a of actions) {
                    const remaining = Math.max(0, Math.round((a.expiresAt - Date.now()) / 1000));
                    const who = a.userDisplayName ?? a.userSenderId;
                    lines.push(`  ${a.token}  ${a.toolName}  by ${who} (${a.userPlatform})  expires in ${remaining}s`);
                }
                ctx.ui.notify(lines.join("\n"), "info");
                return;
            }

            if (sub === "cancel") {
                const origin = currentOrigin(ctx.sessionManager) ?? inferOriginFromCli(ctx);
                if (origin && !whitelist.isAdmin(origin.platform, origin.senderId)) {
                    ctx.ui.notify("Only admins can cancel staged actions.", "error");
                    return;
                }
                const token = parts[1];
                if (!token) { ctx.ui.notify("Usage: /staging cancel <token>", "error"); return; }
                const ok = staging.cancel(token.toUpperCase());
                ctx.ui.notify(ok ? `Cancelled ${token}.` : `${token} not found or already consumed.`, "info");
                return;
            }

            ctx.ui.notify("Usage: /staging list | cancel <token>", "info");
        },
    });
}

// -------------- helpers --------------

/**
 * transport_bridge prepends inbound chat messages with a metadata header:
 *   `[Inbound | platform: ... | from: ... | ...]\n\n<actual body>`
 * Strip it so admin_gate's input handlers can match user-typed prefixes
 * (/init, Approve ACT-...) at the body's start. CLI input has no header,
 * so this is a no-op for terminal users.
 */
function stripMetadataHeader(text: string): string {
    const m = text.match(/^\[Inbound \|[^\]]*\]\s*\n\n([\s\S]*)$/);
    return m ? m[1]! : text;
}

/** Synthesise an InboundOrigin for the CLI operator. Used when no chat origin is persisted. */
function inferOriginFromCli(_ctx: unknown): InboundOrigin | null {
    // CLI sender identity is the OS username. Mirrors what CliAdapter reports.
    try {
        const os = require("node:os") as typeof import("node:os");
        const u = os.userInfo().username;
        return {
            platform: "cli",
            channelId: "cli:default",
            senderId: u,
            senderDisplayName: u,
            timestamp: Date.now(),
        };
    } catch {
        return null;
    }
}

// One-shot allowances: after an admin approves a staged tool call, the LLM's
// next attempt to call that tool must succeed. We store a short-lived
// (tool, platform, senderId) triple here; tool_call consumes it on first
// match. Memory-only — if the admin-approve flow is interrupted (e.g. crash
// between approve and re-call), the admin just re-approves.

interface Allowance {
    toolName: string;
    platform: string;
    senderId: string;
    expiresAt: number;
}
const ALLOWANCES: Allowance[] = [];
const ALLOWANCE_TTL_MS = 60_000; // 60 seconds

function installOneShotAllowance(toolName: string, origin: InboundOrigin): void {
    ALLOWANCES.push({
        toolName,
        platform: origin.platform,
        senderId: origin.senderId,
        expiresAt: Date.now() + ALLOWANCE_TTL_MS,
    });
}

function consumeOneShotAllowance(toolName: string, origin: InboundOrigin): boolean {
    const now = Date.now();
    for (let i = ALLOWANCES.length - 1; i >= 0; i--) {
        const a = ALLOWANCES[i]!;
        if (a.expiresAt < now) {
            ALLOWANCES.splice(i, 1);
            continue;
        }
        if (a.toolName === toolName && a.platform === origin.platform && a.senderId === origin.senderId) {
            ALLOWANCES.splice(i, 1);
            return true;
        }
    }
    return false;
}

// =============================================================================
// Action describers — extensions register a function that turns a tool's args
// into a human-readable description for the staging prompt. Lets the admin
// see "applying DNA feature 'kpi-tracker' v1.2 from kpi_bot, files: …" instead
// of just "Approve ACT-XXXXXX". Critical for any tool whose args carry intent
// the admin needs to verify (apply_dna manifest, bash command, fetch URL).
// =============================================================================

type ActionDescriber = (args: unknown) => string | null;
const ACTION_DESCRIBERS: Map<string, ActionDescriber> = new Map();

/**
 * Register a per-tool describer. Called by other extensions on session_start.
 * Returns a multi-line string that admin_gate embeds in the staging-block
 * reason. Return null if the args can't be described (e.g., import not
 * found) — admin_gate falls back to the generic shortArgsSummary.
 */
export function registerActionDescriber(toolName: string, describer: ActionDescriber): void {
    ACTION_DESCRIBERS.set(toolName, describer);
}

function describeAction(toolName: string, args: unknown): string | null {
    const d = ACTION_DESCRIBERS.get(toolName);
    if (!d) return null;
    try {
        return d(args);
    } catch (e) {
        console.warn(`[admin_gate] action describer for ${toolName} threw: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}

/** Generic fallback when no describer is registered. Truncated to keep
 *  the chat-side staging prompt readable. */
function shortArgsSummary(args: unknown): string {
    try {
        const json = JSON.stringify(args);
        return json.length > 500 ? json.slice(0, 500) + "…[truncated]" : json;
    } catch {
        return "(unrepresentable)";
    }
}
