/**
 * Shared mutable state for the background-tasks extension.
 *
 * One instance per session, threaded through every tool and helper.
 */

import type { Job, ForegroundSlot } from "./types.ts";
import { DEFAULT_WATCHERS_COLLAPSED } from "./watchers.ts";

export class BackgroundRegistry {
    jobs = new Map<string, Job>();
    foreground = new Map<string, ForegroundSlot>();

    /** Per-job AbortController — abort() cancels all monitors/pollers for that job. */
    jobAborts = new Map<string, AbortController>();

    nonInteractive = false;

    completedCount = 0;
    failedCount = 0;
    killedCount = 0;
    totalStarted = 0;
    totalDurationMs = 0;
    recentTerminal: Job[] = [];

    /** Live-duration ticker for the sidebar pills; runs while jobs are alive. */
    sidebarTimer: NodeJS.Timeout | undefined = undefined;
    /** Last rendered sidebar content — used to skip redundant widget updates. */
    lastSidebarContent: string | undefined = undefined;

    /** Watchers (monitor) section collapsed? Starts collapsed; see watchers.ts. */
    watchersCollapsed = DEFAULT_WATCHERS_COLLAPSED;
    /** Obey the user's last collapse decision in new sessions. */
    watchersRemember = false;
    /** Set by the sidebar widget factory; a toggle uses it to force a redraw. */
    sidebarRequestRender: (() => void) | undefined = undefined;
}
