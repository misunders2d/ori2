import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { evaluate, globMatch, type EvaluatorContext, type PolicyEntry } from "./policy.ts";

// Tiny helpers so each test reads as one assertion.
const ctx = (overrides: Partial<EvaluatorContext> = {}): EvaluatorContext => ({
    callerPlatform: "cli",
    callerSenderId: "alice",
    callerRoles: ["admin"],
    toolArgs: {},
    ...overrides,
});

describe("globMatch", () => {
    it("plain literal matches itself", () => {
        assert.equal(globMatch("hello", "hello"), true);
        assert.equal(globMatch("hello", "Hello"), false);
    });

    it("* matches zero or more chars", () => {
        assert.equal(globMatch("prod*", "production"), true);
        assert.equal(globMatch("prod*", "prod"), true);
        assert.equal(globMatch("prod*", "staging"), false);
        assert.equal(globMatch("*db", "userdb"), true);
        assert.equal(globMatch("*", ""), true);
    });

    it("? matches exactly one char", () => {
        assert.equal(globMatch("?", "a"), true);
        assert.equal(globMatch("?", ""), false);
        assert.equal(globMatch("?", "ab"), false);
        assert.equal(globMatch("a?c", "abc"), true);
    });

    it("escapes regex metacharacters in the literal portion", () => {
        // The "." in "finance.salaries" is a regex any-char. If unescaped,
        // pattern "finance.x" would match "financeAx". Make sure that doesn't.
        assert.equal(globMatch("finance.x", "financeAx"), false);
        assert.equal(globMatch("finance.x", "finance.x"), true);
        // Same for + which is regex one-or-more.
        assert.equal(globMatch("a+b", "a+b"), true);
        assert.equal(globMatch("a+b", "ab"), false);
    });

    it("anchors both ends (no partial match)", () => {
        assert.equal(globMatch("abc", "abcd"), false);
        assert.equal(globMatch("abc", "xabc"), false);
    });
});

describe("evaluate — base ACL (no rules)", () => {
    it("allows when caller holds a required role", () => {
        const r = evaluate({ requiredRoles: ["admin"] }, ctx({ callerRoles: ["admin"] }));
        assert.equal(r.decision.kind, "allow");
        assert.equal(r.firedRuleIndex, null);
    });

    it("allows when caller holds any-of required roles", () => {
        const r = evaluate({ requiredRoles: ["admin", "analyst"] }, ctx({ callerRoles: ["analyst"] }));
        assert.equal(r.decision.kind, "allow");
    });

    it("denies when caller has no matching role", () => {
        const r = evaluate({ requiredRoles: ["admin"] }, ctx({ callerRoles: ["user"] }));
        assert.equal(r.decision.kind, "deny");
        if (r.decision.kind === "deny") {
            assert.match(r.decision.reason, /requires role/);
        }
    });

    it("denies caller with no roles at all", () => {
        const r = evaluate({ requiredRoles: ["admin"] }, ctx({ callerRoles: [] }));
        assert.equal(r.decision.kind, "deny");
    });
});

describe("evaluate — alwaysConfirm", () => {
    it("forces require_confirm even when caller holds the required role", () => {
        const r = evaluate(
            { requiredRoles: ["admin"], alwaysConfirm: true },
            ctx({ callerRoles: ["admin"] }),
        );
        assert.equal(r.decision.kind, "require_confirm");
    });

    it("does not bypass a base-role denial", () => {
        const r = evaluate(
            { requiredRoles: ["admin"], alwaysConfirm: true },
            ctx({ callerRoles: ["user"] }),
        );
        assert.equal(r.decision.kind, "deny");
    });
});

describe("evaluate — deny-precedence", () => {
    it("any matching deny rule wins, regardless of order or role", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [
                { match: { role: "admin" }, action: "allow" },
                { match: { user: "telegram:bob" }, action: "deny", reason: "Bob banned" },
            ],
        };
        const r = evaluate(entry, ctx({
            callerPlatform: "telegram",
            callerSenderId: "bob",
            callerRoles: ["admin"],
        }));
        assert.equal(r.decision.kind, "deny");
        if (r.decision.kind === "deny") assert.equal(r.decision.reason, "Bob banned");
    });

    it("first deny in document order wins when multiple deny", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [
                { match: { role: "admin" }, action: "deny", reason: "first" },
                { match: { role: "admin" }, action: "deny", reason: "second" },
            ],
        };
        const r = evaluate(entry, ctx({ callerRoles: ["admin"] }));
        assert.equal(r.decision.kind, "deny");
        if (r.decision.kind === "deny") assert.equal(r.decision.reason, "first");
    });

    it("uses default reason when rule omits one", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { role: "admin" }, action: "deny" }],
        };
        const r = evaluate(entry, ctx({ callerRoles: ["admin"] }));
        if (r.decision.kind !== "deny") assert.fail("expected deny");
        assert.match(r.decision.reason, /denied/);
    });
});

