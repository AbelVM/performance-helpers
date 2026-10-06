/**
 * Cross-realm error detection - GAP-012.
 *
 * ## What these tests are actually for
 *
 * The row that produced this file asserted a mechanism and named the wrong
 * helper. It said "`instanceof Error` is false for an Error from a worker or
 * `vm` realm" and that "`Error.isError()`" fixes it, primarily in `powerLogger`.
 * Both halves were checked before any edit, and one is false:
 *
 * 1. **A `Worker` is not a separate realm for this purpose.** A
 *    `worker_threads` error arrives at the parent through the structured clone
 *    algorithm, which reconstructs it against the *parent's* intrinsics.
 *    Measured: `m instanceof Error` is `true` for an error posted from a
 *    worker. `Error.isError()` agrees. There is nothing for the change to fix
 *    there.
 * 2. **`powerLogger.error()` was never realm-fragile.** Its clause read
 *    `a instanceof Error || (a && typeof a === 'object')`, and the second half
 *    already caught a cross-realm error (`typeof` is `'object'`), after which
 *    `normalizeError` reads only `.code` / `.message` / `.stack` - all of which
 *    a cross-realm error has. The test `a vm-realm TypeError and a local one
 *    produce byte-identical payloads` is the proof, and it passes against the
 *    *pre-change* code.
 *
 *    **Updated by OBS-004: the `|| typeof a === 'object'` fallback is now
 *    gone.** This header previously said that test was kept because it "keeps
 *    `powerLogger` realm-safe if the fallback is ever simplified away", which
 *    would be a real regression. That is no longer the mechanism, and the claim
 *    had become wrong the moment the clause was removed. It is safe because
 *    `isError()` is a **brand** check rather than a prototype check, so a
 *    cross-realm `Error` fails `instanceof` and passes `isError()`. The test is
 *    kept for the assertion itself, and it is what now proves *that* — so it is
 *    stronger than the fallback was, not merely still passing.
 *
 *    What the fallback actually cost: every plain object went through
 *    `normalizeError` and was flattened to a string, discarding its `stack`.
 *    See the last two tests for the deliberate change.
 *
 * The defect that *is* real is in `abortReason()` (`utils/abort.js`), and it is
 * the serious one because the failure mode is a **substitute**: a caller who
 * aborts with their own cross-realm `TypeError` had it silently replaced by a
 * generic `AbortError` with a message they never wrote. That is the test at the
 * bottom of this file, and it fails against the pre-change code.
 *
 * ## Why this file is named for the logger
 *
 * The behavioural fix is in `utils/abort.js`, not in the logger. The file is
 * named `powerLogger.*` because the logger is the helper the row named, and
 * because it keeps the shared-helper contract and its one real consumer in a
 * single readable place. The shared helper itself is exported from
 * `utils/errors.js` and has no public entry point, so `apiSurface.test.js` is
 * untouched by it.
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { isError } from '../src/utils/errors.js';
import { abortReason } from '../src/utils/abort.js';
import { PowerLogger } from '../src/helpers/powerLogger.js';

/**
 * Whether this runtime actually has `Error.isError`. It is absent on the
 * library's declared floor (`engines.node` is `>=22.12.0`, V8 12.4) and CI runs
 * 22.12, so a test that asserted the cross-realm fix unconditionally would pass
 * on 24 and fail on the floor.
 *
 * Every cross-realm assertion below is gated on this, and `pins the feature
 * detect against the runtime rather than assuming it` asserts that the gate is
 * telling the truth - so if a future Node gains the method, the gated tests
 * start running instead of silently staying inert.
 */
const HAS_IS_ERROR = typeof Error.isError === 'function';

/** An Error constructed inside a separate `vm` context - a different realm. */
function foreignError(ctor = 'TypeError', message = 'from another realm') {
  return vm.runInContext(`new ${ctor}(${JSON.stringify(message)})`, vm.createContext({}));
}

