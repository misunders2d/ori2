// =============================================================================
// Evolution-audit helpers — pure functions used by tdd_enforcer's
// verify_and_commit gate to confirm that the agent followed the evolution-sop
// discipline (Phase 1 safety briefing + Phase 2 prior-art search) BEFORE
// committing new code.
//
// Why pure functions: verify_and_commit is where the hard gate lives, but we
// want to unit-test the gate without spawning Pi. All the decision logic is
// here; verify_and_commit just calls into these.
// =============================================================================

/** Session-entry customType written by the evolution_prior_art_search tool. */
export const PRIOR_ART_ENTRY = "evolution-prior-art";

/** Session-entry customType written by the evolve_safety_ack tool. */
export const SAFETY_ACK_ENTRY = "evolution-safety-ack";

export interface PriorArtRecord {
    domain: string;
    conclusion: string;
    at: number;
}

export interface SafetyAckRecord {
    domain: string;
    risks_count: number;
    user_acknowledged: boolean;
    at: number;
}

export interface EvolutionAuditResult {
    hasValidPriorArt: boolean;
    /** Safety ack EXISTS AND user_acknowledged=true. */
    hasValidSafetyAck: boolean;
    mostRecentPriorArt?: PriorArtRecord;
    mostRecentSafetyAck?: SafetyAckRecord;
    /** Human-readable reasons the gate would refuse commit. Empty when clean. */
    missing: string[];
    /** Operator/agent-facing next-steps text, or "" when clean. */
    remedy: string;
}

/**
 * Walk a session branch (root→leaf chronological — Pi returns this order from
 * getBranch) and surface the most-recent prior-art + safety-ack entries.
 *
 * The audit is session-scoped, not domain-scoped: if the agent ran prior-art
 * + ack for ANY domain in this session, the gate passes. Domain-scoping would
 * require verify_and_commit to accept a domain parameter — which it doesn't,
 * and adding it would be a breaking change. The session entries themselves
 * carry the domain name for post-hoc audit.
 */
export function auditSessionForEvolution(
    branch: ReadonlyArray<unknown>,
): EvolutionAuditResult {
    let priorArt: PriorArtRecord | undefined;
    let safetyAck: SafetyAckRecord | undefined;

    for (const raw of branch) {
        if (!raw || typeof raw !== "object") continue;
        const e = raw as { type?: string; customType?: string; data?: unknown };
        if (e.type !== "custom") continue;

        if (e.customType === PRIOR_ART_ENTRY && e.data && typeof e.data === "object") {
            const d = e.data as Record<string, unknown>;
            priorArt = {
                domain: typeof d["domain"] === "string" ? d["domain"] : "unknown",
                conclusion: typeof d["conclusion"] === "string" ? d["conclusion"] : "",
                at: typeof d["at"] === "number" ? d["at"] : 0,
            };
        } else if (e.customType === SAFETY_ACK_ENTRY && e.data && typeof e.data === "object") {
            const d = e.data as Record<string, unknown>;
            const risks = d["risks_enumerated"];
            safetyAck = {
                domain: typeof d["domain"] === "string" ? d["domain"] : "unknown",
                risks_count: Array.isArray(risks) ? risks.length : 0,
                user_acknowledged: d["user_acknowledged"] === true,
                at: typeof d["at"] === "number" ? d["at"] : 0,
            };
        }
    }

    const missing: string[] = [];
    if (!priorArt) {
        missing.push("Phase 2 prior-art search — call `evolution_prior_art_search` first");
    }
    if (!safetyAck) {
        missing.push("Phase 1 safety briefing — call `evolve_safety_ack` after showing the user concrete risks");
    } else if (!safetyAck.user_acknowledged) {
        missing.push("User must acknowledge the safety briefing before commit — re-call `evolve_safety_ack` with user_acknowledged=true after they confirm");
    }

    const result: EvolutionAuditResult = {
        hasValidPriorArt: !!priorArt,
        hasValidSafetyAck: !!safetyAck && safetyAck.user_acknowledged,
        missing,
        remedy: missing.length === 0
            ? ""
            : "EVOLUTION GATE: verify_and_commit refused — evolution-sop discipline not satisfied:\n" +
              missing.map((m) => `  - ${m}`).join("\n") +
              "\n\nConsult the `evolution-sop` skill for the full 6-phase flow.",
    };
    if (priorArt) result.mostRecentPriorArt = priorArt;
    if (safetyAck) result.mostRecentSafetyAck = safetyAck;
    return result;
}
