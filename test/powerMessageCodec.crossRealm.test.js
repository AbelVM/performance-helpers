/**
 * AUD-011 — the two bare `instanceof` sites in `powerMessageCodec`.
 *
 * `instanceof` compares against *this realm's* prototype, so it is `false` for a
 * value from another `vm` context, an iframe, or a `worker_threads` sandbox. The
 * project's own convention (`AGENTS.md`) is the internal-slot check —
 * `Reflect.get(ArrayBuffer.prototype, 'byteLength', value)` — which is what
 * `powerBuffer.isArrayBuffer` already implements, and `isSharedArrayBuffer` now
 * does for SABs.
 *
 * Both sites are covered here against a **real second realm** rather than a
 * hand-rolled stand-in. A `{ byteLength: n }` object is *accepted* by
 * `new Uint8Array()`, so a stand-in would pass for the wrong reason; a `node:vm`
 * context produces a genuine foreign buffer whose only defect is its realm.
 *
 * @see src/helpers/powerMessageCodec.js
 * @see src/helpers/powerBuffer.js
 */
import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { collectTransferables, frameTransferList } from '../src/index.js';

/** A fresh realm, with its own `ArrayBuffer` and `SharedArrayBuffer`. */
function foreignRealm() {
  const context = vm.createContext({});
  return {
    context,
    arrayBuffer: vm.runInContext('new ArrayBuffer(8)', context),
    sharedArrayBuffer: vm.runInContext('new SharedArrayBuffer(8)', context),
    /** A `Uint8Array` over the foreign SAB, built in that realm. */
    sabView: vm.runInContext('new Uint8Array(new SharedArrayBuffer(8))', context),
  };
}

describe('collectTransferables is realm-independent (AUD-011)', () => {
  it('finds a cross-realm ArrayBuffer instead of copying it', () => {
    // The walk visits **arbitrary user values**, so a foreign buffer missing the
    // `instanceof` was silently *copied* rather than transferred — a performance
    // loss on the one path whose entire job is finding buffers to transfer.
    const { arrayBuffer } = foreignRealm();
    // Sanity: the value really is foreign, so the test is exercising the
    // cross-realm branch and not the same-realm fast path.
    expect(arrayBuffer instanceof ArrayBuffer).toBe(false);

    const found = collectTransferables({ payload: arrayBuffer });

    expect(found).toContain(arrayBuffer);
  });

  it('finds a cross-realm ArrayBuffer nested deeper than one level', () => {
    // The walk is depth-limited to 8 and recurses through object properties, so
    // the fix has to hold at depth, not only at the top of the payload.
    const { arrayBuffer } = foreignRealm();
    const found = collectTransferables({ a: { b: { c: [arrayBuffer] } } });
    expect(found).toContain(arrayBuffer);
  });

  it('still finds a same-realm ArrayBuffer', () => {
    // The fast path is first in `isArrayBuffer`, so the common case is one
    // comparison. Pinned so the realm fix cannot regress the ordinary path.
    const local = new ArrayBuffer(8);
    expect(collectTransferables({ payload: local })).toContain(local);
  });

  it('does not treat a tagged impostor as a buffer', () => {
    // `Object.prototype.toString.call(v) === '[object ArrayBuffer]'` is
    // realm-independent but **spoofable**, and a plain
    // `{ [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 8 }` is accepted by
    // `new Uint8Array()` — so a `toString` check would turn an impostor into
    // silent corruption. The internal-slot check throws for it instead.
    const impostor = { [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 8 };
    expect(collectTransferables({ payload: impostor })).toEqual([]);
  });
});

describe('frameTransferList is realm-independent (AUD-011)', () => {
  it('refuses to transfer a cross-realm SharedArrayBuffer', () => {
    // A SAB is not transferable, so naming one in a transfer list makes
    // `postMessage` throw `DOMException: Found invalid value in transferList`
    // rather than post. The only correct answer is to leave it out and let the
    // frame be copied.
    const { sabView } = foreignRealm();
    expect(sabView.buffer instanceof SharedArrayBuffer).toBe(false);

    expect(frameTransferList(sabView)).toEqual([]);
  });

  it('still refuses to transfer a same-realm SharedArrayBuffer', () => {
    const view = new Uint8Array(new SharedArrayBuffer(8));
    expect(frameTransferList(view)).toEqual([]);
  });

  it('still transfers a same-realm ArrayBuffer that fills its frame', () => {
    const frame = new Uint8Array(8);
    expect(frameTransferList(frame)).toEqual([frame.buffer]);
  });
});
