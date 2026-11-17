/**
 * FT-03 — collapsible monitor events in the transcript.
 *
 * A monitor streams one custom message per batch of matched lines. Before this
 * module, pi drew each of those as a flat block: the humanised
 * `◇ Bg Monitor Event` title, the `◉ <description>` line, and every event line
 * — one full block per batch, so a chatty monitor (a dispatcher, a watcher)
 * fills the transcript with blocks that carry no more than the description the
 * user already knows.
 *
 * Registering a message renderer is what makes the block collapsible: pi wraps
 * the renderer's component, and clicking it toggles this module's session-local
 * decision. Collapsed, the block is a header plus the *newest* event line, so
 * the common case ("what just fired?") needs no expansion at all. The header
 * names the monitor instead of repeating a generic title — FT-03 asked for a
 * title the user is less likely to have to expand.
 *
 * The state a block is *added* in comes from the operator's setting
 * `collapse-monitor-events` (default true) in `bizzy-monitor-events.json`. A
 * click overrides it for that monitor for the rest of the session; unlike the
 * sidebar's watchers section (FT-02), nothing is remembered across sessions,
 * because FT-03 asked for a setting, not a memory.
 */

import { readFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentConfigDir } from "./config.ts";
import { EVENT } from "./types.ts";

// ─── Preference file ─────────────────────────────────────────────────────

/** Presentation preferences only, so a collapse toggle can never rewrite the
 *  tool-gating selection in `bizzy.json` (the same reason the watchers file is
 *  separate). */
export const MONITOR_EVENTS_CONFIG_FILENAME = "bizzy-monitor-events.json";
/** The literal key the operator named in FT-03. */
export const COLLAPSE_MONITOR_EVENTS_KEY = "collapse-monitor-events";
/** New blocks are collapsed unless the operator opted out. */
export const DEFAULT_COLLAPSE_MONITOR_EVENTS = true;

export interface MonitorEventsConfig {
    collapse: boolean;
}

/** Resolved per call so `PI_CODING_AGENT_DIR` and tests apply to the process. */
export function monitorEventsConfigPath(
    env: Record<string, string | undefined> = process.env
): string {
    return join(agentConfigDir(env), MONITOR_EVENTS_CONFIG_FILENAME);
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

/**
 * Tolerant read: a missing, unreadable or malformed file degrades to the
 * default, never an error. Only an explicit boolean opts out — a stray string
 * or number cannot turn the transcript into a wall of expanded blocks.
 */
export function readMonitorEventsConfig(path = monitorEventsConfigPath()): MonitorEventsConfig {
    const value = readRecord(path)[COLLAPSE_MONITOR_EVENTS_KEY];
    return {
        collapse: typeof value === "boolean" ? value : DEFAULT_COLLAPSE_MONITOR_EVENTS,
    };
}

let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Write beside the target and rename onto it, so a reader — another pi process
 * starting a session, or this one after a crash — never sees a half-written
 * JSON document. The temp file sits in the same directory so the rename stays
 * within one filesystem, and it is removed when the write itself fails rather
 * than left behind to confuse the next run.
 */
export async function writeAtomic(path: string, text: string): Promise<void> {
    const tmp = `${path}.${process.pid}.tmp`;
    try {
        await writeFile(tmp, text);
        await rename(tmp, path);
    } catch (error) {
        // Swallow the cleanup failure so the caller sees the write failure,
        // which is the one that explains why nothing changed.
        await rm(tmp, { force: true }).catch(() => {});
        throw error;
    }
}

/** Read-modify-write on one queue, so concurrent writers cannot clobber each
 *  other or the file's other keys. */
export function writeMonitorEventsConfig(
    patch: Partial<MonitorEventsConfig>,
    path = monitorEventsConfigPath()
): Promise<void> {
    const filePatch: Record<string, boolean> = {};
    if (patch.collapse !== undefined) filePatch[COLLAPSE_MONITOR_EVENTS_KEY] = patch.collapse;
    const write = writeQueue.then(async () => {
        await writeAtomic(path, `${JSON.stringify({ ...readRecord(path), ...filePatch }, null, 2)}\n`);
    });
    writeQueue = write.catch(() => {});
    return write;
}

/** Resolves once every queued write has settled; a flip right before exit
 *  drains through this. */
export function flushMonitorEventsConfigWrites(): Promise<void> {
    return writeQueue.then(() => {});
}

// ─── Session presentation state ──────────────────────────────────────────

export interface MonitorEventPresentation {
    /** The setting in force for blocks added from now on. */
    collapse: boolean;
    /** Click decisions, keyed by monitor. Deliberately session-local: FT-03
     *  says the last per-block decision is not remembered. */
    overrides: Map<string, boolean>;
}

export function createMonitorEventPresentation(
    config: MonitorEventsConfig
): MonitorEventPresentation {
    return { collapse: config.collapse, overrides: new Map() };
}

/**
 * Whether one monitor's block renders collapsed. `globallyExpanded` is pi's
 * Ctrl+O "expand everything" state; while it is on it wins, so a block cannot
 * hide from the global expansion.
 */
export function monitorEventCollapsed(
    presentation: MonitorEventPresentation,
    key: string,
    globallyExpanded = false
): boolean {
    if (globallyExpanded) return false;
    const override = key ? presentation.overrides.get(key) : undefined;
    return override ?? presentation.collapse;
}

/** Record one block's click decision (session-local). */
export function setMonitorEventCollapsed(
    presentation: MonitorEventPresentation,
    key: string,
    collapsed: boolean
): void {
    if (!key) return;
    presentation.overrides.set(key, collapsed);
}

// ─── Message parsing ─────────────────────────────────────────────────────

export interface MonitorEventDetails {
    jobId?: string;
    description?: string;
    logPath?: string;
    terminal?: boolean;
    /** The event lines, so the renderer need not re-split the content. */
    lines?: string[];
}

export interface MonitorEventMessage {
    content: unknown;
    details?: unknown;
}

export interface ParsedMonitorEvent {
    /** Stable identity for this monitor's blocks: its job id, or the
     *  description for messages recorded before structured details existed. */
    key: string;
    description: string;
    lines: string[];
}

function textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((block): block is { type: string; text: string } =>
                Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text"
            )
            .map((block) => block.text)
            .join("\n");
    }
    return "";
}

