/**
 * Runtime tool gating.
 *
 * Bizzy registers five tools. Most lanes want all of them, but some must not
 * carry one: a lane that is not allowed to delegate to a nested `pi -p`
 * process still wants `jobs` and `monitor`, and a headless `pi --print` run
 * was never given a use for `agent_bg` in the first place. Removing the whole
 * extension is the only other way to do it, and that costs four tools to
 * remove one.
 *
 * The selection is resolved once, when the extension loads, from three
 * sources:
 *
 *   1. `$PI_CODING_AGENT_DIR/bizzy.json`, default `~/.pi/agent/bizzy.json`:
 *        { "tools": ["jobs", "monitor"], "disabledTools": ["bash_bg"] }
 *   2. `BIZZY_TOOLS` — comma or space separated allowlist. Replaces the file's
 *      `tools` selection; it does not merge with it.
 *   3. `BIZZY_DISABLE_TOOLS` — comma or space separated denylist, applied to
 *      whatever the allowlist left standing, and unioned with the file's
 *      `disabledTools`.
 *
 * With no config file and no env var every tool registers, which is exactly
 * the behaviour before this module existed. Names that this package does not
 * register are reported so a typo in a config does not silently look like a
 * successful disable.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Tools this package registers, in registration order. */
export const TOOL_NAMES = ["bash", "bash_bg", "jobs", "agent_bg", "monitor"] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolGatingConfigFile {
    /** When present, only these tools register. */
    tools?: unknown;
    /** Tools that never register, applied after `tools`. */
    disabledTools?: unknown;
}

export interface ResolvedToolGating {
    /** Whether a tool name should be registered. Unregistered names are false. */
    isEnabled(name: string): boolean;
    /** Names from config that this package does not register. */
    unknownNames: string[];
    /** Where the selection came from, for `--verbose` style diagnostics. */
    source: "default" | "file" | "env" | "file+env";
    /** The absolute config path consulted, whether or not it existed. */
    configPath: string;
    /** A problem with the config worth reporting, without failing the load. */
    warning?: string;
}

export interface ResolveToolGatingOptions {
    /** Environment to read; defaults to `process.env`. */
    env?: Record<string, string | undefined>;
    /** Override the config path; defaults to the agent directory. */
    configPath?: string;
    /** Read the file; injectable for tests. */
    readFile?: (path: string) => string;
}

/** The agent directory pi uses for extension config, e.g. `~/.pi/agent`. */
export function agentConfigDir(env: Record<string, string | undefined> = process.env): string {
    return env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function bizzyConfigPath(env: Record<string, string | undefined> = process.env): string {
    return join(agentConfigDir(env), "bizzy.json");
}

function parseNameList(value: unknown): string[] | undefined {
    if (value === undefined || value === null) return undefined;
    if (Array.isArray(value)) {
        return value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean);
    }
    if (typeof value === "string") return splitEnvList(value);
    return undefined;
}

/** Split `BIZZY_*` values on commas and whitespace. */
export function splitEnvList(value: string): string[] {
    return value
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

/**
 * Resolve the tool selection. Never throws: a missing or malformed config
 * falls back to the default (everything registers) and reports a warning, so a
 * bad knob can never cost a session its tools.
 */
export function resolveToolGating(options: ResolveToolGatingOptions = {}): ResolvedToolGating {
    const env = options.env ?? process.env;
    const configPath = options.configPath ?? bizzyConfigPath(env);
    const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf-8"));

    let fileConfig: ToolGatingConfigFile = {};
    let fileFound = false;
    let warning: string | undefined;

    try {
        const raw = readFile(configPath);
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            fileConfig = parsed as ToolGatingConfigFile;
            fileFound = true;
        } else {
            warning = `${configPath}: expected a JSON object; ignoring it`;
        }
    } catch (error) {
        const code = (error as { code?: string } | undefined)?.code;
        if (code !== "ENOENT") {
            warning = `${configPath}: ${error instanceof Error ? error.message : String(error)}; ignoring it`;
        }
    }

    const envAllow = env.BIZZY_TOOLS ? splitEnvList(env.BIZZY_TOOLS) : undefined;
    const envDeny = env.BIZZY_DISABLE_TOOLS ? splitEnvList(env.BIZZY_DISABLE_TOOLS) : undefined;
    const fileAllow = parseNameList(fileConfig.tools);
    const fileDeny = parseNameList(fileConfig.disabledTools);

    const allow = envAllow ?? fileAllow;
    const deny = [...(fileDeny ?? []), ...(envDeny ?? [])];

    const known = new Set<string>(TOOL_NAMES);
    const unknownNames = [...new Set([...(allow ?? []), ...deny])].filter((name) => !known.has(name));

    const enabled = new Set<ToolName>(
        allow ? (allow.filter((name) => known.has(name)) as ToolName[]) : [...TOOL_NAMES]
    );
    for (const name of deny) enabled.delete(name as ToolName);

    const source: ResolvedToolGating["source"] =
        envAllow || envDeny ? (fileAllow || fileDeny || fileFound ? "file+env" : "env") : fileAllow || fileDeny ? "file" : "default";

    return {
        isEnabled: (name: string) => enabled.has(name as ToolName),
        unknownNames,
        source,
        configPath,
        ...(warning ? { warning } : {}),
    };
}