import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { PowerBulkhead } from '../src/index.js';

/**
 * Whether this runtime actually has the brand check the cross-realm assertions
 * below depend on. `errors.js` probes `Error.isError` once at load and falls
 * back to `instanceof` when the platform lacks it — and on that floor
 * `instanceof` *is* the realm-unsafe behaviour these tests exist to catch, so
 * an ungated cross-realm assertion fails there. The gate is load-bearing, not
 * decorative: it records that the fix is realm-safety, not a raised floor.
 * `powerLogger.isError.test.js` uses the identical gate for the identical
 * reason.
 */
const HAS_IS_ERROR = typeof Error.isError === 'function';

// The one remaining `instanceof Error` in the class, found by the same
// reasoning that closed the `abortReason()` defect in GAP-012 rather than by a
// failing test.
//
// `PowerBulkhead#reset({ reason })` delivered the reason to every queued
// waiter. It decided whether the caller's reason was an Error with
// `options.reason instanceof Error`, so a reason created in **another realm** —
// a `vm` context, an iframe — failed that test and was replaced:
//
//     new Error(options.reason)          -> message "Error: foreign reason"
//     coded.code = 'ERR_BULKHEAD_RESET'   -> the caller's code, gone
//
// A substitution, not a degradation: the queued waiter is told *that* the
// bulkhead reset and never learns *why* the caller said it reset. Same defect
// class as `abortReason()`, one file over.

/**
 * The reason `reset` hands to the partition's gate.
 *
 * Captured by standing in for the gate's own `reset`, rather than by trying to
 * observe a queued waiter. Two earlier versions did the latter and both returned
 * `null`: `run()` decides whether to queue from `gate.available`, so the second
 * call must be issued only after the first settles — and `run`'s rejection path
 * does not necessarily surface the error to its caller. That is two wrong
 * assumptions about a layer above the one under test.
 *
 * What the gate is handed is the whole contract: `PowerBulkhead.reset` chooses
 * the reason, and `PowerPermitGate.reset` rejects waiters with it verbatim.
 *
 * @param {*} reason - What to pass as `reset`'s `reason`.
 * @returns {Promise<*>} The `reason` the gate received.
 */
async function reasonGivenToGate(reason) {
  const bulkhead = new PowerBulkhead({ maxConcurrency: 1 });
  const gate = bulkhead._buckets[0].gate;
  const original = gate.reset.bind(gate);
  let handed = null;
  gate.reset = (opts) => {
    handed = opts.reason;
  };
  try {
    bulkhead.reset({ reason });
  } finally {
    gate.reset = original;
  }
  return handed;
}

describe("PowerBulkhead#reset: the caller's reason reaches the waiter intact", () => {
  it("keeps a same-realm coded reason's code and message", async () => {
    const reason = new Error('maintenance window');
    reason.code = 'MY_CODE';
    const seen = await reasonGivenToGate(reason);
    expect(seen.code).toBe('MY_CODE');
    expect(seen.message).toBe('maintenance window');
  });

  it('a cross-realm error is still not an Error in this realm', () => {
    // The premise, pinned so the claim below cannot pass for the wrong reason:
    // if this were same-realm the test would prove nothing. Realm-independent,
    // so ungated — `instanceof` is false across realms on every runtime.
    const foreign = vm.runInNewContext(
      'const e = new Error("foreign reason"); e.code = "FOREIGN_CODE"; e'
    );
    expect(foreign instanceof Error).toBe(false);
    expect(foreign.code).toBe('FOREIGN_CODE');
  });

  it.runIf(HAS_IS_ERROR)("keeps a cross-realm reason's code and message", async () => {
    // The defect. A `vm`-created error is a perfectly good Error; `instanceof`
    // says otherwise only because it compares against *this* realm's prototype.
    // Gated on the brand check the fix depends on: on a runtime without
    // `Error.isError` the shipped answer inherits `instanceof`'s blind spot and
    // substitutes a stamped error, which is the behaviour this row exists to
    // remove. The premise itself is pinned by the test above.
    const foreign = vm.runInNewContext(
      'const e = new Error("foreign reason"); e.code = "FOREIGN_CODE"; e'
    );
    const seen = await reasonGivenToGate(foreign);
    expect(seen.code).toBe('FOREIGN_CODE');
    expect(seen.message).toBe('foreign reason');
  });

  it('still stamps ERR_BULKHEAD_RESET when the reason carries no code', async () => {
    // The behaviour that must survive the fix, and the one that would be lost
    // if `isError` were used to *accept* rather than to *identify*.
    const seen = await reasonGivenToGate(new Error('no code here'));
    expect(seen.code).toBe('ERR_BULKHEAD_RESET');
    expect(seen.message).toBe('no code here');
  });

  it('accepts a string reason, and still stamps the code', async () => {
    const seen = await reasonGivenToGate('a plain string');
    expect(seen.code).toBe('ERR_BULKHEAD_RESET');
    expect(seen.message).toBe('a plain string');
  });
});
