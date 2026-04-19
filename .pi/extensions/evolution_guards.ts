import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { PRIOR_ART_ENTRY, SAFETY_ACK_ENTRY } from "../../src/core/evolutionAudit.js";

// =============================================================================
// evolution_guards — the two mandatory gates the agent must pass BEFORE
// writing code for a new evolution.
//
//   evolution_prior_art_search  → Phase 2 of evolution-sop. Agent records the
//     prior art it found (Pi examples, GitHub hits, SDK docs) and its
//     conclusion (reuse vs adapt vs build-fresh). Prevents trial-and-error
//     reinvention when proven implementations exist.
//
//   evolve_safety_ack           → Phase 1 of evolution-sop. Agent records the
//     concrete safety risks it briefed the user about AND the user's explicit
//     acknowledgement. Prevents evolution from proceeding without the
//     operator seeing what they're authorizing.
//
// Both tools write custom session entries. tdd_enforcer's verify_and_commit
// reads these via auditSessionForEvolution() and REFUSES to commit if either
// is missing. That turns evolution-sop from polite guidance into a hard gate.
// =============================================================================

export default function (pi: ExtensionAPI) {
    pi.registerTool({
        name: "evolution_prior_art_search",
        label: "Record Prior Art Search (Evolution Phase 2)",
        description:
            "Record the results of searching for prior-art implementations BEFORE writing any code " +
            "for a new evolution. Call this AFTER performing the three mandatory searches:\n" +
            "  (1) Pi's own examples — fetch/read node_modules/@mariozechner/pi-coding-agent/docs " +
            "and https://github.com/badlogic/pi-mono/tree/main/examples/extensions for reference " +
            "extensions (subagent, protected-paths, etc).\n" +
            "  (2) GitHub code search — use web_search or web_fetch with queries like " +
            "`\"pi.registerTool\" <domain-keyword>` and `\"@mariozechner/pi-coding-agent\" <domain>` " +
            "to find community extensions.\n" +
            "  (3) Domain SDK docs — fetch the official docs for the target service (Pinecone, " +
            "SendGrid, ClickUp, etc.) via web_fetch to confirm API shape.\n\n" +
            "Present the findings to the user BEFORE calling this tool; then call this tool with " +
            "your structured record + conclusion. The tool writes a session entry that " +
            "verify_and_commit later gates on — without it, commit is refused.\n\n" +
            "This tool does NOT perform the searches itself (web_search / web_fetch do that). " +
            "It records that the searches happened and their structured outcome.",
        parameters: Type.Object({
            domain: Type.String({
                description: "Short identifier for the evolution domain (e.g. 'pinecone', 'sendgrid-email', 'clickup-tasks'). Used for audit trail.",
            }),
            pi_examples_checked: Type.Array(
                Type.String(),
                { description: "List of Pi's own examples/extensions you consulted (paths or descriptions). Empty array if none are relevant — that itself is a valid finding." },
            ),
            github_searches_performed: Type.Array(
                Type.Object({
                    query: Type.String(),
                    relevant_hits: Type.Array(Type.String(), { description: "URLs or repo paths of relevant results. Empty array is fine." }),
                }),
                { description: "GitHub (or broader web) searches you ran and their relevant hits. Document zero-hit searches too." },
            ),
            sdk_docs_reviewed: Type.Array(
                Type.String(),
                { description: "URLs of domain SDK / API documentation you fetched. Must include at least one URL if the evolution calls a 3rd-party API." },
            ),
            conclusion: Type.String({
                description: "One of: 'adapt-existing: <explanation>' / 'partial-reuse: <explanation>' / 'build-fresh: <explanation>'. Include the reasoning — what prior art justified (or failed to justify) the chosen path.",
            }),
        }),
        async execute(_id, params) {
            const entry = {
                domain: params.domain,
                pi_examples_checked: params.pi_examples_checked,
                github_searches_performed: params.github_searches_performed,
                sdk_docs_reviewed: params.sdk_docs_reviewed,
                conclusion: params.conclusion,
                at: Date.now(),
            };
            pi.appendEntry(PRIOR_ART_ENTRY, entry);
            return {
                content: [{
                    type: "text",
                    text:
                        `Prior-art search recorded for domain "${params.domain}". ` +
                        `Pi examples: ${params.pi_examples_checked.length} · ` +
                        `GitHub searches: ${params.github_searches_performed.length} · ` +
                        `SDK docs: ${params.sdk_docs_reviewed.length}. ` +
                        `Conclusion: ${params.conclusion}. ` +
                        `\n\nPhase 2 gate SATISFIED. Next: complete Phase 1 safety briefing (evolve_safety_ack) if not already done, then proceed to Phase 3+.`,
                }],
                details: entry,
            };
        },
    });

    pi.registerTool({
        name: "evolve_safety_ack",
        label: "Record Safety Briefing + User Acknowledgement (Evolution Phase 1)",
        description:
            "Record the safety briefing you showed the user AND their explicit acknowledgement. " +
            "Call this AFTER you have:\n" +
            "  (a) Enumerated concrete risks for THIS evolution (not boilerplate). Credential " +
            "exposure paths, prompt-injection surfaces, network exfil vectors, filesystem write " +
            "scope, dependency supply-chain risks. Each risk must be specific to what the " +
            "evolution does.\n" +
            "  (b) Proposed concrete mitigations for each risk.\n" +
            "  (c) Asked the user explicitly to confirm proceeding (e.g. \"reply `confirm` to " +
            "authorize this evolution\").\n" +
            "  (d) Received their explicit confirmation — you must set user_acknowledged=true " +
            "ONLY if the user has actually replied affirmatively. Fabricating acknowledgement " +
            "is a safety-gate violation.\n\n" +
            "The tool writes a session entry that verify_and_commit later gates on. Commit is " +
            "refused if this entry is missing OR if user_acknowledged=false.",
        parameters: Type.Object({
            domain: Type.String({ description: "Short identifier for the evolution (e.g. 'pinecone'). Matches the prior-art domain." }),
            risks_enumerated: Type.Array(
                Type.Object({
                    category: Type.String({ description: "One of: 'credentials', 'injection', 'exfil', 'fs-write', 'supply-chain', 'other'." }),
                    specifics: Type.String({ description: "Concrete, specific-to-this-evolution description. E.g. 'Pinecone API key stored via /credentials add; never logged; transmitted only over HTTPS to api.pinecone.io'." }),
                    mitigation: Type.String({ description: "How the code will prevent this risk. E.g. 'use getCredential().get(\"pinecone\") at call-time; do not pass to any other tool output'." }),
                }),
                {
                    minItems: 1,
                    description: "At least one specific risk. Generic risks (\"could leak data\") without a concrete mitigation are rejected by convention — a reviewer should see what actually prevents each issue.",
                },
            ),
            briefing_shown_to_user: Type.String({
                description: "The actual text of the safety briefing you posted to the user (verbatim, for audit trail). Must mention each enumerated risk.",
            }),
            user_acknowledged: Type.Boolean({
                description: "TRUE only if the user has explicitly replied to authorize this evolution after seeing the briefing. FALSE otherwise — commit will be blocked.",
            }),
            user_reply_quote: Type.Optional(Type.String({ description: "Optional: quote the user's acknowledgement reply verbatim for the audit trail." })),
        }),
        async execute(_id, params) {
            const entry = {
                domain: params.domain,
                risks_enumerated: params.risks_enumerated,
                briefing_shown_to_user: params.briefing_shown_to_user,
                user_acknowledged: params.user_acknowledged,
                ...(params.user_reply_quote !== undefined ? { user_reply_quote: params.user_reply_quote } : {}),
                at: Date.now(),
            };
            pi.appendEntry(SAFETY_ACK_ENTRY, entry);

            const riskSummary = params.risks_enumerated
                .map((r) => `  • ${r.category}: ${r.specifics.slice(0, 80)}${r.specifics.length > 80 ? "…" : ""}`)
                .join("\n");
            const ackText = params.user_acknowledged
                ? `Safety briefing recorded, user acknowledged. Phase 1 gate SATISFIED.`
                : `Safety briefing recorded BUT user has NOT acknowledged. Phase 1 gate NOT satisfied. ` +
                  `After the user replies to confirm, call this tool again with user_acknowledged=true.`;
            return {
                content: [{
                    type: "text",
                    text:
                        `Evolution safety briefing recorded for domain "${params.domain}".\n` +
                        `Risks (${params.risks_enumerated.length}):\n${riskSummary}\n\n${ackText}`,
                }],
                details: entry,
            };
        },
    });
}
