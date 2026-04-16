import net from "node:net";

// =============================================================================
// Allocate a TCP port — try the preferred port first, walk +1 on EADDRINUSE.
// Used by the A2A server so two ori2 checkouts on the same host can both
// boot without colliding (matches the per-checkout isolation contract).
//
// Walks at most maxAttempts ports above the preferred one. Beyond that we
// throw — anything past +20 attempts is suspicious (likely something else
// holding many sequential ports), and we'd rather fail loud than silently
// jump to a random port the operator has to hunt for in the logs.
// =============================================================================

export async function allocatePort(opts: {
    preferred: number;
    host?: string;
    maxAttempts?: number;
}): Promise<number> {
    const host = opts.host ?? "127.0.0.1";
    const maxAttempts = opts.maxAttempts ?? 20;
    let lastErr: Error | undefined;
    for (let i = 0; i < maxAttempts; i++) {
        const candidate = opts.preferred + i;
        try {
            await tryBind(candidate, host);
            return candidate;
        } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
            if (lastErr.message.includes("EADDRINUSE") || lastErr.message.includes("EACCES")) {
                continue; // walk
            }
            throw lastErr; // some other error — don't keep walking
        }
    }
    throw new Error(
        `[a2a/portAlloc] no free port in [${opts.preferred}, ${opts.preferred + maxAttempts - 1}] on ${host}` +
            (lastErr ? ` (last: ${lastErr.message})` : ""),
    );
}

/** Tries to bind, releases immediately. Resolves if free, rejects with EADDRINUSE otherwise. */
function tryBind(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref(); // don't keep the event loop alive
        srv.once("error", (err: NodeJS.ErrnoException) => {
            srv.close();
            reject(err);
        });
        srv.listen(port, host, () => {
            srv.close((err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    });
}
