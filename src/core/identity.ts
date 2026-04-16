// =============================================================================
// Identity — reads the most-recent inbound "origin" from the current session.
//
// transport_bridge.ts persists a `transport-origin` custom entry on each
// inbound push. Extensions that need to know "who is talking right now?"
// (admin_gate for tool_call ACL/staging, memory_save for attributing saves,
// etc.) walk the session branch and pick the latest entry.
//
// Not a singleton — takes the ReadonlySessionManager from an extension's
// ExtensionContext. Import-and-call style.
// =============================================================================

export interface InboundOrigin {
    platform: string;
    channelId: string;
    threadId?: string;
    senderId: string;
    senderDisplayName: string;
    timestamp: number;
}

// The session-manager shape varies between Pi versions; use a minimal
// structural type so this helper doesn't tightly couple to the SDK.
interface BranchEntry {
    type: string;
    customType?: string;
    data?: unknown;
}
interface SessionManagerLike {
    getBranch(): ReadonlyArray<BranchEntry>;
}

const ENTRY_TYPE = "transport-origin";

/**
 * Returns the most-recent InboundOrigin on the current branch, or null if
 * the session has no inbound yet (e.g. CLI-only, or before the first
 * Telegram message).
 */
export function currentOrigin(sm: SessionManagerLike): InboundOrigin | null {
    const branch = sm.getBranch();
    for (let i = branch.length - 1; i >= 0; i--) {
        const e = branch[i];
        if (!e || e.type !== "custom" || e.customType !== ENTRY_TYPE) continue;
        const d = e.data as Partial<InboundOrigin> | undefined;
        if (!d || typeof d.platform !== "string" || typeof d.senderId !== "string") continue;
        return {
            platform: d.platform,
            channelId: typeof d.channelId === "string" ? d.channelId : "",
            ...(typeof d.threadId === "string" ? { threadId: d.threadId } : {}),
            senderId: d.senderId,
            senderDisplayName: typeof d.senderDisplayName === "string" ? d.senderDisplayName : d.senderId,
            timestamp: typeof d.timestamp === "number" ? d.timestamp : Date.now(),
        };
    }
    return null;
}
