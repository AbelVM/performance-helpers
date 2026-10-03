/**
 * `WorkerAgnostic` routes listener errors to `onError` — WRK-003.
 *
 * **Swallowing is right; swallowing *silently* is the defect.** `_dispatch` wraps
 * every listener call in a `try/catch` whose body was a comment and nothing else —
 * correctly, so a throwing listener cannot break the worker event loop, and
 * incorrectly, because a listener that throws on every message leaves behind a class
 * that looks completely healthy: the events stop arriving at that handler, nothing is
 * logged, nothing is counted, and the only symptom is a feature quietly ceasing to
 * work. Four sibling helpers had already grown an `onError` route; this one was missed
 * because it looked identical to a dozen deliberate `catch {}` blocks elsewhere.
 *
 * **The property pinned here is the one that is easy to get backwards.** Routing the
 * error is only half of it — the other half is that the *other* listeners must still
 * run. An implementation that let the error escape, or that `return`ed out of the loop,
 * would satisfy "onError was called" while turning one bad handler into a dead event
 * loop. That is the trade this class is supposed to be making in the other direction.
 *
 * Counted on a real `EventTarget`, following `workerAgnostic.dispose.test.js`: a stub
 * recording `addEventListener` calls cannot tell which native model was wired, and a
 * previous draft of that file tested the emitter path twice while claiming to cover the
 * listener path.
 *
 * **One thing here is deliberately untested.** `onError` is stripped from the bag
 * before it reaches `new Worker(...)`, because it is this class's option and not the
 * platform's. That change is **hygiene with no observable behaviour**: Node's `Worker`
 * and the DOM's `WorkerOptions` both ignore unknown members, and reaching the
 * string-source path needs a stubbed global `Worker`. A test asserting the strip would
 * therefore pass whether or not the strip exists — a test that cannot fail on the
 * regression it names is decoration, so it is not written. The strip is documented at
 * the call site instead.
 */
import { describe, it, expect, vi } from 'vitest';
import { WorkerAgnostic } from '../src/index.js';

/**
 * A worker-like exposing the DOM listener pair, so the listener model is wired.
 *
 * `EventTarget`, `Event` and `MessageEvent` are Node globals rather than
 * `node:events` exports — `require('node:events').Event` is `undefined`, which cost
 * this file its first two runs.
 */
class ListenerWorker extends EventTarget {
  terminate() {
    this.terminated = true;
  }
}

describe('WorkerAgnostic onError', () => {
  it('reports a throwing listener instead of dropping the error', () => {
    const onError = vi.fn();
    const w = new WorkerAgnostic(() => new ListenerWorker(), { onError });

    w.addEventListener('message', () => {
      throw new Error('listener blew up');
    });
    w.worker.dispatchEvent(new MessageEvent('message', { hello: 1 }));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toBe('listener blew up');
  });

  it('keeps delivering to the other listeners', () => {
    // **This is the assertion that fails if the error is allowed to escape.** The
    // whole point of swallowing is that one bad handler does not become a dead event
    // loop; an implementation that reported the error and gave up would still pass
    // "onError was called".
    const onError = vi.fn();
    const w = new WorkerAgnostic(() => new ListenerWorker(), { onError });
    const good = vi.fn();
    const alsoGood = vi.fn();

    w.addEventListener('message', () => {
      throw new Error('first is bad');
    });
    w.addEventListener('message', good);
    w.addEventListener('message', () => {
      throw new Error('second is bad');
    });
    w.addEventListener('message', alsoGood);

    w.worker.dispatchEvent(new MessageEvent('message', { n: 1 }));

    expect(good).toHaveBeenCalledTimes(1);
    expect(alsoGood).toHaveBeenCalledTimes(1);
    // Both failures reported — one per throwing handler, not one per event.
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('says which event and which handler threw', () => {
    // "A listener threw" is not actionable when a caller registered four of them.
    const onError = vi.fn();
    const w = new WorkerAgnostic(() => new ListenerWorker(), { onError });
    const handler = () => {
      throw new Error('boom');
    };
    w.addEventListener('message', handler);
    w.worker.dispatchEvent(new MessageEvent('message', { n: 1 }));

    const context = onError.mock.calls[0][1];
    expect(context.type).toBe('message');
    expect(context.listener).toBe(handler);
  });

  it('does not let a throwing onError escape', () => {
    // An error handler that throws would turn a swallowed listener error into an
    // uncaught one — the exact failure the mechanism exists to prevent. The guard is
    // the feature, which is why `PowerScheduler._notifyError` has the same one.
    const w = new WorkerAgnostic(() => new ListenerWorker(), {
      onError: () => {
        throw new Error('the error handler is worse than the error');
      },
    });
    w.addEventListener('message', () => {
      throw new Error('listener');
    });
    expect(() => w.worker.dispatchEvent(new MessageEvent('message', { n: 1 }))).not.toThrow();
  });

  it('is silent when no onError is configured', () => {
    // The default must stay free. A class that allocated an error-capturing closure
    // per listener to hand to nobody would be paying for a feature nobody asked for.
    const w = new WorkerAgnostic(() => new ListenerWorker());
    w.addEventListener('message', () => {
      throw new Error('nobody is listening');
    });
    expect(() => w.worker.dispatchEvent(new MessageEvent('message', { n: 1 }))).not.toThrow();
  });
});
