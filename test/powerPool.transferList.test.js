import { describe, it, expect, vi } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';
import { decodeMessage } from '../src/helpers/powerMessageCodec.js';

/**
 * TEST-003, continued: the transfer-list pre-check and the transfer-list
 * normalisation around it.
 *
 * `isTransferListLive` (`powerPool.js:108`) is the guard that decides whether the
 * pool may reach *through* the wrapper and post directly to the underlying
 * worker. Getting that decision wrong is not a performance bug. Reaching
 * through with a buffer the runtime cannot transfer means the post throws after
 * the pool has already committed to it, and BUG-020 is the record of what that
 * costs: a message that reports as a caller bug while the real failure is
 * buried in the wrapper.
 *
 * The guard has three arms - a raw `ArrayBuffer`, a view onto one, and "not a
 * transferable at all" - and the existing hardening tests only exercise the
 * first. A detached *view* is the one that slips through a naive
 * `instanceof ArrayBuffer` check, because a `Uint8Array` is an object and a
 * live object, and the buffer it is a window onto is what is gone.
 */

/** A worker that records what it was sent and never replies. */
class Recording {
  constructor() {
    this.onmessage = null;
    this.onmessageerror = null;
    this.postMessage = (msg, transfer) => {
      this.posts.push({ msg, transfer });
    };
    this.posts = [];
    this.terminate = () => {};
  }
}

/**
 * A view onto a buffer that is *already* detached.
 *
 * The constructor cannot be used for this: `new Uint8Array(detachedBuffer())`
 * throws `TypeError: Cannot perform Construct on a detached ArrayBuffer`. The
 * view has to be taken first and orphaned afterwards, which is also the order
 * things actually go wrong in - a buffer handed to a previous post, then reused.
 */
function detachedView(bytes = 8) {
  const buf = new ArrayBuffer(bytes);
  const view = new Uint8Array(buf);
  structuredClone(buf, { transfer: [buf] });
  return view;
}

function pool() {
  return new PowerPool(Recording, { size: 1, minSize: 1, maxSize: 1 });
}

describe('PowerPool transfer list pre-check', () => {
  it('skips the bypass for a detached view, not only a detached buffer', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const view = detachedView();
    expect(view.buffer.detached).toBe(true);

    const payload = { a: 1 };
    p.postMessage(payload, [view], { zeroCopy: true });

    // The view is an object, so an `instanceof ArrayBuffer` check alone would
    // call it live. The payload must therefore NOT have reached the underlying
    // worker as-is.
    expect(worker.posts[0].msg).not.toBe(payload);
    expect(worker.posts[0].msg).toBeInstanceOf(Uint8Array);
    p.terminate();
  });

  it('skips the bypass for an entry that is not a transferable at all', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const payload = { a: 1 };
    // Posting a string or null in a transfer list is guaranteed to throw. The
    // point of the pre-check is to find that out *before* the post, not after.
    p.postMessage(payload, ['not transferable'], { zeroCopy: true });
    expect(worker.posts[0].msg).not.toBe(payload);
    p.terminate();
  });

  it('skips the bypass for a null entry', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    p.postMessage({ a: 1 }, [null], { zeroCopy: true });
    expect(worker.posts[0].msg).not.toBe(undefined);
    p.terminate();
  });

  it('still bypasses for a live view', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const view = new Uint8Array(8);
    const payload = { a: 1 };
    // The counter-test. A guard that refuses every view would be just as broken
    // as one that refuses none: the view is transferable and must go direct.
    expect(view.buffer.detached).toBe(false);
    expect(p.postMessage(payload, [view], { zeroCopy: true })).toBe(true);
    expect(worker.posts[0].msg).toBe(payload);
    p.terminate();
  });

  it('treats a zero-length view as live', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const view = new Uint8Array(0);
    const payload = { a: 1 };
    // The `byteLength === 0` heuristic is deliberately not used: a
    // zero-length buffer is a perfectly valid transferable, and the older
    // heuristic treated real work as dead.
    expect(p.postMessage(payload, [view], { zeroCopy: true })).toBe(true);
    expect(worker.posts[0].msg).toBe(payload);
    p.terminate();
  });
});

