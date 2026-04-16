// =============================================================================
// Tool-call policy evaluator. Pure function, no I/O, no SDK calls.
//
// Inputs:
//   - PolicyEntry — the per-tool ACL row (requiredRoles + rules + alwaysConfirm)
//   - EvaluatorContext — who is calling, what roles they hold, and what args
//     they're passing to the tool
//
// Output: a typed Decision the gate switches on.
//
// Algorithm:
//   1. Scan all rules; collect matching ones by action category.
//   2. If any "deny" matched → return deny (deny-precedence; first matching
//      deny's reason wins).
//   3. Pass-the-gate test: caller either (a) holds at least one of the base
//      requiredRoles OR (b) some "allow" rule matched as an exception. Else
//      → deny ("no role and no allow exception").
//   4. If any "require_2fa" matched → require_2fa (stricter than confirm).
//   5. If any "require_confirm" matched OR alwaysConfirm flag → require_confirm.
//   6. Otherwise → allow.
//
// Match clauses (all specified clauses must hold for the rule to fire):
//   - user:  exact "<platform>:<senderId>" match against caller identity.
//   - role:  caller holds this role (any of their roles).
//   - args:  shallow dot-path lookup into the tool's input + glob match.
//            Only "*" (zero-or-more) and "?" (one-char) are supported —
//            no regex (avoid ReDoS), no negation, no boolean composition.
//            Multiple keys = AND. Missing path → no match.
//
// Why "allow" rules can override base role: the user explicitly asked for
// this — e.g. `bigquery_query` requires admin by default, but an "analyst"
// role gets allowed through for `dataset=marketing` only. Without this,
// every cross-cutting exception would need its own role.
// =============================================================================

export type PolicyAction = "allow" | "deny" | "require_confirm" | "require_2fa";

export interface PolicyMatch {
    /** Exact "<platform>:<senderId>" match against caller identity. */
    user?: string;
    /** Caller holds this role (checked against their full role set). */
    role?: string;
    /** Map of dot-path → glob pattern. All keys must match. */
    args?: Record<string, string>;
}

export interface PolicyRule {
    match: PolicyMatch;
    action: PolicyAction;
    /** Required when action is "deny"; ignored otherwise. */
    reason?: string;
}

export interface PolicyEntry {
    requiredRoles: string[];
    rules?: PolicyRule[];
    alwaysConfirm?: boolean;
}

export interface EvaluatorContext {
    callerPlatform: string;
    callerSenderId: string;
    callerRoles: string[];
    toolArgs: unknown;
}

export type Decision =
    | { kind: "allow" }
    | { kind: "deny"; reason: string }
    | { kind: "require_confirm" }
    | { kind: "require_2fa" };

export interface EvaluationTrace {
    decision: Decision;
    /** Index of the rule that fired (in PolicyEntry.rules). null if decision came from base ACL or alwaysConfirm. */
    firedRuleIndex: number | null;
    /** Human-readable explanation of which path was taken. */
    explanation: string;
}

export function evaluate(entry: PolicyEntry, ctx: EvaluatorContext): EvaluationTrace {
    const rules = entry.rules ?? [];
    const matches: Array<{ index: number; rule: PolicyRule }> = [];
    for (let i = 0; i < rules.length; i++) {
        const rule = rules[i]!;
        if (matchesRule(rule.match, ctx)) matches.push({ index: i, rule });
    }

    // Step 2: deny-precedence.
    const deny = matches.find((m) => m.rule.action === "deny");
    if (deny) {
        return {
            decision: { kind: "deny", reason: deny.rule.reason ?? "denied by policy rule" },
            firedRuleIndex: deny.index,
            explanation: `rule[${deny.index}] denied`,
        };
    }

    // Step 3: pass-the-gate test.
    const holdsRequiredRole = entry.requiredRoles.some((r) => ctx.callerRoles.includes(r));
    const allowException = matches.find((m) => m.rule.action === "allow");
    if (!holdsRequiredRole && !allowException) {
        return {
            decision: {
                kind: "deny",
                reason:
                    `tool requires role(s) [${entry.requiredRoles.join(", ")}]; caller has [` +
                    `${ctx.callerRoles.join(", ") || "(none)"}]`,
            },
            firedRuleIndex: null,
            explanation: `base ACL: caller missing required role and no allow rule matched`,
        };
    }

    // Step 4: 2FA wins over confirm.
    const twoFa = matches.find((m) => m.rule.action === "require_2fa");
    if (twoFa) {
        return {
            decision: { kind: "require_2fa" },
            firedRuleIndex: twoFa.index,
            explanation: `rule[${twoFa.index}] requires 2FA`,
        };
    }

    // Step 5: confirm.
    const confirm = matches.find((m) => m.rule.action === "require_confirm");
    if (confirm) {
        return {
            decision: { kind: "require_confirm" },
            firedRuleIndex: confirm.index,
            explanation: `rule[${confirm.index}] requires confirmation`,
        };
    }
    if (entry.alwaysConfirm) {
        return {
            decision: { kind: "require_confirm" },
            firedRuleIndex: null,
            explanation: `entry.alwaysConfirm`,
        };
    }

    // Step 6.
    if (allowException && !holdsRequiredRole) {
        return {
            decision: { kind: "allow" },
            firedRuleIndex: allowException.index,
            explanation: `rule[${allowException.index}] explicit allow (caller lacks base role)`,
        };
    }
    return { decision: { kind: "allow" }, firedRuleIndex: null, explanation: "base ACL allow" };
}

function matchesRule(match: PolicyMatch, ctx: EvaluatorContext): boolean {
    if (match.user !== undefined) {
        const id = `${ctx.callerPlatform}:${ctx.callerSenderId}`;
        if (id !== match.user) return false;
    }
    if (match.role !== undefined) {
        if (!ctx.callerRoles.includes(match.role)) return false;
    }
    if (match.args !== undefined) {
        for (const [path, glob] of Object.entries(match.args)) {
            const value = lookupDotPath(ctx.toolArgs, path);
            if (typeof value !== "string") return false;
            if (!globMatch(glob, value)) return false;
        }
    }
    return true;
}

function lookupDotPath(obj: unknown, path: string): unknown {
    const segments = path.split(".");
    let current: unknown = obj;
    for (const seg of segments) {
        if (current === null || typeof current !== "object") return undefined;
        current = (current as Record<string, unknown>)[seg];
    }
    return current;
}

/**
 * Glob match: `*` matches zero or more chars, `?` matches one char.
 * No regex, no anchoring needed (compiled regex is anchored by default below).
 * All other regex metacharacters are escaped — pure literal match for
 * everything except `*` and `?`.
 */
export function globMatch(pattern: string, text: string): boolean {
    let r = "";
    for (const c of pattern) {
        if (c === "*") r += ".*";
        else if (c === "?") r += ".";
        else r += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    return new RegExp(`^${r}$`).test(text);
}
