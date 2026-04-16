import type { AgentCard, AgentCardSkill } from "./types.js";

// =============================================================================
// Pure builder for the v1.0 A2A agent card. No I/O, no env reads — caller
// passes everything explicitly. Persisting the rendered card to disk happens
// in src/a2a/server.ts at the moment a base URL becomes available.
//
// Skill list composition (fixed → additional → dna):
//   1. FIXED_SKILLS — always advertised, baked in here.
//   2. additionalSkills — operator-curated extras from A2A_SKILLS_JSON
//      vault entry, parsed by the caller before invoking buildAgentCard.
//   3. dnaFeatures — registered DNA features rendered as `dna:<id>` skill
//      entries. Tags get `"dna"` prepended so peers can filter.
// =============================================================================

/** Always-advertised core skills. Add to this list when ori2 itself gains a public capability. */
export const FIXED_SKILLS: AgentCardSkill[] = [
    {
        id: "general-conversation",
        name: "general-conversation",
        description:
            "General-purpose conversation, task management, scheduling, and the standard ori2 operator surface.",
        tags: ["conversation", "default"],
    },
    {
        id: "dna-exchange",
        name: "dna-exchange",
        description:
            "Packages and exchanges named, secret-scrubbed feature bundles (extensions, skills, prompts) with peer ori2 instances.",
        tags: ["a2a", "exchange"],
    },
];

export interface BuildAgentCardInput {
    botName: string;
    agentId: string;
    /** Defaults to "1.0.0". */
    version?: string;
    description: string;
    /** Public URL — typically the cloudflared tunnel address. */
    baseUrl: string;
    providerName?: string;
    providerUrl?: string;
    additionalSkills?: AgentCardSkill[];
    dnaFeatures?: Array<{ id: string; description: string; tags?: string[] }>;
    /**
     * If true, the card declares the `x-a2a-api-key` header security scheme.
     * Set to false when the operator deliberately runs an unauthenticated
     * server (testing only — never in production).
     */
    hasApiKey?: boolean;
}

export function buildAgentCard(input: BuildAgentCardInput): AgentCard {
    const baseUrl = input.baseUrl;
    const dnaSkills: AgentCardSkill[] = (input.dnaFeatures ?? []).map((f) => ({
        id: `dna:${f.id}`,
        name: f.id,
        description: f.description,
        tags: ["dna", ...(f.tags ?? [])],
    }));

    const card: AgentCard = {
        id: input.agentId,
        name: input.botName,
        version: input.version ?? "1.0.0",
        description: input.description,
        url: baseUrl,
        provider: {
            organization: input.providerName ?? "Ori2 Project",
            url: input.providerUrl ?? baseUrl,
        },
        defaultInputModes: ["text/plain"],
        defaultOutputModes: ["text/plain"],
        endpoints: [{ type: "json-rpc", url: baseUrl }],
        capabilities: {
            streaming: false,
            pushNotifications: false,
            multiTurn: true,
            extendedAgentCard: false,
        },
        skills: [
            ...FIXED_SKILLS,
            ...(input.additionalSkills ?? []),
            ...dnaSkills,
        ],
    };

    if (input.hasApiKey) {
        card.securitySchemes = {
            apiKey: { type: "apiKey", name: "x-a2a-api-key", in: "header" },
        };
        card.security = [{ apiKey: [] }];
    }

    return card;
}
