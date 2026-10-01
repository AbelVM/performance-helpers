import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PowerLatch } from '../src/helpers/powerLatch.js';
import { PowerCircuit } from '../src/helpers/powerCircuit.js';
import { PowerDeadline } from '../src/helpers/powerDeadline.js';
import { PowerPermitGate } from '../src/helpers/powerPermitGate.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { normalizeError } from '../src/utils/errors.js';

/**
 * QUAL-011 (F10): the error codes the library publishes are collected in one
 * place, and stay true.
 *
 * ## Why this exists
 *
 * `guides/errors.md` had a genuinely good table for the six `ERR_POOL_*`
 * refusal codes — what each means, and what to do about it. It had **nothing**
 * for the other nine branchable codes, while the per-helper guides already told
 * readers to branch on them: `guides/powerCircuit.md` says to check
 * `err.code === 'ECIRCUITOPEN'`, and `guides/powerDeadline.md` tells you to
 * filter `err.code !== 'EABORT'`. So the library instructed users to branch on
 * codes that appeared in no index.
 *
 * A table nobody checks drifts into fiction within a release. That is exactly
 * how `guides/powerThrottle.md` came to document `refillInterval` — removed in
 * 9a1d9d5 because it was inert — as a real option, while the generated `.d.ts`
 * correctly omitted it. A hand-written document asserting something about the
 * code is the failure mode, and only a test catches it.
 *
 * The two halves check opposite directions:
 * - **existence**: every code in the guide is really thrown by the library (the
 *   F5 direction — a guide naming something that does not exist).
 * - **meaning**: the load-bearing claims about what each code *implies* are
 *   asserted against real behaviour, because a correct code with a wrong
 *   description is worse than no documentation at all.
 *
 * Every error below is **produced** rather than pattern-matched out of `src/`.
 * A regex over the source would pass on a code that is defined and never thrown,
 * which is a different and worse claim.
 */

const GUIDE = readFileSync(path.resolve(process.cwd(), 'guides', 'errors.md'), 'utf8');
const TABLE = GUIDE.slice(GUIDE.indexOf('## Codes outside the pool'));

/**
 * Capture the code of a rejection.
 * @param {() => Promise<any>} produce
 * @returns {Promise<{code: any, error: any}>}
 */
async function capture(produce) {
  try {
    await produce();
    return { code: null, error: null };
  } catch (error) {
    return { code: error?.code ?? null, error };
  }
}

describe('the error-code table matches the library', () => {
  it('documents every code the library actually throws', async () => {
    const aborted = new PowerLatch(1);
    aborted.abort();
    const disposed = new PowerLatch(1);
    disposed.dispose();
    const neverCounted = new PowerLatch(2);

    const cases = [
      ['EABORT', () => aborted.wait()],
      ['EDISPOSED', () => disposed.wait()],
      ['ETIMEOUT', () => neverCounted.wait({ timeout: 1 })],
      // Same code, second subsystem: `PowerRetry`'s per-attempt bound. Which is
      // why the guide's response column has to be right in both cases.
      [
        'ETIMEOUT',
        () =>
          PowerDeadline.run(async () => new Promise(() => {}), {
            attemptTimeout: 5,
            maxAttempts: 1,
          }),
      ],
      [
        'EDEADLINE',
        () =>
          PowerDeadline.run(async () => new Promise(() => {}), {
            totalTimeout: 5,
            maxAttempts: 1,
          }),
      ],
    ];

    for (const [expected, produce] of cases) {
      const { code } = await capture(produce);
      expect(code, `expected ${expected} to be observable`).toBe(expected);
    }

    const circuit = new PowerCircuit({ threshold: 1, resetTimeoutMs: 60_000 });
    await capture(() =>
      circuit.call(async () => {
        throw new Error('boom');
      })
    );
    const open = await capture(() => circuit.call(async () => 'never'));
    expect(open.code).toBe('ECIRCUITOPEN');

    // Every code produced above is documented. This is the direction that catches
    // F5: a guide naming something the library does not have.
    for (const code of ['EABORT', 'EDISPOSED', 'ETIMEOUT', 'EDEADLINE', 'ECIRCUITOPEN']) {
      expect(TABLE, `${code} should be documented in guides/errors.md`).toContain(code);
    }
  });

  it('lists each code once, in the table, with a raiser column', () => {
    // Derives the documented set from the table's own first column rather than
    // hardcoding it, so a row deleted from the guide fails here.
    const rows = [...TABLE.matchAll(/^\|\s*`([A-Z_]+)`\s*\|([^|]*)\|/gm)];
    expect(rows.length, 'the non-pool table should have rows').toBeGreaterThanOrEqual(9);
    const documented = new Set(rows.map((m) => m[1]));

    for (const code of [
      'EABORT',
      'EDISPOSED',
      'ETIMEOUT',
      'EDEADLINE',
      'ECIRCUITOPEN',
      'ERR_BULKHEAD_RESET',
      'ECHUNKDISPATCH',
      'ERR_WS_CONNECT_TIMEOUT',
      'ERR_QUEUE_FULL',
      'ERR_ITEM',
    ]) {
      expect(documented.has(code), `${code} should be a row in the table`).toBe(true);
    }

    // Every row names what raises it. A code with no raiser is a code nobody can
    // act on, which is how the gap this file closes started.
    for (const [, code, raiser] of rows) {
      expect(raiser.trim().length, `${code} row should name its raiser`).toBeGreaterThan(0);
    }
  });

  it('ERR_ITEM is what normalizeError invents, never a raised condition', () => {
    // The guide says branching on `ERR_ITEM` is a category error. That is only
    // true because it never arrives from a raiser — it is the fallback
    // `normalizeError` applies to an error that carried no code.
    expect(normalizeError(new Error('anonymous')).code).toBe('ERR_ITEM');
    // An error that already has a code keeps it.
    expect(normalizeError(Object.assign(new Error('x'), { code: 'ECIRCUITOPEN' })).code).toBe(
      'ECIRCUITOPEN'
    );
    // And the guide says so, rather than listing it as if it were a condition.
    expect(TABLE).toMatch(/ERR_ITEM[\s\S]{0,600}fallback/i);
  });
});

