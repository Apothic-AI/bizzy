// src/spawn.ts
import { spawn } from "node:child_process";
import { chmodSync, closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";

/** How the child ended: an exit code, or the signal that killed it. Node
 *  reports `code === null` when the child died by signal (external kill, OOM),
 *  so the signal half is what tells a crash apart from a clean exit. */
export interface SpawnExit {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface SpawnResult {
    pid: number;
    logPath: string;
    exit: Promise<SpawnExit>;
}

/**
 * Spawn a child with stdout+stderr written directly to a file descriptor — the
 * Claude Code pattern: the kernel writes output to disk with zero JS in the
 * data path. Progress is read back by polling the file tail separately.
 *
 * Pass `command` to run `bash -c <command>`, or `file`/`fileArgs` to exec a
 * binary directly (e.g. agent_bg launching `pi -p`). The child is detached so
 * the whole process group can be signalled.
 */
export function spawnWithFileOutput(args: {
    command?: string;
    file?: string;
    fileArgs?: string[];
    cwd: string;
    logPath: string;
    /** When set, stderr is written here instead of merged into logPath. Used by
     *  the monitor tool so stdout is a clean event stream and stderr is captured
     *  separately (readable, but never emitted as an event). */
    errPath?: string;
    signal?: AbortSignal;
    /** Extra environment for the child, merged over `process.env`. Used to
     *  mark a spawned child pi process so this extension can stand down in it. */
    env?: Record<string, string>;
}): SpawnResult {
    const outFd = openLogFd(args.logPath);
    let errFd: number;
    try {
        errFd = args.errPath ? openLogFd(args.errPath) : outFd;
    } catch (err) {
        closeSync(outFd);
        throw err;
    }

    const [bin, binArgs]: [string, string[]] = args.file
        ? [args.file, args.fileArgs ?? []]
        : ["bash", ["-c", args.command ?? ""]];

    let proc;
    try {
        proc = spawn(bin, binArgs, {
            stdio: ["ignore", outFd, errFd],
            cwd: args.cwd,
            detached: true,
            env: { ...process.env, ...args.env },
        });
    } finally {
        closeSync(outFd);
        if (errFd !== outFd) closeSync(errFd);
    }

    // Build the exit promise and attach the 'error' listener BEFORE any throw,
    // so an asynchronous spawn failure (ENOENT / EMFILE / EAGAIN) can never
    // surface as an uncaught exception that takes pi down.
    const exit = new Promise<SpawnExit>((resolve) => {
        // Use 'exit' not 'close': 'close' waits for stdio to close, which
        // includes grandchild processes that inherit file descriptors (e.g.
        // `sleep 30 &`). 'exit' fires when the shell itself exits, returning
        // control immediately. Output still flushes fine — the kernel writes
        // directly to the file fd, no JS drain needed.
        proc.on("exit", (code, signal) => resolve({ code, signal }));
        proc.on("error", () => resolve({ code: 1, signal: null }));
    });

    if (!proc.pid) {
        try { unlinkSync(args.logPath); } catch { /* best-effort */ }
        if (args.errPath) {
            try { unlinkSync(args.errPath); } catch { /* best-effort */ }
        }
        throw new Error("Failed to spawn process");
    }
    const pid = proc.pid;

    // Kill the process group on abort. Most callers manage abort themselves and
    // do not pass a signal; this is offered for direct/background spawns.
    const onAbort = () => killProcessTree(pid);
    if (args.signal) {
        if (args.signal.aborted) onAbort();
        else args.signal.addEventListener("abort", onAbort, { once: true });
    }
    void exit.finally(() => args.signal?.removeEventListener("abort", onAbort));

    proc.unref();

    return { pid, logPath: args.logPath, exit };
}

/**
 * Open a log file, creating the private log directory if it is missing.
 *
 * The directory is created 0700 and the file 0600. Job logs routinely contain
 * whatever a command printed, including anything it echoed out of its own
 * environment, so they are not world-readable.
 *
 * Creating the directory lazily on ENOENT — rather than behind a one-shot
 * `logDirCreated` flag cached for the process — is deliberate. Caching it
 * meant that anything which removed the directory (a tmp cleaner, a reboot, an
 * agent running `rm -rf`) put every *later* spawn in that process into a
 * permanent ENOENT failure: the flag said the directory existed, so it was
 * never recreated. Paying one `mkdirSync` only on the failure path costs
 * nothing in the common case and cannot wedge the process.
 */
function openLogFd(logPath: string): number {
    try {
        return openSync(logPath, "w", 0o600);
    } catch (err) {
        // Only a missing directory is recoverable here. Anything else (a
        // permission failure, EMFILE) must surface rather than be retried.
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const dir = dirname(logPath);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to a directory it actually creates, and is
    // filtered through umask. Tighten a pre-existing one on a best-effort
    // basis: if it is not ours to chmod, there is nothing useful to do.
    try {
        chmodSync(dir, 0o700);
    } catch {
        /* not ours to change */
    }
    return openSync(logPath, "w", 0o600);
}

/**
 * Kill an entire process group via negative PID signal.
 * Falls back to direct PID kill if group kill fails.
 */export function killProcessTree(
    pid: number | undefined,
    signal: NodeJS.Signals = "SIGTERM"
): void {
    if (typeof pid !== "number" || pid <= 0) return;
    try {
        process.kill(-pid, signal);
    } catch {
        // No process group to signal is the designed fallback path, so this catch stays quiet.
        try {
            process.kill(pid, signal);
        } catch (err) {
            // A dead pid is normal. Anything else means the job is still alive while callers treat it
            // as killed, which is worth hearing about.
            if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
                console.error("[bg-tasks] could not kill process, it may still be running:", pid, signal, err);
            }
        }
    }
}

/** Cheap liveness probe via signal 0. */
export function processExists(pid: number | undefined): boolean {
    if (typeof pid !== "number" || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}
