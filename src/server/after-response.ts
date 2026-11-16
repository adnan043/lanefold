/** What it needs of a Hono context: its `executionCtx` (whose getter throws when there is none). */
export type WithExecutionCtx = {readonly executionCtx: {waitUntil(promise: Promise<unknown>): void}};

/**
 * Work a route does AFTER its write has committed that the answer does not need: notifications, watcher emails,
 * Flows. On the Worker it runs after the answer is sent (`waitUntil`), so the person is not kept waiting for its
 * round trips (performance.md › Worker budgets: "Work after the answer"). Never throws into the route.
 *
 * Without an execution context (tests, in-process `backend()` calls from a page) it runs before answering, as
 * it always did: nothing is left running unawaited.
 */
export async function afterResponse(c: WithExecutionCtx, label: string, work: () => Promise<unknown>): Promise<void> {
  const guarded = () =>
    work().catch(err => {
      // Words for the log only: never card text, never a secret.
      console.error(`${label} failed: ${(err as Error).message}`);
    });
  let ctx: {waitUntil(promise: Promise<unknown>): void} | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined;
  }
  if (ctx) ctx.waitUntil(guarded());
  else await guarded();
}