describe('isError() - the shared cross-realm check', () => {
  it('agrees with instanceof for every same-realm Error', () => {
    class Custom extends Error {}
    for (const err of [new Error('e'), new TypeError('t'), new RangeError('r'), new Custom('c')]) {
      expect(isError(err)).toBe(true);
      expect(isError(err)).toBe(err instanceof Error);
    }
  });

  it('rejects every non-Error value, including Error-shaped lookalikes', () => {
    // A cross-realm test that only checked "instanceof says false, isError says
    // true" would pass against a function that returned `true` for everything.
    // These are the values that must not move.
    for (const v of [
      null,
      undefined,
      0,
      17,
      '',
      'Error',
      true,
      false,
      Symbol('s'),
      {},
      [],
      () => {},
    ]) {
      expect(isError(v)).toBe(false);
    }
    // `{}` with every Error-ish field set is still not an Error: this is the
    // case a duck-typed `isError` implementation gets wrong.
    expect(isError({ name: 'TypeError', message: 'x', stack: 'y' })).toBe(false);
  });

  it('does not throw on a primitive or a null-prototype object', () => {
    expect(isError(Object.create(null))).toBe(false);
    expect(isError(Symbol.iterator)).toBe(false);
  });

  it.runIf(HAS_IS_ERROR)('recognises an Error from another vm realm', () => {
    const foreign = foreignError();
    // The premise, asserted rather than assumed. If this ever stops holding,
    // the whole reason this helper exists is gone and the row is stale.
    expect(foreign instanceof Error).toBe(false);
    expect(isError(foreign)).toBe(true);
  });

  it.runIf(HAS_IS_ERROR)('recognises a *subclass* from another realm, not just the base', () => {
    const foreign = vm.runInContext(
      'class Remote extends TypeError {}; new Remote("sub")',
      vm.createContext({})
    );
    expect(foreign instanceof Error).toBe(false);
    expect(isError(foreign)).toBe(true);
    // The subclass has no own `name`, so `foreign.name` resolves to
    // `TypeError.prototype.name` through the prototype chain. The observable
    // proof that this is the *foreign* subclass is the constructor identity,
    // not the name - which is the whole point of the row: the constructor is
    // exactly what `instanceof` failed on.
    expect(Object.getPrototypeOf(foreign).constructor.name).toBe('Remote');
    expect(foreign.constructor).not.toBe(Error);
    expect(foreign.message).toBe('sub');
  });

  it.runIf(HAS_IS_ERROR)('rejects an object that only borrows Error.prototype', () => {
    // The other direction: `instanceof` is true here and `isError` is false,
    // because the brand check looks at the [[ErrorData]] slot rather than the
    // prototype chain. Pinned so nobody "simplifies" it back to instanceof.
    const impostor = Object.create(Error.prototype);
    expect(impostor instanceof Error).toBe(true);
    expect(isError(impostor)).toBe(false);
  });

  it.runIf(HAS_IS_ERROR)(
    'accepts a DOMException, which is branded but not an Error subclass',
    () => {
      // `abortReason` falls through to a DOMException on every abort, so this is
      // load-bearing rather than an exotic case.
      expect(isError(new DOMException('nope', 'AbortError'))).toBe(true);
    }
  );

  it('pins the feature detect against the runtime rather than assuming it', () => {
    // Two assertions that sound circular and are not. The first says the gate
    // used to skip the tests above is reading the real capability; the second
    // says the shipped answer on a runtime WITHOUT the method is the pre-change
    // `instanceof` behaviour, which is what makes this a strict improvement
    // rather than a raised floor.
    expect(HAS_IS_ERROR).toBe(typeof Error.isError === 'function');
    if (!HAS_IS_ERROR) {
      expect(isError(new Error('e'))).toBe(true);
      expect(isError({})).toBe(false);
      // And the documented residual: without the platform method there is no
      // cross-realm answer, so this helper inherits instanceof's blind spot.
      expect(isError(foreignError())).toBe(false);
    }
  });
});

