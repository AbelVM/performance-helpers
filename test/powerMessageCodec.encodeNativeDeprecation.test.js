import { describe, it, expect } from 'vitest';
import {
  encodeNative,
  encodeNativeEnvelope,
  collectTransferables,
  canUseNativeClone,
} from '../src/helpers/powerMessageCodec.js';

/**
 * RT-023: `encodeNative` is deprecated in favour of `encodeNativeEnvelope`.
 *
 * ## What is actually pinned here, and what is not
 *
 * The row's substance is a **cost** claim: `encodeNative` clones the value and
 * hands the clone back, and `postMessage` then clones that again, so the common
 * case pays for two deep copies. The consequence is a guidance fix — the guide
 * steered readers at the slower call — plus one internal cleanup.
 *
 * None of that is asserted by timing here, deliberately. The measurement lives in
 * `guides/powerMessageCodec.md` and in the `@deprecated` tag, and the harness
 * measures a 28 % median min/max spread, so a duration assertion at a ~14x
 * difference would be the one thing in this file that could not fail on a real
 * regression.
 *
 * What a test *can* do is pin the three things a future edit could break silently:
 *
 * 1. **The export still exists.** Deprecated is not removed, and the pool's own use
 *    of it is load-bearing. A future "cleanup" that drops it would break
 *    `PowerPool._encodeNativeForWorker`, so the removal has to be deliberate.
 * 2. **It still clones**, which is the property that makes the deprecation advice
 *    true and the function correct for the transferable case.
 * 3. **Its transfer list matches `collectTransferables`** — the delegation the row
 *    asked for. Two hand-rolled copies of the same walk, only one of them tested,
 *    is the hazard; this is what makes them one.
 */
describe('RT-023: encodeNative is deprecated, not removed', () => {
  it('is still exported and still usable', () => {
    // If this fails, a future edit removed or renamed the call rather than
    // deprecating it, and `PowerPool._encodeNativeForWorker` — which needs a private
    // copy *plus* a transfer list naming that copy's buffers — would break.
    expect(typeof encodeNative).toBe('function');
    expect(canUseNativeClone()).toBe(true);
    expect(() => encodeNative({ a: 1 })).not.toThrow();
  });

  it('still clones, so the returned object shares no memory with the input', () => {
    // The property that makes the deprecation advice *true*. If this ever stopped
    // cloning, `encodeNativeEnvelope` would be strictly better with no caveat at
    // all, and the reason to keep the function would be gone.
    const nested = { deep: { n: 1 } };
    const { message } = encodeNative({ nested });
    expect(message.nested).not.toBe(nested);
    expect(message.nested.deep).not.toBe(nested.deep);
    message.nested.deep.n = 99;
    expect(nested.deep.n).toBe(1);
  });

  it('names the clone’s buffers, not the caller’s', () => {
    // The one case where `encodeNative` remains correct and the envelope is not
    // enough: posting binary without detaching the caller's data needs a private
    // copy *and* a list naming that copy's buffers.
    //
    // `transfer[0]` is the **clone's** buffer, so `not.toBe(caller)` is the assertion
    // that matters — naming the caller's buffer here would detach the caller's data
    // on post, which is a data-loss bug that looks like a successful send.
    const caller = new ArrayBuffer(8);
    const { message, transfer } = encodeNative({ bin: caller });
    expect(message.bin).not.toBe(caller);
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(message.bin);
    expect(transfer[0]).not.toBe(caller);
  });

  it('produces the same transfer list as collectTransferables', () => {
    // The delegation the row asked for. Before it, `encodeNative` carried a private
    // copy of the same walk — correct, but O(n^2) via `Array.includes` where the
    // exported function is O(n) behind a `Set`, and only the exported one was
    // directly tested.
    const value = {
      a: new ArrayBuffer(4),
      view: new Uint8Array(new ArrayBuffer(4)),
      nested: { b: new ArrayBuffer(4) },
    };
    const { message } = encodeNative(value);
    expect(encodeNative(value).transfer).toEqual(collectTransferables(message));
  });

  it('lists one entry per distinct buffer, however many paths reach it', () => {
    // Pins the *shape* of the result rather than the cost. `includes` got this right
    // before the delegation and a `Set` gets it right now, so this is a
    // characterisation: it holds whichever implementation is in place, and it fails
    // if a future rewrite drops the de-duplication entirely.
    const shared = new ArrayBuffer(4);
    const { message, transfer } = encodeNative({ x: shared, y: shared, z: { w: shared } });
    expect(transfer).toHaveLength(1);
    // The clone's copy, reached by three different paths in the input.
    expect(transfer[0]).toBe(message.x);
    expect(transfer[0]).not.toBe(shared);
  });
});

describe('RT-023: the replacement does not clone', () => {
  it('returns the caller’s object by reference, with no copy', () => {
    // The whole reason for the deprecation. `postMessage` clones whatever it is
    // handed, so cloning here would be a second deep copy for no benefit.
    const value = { map: new Map([['k', 1]]), bin: new Uint8Array(8) };
    const envelope = encodeNativeEnvelope(value);
    expect(envelope.value).toBe(value);
    expect(envelope.value.map).toBe(value.map);
  });

  it('still wraps rather than passing the value through bare', () => {
    // It has to be recognisable on the receiving side, and `correlationId` has to be
    // top-level because that is where the pool looks when settling a response.
    const envelope = encodeNativeEnvelope({ n: 1 }, { correlationId: 'c1' });
    expect(envelope.value).toEqual({ n: 1 });
    expect(envelope.correlationId).toBe('c1');
    expect(envelope.kind).toBe('envelope');
  });
});
