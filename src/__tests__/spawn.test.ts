// src/__tests__/spawn.test.ts
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { holdEventLoop } from "./helpers/hold-event-loop.ts";

// Will import from spawn.ts once created
// import { spawnWithFileOutput, killProcessTree, processExists } from "../spawn.ts";

const testDir = join(tmpdir(), `pi-bg-test-${process.pid}`);

// Every test here awaits a real child's exit, and spawnWithFileOutput unrefs it.
holdEventLoop();

describe("spawnWithFileOutput", () => {
    test("captures stdout to log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stdout.log");
        const result = spawnWithFileOutput({
            command: 'echo "hello world"',
            cwd: process.cwd(),
            logPath,
        });
        assert.ok(result.pid > 0);
        const { code } = await result.exit;
        assert.equal(code, 0);
        const output = readFileSync(logPath, "utf-8");
        assert.ok(output.includes("hello world"));
        unlinkSync(logPath);
    });

    test("captures stderr to same log file", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-stderr.log");
        const result = spawnWithFileOutput({
            command: 'echo "err msg" >&2',
            cwd: process.cwd(),
            logPath,
        });
        const { code } = await result.exit;
        assert.equal(code, 0);
        const output = readFileSync(logPath, "utf-8");
        assert.ok(output.includes("err msg"));
        unlinkSync(logPath);
    });

    test("returns non-zero exit code on failure", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-fail.log");
        const result = spawnWithFileOutput({
            command: "exit 42",
            cwd: process.cwd(),
            logPath,
        });
        const { code } = await result.exit;
        assert.equal(code, 42);
        try { unlinkSync(logPath); } catch {}
    });

    test("respects AbortSignal", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-abort.log");
        const ac = new AbortController();
        const result = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath,
            signal: ac.signal,
        });
        // Give process time to start
        await new Promise((r) => setTimeout(r, 200));
        ac.abort();
        const { code, signal } = await result.exit;
        // Killed process: a signal death, or at least a non-zero code.
        assert.ok(signal !== null || code !== 0);
        try { unlinkSync(logPath); } catch {}
    });

    test("resolves when the shell exits even if a grandchild holds the fds", async () => {
        const { spawnWithFileOutput, killProcessTree } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-grandchild.log");
        // The shell daemonizes a child that inherits the log fd — with 'close'
        // this would hang for 30s; with 'exit' it resolves as soon as the
        // shell itself exits.
        const result = spawnWithFileOutput({
            command: "sleep 30 & echo started",
            cwd: process.cwd(),
            logPath,
        });
        try {
            const raced = await Promise.race([
                result.exit,
                new Promise<null>((r) => setTimeout(() => r(null), 3_000)),
            ]);
            assert.ok(raced !== null, "exit promise must resolve promptly, not after the grandchild");
            assert.equal(raced.code, 0);
        } finally {
            // Clean up the lingering grandchild.
            killProcessTree(result.pid, "SIGKILL");
        }
        try { unlinkSync(logPath); } catch {}
    });
});

describe("log directory", () => {
    test("is private per-user state, not a shared /tmp path", async () => {
        const { LOG_DIR } = await import("../registry.ts");
        assert.ok(isAbsolute(LOG_DIR), "LOG_DIR must be absolute");

        // Compare against the literal /tmp, which is the bug being guarded
        // against. An os.tmpdir()-based assertion is not safe here: TMPDIR can
        // point somewhere that is itself under a shared parent (this box sets
        // TMPDIR=/tmp/user/1000), so "/tmp/pi-bg" would fail to match and the
        // test would pass while the code was still wrong.
        assert.ok(!LOG_DIR.startsWith("/tmp"), `LOG_DIR must not be under /tmp (got ${LOG_DIR})`);

        // And pin the actual root it must resolve from.
        const xdg = process.env.XDG_STATE_HOME;
        const root = xdg && isAbsolute(xdg) ? xdg : join(homedir(), ".local", "state");
        assert.equal(LOG_DIR, join(root, "pi-bg"));
    });

    test("derives log and err paths from LOG_DIR", async () => {
        const { LOG_DIR, logPathFor, errPathFor } = await import("../registry.ts");
        assert.equal(logPathFor("abc123"), `${LOG_DIR}/abc123.log`);
        assert.equal(errPathFor("abc123"), `${LOG_DIR}/abc123.err`);
    });

    test("creates the directory 0700 and the log file 0600", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        const { LOG_DIR } = await import("../registry.ts");
        const logPath = join(LOG_DIR, "perm-probe.log");
        rmSync(LOG_DIR, { recursive: true, force: true });

        const result = spawnWithFileOutput({ command: "echo perm", cwd: process.cwd(), logPath });
        await result.exit;

        // Job logs carry whatever a command printed, including anything echoed
        // out of its own environment, so neither may be readable by other users.
        assert.equal(statSync(LOG_DIR).mode & 0o777, 0o700, "log dir must be 0700");
        assert.equal(statSync(logPath).mode & 0o777, 0o600, "log file must be 0600");
        rmSync(LOG_DIR, { recursive: true, force: true });
    });

    test("recovers when the log directory is removed mid-process", async () => {
        // Regression: a cached `logDirCreated` flag meant that once anything
        // removed the directory (tmp cleaner, reboot, `rm -rf`), every later
        // spawn in that process failed with ENOENT for good.
        const { spawnWithFileOutput } = await import("../spawn.ts");
        const { LOG_DIR } = await import("../registry.ts");
        const logPath = join(LOG_DIR, "recover.log");

        rmSync(LOG_DIR, { recursive: true, force: true });
        const first = spawnWithFileOutput({ command: "echo one", cwd: process.cwd(), logPath });
        await first.exit;

        rmSync(LOG_DIR, { recursive: true, force: true });
        assert.ok(!existsSync(LOG_DIR), "precondition: directory is gone");

        const second = spawnWithFileOutput({ command: "echo two", cwd: process.cwd(), logPath });
        const { code } = await second.exit;
        assert.equal(code, 0);
        assert.match(readFileSync(logPath, "utf-8"), /two/);
        rmSync(LOG_DIR, { recursive: true, force: true });
    });

    test("passes extra env to the child", async () => {
        const { spawnWithFileOutput } = await import("../spawn.ts");
        const { LOG_DIR } = await import("../registry.ts");
        const logPath = join(LOG_DIR, "env.log");
        const result = spawnWithFileOutput({
            command: 'echo "marker=$PI_BG_TEST_MARKER"',
            cwd: process.cwd(),
            logPath,
            env: { PI_BG_TEST_MARKER: "present" },
        });
        await result.exit;
        assert.match(readFileSync(logPath, "utf-8"), /marker=present/);
        rmSync(LOG_DIR, { recursive: true, force: true });
    });
});

describe("killProcessTree", () => {
    test("kills a running process", async () => {
        const { spawnWithFileOutput, killProcessTree, processExists } = await import("../spawn.ts");
        mkdirSync(testDir, { recursive: true });
        const logPath = join(testDir, "test-kill.log");
        const result = spawnWithFileOutput({
            command: "sleep 60",
            cwd: process.cwd(),
            logPath,
        });
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(processExists(result.pid));
        killProcessTree(result.pid);
        await result.exit;
        // After exit, process should be gone (give OS a moment)
        await new Promise((r) => setTimeout(r, 100));
        assert.ok(!processExists(result.pid));
        try { unlinkSync(logPath); } catch {}
    });
});