describe('abortReason() - the real cross-realm defect', () => {
  it('returns the caller-s own error when they abort with a local one', () => {
    const c = new AbortController();
    const mine = new TypeError('mine');
    c.abort(mine);
    expect(abortReason(c.signal)).toBe(mine);
  });

  it('falls back to a named AbortError when there is no reason', () => {
    const c = new AbortController();
    c.abort();
    const reason = abortReason(c.signal);
    expect(reason.name).toBe('AbortError');
  });

  it.runIf(HAS_IS_ERROR)(
    "returns the caller's cross-realm error instead of silently replacing it",
    () => {
      const c = new AbortController();
      const mine = foreignError('TypeError', 'I aborted for my own reasons');
      c.abort(mine);
      const reason = abortReason(c.signal);

      // Identity, not shape: the pre-change code returned a *different* object
      // with the right-looking name, so a shape assertion would have passed.
      // The defect was precisely that the caller's error was thrown away.
      expect(reason).toBe(mine);
      expect(reason.message).toBe('I aborted for my own reasons');

      // And the observable symptom from the guide's point of view: before the
      // fix this read 'AbortError' / 'The operation was aborted'.
      expect(reason.name).toBe('TypeError');
    }
  );

  it.runIf(HAS_IS_ERROR)('rejects a promise with the cross-realm reason, end to end', async () => {
    // The same defect observed through the public surface rather than through
    // the internal helper, because the helper returning the right object and
    // the promise rejecting with something else would both be plausible.
    const { raceWithAbort } = await import('../src/utils/abort.js');
    const c = new AbortController();
    const mine = foreignError('RangeError', 'cross-realm rejection');
    c.abort(mine);
    await expect(raceWithAbort(new Promise(() => {}), c.signal)).rejects.toBe(mine);
  });
});

describe('powerLogger.error() - realm-safe, and pinned as such', () => {
  /** Captures what the logger hands to an output sink. */
  function capturingLogger() {
    const seen = [];
    const log = new PowerLogger({ level: 1, output: (p) => seen.push(p) });
    return { log, seen };
  }

  it.runIf(HAS_IS_ERROR)('formats a cross-realm Error identically to a local one', () => {
    const { log, seen } = capturingLogger();
    log.error(foreignError('TypeError', 'same message'));
    log.error(new TypeError('same message'));

    // `ts` is a clock read and is excluded for that reason alone. Everything
    // else must match exactly.
    //
    // Two things are true about this assertion and both are deliberate:
    //
    // It passes against the *pre-change* code. The old clause was
    // `a instanceof Error || (a && typeof a === 'object')`, and the second
    // half already covered the realm case - which is how the row's claim that
    // the logger was realm-fragile was falsified.
    //
    // And it now passes *through* `isError()` rather than the fallback, so the
    // fallback's realm role is genuinely redundant post-change. What it still
    // governs is plain objects, pinned by the next test. Removing it is
    // therefore a behaviour change worth a decision, not a silent cleanup -
    // which is exactly what mutation-check M3 (dropping the fallback) shows:
    // it fails this file's sibling test, and it would not have failed this one.
    const strip = (p) => JSON.stringify(p, (k, v) => (k === 'ts' ? 0 : v));
    expect(strip(seen[0])).toBe(strip(seen[1]));
    expect(seen[0].msg).toBe('ERR_ITEM: same message');
  });

  it('leaves primitives alone and passes plain objects through as objects', () => {
    // The guard above would also pass if `error()` formatted *everything*
    // identically, so this pins the actual split.
    //
    // **This expectation is the second half of OBS-004, and it is a deliberate
    // behaviour change rather than a cleanup.** The clause used to be
    // `isError(a) || (a && typeof a === 'object')`, so every plain object went
    // through `normalizeError` and came out as a string — `{ plain: true }` as
    // the fixed `'ERR_ITEM: '`. This file previously pinned that as a
    // "pre-existing quirk", explicitly deferred because "fixing it is a behaviour
    // change outside this row's scope". OBS-004 is that scope, so the quirk is
    // now gone and the objects survive.
    //
    // Realm safety is not what was lost: `isError()` is a brand check, not a
    // prototype check, so a cross-realm `Error` still passes it — pinned by the
    // `vm` test above rather than by this one.
    const { log, seen } = capturingLogger();
    log.error('a string', 42, null, undefined, { plain: true }, [1, 2]);
    expect(seen[0].msg).toEqual(['a string', 42, null, undefined, { plain: true }, [1, 2]]);
  });

  it('keeps the fields and stack of a plain error-shaped object', () => {
    // The concrete loss the row describes: `normalizeError` copies `.stack` into
    // the normalised object and then `formatErrorObj` renders a string from it, so
    // the structured `stack` never reached the sink. A sink is the one consumer
    // that can act on it — group by `code`, filter by `stack` — and it is now
    // reachable.
    const { log, seen } = capturingLogger();
    const shaped = { code: 'EPLAIN', message: 'plain object', stack: 'STACKLINE' };
    log.error(shaped);

    expect(seen[0].msg, 'the object, not "EPLAIN: plain object"').toEqual(shaped);
    expect(seen[0].msg.stack, 'the stack survived').toBe('STACKLINE');
  });
});