/**
 * Split a monitor-event message into what the block needs. The persisted
 * content keeps the `◉ <description>` header (it is also the fallback when no
 * renderer is registered), so messages recorded before this change still
 * render; structured `details` win when present.
 */
export function parseMonitorEventMessage(message: MonitorEventMessage): ParsedMonitorEvent {
    const details = (
        message.details && typeof message.details === "object" ? message.details : {}
    ) as MonitorEventDetails;
    const contentLines = textOf(message.content).split("\n");
    const header = contentLines[0] ?? "";
    const headerDescription = (header.startsWith("◉") ? header.slice(1) : header).trim();
    const described = typeof details.description === "string" ? details.description.trim() : "";
    const description = described || headerDescription || "monitor";
    const lines = (
        Array.isArray(details.lines) && details.lines.length > 0
            ? details.lines.map(String)
            : contentLines.slice(1)
    )
        .map((line) => line.replace(/\r$/, ""))
        .filter((line) => line.trim().length > 0);
    const jobId = typeof details.jobId === "string" ? details.jobId : "";
    return { key: jobId || `description:${description}`, description, lines };
}

// ─── Rendering ───────────────────────────────────────────────────────────

export interface MonitorEventTheme {
    fg(colour: string, text: string): string;
}

/** CSI and two-character escape sequences: enough for theme colours and any
 *  ANSI a monitored command wrote into its log. */