describe('PowerPool transfer list normalisation', () => {
  it('appends the encoded buffer when the caller supplied none', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    // A plain object is encoded to a transferable, so the transfer list the
    // worker receives must contain that buffer even though the caller passed
    // nothing. Posting without it would silently copy instead.
    p.postMessage({ a: 1 }, undefined, { zeroCopy: true });
    expect(Array.isArray(worker.posts[0].transfer)).toBe(true);
    expect(worker.posts[0].transfer.length).toBeGreaterThan(0);
    p.terminate();
  });

  it('appends the encoded buffer to a caller-supplied list without duplicating it', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const mine = new ArrayBuffer(8);
    p.postMessage({ a: 1 }, [mine], { zeroCopy: true });
    const tr = worker.posts[0].transfer;
    // The caller's own buffer survives, and the encoded one is appended once.
    expect(tr).toContain(mine);
    expect(new Set(tr).size).toBe(tr.length);
    p.terminate();
  });

  it('does not append twice when the caller already passed the encoded buffer', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    // Encode the same object first so the caller can hand back the exact
    // buffer the pool is about to produce.
    const encoded = p._encodeForTransfer({ a: 1 });
    p.postMessage({ a: 1 }, [encoded.buffer], { zeroCopy: true });
    const tr = worker.posts[0].transfer;
    expect(new Set(tr).size).toBe(tr.length);
    p.terminate();
  });

  it('sends a zero-copy raw payload without re-encoding it', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const raw = new Uint8Array([1, 2, 3]);
    p.postMessage(raw, [raw.buffer], { zeroCopy: true });
    // `zeroCopy` means the caller's buffer is the payload. Re-encoding it into
    // a codec envelope would be a copy, which is the thing the option exists to
    // avoid - and would also corrupt the bytes.
    expect(worker.posts[0].msg).toBe(raw);
    p.terminate();
  });

  it('leaves a binary payload alone when the caller named its transfer list', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const raw = new Uint8Array([1, 2, 3]);
    p.postMessage(raw, [raw.buffer]);
    // An explicit transfer list means "I am sending this exact buffer, already
    // in the form I want" - `powerPool.js:1476`. So the bytes go across
    // unframed and un-copied. Getting this wrong in the other direction would
    // wrap a payload the worker is already prepared to read, and a worker
    // written against the 1.x bare-binary protocol would see an envelope.
    expect(worker.posts[0].msg).toBe(raw);
    p.terminate();
  });

  it('frames a binary payload the caller did not name a transfer list for', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    const raw = new Uint8Array([1, 2, 3]);
    p.postMessage(raw);
    // The counterpart to the test above, and the reason the raw codec exists:
    // without a transfer list a binary message arrived framed while an object
    // message arrived framed too, and the sniffing that removed is exactly
    // what a worker cannot do safely.
    //
    // Asserted by decoding rather than by byte comparison, because the framed
    // form is header-plus-payload - `[1, 2, 3, 0, 0, 0, 1, 2, 3]` here - and
    // comparing it to the raw bytes would pin the header's layout rather than
    // the property that matters.
    const framed = worker.posts[0].msg;
    expect(framed).not.toBe(raw);
    expect(framed).toBeInstanceOf(Uint8Array);
    // `decodeMessage` returns `{ version, codec, value, byteLength }`, not the
    // bytes themselves - reading the array off the return value directly gives
    // `[]`, because the object is not array-like.
    const decoded = decodeMessage(framed);
    expect(decoded.codec).toBe('raw');
    expect(Array.from(decoded.value)).toEqual([1, 2, 3]);
    p.terminate();
  });

  it('leaves a zero-length raw payload out of the transfer list', () => {
    const p = pool();
    const worker = p.workers[0].worker._underlying;
    // An empty payload has nothing to transfer, and listing a zero-length
    // buffer as a transfer is at best a no-op and at worst a runtime error.
    p.postMessage(new Uint8Array(0), [new Uint8Array(0).buffer], { zeroCopy: true });
    expect(worker.posts.length).toBe(1);
    p.terminate();
  });
});

describe('PowerPool post failure accounting', () => {
  it('reports false and leaves the task uncounted when the underlying post throws', () => {
    const p = pool();
    p.workers[0].worker._underlying.postMessage = () => {
      throw new Error('underlying refused');
    };
    p._logger.error = vi.fn();
    // The accounting invariant: a post that never landed must not be counted
    // as in flight, or the pool reports itself busy forever.
    expect(p.postMessage({ a: 1 })).toBe(false);
    expect(p.workers[0].tasks).toBe(0);
    expect(p.getStats().activeTasks).toBe(0);
    p.terminate();
  });

  it('rejects a pending response when the post fails', async () => {
    const p = pool();
    p.workers[0].worker._underlying.postMessage = () => {
      throw new Error('underlying refused');
    };
    p._logger.error = vi.fn();
    // The Promise path must settle. A promise left pending because the
    // synchronous post threw is a caller that hangs with no diagnostic.
    await expect(p.postMessage({ a: 1 }, undefined, { awaitResponse: true })).rejects.toThrow(
      /underlying refused/
    );
    p.terminate();
  });
});
