// Shared types for the A2A subsystem. Kept in one file so the wire shape
// (agent card + friend record + DNA manifest) lives in a single place — easy
// to inspect when debugging interop issues with peers.

// =============================================================================
// Agent card — Google A2A v1.0 spec subset we generate + accept
// =============================================================================

export interface AgentCardSkill {
    /** Stable id. DNA features use the prefix `dna:` so requesters can distinguish. */
    id: string;
    name: string;
    description: string;
    /** Required by @a2a-js/sdk's AgentSkill. Empty array if no tags. */
    tags: string[];
}

export interface AgentCardEndpoint {
    type: "json-rpc" | string;
    url: string;
}

export interface AgentCardCapabilities {
    streaming: boolean;
    pushNotifications: boolean;
    multiTurn: boolean;
    extendedAgentCard: boolean;
}

export interface AgentCardSecurityScheme {
    type: "apiKey";
    name: string;
    in: "header" | "query";
}

export interface AgentCard {
    /**
     * A2A spec version we implement. Required by @a2a-js/sdk's AgentCard
     * shape — value is the spec version we render to (e.g. "0.3.0").
     */
    protocolVersion: string;
    /** Our internal agent id. SDK doesn't require it but we use it for our own audit. */
    id: string;
    name: string;
    version: string;
    description: string;
    url: string;
    provider: { organization: string; url: string };
    defaultInputModes: string[];
    defaultOutputModes: string[];
    /** Our-side legacy field — SDK uses `additionalInterfaces` instead. Kept for backward audit logs. */
    endpoints: AgentCardEndpoint[];
    capabilities: AgentCardCapabilities;
    skills: AgentCardSkill[];
    securitySchemes?: Record<string, AgentCardSecurityScheme>;
    security?: Array<Record<string, string[]>>;
}

// =============================================================================
// Friend registry — what we persist locally about each peer
// =============================================================================

export interface FriendRecord {
    /** Operator-chosen short name. Used as the registry key + as `senderId` (a2a:<name>) on inbound dispatch. */
    name: string;
    /** Public base URL of the peer's A2A server. Updated by address-update broadcasts. */
    base_url: string;
    /** Same as base_url today. Reserved if a peer ever splits discovery from JSON-RPC. */
    endpoint_url: string;
    /** From their agent card on add. */
    agent_id: string;
    added_at: number;
    /** "<platform>:<senderId>" of the operator who added — for audit. */
    added_by: string;
    /** Optional cached display name from the card (informational). */
    displayName?: string;
    /** Skills array we observed when discovering them. Updated on next call. */
    card_skills?: string[];
    /** Wallclock when address-update last fired or we observed inbound traffic. */
    last_seen_at?: number;
    last_address_update?: number;
}

export interface FriendsFile {
    version: number;
    updated_at: number;
    friends: Record<string, FriendRecord>;
}

// =============================================================================
// DNA exchange — feature catalog + tarball manifest
// =============================================================================

export interface DnaFeature {
    description: string;
    /** Paths under .pi/ — relative to the project root. Validated against an allowlist. */
    files: string[];
    tags?: string[];
    version: string;
    /** ["*"] = all friends; [] = nobody (private); ["nameA","nameB"] = explicit allow list. */
    share_with: string[];
    registered_at: number;
    /** "<platform>:<senderId>" of the operator who registered — for audit. */
    registered_by: string;
}

export interface DnaFeaturesFile {
    version: number;
    features: Record<string, DnaFeature>;
}

export interface DnaManifestFile {
    path: string;
    sha256: string;
    size: number;
}

/** Manifest written into manifest.json at the root of every DNA tarball. */
export interface DnaManifest {
    feature_id: string;
    feature_version: string;
    source_bot: string;
    source_agent_id: string;
    ori2_version: string;
    pi_sdk_version: string;
    exported_at: number;
    files: DnaManifestFile[];
    description: string;
    tags: string[];
}

// =============================================================================
// Invitation token — base64-encoded JSON for the bilateral handshake
// =============================================================================

export interface InvitationTokenPayload {
    inviter_name: string;
    inviter_url: string;
    /** The bearer key the invitee will present when calling the inviter. */
    inviter_key: string;
    invite_id: string;
    /** Wallclock ms after which the token must be rejected on accept. */
    expires_at: number;
}