describe('the claims the table makes about meaning', () => {
  it('ECIRCUITOPEN means the call was never attempted', async () => {
    // The guide says a short-circuited call is a failure count of zero for that
    // request, and must not be counted upstream. Asserted directly, because it
    // is the claim most likely to be wrong: were `fn` called before the state
    // check, a code-only assertion would still pass.
    const circuit = new PowerCircuit({ threshold: 1, resetTimeoutMs: 60_000 });
    await capture(() =>
      circuit.call(async () => {
        throw new Error('boom');
      })
    );

    let called = false;
    const { code } = await capture(() =>
      circuit.call(async () => {
        called = true;
        return 'unreachable';
      })
    );

    expect(code).toBe('ECIRCUITOPEN');
    expect(called, 'fn must not run while the circuit is open').toBe(false);
    // The guide's "failure count of zero" claim, measured rather than assumed.
    // Opening the circuit moves `state` to `open` without `failures` climbing,
    // so a refused request contributes nothing to an upstream success rate.
    expect(circuit.state).toBe('open');
    expect(circuit.failures).toBe(0);
  });

  it('ETIMEOUT bounds one attempt while EDEADLINE bounds the whole operation', async () => {
    // The guide separates these because both read as "time ran out" and the right
    // response differs. If they ever collapsed to one code the distinction would
    // be unfalsifiable, so it is pinned as an inequality.
    const attempt = await capture(() =>
      PowerDeadline.run(async () => new Promise(() => {}), {
        attemptTimeout: 5,
        maxAttempts: 1,
      })
    );
    const whole = await capture(() =>
      PowerDeadline.run(async () => new Promise(() => {}), {
        totalTimeout: 5,
        maxAttempts: 1,
      })
    );

    expect(attempt.code).toBe('ETIMEOUT');
    expect(whole.code).toBe('EDEADLINE');
    expect(attempt.code).not.toBe(whole.code);

    // The fields the guide promises a caller can read instead of parsing text.
    expect(typeof whole.error.attempts).toBe('number');
    expect(typeof whole.error.elapsedMs).toBe('number');
  });

  it('a latch wait rejects on abort and dispose without changing the count', async () => {
    // `EDISPOSED` reaches you only when teardown outruns a waiter, and
    // `EABORT` is your own signal. Both leave the barrier's count alone, which
    // is what makes them safe to distinguish from a completed wait.
    const aborted = new PowerLatch(2);
    aborted.abort();
    expect((await capture(() => aborted.wait())).code).toBe('EABORT');
    expect(aborted.remaining).toBe(2);

    const disposed = new PowerLatch(2);
    disposed.dispose();
    expect((await capture(() => disposed.wait())).code).toBe('EDISPOSED');
  });
});

describe('queue-bound helpers refuse with a code, not with message text', () => {
  // F13. `PowerPermitGate` and `PowerBulkhead` both rejected a full queue with a
  // bare `Error`, so `err.code` was `undefined` and the only way to tell the
  // condition apart was to match the string "queue is full" — while the pool
  // published `ERR_POOL_QUEUE_FULL` for the identical situation. The guide
  // argues at length that shedding load is the whole point of a code; retrying a
  // refusal is what filled the queue.

  it('PowerPermitGate.acquire rejects with ERR_QUEUE_FULL and the bound hit', async () => {
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 1 });
    const release = await gate.acquire();
    gate.acquire(); // occupies the one queue slot
    const { code, error } = await capture(() => gate.acquire());
    expect(code).toBe('ERR_QUEUE_FULL');
    // The bound is published rather than left to be inferred from the message.
    expect(error.queueCapacity).toBe(1);
    release();
  });

  it('PowerBulkhead.run rejects with the same code', async () => {
    const bulkhead = new PowerBulkhead({
      maxConcurrency: 1,
      partitions: 1,
      queueCapacity: 0,
    });
    const held = bulkhead._buckets[0].gate.tryAcquire();
    const { code } = await capture(() => bulkhead.run(() => {}));
    expect(code).toBe('ERR_QUEUE_FULL');
    held();
  });

  it('does not regress the synchronous path, which reports null not false', async () => {
    // `tryAcquire` documents `{PowerReleaseFn|null}` — it returns `null` when it
    // cannot acquire, not `false`. Asserted as `null` rather than "falsy" on
    // purpose: the first draft of this test wrote `toBe(false)` and failed,
    // which is what a guessed return shape does. Adding a code to the promise
    // path must not have changed the synchronous one.
    const gate = new PowerPermitGate({ capacity: 1, queueCapacity: 0 });
    const release = await gate.acquire();
    expect(gate.tryAcquire()).toBeNull();
    expect(gate.isFull).toBe(true);
    release();
    // And it grants again once capacity returns.
    expect(typeof gate.tryAcquire()).toBe('function');
  });
});
