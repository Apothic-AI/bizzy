/**
 * Tool gating — `bizzy.json` and the `BIZZY_TOOLS` / `BIZZY_DISABLE_TOOLS`
 * env overrides.
 *
 * The contract that matters: no config means every tool registers exactly as
 * before, and a config that names one tool must not cost the session the
 * others. Nothing here may throw: a malformed knob falls back to the default
 * and reports a warning.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { resolveToolGating, TOOL_NAMES } from "../config.ts";

type Registered = { name: string };

function makePi() {
    const tools: Registered[] = [];
    const pi = {
        registerTool(def: Registered) {
            tools.push(def);
        },
        registerShortcut() {},
        registerCommand() {},
        registerMessageRenderer() {},
        on() {},
        sendMessage() {},
        appendEntry() {},
    };
    return { pi, tools };
}

/** Register the extension and return the tool names it declared. */
function registeredTools(): string[] {
    const { pi, tools } = makePi();
    extension(pi as never);
    return tools.map((tool) => tool.name).sort();
}

const ENV_KEYS = ["BIZZY_TOOLS", "BIZZY_DISABLE_TOOLS", "PI_CODING_AGENT_DIR"] as const;
let savedEnv: Record<string, string | undefined> = {};
let tempDirs: string[] = [];

beforeEach(() => {
    savedEnv = {};
    for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of ENV_KEYS) {
        if (savedEnv[key] === undefined) delete process.env[key];
        else process.env[key] = savedEnv[key];
    }
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
});

/** Write a `bizzy.json` into a fresh agent dir and point env at it. */
function useConfig(config: unknown | string): string {
    const dir = mkdtempSync(join(tmpdir(), "bizzy-gating-"));
    tempDirs.push(dir);
    const path = join(dir, "bizzy.json");
    writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config));
    process.env.PI_CODING_AGENT_DIR = dir;
    return path;
}

const ALL = [...TOOL_NAMES].sort();

void describe("tool gating — default", () => {
    void it("registers every tool when nothing is configured", () => {
        useConfigless();
        assert.deepEqual(registeredTools(), ALL);
    });

    void it("registers every tool when the config file is absent", () => {
        const dir = mkdtempSync(join(tmpdir(), "bizzy-gating-empty-"));
        tempDirs.push(dir);
        process.env.PI_CODING_AGENT_DIR = dir;
        assert.deepEqual(registeredTools(), ALL);
    });
});

void describe("tool gating — env overrides", () => {
    void it("BIZZY_DISABLE_TOOLS drops only the named tool", () => {
        useConfigless();
        process.env.BIZZY_DISABLE_TOOLS = "agent_bg";
        assert.deepEqual(registeredTools(), ALL.filter((name) => name !== "agent_bg"));
    });

    void it("BIZZY_TOOLS is an allowlist", () => {
        useConfigless();
        process.env.BIZZY_TOOLS = "jobs,monitor";
        assert.deepEqual(registeredTools(), ["jobs", "monitor"]);
    });

    void it("accepts whitespace-separated names", () => {
        useConfigless();
        process.env.BIZZY_TOOLS = "jobs monitor";
        assert.deepEqual(registeredTools(), ["jobs", "monitor"]);
    });

    void it("BIZZY_DISABLE_TOOLS wins over BIZZY_TOOLS", () => {
        useConfigless();
        process.env.BIZZY_TOOLS = "jobs,monitor";
        process.env.BIZZY_DISABLE_TOOLS = "monitor";
        assert.deepEqual(registeredTools(), ["jobs"]);
    });
});

void describe("tool gating — config file", () => {
    void it("reads disabledTools from bizzy.json", () => {
        useConfig({ disabledTools: ["agent_bg"] });
        assert.deepEqual(registeredTools(), ALL.filter((name) => name !== "agent_bg"));
    });

    void it("reads an allowlist from bizzy.json", () => {
        useConfig({ tools: ["bash_bg", "jobs"] });
        assert.deepEqual(registeredTools(), ["bash_bg", "jobs"]);
    });

    void it("lets BIZZY_TOOLS replace the file selection rather than merge", () => {
        useConfig({ tools: ["agent_bg", "jobs"] });
        process.env.BIZZY_TOOLS = "monitor";
        assert.deepEqual(registeredTools(), ["monitor"]);
    });

    void it("unions BIZZY_DISABLE_TOOLS with the file denylist", () => {
        useConfig({ disabledTools: ["agent_bg"] });
        process.env.BIZZY_DISABLE_TOOLS = "monitor";
        assert.deepEqual(registeredTools(), ["bash", "bash_bg", "jobs"]);
    });
});

void describe("tool gating — malformed input never costs tools", () => {
    void it("falls back to every tool on invalid JSON and warns", () => {
        const path = useConfig("{ not json");
        const gating = resolveToolGating({ env: process.env, configPath: path });
        assert.match(gating.warning ?? "", /ignoring it$/);
        assert.deepEqual(registeredTools(), ALL);
    });

    void it("reports unknown names instead of treating them as a disable", () => {
        const path = useConfig({ disabledTools: ["agent-bgg"] });
        const gating = resolveToolGating({ env: process.env, configPath: path });
        assert.deepEqual(gating.unknownNames, ["agent-bgg"]);
        assert.deepEqual(registeredTools(), ALL);
    });
});

/** Point PI_CODING_AGENT_DIR at an empty directory (no bizzy.json). */
function useConfigless(): void {
    const dir = mkdtempSync(join(tmpdir(), "bizzy-gating-none-"));
    tempDirs.push(dir);
    process.env.PI_CODING_AGENT_DIR = dir;
}