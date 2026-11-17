/**
 * Slash command registration.
 *
 *   - /bg: same as Ctrl+Shift+B — background the foreground process
 *   - /bg-list: open the interactive background task manager
 *   - /bg-version: show the loaded extension version/path
 *   - /watchers: collapse/expand the sidebar's watchers (monitor) section
 *   - /remember-watchers-toggle: remember that decision in new sessions
 *   - /toggle-collapse-monitor-events: flip the transcript's monitor-event
 *     collapse setting (FT-03)
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
    ExtensionAPI,
    ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import type { BackgroundRegistry } from "./state.ts";
import { takeControl, type ControlContext } from "./lifecycle.ts";
import { setWatchersCollapsed, toggleWatchers } from "./registry.ts";
import { writeWatcherConfig } from "./watchers.ts";
import {
    type MonitorEventPresentation,
    writeMonitorEventsConfig,
} from "./monitor-events.ts";
import { openBgListPanel } from "./ui.ts";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageRoot = dirname(packageJsonPath);

/** Register all slash commands. */
export function registerCommands(
    pi: ExtensionAPI,
    reg: BackgroundRegistry,
    monitorEvents: MonitorEventPresentation
): void {
    pi.registerCommand("bg", {
        description: "Background the current process and hand control to the agent",
        handler: async (_args, ctx) => {
            takeControl(reg, ctx as unknown as ControlContext);
        },
    });

    pi.registerCommand("bg-list", {
        description: "Open the interactive background task manager",
        handler: async (_args, ctx: ExtensionCommandContext) => {
            await openBgListPanel(reg, ctx);
        },
    });

    pi.registerCommand("bg-version", {
        description: "Show the loaded background tasks extension version",
        handler: async (_args, ctx) => {
            const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8")) as {
                name?: string;
                version?: string;
            };
            ctx.ui.notify(
                `${pkg.name ?? "pi-bizzy-bg-tasks"}@${pkg.version ?? "unknown"} loaded from ${packageRoot}`,
                "info"
            );
        },
    });

    pi.registerCommand("watchers", {
        description:
            "Collapse or expand the sidebar watchers (monitor) section: /watchers [collapse|expand|toggle]",
        handler: async (args, ctx) => {
            const verb = args.trim().toLowerCase();
            if (verb && verb !== "collapse" && verb !== "expand" && verb !== "toggle") {
                ctx.ui.notify(
                    `Unknown value "${verb}". Use \`/watchers [collapse|expand|toggle]\`.`,
                    "warning"
                );
                return;
            }
            if (verb === "collapse") setWatchersCollapsed(reg, ctx, true);
            else if (verb === "expand") setWatchersCollapsed(reg, ctx, false);
            else toggleWatchers(reg, ctx);
        },
    });

    pi.registerCommand("remember-watchers-toggle", {
        description:
            "Toggle whether the sidebar watchers collapse state is remembered across sessions: /remember-watchers-toggle [on|off]",
        handler: async (args, ctx) => {
            const value = args.trim().toLowerCase();
            if (value && value !== "on" && value !== "off") {
                ctx.ui.notify(
                    `Unknown value "${value}". Use \`/remember-watchers-toggle [on|off]\`.`,
                    "warning"
                );
                return;
            }
            const next = value === "on" ? true : value === "off" ? false : !reg.watchersRemember;
            reg.watchersRemember = next;
            // Enabling records the state that is on screen, so the next session
            // matches what the user saw rather than a decision made earlier.
            await writeWatcherConfig(
                next ? { remember: next, collapsed: reg.watchersCollapsed } : { remember: next }
            );
            ctx.ui.notify(
                next
                    ? `Watchers collapse state is remembered (${
                          reg.watchersCollapsed ? "collapsed" : "expanded"
                      }).`
                    : "Watchers collapse state is no longer remembered.",
                "info"
            );
        },
    });

    pi.registerCommand("toggle-collapse-monitor-events", {
        description:
            "Collapse or expand monitor event blocks in the transcript: /toggle-collapse-monitor-events [collapse|expand|toggle]",
        handler: async (args, ctx) => {
            const verb = args.trim().toLowerCase();
            if (verb && verb !== "collapse" && verb !== "expand" && verb !== "toggle") {
                ctx.ui.notify(
                    `Unknown value "${verb}". Use \`/toggle-collapse-monitor-events [collapse|expand|toggle]\`.`,
                    "warning"
                );
                return;
            }
            const collapsed =
                verb === "collapse" ? true : verb === "expand" ? false : !monitorEvents.collapse;
            monitorEvents.collapse = collapsed;
            // A click decision for one monitor outranks the setting. Flipping
            // the setting is a deliberate global choice, so it discards those
            // decisions and is in force for every monitor from here on.
            monitorEvents.overrides.clear();
            await writeMonitorEventsConfig({ collapse: collapsed });
            ctx.ui.notify(
                `Monitor event blocks will start ${collapsed ? "collapsed" : "expanded"}.`,
                "info"
            );
        },
    });
}
