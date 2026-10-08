// src/__tests__/helpers/hold-event-loop.ts
import { after, before } from "node:test";

/**
 * Hold the event loop open for the lifetime of this test file.
 *
 * `spawnWithFileOutput` calls `proc.unref()` on purpose: a background job must
 * never be the reason pi stays alive, and that is the whole point of the
 * extension. The side effect in a test is that once a spawn has returned,
 * nothing in the loop references the pending child. A test that then awaits
 * that child's `exit` sees Node resolve the loop first, and the test is
 * cancelled with:
 *
 *     'Promise resolution is still pending but the event loop has already resolved'
 *
 * Every suite that spawns a real process therefore loses most of its tests to
 * cancellation — silently, since the runner still exits 0 for the unaffected
 * ones. `spawn`, `bash-results`, and `monitor` were all affected, which left
 * `spawnWithFileOutput` and the bash timeout path with no effective coverage.
 *
 * A zero-work ref'd interval is the standard way to keep a loop alive across an
 * await. Doing it once per file rather than wrapping each await means a test
 * added later cannot silently regress back into cancellation.
 *
 * Production behaviour is deliberately untouched: `proc.unref()` stays, because
 * removing it would make pi hang until every background job finished.
 */
export function holdEventLoop(): void {
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    before(() => {
        keepAlive = setInterval(() => {}, 10);
    });
    after(() => {
        clearInterval(keepAlive);
        keepAlive = undefined;
    });
}