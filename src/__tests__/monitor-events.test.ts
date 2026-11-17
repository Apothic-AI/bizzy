/**
 * FT-03 — collapsible monitor events in the transcript.
 *
 * Covers the preference file (literal `collapse-monitor-events` key, default
 * true, merge-preserving writes), the initial-state rule and session-local
 * per-monitor overrides, the rendered block (collapsed by default, expanded on
 * demand, the monitor's own description as the title), the click target, and
 * that `/toggle-collapse-monitor-events` flips the setting the renderer reads.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundRegistry } from "../state.ts";
import { registerCommands } from "../commands.ts";
import {
    COLLAPSE_MONITOR_EVENTS_KEY,
    DEFAULT_COLLAPSE_MONITOR_EVENTS,
    createMonitorEventPresentation,
    flushMonitorEventsConfigWrites,
    monitorEventCollapsed,
    parseMonitorEventMessage,
    readMonitorEventsConfig,
    renderMonitorEventBlock,
    renderMonitorEventLines,
    setMonitorEventCollapsed,
    visibleWidth,
    wrapLine,
    writeMonitorEventsConfig,
} from "../monitor-events.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-monitor-events-"));
const plainTheme = { fg: (_colour: string, text: string) => text };

after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PI_CODING_AGENT_DIR;
});

function tmpConfig(name: string, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
}

function eventMessage(overrides: Record<string, unknown> = {}) {
    return {
        content: "◉ deploy watcher\n12:31:37Z DONE ft75\n12:31:44Z START ft74",
        details: {
            jobId: "m7f3k9a2x1",
            description: "deploy watcher",
            logPath: "/tmp/watch.log",
            terminal: false,
            lines: ["12:31:37Z DONE ft75", "12:31:44Z START ft74"],
            ...overrides,
        },
    };
}

void describe("monitor events — preference file", () => {
    void it("defaults to collapsed when the file is missing or unreadable", () => {
        assert.equal(DEFAULT_COLLAPSE_MONITOR_EVENTS, true);
        assert.deepEqual(readMonitorEventsConfig(join(dir, "absent.json")), { collapse: true });
        assert.deepEqual(
            readMonitorEventsConfig(tmpConfig("broken.json", "{not json")),
            { collapse: true }
        );
    });

    void it("reads an explicit opt-out under the literal collapse-monitor-events key", () => {
        const path = tmpConfig(
            "explicit.json",
            JSON.stringify({ [COLLAPSE_MONITOR_EVENTS_KEY]: false })
        );
        assert.deepEqual(readMonitorEventsConfig(path), { collapse: false });
    });

    void it("ignores a non-boolean value instead of guessing", () => {
        const path = tmpConfig(
            "stray.json",
            JSON.stringify({ [COLLAPSE_MONITOR_EVENTS_KEY]: "off" })
        );
        assert.deepEqual(readMonitorEventsConfig(path), { collapse: true });
    });

    void it("writes merge-preservingly, leaving other keys alone", async () => {
        const path = tmpConfig(
            "merge.json",
            JSON.stringify({ "some-other-key": 7, [COLLAPSE_MONITOR_EVENTS_KEY]: true })
        );
        await writeMonitorEventsConfig({ collapse: false }, path);
        await flushMonitorEventsConfigWrites();
        const raw = JSON.parse(readFileSync(path, "utf8"));
        assert.equal(raw[COLLAPSE_MONITOR_EVENTS_KEY], false);
        assert.equal(raw["some-other-key"], 7);
    });
});

void describe("monitor events — session presentation state", () => {
    void it("starts in the configured state", () => {
        const collapsed = createMonitorEventPresentation({ collapse: true });
        assert.equal(monitorEventCollapsed(collapsed, "m1"), true);
        const expanded = createMonitorEventPresentation({ collapse: false });
        assert.equal(monitorEventCollapsed(expanded, "m2"), false);
    });

    void it("keeps a click decision per monitor, not globally", () => {
        const presentation = createMonitorEventPresentation({ collapse: true });
        setMonitorEventCollapsed(presentation, "m1", false);
        assert.equal(monitorEventCollapsed(presentation, "m1"), false);
        assert.equal(monitorEventCollapsed(presentation, "m2"), true);
    });

    void it("lets pi's global expansion win while it is on", () => {
        const presentation = createMonitorEventPresentation({ collapse: true });
        assert.equal(monitorEventCollapsed(presentation, "m1", true), false);
    });
});

void describe("monitor events — message parsing", () => {
    void it("prefers structured details", () => {
        const parsed = parseMonitorEventMessage(eventMessage());
        assert.equal(parsed.key, "m7f3k9a2x1");
        assert.equal(parsed.description, "deploy watcher");
        assert.deepEqual(parsed.lines, ["12:31:37Z DONE ft75", "12:31:44Z START ft74"]);
    });

    void it("still renders messages recorded before details carried lines", () => {
        const parsed = parseMonitorEventMessage({
            content: "◉ legacy watch\nold line",
        });
        assert.equal(parsed.key, "description:legacy watch");
        assert.equal(parsed.description, "legacy watch");
        assert.deepEqual(parsed.lines, ["old line"]);
    });
});

void describe("monitor events — rendering", () => {
    void it("collapsed: informative header plus only the newest event", () => {
        const lines = renderMonitorEventLines({
            description: "si-batch dispatcher progress",
            lines: ["12:31:37Z DONE ft75", "12:31:44Z START ft74", "12:49:04Z DONE ft38"],
            collapsed: true,
            width: 120,
            theme: plainTheme,
        });
        assert.equal(lines.length, 2);
        // The description is the title — the part the generic “Bg Monitor Event”
        // title never carried.
        assert.match(lines[0], /▸ Monitor · si-batch dispatcher progress/);
        assert.match(lines[0], /3 events/);
        assert.match(lines[0], /click to expand/);
        assert.match(lines[1], /12:49:04Z DONE ft38/);
        assert.doesNotMatch(lines.join("\n"), /12:31:37Z DONE ft75/);
    });

    void it("expanded: every event line, wrapped to the width", () => {
        const events = ["first event", "second event"];
        const lines = renderMonitorEventLines({
            description: "watch",
            lines: events,
            collapsed: false,
            width: 80,
            theme: plainTheme,
        });
        assert.match(lines[0], /▾ Monitor · watch/);
        assert.match(lines[0], /2 events/);
        assert.match(lines[0], /click to collapse/);
        const body = lines.slice(1).join("\n");
        assert.match(body, /first event/);
        assert.match(body, /second event/);
    });

    void it("never emits a line wider than the terminal", () => {
        const width = 40;
        for (const collapsed of [true, false]) {
            const lines = renderMonitorEventLines({
                description: "a monitor with a deliberately long description that cannot fit on one row",
                lines: [
                    "12:49:09Z START ft73 lane=si-ft73-record cwd=/home/bitnom/Documents/Fleet with a long tail",
                    "short",
                ],
                collapsed,
                width,
                theme: plainTheme,
            });
            for (const line of lines) {
                assert.ok(
                    visibleWidth(line) <= width,
                    `line ${JSON.stringify(line)} is ${visibleWidth(line)} cols (width ${width})`
                );
            }
        }
    });

    void it("truncates an over-long collapsed event with an ellipsis", () => {
        const lines = renderMonitorEventLines({
            description: "watch",
            lines: ["x".repeat(200)],
            collapsed: true,
            width: 30,
            theme: plainTheme,
        });
        assert.ok(visibleWidth(lines[1]) <= 30);
        assert.match(lines[1], /…$/);
    });

    void it("wraps a long line into width-sized pieces", () => {
        assert.deepEqual(wrapLine("abcdefghij", 4), ["abcd", "efgh", "ij"]);
        assert.deepEqual(wrapLine("short", 10), ["short"]);
    });
});

void describe("monitor events — the rendered component", () => {
    void it("renders collapsed, then expands when clicked", () => {
        const presentation = createMonitorEventPresentation({ collapse: true });
        const component = renderMonitorEventBlock(
            presentation,
            eventMessage(),
            { expanded: false },
            plainTheme
        );
        assert.match(component.render(100)[0], /▸ Monitor · deploy watcher/);
        assert.equal(component.render(100).length, 2);

        assert.deepEqual(component.handleMouse?.({ type: "click", button: "left" }), {
            handled: true,
        });
        const expanded = component.render(100);
        assert.match(expanded[0], /▾ Monitor · deploy watcher/);
        assert.match(expanded.join("\n"), /12:31:37Z DONE ft75/);
    });

    void it("ignores clicks that are not a left click", () => {
        const presentation = createMonitorEventPresentation({ collapse: true });
        const component = renderMonitorEventBlock(
            presentation,
            eventMessage(),
            { expanded: false },
            plainTheme
        );
        assert.equal(component.handleMouse?.({ type: "move", button: "left" }), undefined);
        assert.equal(component.handleMouse?.({ type: "click", button: "right" }), undefined);
        assert.match(component.render(100)[0], /▸/);
    });

    void it("respects pi's global expansion for the initial view", () => {
        const presentation = createMonitorEventPresentation({ collapse: true });
        const component = renderMonitorEventBlock(
            presentation,
            eventMessage(),
            { expanded: true },
            plainTheme
        );
        assert.match(component.render(100)[0], /▾/);
    });
});

void describe("monitor events — /toggle-collapse-monitor-events", () => {
    void it("flips the setting the renderer reads, and persists it", async () => {
        process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

        const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
        const pi = {
            registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
                commands.set(name, definition);
            },
        };
        const presentation = createMonitorEventPresentation({ collapse: true });
        registerCommands(
            pi as never,
            new BackgroundRegistry(),
            presentation
        );

        const notices: string[] = [];
        const ctx = { ui: { notify: (message: string) => notices.push(message) } };
        const command = commands.get("toggle-collapse-monitor-events");
        assert.ok(command, "expected the slash command to be registered");

        // A click decision for one monitor is discarded when the global
        // setting is flipped deliberately.
        setMonitorEventCollapsed(presentation, "m1", false);
        await command!.handler("", ctx);
        assert.equal(presentation.collapse, false);
        assert.equal(presentation.overrides.size, 0);
        assert.match(notices.at(-1) ?? "", /will start expanded/);

        await flushMonitorEventsConfigWrites();
        const path = join(process.env.PI_CODING_AGENT_DIR, "bizzy-monitor-events.json");
        assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
            [COLLAPSE_MONITOR_EVENTS_KEY]: false,
        });

        await command!.handler("toggle", ctx);
        assert.equal(presentation.collapse, true);
        assert.match(notices.at(-1) ?? "", /will start collapsed/);

        await command!.handler("sideways", ctx);
        assert.match(notices.at(-1) ?? "", /Unknown value "sideways"/);
    });
});
