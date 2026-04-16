import { getFriends, type Friends } from "./friends.js";

// =============================================================================
// Address-rotation broadcaster.
//
// When our public URL changes (cloudflared restarts and picks up a new
// ephemeral *.trycloudflare.com domain, or operator manually rotates), every
// registered friend needs to be told. We POST `/a2a/address-update` to each
// peer, authenticated with the per-friend outbound key.
//
// Failures retry with exponential backoff (matches ori's perform_a2a_broadcast
// — 5 attempts, base 15s). After exhaustion the friend stays at the old URL
// in their registry; we'll re-attempt next time we boot or when the operator
// runs /a2a broadcast-address.
// =============================================================================

export interface BroadcasterOptions {
    /** Our advertised name (the `sender_name` peers match by). */
    senderName: string;
    /** New public URL to advertise. */
    newBaseUrl: string;
    /** Skip these friend names (e.g. operator just removed them). Optional. */
    skip?: Iterable<string>;
    /** Override the default 5-attempt schedule (mostly for tests). */
    maxAttempts?: number;
    /** Base delay in ms for backoff. Default 15000. */
    baseDelayMs?: number;
    /** fetch implementation — defaults to global fetch. Tests inject a mock. */
    fetchImpl?: typeof fetch;
    /** Friends instance — defaults to singleton. Tests inject a fresh one. */
    friends?: Friends;
}

export interface BroadcastReport {
    /** Friends successfully notified. */
    succeeded: string[];
    /** Friends that exhausted retries. */
    failed: Array<{ name: string; lastError: string }>;
    /** Friends skipped because they had no outbound key (can't authenticate). */
    skippedNoKey: string[];
}

/**
 * Fire address-update to every friend (minus skip list). Resolves once every
 * friend has either succeeded or exhausted retries. Caller logs the report.
 */
export async function broadcastAddressUpdate(opts: BroadcasterOptions): Promise<BroadcastReport> {
    const friends = opts.friends ?? getFriends();
    const fetchImpl = opts.fetchImpl ?? fetch;
    const maxAttempts = opts.maxAttempts ?? 5;
    const baseDelay = opts.baseDelayMs ?? 15_000;
    const skip = new Set(opts.skip ?? []);

    const report: BroadcastReport = { succeeded: [], failed: [], skippedNoKey: [] };

    const allFriends = friends.list().filter((f) => !skip.has(f.name));

    // Fan out in parallel — each friend retries independently.
    await Promise.all(allFriends.map(async (f) => {
        const outboundKey = friends.getOutboundKey(f.name);
        if (!outboundKey) {
            report.skippedNoKey.push(f.name);
            return;
        }
        let lastErr = "";
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const res = await fetchImpl(`${f.base_url.replace(/\/+$/, "")}/a2a/address-update`, {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-a2a-api-key": outboundKey,
                    },
                    body: JSON.stringify({
                        sender_name: opts.senderName,
                        new_base_url: opts.newBaseUrl,
                    }),
                });
                if (res.ok) {
                    report.succeeded.push(f.name);
                    return;
                }
                lastErr = `HTTP ${res.status}`;
            } catch (e) {
                lastErr = e instanceof Error ? e.message : String(e);
            }
            // Exponential backoff: base * 2^attempt, capped at 5min.
            if (attempt < maxAttempts - 1) {
                const delay = Math.min(baseDelay * Math.pow(2, attempt), 5 * 60 * 1000);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        report.failed.push({ name: f.name, lastError: lastErr });
    }));

    return report;
}
