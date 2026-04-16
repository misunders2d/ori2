import { describe, it, after } from "node:test";
import { strict as assert } from "node:assert";
import net from "node:net";
import { allocatePort } from "./portAlloc.js";

const HOLD_SERVERS: net.Server[] = [];

after(() => {
    for (const s of HOLD_SERVERS) try { s.close(); } catch { /* ignore */ }
});

function holdPort(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(port, host, () => {
            HOLD_SERVERS.push(s);
            resolve();
        });
    });
}

describe("allocatePort", () => {
    it("returns the preferred port when free", async () => {
        // Use a high port unlikely to be in use on a CI runner.
        const p = await allocatePort({ preferred: 51900 });
        assert.equal(p, 51900);
    });

    it("walks +1 when preferred is in use", async () => {
        await holdPort(51910);
        const p = await allocatePort({ preferred: 51910 });
        assert.equal(p, 51911);
    });

    it("walks past multiple in-use ports", async () => {
        await holdPort(51920);
        await holdPort(51921);
        await holdPort(51922);
        const p = await allocatePort({ preferred: 51920 });
        assert.equal(p, 51923);
    });

    it("throws when maxAttempts exhausted", async () => {
        await holdPort(51930);
        await holdPort(51931);
        await holdPort(51932);
        await assert.rejects(
            () => allocatePort({ preferred: 51930, maxAttempts: 3 }),
            /no free port/,
        );
    });
});
