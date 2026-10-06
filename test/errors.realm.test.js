import { describe, it, expect, beforeAll } from 'vitest';
import vm from 'node:vm';
import {
  simpleArgsKey,
  PowerCron,
  MetricsCollector,
  PowerPool,
  preloadNode,
} from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/**
 * WRK-007: every `instanceof Error` narrowing in the library, and the four that
 * were left behind.
 *
 * `src/utils/errors.js` states the rule in its own comment — `instanceof`
 * compares against *this realm's* `Error.prototype`, so it is false for an error
 * from another `vm` context, realm or iframe, and "the failure mode is a
 * *substitute* rather than a diagnostic". `powerBulkhead` and `powerLogger` were
 * both converted for that reason; `powerLogger`'s comment even records that the
 * premise about *it* was false and was disproved with a `vm`-created `TypeError`
 * before any edit was made.
 *
 * These tests use `node:vm` to build a genuine second realm. A hand-rolled
 * `{name, message}` stand-in would pass `instanceof` failures for the wrong
 * reason and prove nothing: the whole defect is that the value is a real `Error`
 * that this realm's `instanceof` rejects.
 *
 * **The cross-realm assertions below are gated on `HAS_IS_ERROR`, and the gate is
 * load-bearing rather than decorative.** `errors.js` probes `Error.isError` once
 * at module load and falls back to `instanceof` when the platform lacks it, and
 * on that floor `instanceof` *is* the realm-unsafe behaviour these tests exist to
 * catch — so an ungated cross-realm assertion fails there, and the file's own
 * opening claim that "these pass on the `instanceof` fallback too" was false and
 * is corrected here. The fix is realm-safety, not a raised floor: on a runtime
 * without the brand check the shipped answer inherits `instanceof`'s blind spot,
 * and these rows record that rather than assert it away. `powerLogger.isError`
 * uses the identical gate for the identical reason.
 */
let realm;
/** A real `Error` from another realm: same shape, different prototype. */
const foreign = (src) => vm.runInContext(src, realm);

/** Whether this runtime actually has `Error.isError` (see `powerLogger.isError`). */
const HAS_IS_ERROR = typeof Error.isError === 'function';

beforeAll(() => {
  realm = vm.createContext({});
});

describe('WRK-007: a cross-realm Error is still an Error', () => {
  it('the fixture really is cross-realm, or these tests prove nothing', () => {
    const err = foreign('new TypeError("boom")');
    // The two halves of the defect. If either stopped being true the suite below
    // would be passing for a reason unrelated to the fix.
    expect(err instanceof Error, 'must FAIL instanceof in this realm').toBe(false);
    expect(typeof err.message).toBe('string');
    // And it must still be a genuine Error, not a look-alike object.
    expect(Object.getPrototypeOf(err).constructor.name).toBe('TypeError');
  });

  it('reports whether the runtime has the brand check, without depending on it', () => {
    // Recorded rather than assumed: `errors.js` probes `Error.isError` once at
    // load, so the sites below take a different path on this machine than on the
    // declared floor. The assertion is the same on both paths by construction —
    // it is `true` when the method is absent — so it is not the cross-realm
    // claim; that one is gated above, and on a runtime without the brand check
    // the shipped answer is `instanceof`, which is not realm-safe.
    expect(
      typeof Error.isError === 'function' ? Error.isError(foreign('new Error("x")')) : true
    ).toBe(true);
  });
});

describe('WRK-007: simpleArgsKey does not collapse cross-realm errors into one key', () => {
  // **The one site where the defect was not diagnostic.** Every other case
  // substitutes a message; this one builds a *cache key*, so a wrong answer is a
  // wrong value handed back from `get()`.

  it.runIf(HAS_IS_ERROR)('gives two different cross-realm errors two different keys', () => {
    const a = foreign('new TypeError("user A not found")');
    const b = foreign('new RangeError("user B quota exceeded")');

    expect(simpleArgsKey(a)).not.toBe(simpleArgsKey(b));
  });

  it('leaves a cross-realm Error with no enumerable own keys', () => {
    // The mechanism, and the reason the collision was total — and realm-independent,
    // so it is asserted here rather than behind the gate: an `Error`'s `message`
    // and `stack` are own but **non-enumerable**, so `Object.keys` returns `[]`.
    // This holds on every runtime the library supports, including the floor.
    const err = foreign('new TypeError("user A not found")');
    expect(Object.keys(err)).toEqual([]);
  });

  it.runIf(HAS_IS_ERROR)('does not collapse a cross-realm error to the empty object key', () => {
    // Without the brand check the cross-realm error reached the plain-object
    // branch and produced `O:{}` — one key for the whole realm. On a runtime
    // without `Error.isError` there is no realm-safe answer, which is what the
    // gate records rather than asserts away.
    const err = foreign('new TypeError("user A not found")');
    expect(simpleArgsKey(err)).not.toBe('O:{}');
  });

  it.runIf(HAS_IS_ERROR)('keys a cross-realm error exactly as its local twin', () => {
    // The correct semantics: it *is* the same error. Before the fix this was also
    // `false`, so a cross-realm argument silently missed a populated entry.
    expect(simpleArgsKey(foreign('new TypeError("same")'))).toBe(
      simpleArgsKey(new TypeError('same'))
    );
  });

  it('still refuses symbols and functions', () => {
    // The neighbouring guards, so the branch change did not soften them.
    expect(() => simpleArgsKey(Symbol('s'))).toThrow(TypeError);
    expect(() => simpleArgsKey(() => {})).toThrow(TypeError);
  });
});

