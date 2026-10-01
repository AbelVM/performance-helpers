import { describe, it, expect } from 'vitest';
import { PowerSemaphore } from '../src/helpers/powerSemaphore.js';
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';

describe('PowerSemaphore', () => {
  it('acquires immediately when permits are available', async () => {
    const sem = new PowerSemaphore(2);
    const release = await sem.acquire();
    expect(typeof release).toBe('function');
    expect(sem.active).toBe(1);
    expect(sem.available).toBe(1);
    release();
    expect(sem.active).toBe(0);
  });

  it('queues acquire requests when limit is reached', async () => {
    const sem = new PowerSemaphore(1);
    const first = await sem.acquire();
    const pending = sem.acquire();
    expect(sem.pending).toBe(1);
    let released = false;
    const promise = pending.then((release) => {
      released = true;
      release();
    });

    expect(released).toBe(false);
    first();
    await promise;
    expect(sem.pending).toBe(0);
    expect(released).toBe(true);
  });

  it('tryAcquire returns null when no permit is available', () => {
    const sem = new PowerSemaphore(1);
    const release = sem.tryAcquire();
    expect(typeof release).toBe('function');
    expect(sem.tryAcquire()).toBeNull();
    release();
    expect(sem.tryAcquire()).not.toBeNull();
  });

  it('run serializes work to the concurrency limit', async () => {
    const sem = new PowerSemaphore(2);
    const results = [];

    const task = async (name, delayMs) => {
      await sem.run(async () => {
        results.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        results.push(`${name}-end`);
      });
    };

    const a = task('a', 30);
    const b = task('b', 30);
    const c = task('c', 10);

    await Promise.all([a, b, c]);
    expect(results[0]).toBe('a-start');
    expect(results[1]).toBe('b-start');
    expect(results).toContain('c-start');
    expect(results).toContain('c-end');
    expect(results.indexOf('c-start')).toBeGreaterThan(results.indexOf('a-end'));
    expect(results.indexOf('c-start')).toBeGreaterThan(results.indexOf('b-start'));
    expect(results.indexOf('b-end')).toBeGreaterThan(results.indexOf('c-start'));
  });

  it('isLocked reflects when the semaphore is fully acquired', async () => {
    const sem = new PowerSemaphore(1);
    expect(sem.isLocked).toBe(false);
    const release = await sem.acquire();
    expect(sem.isLocked).toBe(true);
    release();
    expect(sem.isLocked).toBe(false);
  });

  it('run releases the permit when the callback throws', async () => {
    const sem = new PowerSemaphore(1);

    await expect(
      sem.run(async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(sem.active).toBe(0);
    expect(sem.available).toBe(1);
    expect(sem.isLocked).toBe(false);
  });

  it('reset rejects queued waiters without admitting a second holder', async () => {
    // RES-023. The reset is a teardown, not a licence to over-issue: a `run()`
    // in flight at scope exit is the case that reached it, because
    // `using sem = new PowerSemaphore(1)` disposes while the first `run()` is
    // still awaiting. The old `reset()` set `available` to the limit regardless,
    // so the next `tryAcquire()` succeeded and two tasks ran against a limit of
    // one - permanently, since the first holder's release was absorbed by the
    // capacity clamp.
    const sem = new PowerSemaphore(1);
    const release = await sem.acquire();
    const pending = sem.acquire();

    expect(sem.pending).toBe(1);
    sem.reset();

    await expect(pending).rejects.toThrow();
    expect(sem.pending).toBe(0);
    expect(sem.active).toBe(1);
    expect(sem.available).toBe(0);
    expect(sem.tryAcquire()).toBeNull();

    // The permit returns when the holder that owns it releases.
    release();
    expect(sem.active).toBe(0);
    expect(sem.available).toBe(1);
    const nextRelease = sem.tryAcquire();
    expect(typeof nextRelease).toBe('function');
    nextRelease();
  });

  // QUAL-011. Both of these failed against the previous implementation, which
  // is why they are pinned here rather than left to the probe that found them.
  describe('the class and option names in its own validation errors', () => {
    it('names PowerSemaphore and `limit`, not the gate it delegates to', () => {
      // `PowerSemaphore` is a three-line wrapper whose whole body is
      // `new PowerPermitGate({ capacity: limit })`, so the gate's hardcoded
      // `className: 'PowerPermitGate'` reached the user verbatim. Every one of
      // these errors told a caller who wrote `new PowerSemaphore(...)` to look
      // at a class they never constructed and an option they never typed:
      //
      //   before: PowerPermitGate: `capacity` must be a finite number
      //   after:  PowerSemaphore:   `limit` must be a finite number
      //
      // This is what `assertLimitRequired`'s `className` argument exists for,
      // so the wrapper passing its own vocabulary is the fix rather than
      // deleting the parameter.
      expect(() => new PowerSemaphore(Number.NaN)).toThrow(/^PowerSemaphore: `limit`/);
      expect(() => new PowerSemaphore(0)).toThrow(/^PowerSemaphore: `limit` must be >= 1/);
      expect(() => new PowerSemaphore(-1)).toThrow(/^PowerSemaphore: `limit`/);
      expect(() => new PowerSemaphore(2.5)).toThrow(
        /^PowerSemaphore: `limit` must be a whole number/
      );
    });

    it('still names PowerPermitGate when that is the class constructed', () => {
      // The counterpart, and the reason the label is opt-in rather than
      // universal: the default must not change for direct users of the gate.
      // Asserted because a "fix" that renamed the gate's own errors to
      // `PowerSemaphore` would be a strictly worse lie.
      expect(() => new PowerPermitGate({ capacity: Number.NaN })).toThrow(
        /^PowerPermitGate: `capacity`/
      );
      expect(() => new PowerPermitGate({ capacity: 0 })).toThrow(
        /^PowerPermitGate: `capacity` must be >= 1/
      );
    });

    it('still names the gate for options the wrapper does not expose', () => {
      // `queueCapacity` and `initialTokens` keep the gate's own names on
      // purpose. `PowerSemaphore` exposes neither, so telling a caller to
      // configure `queueCapacity` *on the semaphore* would invent an option
      // that does not exist — the same failure mode in the opposite direction.
      // The gate is where the caller would fix it, so the gate is named.
      // (Asserted via `expect(() => …)`, not by constructing and inspecting:
      // the constructor throws, so there is no object to reach.)
      expect(() => new PowerPermitGate({ capacity: 1, queueCapacity: 0.5 })).toThrow(
        /^PowerPermitGate: `queueCapacity`/
      );
      expect(() => new PowerPermitGate({ capacity: 1, initialTokens: -1 })).toThrow(
        /^PowerPermitGate: `initialTokens`/
      );
    });
  });

  describe('run() honours options', () => {
    it('rejects with AbortError when handed an already-aborted signal', async () => {
      // The defect: `run(fn)` took no second parameter, so the `{ signal }` a
      // caller writes by mirroring `acquire(options)` — which this class does
      // accept — was silently discarded. Worse, it was discarded *quietly*:
      // the promise stayed pending until a permit happened to be released, so
      // an uncancellable request looked exactly like a slow one.
      //
      // Saturation is what makes this fail without the fix: `acquire` checks
      // `signal.aborted` before the fast path, but `run` has to reach
      // `acquire` first, and against a saturated semaphore it never would.
      const sem = new PowerSemaphore(1);
      const release = await sem.acquire();
      const controller = new AbortController();
      controller.abort();

      await expect(sem.run(() => 'never', { signal: controller.signal })).rejects.toThrow(/abort/i);
      release();
    });

    it('leaves no queued waiter behind after aborting', async () => {
      // The leak half. A cancelled wait that still holds a queue slot is the
      // failure `src/utils/abort.js` documents at length, and this is the
      // thinnest possible path to it: `run` is a fresh caller of `acquire`.
      const sem = new PowerSemaphore(1);
      const release = await sem.acquire();
      const controller = new AbortController();
      const promise = sem.run(() => 'never', { signal: controller.signal });
      controller.abort();
      await expect(promise).rejects.toThrow(/abort/i);
      expect(sem.pending).toBe(0);
      release();
      // And the semaphore is still usable afterwards.
      expect(await sem.run(() => 'ok')).toBe('ok');
    });

    it('still runs the callback and releases the permit when given no options', async () => {
      // The other direction: forwarding an argument must not have broken the
      // ordinary path, which is the one every existing caller uses.
      const sem = new PowerSemaphore(1);
      expect(await sem.run(() => 'value')).toBe('value');
      expect(sem.active).toBe(0);
      await expect(
        sem.run(async () => {
          throw new Error('boom');
        })
      ).rejects.toThrow('boom');
      // Released on the rejection path too, or the semaphore leaks a permit.
      expect(sem.active).toBe(0);
    });
  });
});

// QUAL-011 (F13): the queue bound the wrapper's own gate supports is reachable.
describe('the queue bound is reachable through the wrapper', () => {
  it('defaults to unbounded, and says so', () => {
    // Previously neither this nor `isFull` existed on `PowerSemaphore`, so a
    // caller had no way to observe the queue the gate was already keeping.
    expect(new PowerSemaphore(1).queueCapacity).toBe(Infinity);
    expect(new PowerSemaphore(1).isFull).toBe(false);
  });

  it('accepts a bound and reports saturation', async () => {
    const sem = new PowerSemaphore({ limit: 1, queueCapacity: 1 });
    expect(sem.queueCapacity).toBe(1);
    const release = await sem.acquire();
    expect(sem.isFull).toBe(false);
    sem.acquire(); // occupies the single queue slot
    expect(sem.isFull).toBe(true);
    release();
  });

  it('refuses with ERR_QUEUE_FULL once the queue it reports is full', async () => {
    // The point of exposing the bound: a caller can now cap the queue, and the
    // refusal is the code the pool already uses for the same condition.
    const sem = new PowerSemaphore({ limit: 1, queueCapacity: 1 });
    const release = await sem.acquire();
    const queued = sem.acquire();
    await expect(sem.acquire()).rejects.toMatchObject({
      code: 'ERR_QUEUE_FULL',
      queueCapacity: 1,
    });
    release();
    await queued;
  });

  it('rejects an unknown option in the object form rather than ignoring it', () => {
    expect(() => new PowerSemaphore({ limit: 1, nonsense: 1 })).toThrow(
      /unknown option `nonsense`/
    );
  });
});
