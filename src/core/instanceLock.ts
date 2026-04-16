import fs from "fs";
import path from "path";

export function acquireInstanceLock(storagePath: string, botName: string): void {
    const lockFile = path.join(storagePath, ".instance.lock");

    // Ensure the directory exists before checking/writing the lock
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    if (fs.existsSync(lockFile)) {
        const pid = fs.readFileSync(lockFile, "utf-8");
        try {
            // process.kill with signal 0 checks if the process exists without actually killing it
            process.kill(parseInt(pid, 10), 0);
            
            // If we reach here, the process is actively running
            console.error(`\n❌ FATAL ERROR: An instance of '${botName}' is already running (PID: ${pid}).`);
            console.error(`To prevent database corruption and tangled memories, you cannot run two bots with the same name simultaneously.`);
            console.error(`Please specify a different BOT_NAME.\n`);
            process.exit(1);
        } catch (e) {
            // Process doesn't exist, this is a stale lock file from a previous crash.
            // Safe to overwrite.
        }
    }

    // Write current process ID to the lock file
    fs.writeFileSync(lockFile, process.pid.toString());

    // Clean up the lock file when the process exits cleanly
    const cleanup = () => {
        if (fs.existsSync(lockFile)) {
            fs.unlinkSync(lockFile);
        }
    };

    process.on("exit", cleanup);
    process.on("SIGINT", () => { cleanup(); process.exit(); });
    process.on("SIGTERM", () => { cleanup(); process.exit(); });
}