describe('WRK-007: onError receives the caller’s error, not a substitute', () => {
  it.runIf(HAS_IS_ERROR)('passes a cross-realm error through PowerCron unchanged', () => {
    // The `powerBulkhead` case verbatim: `new Error(String(err))` stringifies to
    // `"TypeError: …"`, **discards `err.code`**, and hands `onError` an error
    // about the substitute rather than the failure.
    const err = foreign('new TypeError("cron entry blew up")');
    err.code = 'E_CRON';

    let seen = null;
    // `onError` is a constructor option, not a settable property — assigning it
    // left `_onError` null and the error went to the fallback log instead.
    const cron = new PowerCron(() => {}, {
      onError: (e) => {
        seen = e;
      },
    });
    cron._report(err, 'test');

    expect(seen).toBe(err);
    expect(seen.code, 'the caller’s code survives').toBe('E_CRON');
    expect(String(seen.message)).toBe('cron entry blew up');
  });
});

describe('WRK-007: an exported series error is the message, not a stringified copy', () => {
  it.runIf(HAS_IS_ERROR)('names the failure rather than its class', () => {
    const metrics = new MetricsCollector();
    const err = foreign('new RangeError("queue depth probe failed")');
    metrics.register('queue', () => {
      throw err;
    });

    const exported = JSON.parse(JSON.stringify(metrics.snapshot()));
    // Before the fix this read `"RangeError: queue depth probe failed"` — the
    // class name leaking into a field that is supposed to be the message.
    expect(exported.errors.queue).toBe('queue depth probe failed');
  });
});

describe('WRK-007: a framing warning quotes the message, not the class', () => {
  it.runIf(HAS_IS_ERROR)('drops the class prefix from the unframed-post warning', () => {
    // `PowerPool._prepareForTransfer` catches a framing failure and warns with
    // `err.message`, so the realm of the *cause* is what decides the answer. A
    // `BigInt` only makes `JSON.stringify` throw a **local** `TypeError`, which
    // `instanceof` accepts — so that would pass with or without the fix and pin
    // nothing. The reachable way to make the encoder throw a **cross-realm**
    // error is a payload whose `toJSON` throws one: `JSON.stringify` calls
    // `toJSON` and propagates whatever it throws.
    const warnings = [];
    const pool = new PowerPool(() => makeFakeWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    pool._logger = { ...pool._logger, warn: (m) => warnings.push(String(m)) };

    try {
      const cause = foreign('new RangeError("payload serializer exploded")');
      const out = pool._prepareForTransfer(
        {
          toJSON() {
            throw cause;
          },
        },
        undefined
      );

      expect(out, 'the message still went out unframed').toBeTruthy();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('payload serializer exploded');
      // Before the fix this read `"RangeError: payload serializer exploded"` —
      // the class name leaking into a field that is supposed to be the message.
      expect(warnings[0]).not.toContain('RangeError:');
    } finally {
      pool.shutdown();
    }
  });

  it('does not warn at all in legacy mode', () => {
    // The row's other half: `'legacy'` promises no envelope, so a framing failure
    // is not a broken promise and must stay quiet.
    const warnings = [];
    const pool = new PowerPool(() => makeFakeWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
      messageCodec: 'legacy',
    });
    pool._logger = { ...pool._logger, warn: (m) => warnings.push(String(m)) };

    try {
      pool._prepareForTransfer({ big: 1n }, undefined);
      expect(warnings).toEqual([]);
    } finally {
      pool.shutdown();
    }
  });
});

function makeFakeWorker() {
  return { onmessage: null, onerror: null, postMessage() {}, terminate() {} };
}
