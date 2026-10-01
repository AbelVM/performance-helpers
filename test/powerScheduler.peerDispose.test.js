import { describe, it, expect } from 'vitest';

/**
 * SCHED-001 — `dispose()` closes a **module-level** channel, so disposing one
 * macrotask scheduler tears the listener off every *other* scheduler's pending
 * flush.
 *
 * The failure: the peer's post is discarded, `_run()` never runs, `_scheduled`
 * stays `true`, and `schedule()` short-circuits on its first line. From then on
 * the peer's `schedule()` is a permanent no-op. Measured before the fix: `a`
 * flushed **0** times after `b.dispose()`, and `a.scheduled` was still `true`
 * after three further `schedule()` calls.
 *
 * Why this file exists separately from `powerScheduler.macrotask.test.js`:
 * that file's tests each dispose a scheduler **after** its own `flush()` has
 * been awaited, so nothing is ever in flight at dispose time and the defect is
 * unreachable. The window here is narrow and that is the point — the trigger is
 * `a.schedule(); b.schedule(); b.dispose();` with no await between, which is
 * what `using` / `[Symbol.dispose]` produces when two schedulers share a scope.
 *
 * RES-005 / F-53 added `closeMacrotaskChannel()` to fix a *different* real bug
 * (a macrotask scheduler pinning a Node process open forever), so this is a
 * regression the fix introduced, not a pre-existing one.
 */
describe('disposing one macrotask scheduler does not wedge its peers', () => {
  /**
   * A **fresh** module, so its module-level channel cache and its
   * `_macrotaskPending` counter both start at zero.
   *
   * Both are module-scope singletons. Importing normally would inherit whatever
   * an earlier test in this file left behind, which is how the first draft of
   * the third test read as a broken instrument rather than as shared state.
   *
   * @returns {Promise<any>} a freshly imported `PowerScheduler`.
   */
  async function freshSchedulerModule() {
    const { vi } = await import('vitest');
    vi.resetModules();
    return import('../src/helpers/powerScheduler.js');
  }

  it('a peer with a flush in flight still flushes', async () => {
    // The regression, stated as the smallest case that reaches it. The
    // `dispose()` sits between the two posts and the delivery, which is the
    // whole of the window: `await` anywhere in here and the test passes against
    // the unfixed code.
    const { PowerScheduler } = await freshSchedulerModule();
    let a = 0;
    let b = 0;
    const peer = new PowerScheduler(() => (a += 1), { scheduling: 'macrotask' });
    const other = new PowerScheduler(() => (b += 1), { scheduling: 'macrotask' });

    peer.schedule();
    other.schedule();
    other.dispose();

    await new Promise((r) => setTimeout(r, 60));
    expect(a, 'the peer had a post in flight when the channel was closed').toBe(1);
  });

  it('the peer is not left permanently unable to schedule', async () => {
    // The consequence, and the half that matters more: even if a reader is
    // content to lose the in-flight flush, a `_scheduled` flag stuck at `true`
    // is a scheduler that never runs again for the life of the object. Only
    // `cancel()` recovers it, and nothing in `dispose()` documents that.
    const { PowerScheduler } = await freshSchedulerModule();
    let a = 0;
    const peer = new PowerScheduler(() => (a += 1), { scheduling: 'macrotask' });
    const other = new PowerScheduler(() => {}, { scheduling: 'macrotask' });

    peer.schedule();
    other.dispose();
    await new Promise((r) => setTimeout(r, 60));
    expect(peer.scheduled, 'a flush that ran must have cleared the flag').toBe(false);

    peer.schedule();
    await new Promise((r) => setTimeout(r, 60));
    expect(a, 'a later schedule() must still reach the port').toBe(2);
  });

  it('the channel is still released once nothing is in flight', async () => {
    // The other direction, and the one that guards against "fix" meaning
    // "delete `closeMacrotaskChannel()`". Dropping the close restores the
    // process hang RES-005 fixed: a started `MessagePort` keeps the Node event
    // loop alive forever, and `unref()` is what stopped that. This asserts the
    // close still happens on the idle path — the same two ports as
    // `powerScheduler.macrotask.test.js` asserts there, reached here so the
    // guard and the fix sit in one file.
    const { PowerScheduler } = await freshSchedulerModule();
    const s = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
    s.schedule();
    await s.flush();

    const probe = new MessageChannel();
    const PortProto = Object.getPrototypeOf(probe.port1);
    probe.port1.close();
    probe.port2.close();
    const realClose = PortProto.close;
    let closes = 0;
    PortProto.close = function (...a) {
      closes += 1;
      return realClose.apply(this, a);
    };
    try {
      s.dispose();
      expect(closes, 'both ports of the one idle channel').toBe(2);
    } finally {
      PortProto.close = realClose;
    }
  });

  it('a cancelled post does not hold the channel open', async () => {
    // The counter has two exits, and only one of them is the delivery. If
    // `cancel()` did not decrement it, a scheduler that schedules and cancels in
    // a loop would leave the counter permanently above zero and the channel
    // would never be closed — a leak introduced by the fix for a different leak.
    const { PowerScheduler } = await freshSchedulerModule();
    const s = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
    s.schedule();
    s.cancel();
    await new Promise((r) => setTimeout(r, 30));

    const probe = new MessageChannel();
    const PortProto = Object.getPrototypeOf(probe.port1);
    probe.port1.close();
    probe.port2.close();
    const realClose = PortProto.close;
    let closes = 0;
    PortProto.close = function (...a) {
      closes += 1;
      return realClose.apply(this, a);
    };
    try {
      s.dispose();
      expect(closes, 'a cancelled post must not count as in flight').toBe(2);
    } finally {
      PortProto.close = realClose;
    }
  });
});