describe("evaluate — match clauses", () => {
    it("user clause: exact <platform>:<senderId> match", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { user: "telegram:42" }, action: "deny", reason: "no" }],
        };
        const matched = evaluate(entry, ctx({
            callerPlatform: "telegram",
            callerSenderId: "42",
            callerRoles: ["admin"],
        }));
        assert.equal(matched.decision.kind, "deny");

        const wrongSender = evaluate(entry, ctx({
            callerPlatform: "telegram",
            callerSenderId: "43",
            callerRoles: ["admin"],
        }));
        assert.equal(wrongSender.decision.kind, "allow");
    });

    it("role clause: any of caller's roles", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { role: "intern" }, action: "deny", reason: "interns no" }],
        };
        const r = evaluate(entry, ctx({ callerRoles: ["admin", "intern"] }));
        assert.equal(r.decision.kind, "deny");
    });

    it("args clause: shallow string equality", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { args: { dataset: "finance" } }, action: "deny", reason: "no finance" }],
        };
        const r = evaluate(entry, ctx({ toolArgs: { dataset: "finance" } }));
        assert.equal(r.decision.kind, "deny");

        const r2 = evaluate(entry, ctx({ toolArgs: { dataset: "marketing" } }));
        assert.equal(r2.decision.kind, "allow");
    });

    it("args clause: glob pattern", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { args: { table: "finance.*" } }, action: "deny", reason: "no finance.*" }],
        };
        assert.equal(evaluate(entry, ctx({ toolArgs: { table: "finance.salaries" } })).decision.kind, "deny");
        assert.equal(evaluate(entry, ctx({ toolArgs: { table: "marketing.x" } })).decision.kind, "allow");
    });

    it("args clause: dot-path lookup into nested object", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { args: { "where.dataset": "prod*" } }, action: "deny", reason: "no prod" }],
        };
        const r = evaluate(entry, ctx({ toolArgs: { where: { dataset: "production" } } }));
        assert.equal(r.decision.kind, "deny");
    });

    it("args clause: missing path → no match (falls through)", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { args: { "missing.path": "x" } }, action: "deny", reason: "n/a" }],
        };
        const r = evaluate(entry, ctx({ toolArgs: { other: "y" } }));
        assert.equal(r.decision.kind, "allow");
    });

    it("args clause: non-string leaf → no match", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { args: { count: "*" } }, action: "deny", reason: "n/a" }],
        };
        // Numeric value at the path — globMatch only handles strings.
        const r = evaluate(entry, ctx({ toolArgs: { count: 5 } }));
        assert.equal(r.decision.kind, "allow");
    });

    it("multiple match clauses are AND-combined", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [
                {
                    match: { user: "telegram:bob", args: { dataset: "finance" } },
                    action: "deny",
                    reason: "bob+finance",
                },
            ],
        };
        const both = evaluate(entry, ctx({
            callerPlatform: "telegram",
            callerSenderId: "bob",
            callerRoles: ["admin"],
            toolArgs: { dataset: "finance" },
        }));
        assert.equal(both.decision.kind, "deny");

        const userOnly = evaluate(entry, ctx({
            callerPlatform: "telegram",
            callerSenderId: "bob",
            callerRoles: ["admin"],
            toolArgs: { dataset: "marketing" },
        }));
        assert.equal(userOnly.decision.kind, "allow");
    });
});

describe("evaluate — allow exceptions", () => {
    it("allow rule grants access to caller without base role", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { role: "analyst", args: { dataset: "marketing" } }, action: "allow" }],
        };
        const r = evaluate(entry, ctx({
            callerRoles: ["analyst"],
            toolArgs: { dataset: "marketing" },
        }));
        assert.equal(r.decision.kind, "allow");
    });

    it("allow rule does not bypass a deny rule", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [
                { match: { role: "analyst" }, action: "allow" },
                { match: { args: { dataset: "secret" } }, action: "deny", reason: "secret blocked" },
            ],
        };
        const r = evaluate(entry, ctx({
            callerRoles: ["analyst"],
            toolArgs: { dataset: "secret" },
        }));
        assert.equal(r.decision.kind, "deny");
    });

    it("non-matching allow rule does not save a caller without base role", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [{ match: { args: { dataset: "marketing" } }, action: "allow" }],
        };
        const r = evaluate(entry, ctx({
            callerRoles: ["user"],
            toolArgs: { dataset: "production" },
        }));
        assert.equal(r.decision.kind, "deny");
    });
});

describe("evaluate — confirm vs 2FA precedence", () => {
    it("require_2fa wins over require_confirm when both match", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [
                { match: { args: { dataset: "production" } }, action: "require_2fa" },
                { match: { role: "admin" }, action: "require_confirm" },
            ],
        };
        const r = evaluate(entry, ctx({
            callerRoles: ["admin"],
            toolArgs: { dataset: "production" },
        }));
        assert.equal(r.decision.kind, "require_2fa");
    });

    it("require_2fa wins over alwaysConfirm flag", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            alwaysConfirm: true,
            rules: [{ match: { args: { dataset: "production" } }, action: "require_2fa" }],
        };
        const r = evaluate(entry, ctx({ toolArgs: { dataset: "production" } }));
        assert.equal(r.decision.kind, "require_2fa");
    });

    it("require_confirm rule beats alwaysConfirm flag (same outcome, just attribution)", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            alwaysConfirm: true,
            rules: [{ match: { role: "admin" }, action: "require_confirm" }],
        };
        const r = evaluate(entry, ctx());
        assert.equal(r.decision.kind, "require_confirm");
        assert.notEqual(r.firedRuleIndex, null);
    });
});

describe("evaluate — trace fields", () => {
    it("firedRuleIndex points at the responsible rule", () => {
        const entry: PolicyEntry = {
            requiredRoles: ["admin"],
            rules: [
                { match: { role: "nope" }, action: "deny", reason: "won't match" },
                { match: { role: "admin" }, action: "deny", reason: "second wins" },
            ],
        };
        const r = evaluate(entry, ctx());
        assert.equal(r.firedRuleIndex, 1);
    });

    it("firedRuleIndex is null for a base-ACL allow", () => {
        const r = evaluate({ requiredRoles: ["admin"] }, ctx());
        assert.equal(r.firedRuleIndex, null);
    });
});
