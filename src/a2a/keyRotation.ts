import { randomBytes } from "node:crypto";
import { getFriends, type Friends } from "./friends.js";

// =============================================================================
// Key rotation — force every registered friend to a new inbound key.
//
// Semantics (per-friend, transactional):
//   1. Generate a fresh 32-byte hex key.
//   2. POST /a2a/key-update to the friend's URL, authenticated with our
//      CURRENT outbound key to them. Body: { sender_name, new_key }.
//   3. If the peer acks 2xx → commit locally (overwrite our a2a:friend_key:<name>
//      so subsequent inbound calls from them must use the new key).
//   4. If the peer fails to ack → DO NOT commit. Their old key stays valid; the
//      report surfaces the failure so the operator can re-invite or manual-rotate.
//
// Idempotency on the receiver side: if the submitted new_key is already stored
// as a2a:friend_outbound_key:<sender>, return 200 with {status: "no-op"}. This
// makes retrying a timed-out request safe.
//
// This is distinct from broadcaster.ts (address-update is fire-and-forget —
// failures are informational). Key rotation is transactional — a half-completed
// rotation locks the friend out, so we never commit speculatively.
// =============================================================================

export interface KeyRotationOptions {
    /** Our advertised name on the wire. */
    senderName: string;
    /** Limit rotation to these friend names. Default: all friends. */
    only?: Iterable<string>;
    /** Skip these friend names. Default: none. */
    skip?: Iterable<string>;
    /** HTTP attempt cap per friend (default 2). */
    maxAttempts?: number;
    /** Base retry delay in ms. Default 500. */
    baseDelayMs?: number;
    /** fetch implementation — overridable for tests. */
    fetchImpl?: typeof fetch;
    /** Friends instance — overridable for tests. */
    friends?: Friends;
    /** Key generator — overridable for tests (deterministic). */
    genKey?: () => string;
}

export interface KeyRotationReport {
    /** Friends whose inbound key was successfully rotated. */
    rotated: string[];
    /** Friends who could not be reached; their old inbound key is still valid. */
    failed: Array<{ name: string; lastError: string }>;
    /** Friends skipped because we have no outbound key for them (can't authenticate the rotate call). */
    skippedNoOutboundKey: string[];
    /** Friends skipped because we have no inbound key stored for them either (nothing to rotate). */
    skippedNoInboundKey: string[];
    /** Friends filtered out via the skip/only lists. */
    skippedByCaller: string[];
}

function defaultGenKey(): string {
    return randomBytes(32).toString("hex");
}

/**
 * Rotate inbound keys for each selected friend. Resolves once every friend has
 * either rotated or exhausted retries. Caller surfaces the report to the
 * operator (partial success is expected — a friend bot being offline should
 * not block rotation of the rest).
 */
export async function rotateAllFriendKeys(opts: KeyRotationOptions): Promise<KeyRotationReport> {
    const friends = opts.friends ?? getFriends();
    const fetchImpl = opts.fetchImpl ?? fetch;
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
    const baseDelay = opts.baseDelayMs ?? 500;
    const genKey = opts.genKey ?? defaultGenKey;
    const onlySet = opts.only ? new Set(opts.only) : null;
    const skipSet = new Set(opts.skip ?? []);

    const report: KeyRotationReport = {
        rotated: [],
        failed: [],
        skippedNoOutboundKey: [],
        skippedNoInboundKey: [],
        skippedByCaller: [],
    };

    const targets = friends.list().filter((f) => {
        if (onlySet && !onlySet.has(f.name)) { report.skippedByCaller.push(f.name); return false; }
        if (skipSet.has(f.name)) { report.skippedByCaller.push(f.name); return false; }
        return true;
    });

    await Promise.all(targets.map(async (f) => {
        const outboundKey = friends.getOutboundKey(f.name);
        if (!outboundKey) { report.skippedNoOutboundKey.push(f.name); return; }
        const oldInboundKey = friends.getKey(f.name);
        if (!oldInboundKey) { report.skippedNoInboundKey.push(f.name); return; }

        const newKey = genKey();
        let lastErr = "";
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const res = await fetchImpl(`${f.base_url.replace(/\/+$/, "")}/a2a/key-update`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-a2a-api-key": outboundKey,
                    },
                    body: JSON.stringify({
                        sender_name: opts.senderName,
                        new_key: newKey,
                    }),
                });
                if (res.ok) {
                    // Peer accepted. Commit the new key locally — our inbound
                    // check `friends.resolveByKey` will now accept newKey and
                    // reject the old one.
                    friends.setKey(f.name, newKey);
                    report.rotated.push(f.name);
                    return;
                }
                lastErr = `HTTP ${res.status}`;
            } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e);
            }
            if (attempt < maxAttempts - 1) {
                await new Promise((r) => setTimeout(r, baseDelay * Math.pow(2, attempt)));
            }
        }
        report.failed.push({ name: f.name, lastError: lastErr });
    }));

    return report;
}
