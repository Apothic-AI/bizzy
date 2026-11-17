/**
 * The watchers section of the sidebar, and its collapse preference.
 *
 * A monitor is a streaming watch (`◉` in the sidebar), and a lane that keeps
 * several leader watchers armed spends one pill per watcher on the screen forever.
 * The sidebar therefore groups every running monitor into one section that can be
 * collapsed to a single line. Collapsed is the default; the user's last decision is
 * only obeyed in a new session when they opt in with `/remember-watchers-toggle`.
 *
 * The preference lives in its own file rather than `bizzy.json` so a collapse
 * toggle can never rewrite the tool-gating selection (and vice versa). Both writers
 * read-modify-write, but separate files keep the ownership obvious.
 */

import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentConfigDir } from "./config.ts";

export const WATCHERS_CONFIG_FILENAME = "bizzy-watchers.json";

/** File key: the user's last collapse/expand decision. */
export const WATCHERS_COLLAPSED_KEY = "watchers-collapsed";
/** File key: remember that decision across sessions. */
export const REMEMBER_WATCHERS_KEY = "remember-watchers-toggle";

export interface WatcherConfig {
    /** The last decision the user made; only obeyed while `remember` is on. */
    collapsed: boolean;
    /** Obey the last decision in new sessions. */
    remember: boolean;
}

/**
 * The file defaults: no decision recorded yet (`collapsed: false`) and no
 * remembering. A session still *starts* collapsed — see
 * `DEFAULT_WATCHERS_COLLAPSED`; `collapsed` is the remembered decision, not the
 * first-session layout.
 */
export const DEFAULT_WATCHER_CONFIG: WatcherConfig = { collapsed: false, remember: false };

/** A session starts with the watchers section collapsed unless told otherwise. */
export const DEFAULT_WATCHERS_COLLAPSED = true;

/** The collapse state a new session starts in. */
export function initialWatchersCollapsed(config: WatcherConfig): boolean {
    return config.remember ? config.collapsed : DEFAULT_WATCHERS_COLLAPSED;
}

/** Resolved per call, so a test or a `PI_CODING_AGENT_DIR` override applies to the running process. */
export function watchersConfigPath(env: Record<string, string | undefined> = process.env): string {
    return join(agentConfigDir(env), WATCHERS_CONFIG_FILENAME);
}

function readRecord(path: string): Record<string, unknown> {
    try {
        const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
        return raw as Record<string, unknown>;
    } catch {
        return {};
    }
}

/** Tolerant read: a missing, unreadable or malformed file degrades to the defaults, never an error. */
export function readWatcherConfig(path = watchersConfigPath()): WatcherConfig {
    const raw = readRecord(path);
    return {
        collapsed: raw[WATCHERS_COLLAPSED_KEY] === true,
        remember: raw[REMEMBER_WATCHERS_KEY] === true,
    };
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Read-modify-write on a single queue, so concurrent writers cannot clobber each
 * other. Keys are the file's kebab-case names on purpose: the operator asked for
 * `watchers-collapsed` and `remember-watchers-toggle` by name.
 */
export function writeWatcherConfig(
    patch: Partial<WatcherConfig>,
    path = watchersConfigPath()
): Promise<void> {
    const filePatch: Record<string, boolean> = {};
    if (patch.collapsed !== undefined) filePatch[WATCHERS_COLLAPSED_KEY] = patch.collapsed;
    if (patch.remember !== undefined) filePatch[REMEMBER_WATCHERS_KEY] = patch.remember;
    const write = writeQueue.then(async () => {
        await writeFile(path, `${JSON.stringify({ ...readRecord(path), ...filePatch }, null, 2)}\n`);
    });
    writeQueue = write.catch(() => {});
    return write;
}

/** Resolves once every queued write has settled; a collapse right before exit drains through this. */
export function flushWatcherConfigWrites(): Promise<void> {
    return writeQueue.then(() => {});
}