const ANSI_SEQUENCE = /\u001B(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\^_`a-z{|}~])/g;

interface AnsiToken {
    ansi: boolean;
    text: string;
}

function ansiTokens(text: string): AnsiToken[] {
    const tokens: AnsiToken[] = [];
    let last = 0;
    let match: RegExpExecArray | null;
    ANSI_SEQUENCE.lastIndex = 0;
    while ((match = ANSI_SEQUENCE.exec(text)) !== null) {
        if (match.index > last) tokens.push({ ansi: false, text: text.slice(last, match.index) });
        tokens.push({ ansi: true, text: match[0] });
        last = match.index + match[0].length;
    }
    if (last < text.length) tokens.push({ ansi: false, text: text.slice(last) });
    return tokens;
}

/** Visible columns, ignoring escape sequences. */
export function visibleWidth(text: string): number {
    let width = 0;
    for (const token of ansiTokens(text)) if (!token.ansi) width += [...token.text].length;
    return width;
}

/**
 * Fit one line into `width` columns, ending an over-long line with `…`. A cut
 * that left a colour open is closed with a reset, so a truncated themed line
 * cannot bleed into the next row.
 */
export function fitLine(text: string, width: number): string {
    if (width <= 0) return "";
    if (visibleWidth(text) <= width) return text;
    const limit = Math.max(1, width - 1);
    let out = "";
    let visible = 0;
    let sawAnsi = false;
    for (const token of ansiTokens(text)) {
        if (token.ansi) {
            out += token.text;
            sawAnsi = true;
            continue;
        }
        for (const char of token.text) {
            if (visible >= limit) break;
            out += char;
            visible += 1;
        }
        if (visible >= limit) break;
    }
    return `${out}…${sawAnsi ? "\u001B[0m" : ""}`;
}

/**
 * Wrap one line into `width` columns. Hard wrapping (not word wrapping): log
 * lines are timestamps and paths, and losing the tail of an expanded line is
 * worse than breaking mid-token.
 */
export function wrapLine(text: string, width: number): string[] {
    if (width <= 0) return [text];
    if (visibleWidth(text) <= width) return [text];
    const out: string[] = [];
    let current = "";
    let visible = 0;
    for (const token of ansiTokens(text)) {
        if (token.ansi) {
            current += token.text;
            continue;
        }
        for (const char of token.text) {
            if (visible >= width) {
                out.push(current);
                current = "";
                visible = 0;
            }
            current += char;
            visible += 1;
        }
    }
    if (current.length > 0) out.push(current);
    return out.length > 0 ? out : [""];
}

export interface MonitorEventLinesArgs {
    description: string;
    lines: readonly string[];
    collapsed: boolean;
    width: number;
    theme: MonitorEventTheme;
}

/**
 * The block's lines. Collapsed is a header plus the newest event; expanded is
 * the header plus every event, wrapped to the width.
 */
export function renderMonitorEventLines(args: MonitorEventLinesArgs): string[] {
    const { description, lines, collapsed, width, theme } = args;
    if (width <= 0) return [];
    const count = lines.length === 0 ? "" : ` · ${lines.length} event${lines.length === 1 ? "" : "s"}`;
    const marker = collapsed ? "▸" : "▾";
    const hint = collapsed ? "click to expand" : "click to collapse";
    // The monitor's own description is the title: it is the one piece of
    // context the user needs and the old generic title did not carry.
    const header = `${marker} Monitor · ${description}${count} · ${hint}`;
    const out = [theme.fg("customMessageLabel", fitLine(header, width))];
    if (collapsed) {
        const newest = lines[lines.length - 1];
        if (newest) out.push(theme.fg("dim", fitLine(`  ${newest}`, width)));
        return out;
    }
    for (const line of lines) {
        for (const part of wrapLine(line, Math.max(1, width - 2))) {
            out.push(theme.fg("dim", `  ${part}`));
        }
    }
    return out;
}

/** The component pi wraps for a `bg-monitor-event` message. */
export interface MonitorEventComponent {
    render(width: number): string[];
    handleMouse?(event: { type: string; button: string }): { handled: boolean } | undefined;
    invalidate(): void;
}

/**
 * Build the renderer's component for one message. State is read from
 * `presentation` on every render, so a click only has to record the decision;
 * pi's next frame (a handled mouse event requests one) draws it.
 */
export function renderMonitorEventBlock(
    presentation: MonitorEventPresentation,
    message: MonitorEventMessage,
    options: { expanded: boolean },
    theme: MonitorEventTheme
): MonitorEventComponent {
    const parsed = parseMonitorEventMessage(message);
    const collapsedNow = (): boolean => monitorEventCollapsed(presentation, parsed.key, options.expanded);
    return {
        render: (width: number) =>
            renderMonitorEventLines({
                description: parsed.description,
                lines: parsed.lines,
                collapsed: collapsedNow(),
                width,
                theme,
            }),
        handleMouse: (event) => {
            if (event.type !== "click" || event.button !== "left") return undefined;
            // Toggle what is on screen. Session-local, per monitor — FT-03
            // explicitly does not remember the decision.
            setMonitorEventCollapsed(presentation, parsed.key, !collapsedNow());
            return { handled: true };
        },
        invalidate: () => {},
    };
}

/** Register the renderer. The presentation is the session object the command
 *  mutates, so a flip in one place shows up in the other. */
export function registerMonitorEventRenderer(
    pi: ExtensionAPI,
    presentation: MonitorEventPresentation
): void {
    pi.registerMessageRenderer(EVENT.monitorEvent, (message, options, theme) =>
        renderMonitorEventBlock(presentation, message as MonitorEventMessage, options, theme)
    );
}
