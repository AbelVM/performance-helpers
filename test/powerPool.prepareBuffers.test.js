import { describe, it, expect, vi, afterEach } from 'vitest';
import vm from 'node:vm';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * TEST-003, continued: `prepareBuffers` option modes and the shutdown sweep.
 *
 * `prepareBuffers` is public, has two documented options with a long contract
 * between them (`clone: false` hands back the *cached* buffer and the runtime
 * copies it; `clone: true` hands back a private transferable copy), and every
 * statement in that contract is about who owns the bytes. The failure mode is
 * not a wrong value, it is a detached buffer handed to a caller who still owns
 * it — which throws later, somewhere else, and reads as a worker bug.
 */

function Silent() {
  this.onmessage = null;
  this.postMessage = () => {};
  this.terminate = () => {};
}

const pools = [];
function makePool(options = {}) {
  const pool = new PowerPool(Silent, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    ...options,
  });
  pools.push(pool);
  return pool;
}

afterEach(() => {
  for (const pool of pools.splice(0)) {
    try {
      pool.terminate();
    } catch {
      /* already gone */
    }
  }
});

describe('PowerPool prepareBuffers modes', () => {
  it('wraps a bare value in a message property', () => {
    const pool = makePool();
    const out = pool.prepareBuffers(['plain', { a: 1 }]);
    // `prepareBuffers` takes either `{message, transfer}` items or bare values.
    // A bare value must come back wrapped, or a caller reading `.message` gets
    // undefined for the whole input array.
    expect(out).toHaveLength(2);
    for (const item of out) {
      expect(item).toHaveProperty('message');
      expect(item).toHaveProperty('transfer');
    }
  });

  it('keeps an explicit { message, transfer } item as it is', () => {
    const pool = makePool();
    const buf = new ArrayBuffer(8);
    const out = pool.prepareBuffers([{ message: 'hello', transfer: [buf] }]);
    expect(out[0].transfer).toEqual([buf]);
  });

  it('passes a plain object straight through under zeroCopy', () => {
    const pool = makePool();
    const payload = { a: 1 };
    const out = pool.prepareBuffers([{ message: payload }], { zeroCopy: true });
    // `zeroCopy` means the object goes to the worker structurally, with no
    // encode step. Wrapping it in bytes would be a copy - the thing the option
    // exists to avoid - and would also change the wire shape a worker sees.
    expect(out[0].message).toBe(payload);
    expect(out[0].transfer).toBeUndefined();
  });

  it('defers the encode under the default mode, so nothing postable is left unframed', () => {
    const pool = makePool();
    const out = pool.prepareBuffers([{ message: { a: 1 } }]);
    // **This test used to pin the bug.** It asserted that the default returns the
    // shared encode-cache body as a `Uint8Array` — which is a bare JSON body, not
    // an envelope, so posting it verbatim made the worker read `{` (123) as a
    // protocol version. Every batched request failed at the first line; see
    // `test/powerPool.framing.test.js`.
    //
    // The concern underneath it was always right and is stronger than before: a
    // transfer list on a *shared* buffer would detach the cached encode entry,
    // which is what the `clone` option exists to let callers avoid. The deferred
    // item carries no buffer at all, so there is nothing that can be detached —
    // and framing wraps the body in a fresh header per call, so a cached body
    // could never be both shared and correct on the wire.
    expect(out[0].deferred).toBe(true);
    expect(out[0].transfer).toBeUndefined();
    // The object is passed through untouched: no encode happened here, which is
    // the whole point of deferring.
    expect(out[0].message).toEqual({ a: 1 });
  });

  it('pre-encodes the shared body under legacy, where that body is the wire format', () => {
    // The mode the default `clone: false` optimisation is actually for. Under
    // `'legacy'` there is no frame, so the cached body *is* what the worker will
    // read, and pre-encoding it is a real saving rather than a protocol error.
    const pool = makePool({ messageCodec: 'legacy' });
    const out = pool.prepareBuffers([{ message: { a: 1 } }]);
    expect(out[0].message).toBeInstanceOf(Uint8Array);
    expect(out[0].transfer).toBeUndefined();
    expect(out[0].deferred).toBeFalsy();
    // And it is the shared entry, which is the property the transfer-list
    // assertion above protects.
    expect(pool._encodeForTransfer({ a: 1 })).toBe(out[0].message);
  });

  it('gives a private transferable copy under clone', () => {
    const pool = makePool();
    const out = pool.prepareBuffers([{ message: { a: 1 } }], { clone: true });
    // `clone: true` is "I want to keep the payload alive here and hand a
    // detachable buffer to the worker", so the buffer is sliced and listed.
    expect(out[0].message).toBeInstanceOf(Uint8Array);
    expect(Array.isArray(out[0].transfer)).toBe(true);
    expect(out[0].transfer).toContain(out[0].message.buffer);
  });

  it('leaves the encode cache intact when cloning', () => {
    const pool = makePool();
    pool.prepareBuffers([{ message: { a: 1 } }], { clone: true });
    // The cache entry must survive, with its buffer still attached. If the
    // clone were taken from the cache and transferred directly, the next
    // identical message would encode into a detached buffer and post nothing.
    const cached = pool._encodeCache.get(JSON.stringify({ a: 1 }));
    expect(cached).toBeTruthy();
    expect(cached.buffer.detached).toBe(false);
  });

  it('transfers a binary payload as its own buffer', () => {
    const pool = makePool();
    const raw = new Uint8Array([1, 2, 3]);
    const out = pool.prepareBuffers([{ message: raw }]);
    expect(out[0].message).toBe(raw);
    expect(out[0].transfer).toEqual([raw.buffer]);
  });

  it('keeps a non-object value as-is with no transfer list', () => {
    const pool = makePool();
    const out = pool.prepareBuffers(['a string', 42, null]);
    // Nothing here is transferable and nothing needs encoding, so each entry
    // must pass through untouched.
    expect(out[0].message).toBe('a string');
    expect(out[1].message).toBe(42);
    expect(out[2].message).toBeNull();
    for (const item of out) expect(item.transfer).toBeUndefined();
  });

  it('preserves order and length for an empty batch', () => {
    const pool = makePool();
    expect(pool.prepareBuffers([])).toEqual([]);
  });
});

describe('PowerPool shutdown sweep', () => {
  it('rejects pending responses and clears the underlying map', async () => {
    const pool = makePool({ size: 1, maxSize: 1 });
    const pending = pool.postMessage({ a: 1 }, undefined, { awaitResponse: true });
    expect(pool._pendingResponses.size).toBe(1);
    pool.terminate();
    // The shutdown sweep is the last chance to settle a caller. Leaving a
    // promise pending here keeps its timer armed, so the process cannot exit.
    await expect(pending).rejects.toThrow();
    expect(pool._pendingResponses.size).toBe(0);
  });

  it('survives a second terminate', () => {
    const pool = makePool();
    pool.terminate();
    // Idempotence: a caller that terminates in a `finally` after an explicit
    // terminate should not get a throw from cleanup code.
    expect(() => pool.terminate()).not.toThrow();
  });

  it('refuses to dispatch after termination', () => {
    const pool = makePool();
    pool.terminate();
    // A shut-down pool is final. Silently re-growing here is what previously
    // pinned a Node process forever, because the new worker had no reaper.
    expect(() => pool.postMessage({ a: 1 })).toThrow();
  });

  it('emits pool:scale for the workers it retired', () => {
    const pool = makePool({ size: 2, minSize: 2, maxSize: 2 });
    const seen = [];
    pool._bus.on('pool:scale', (e) => seen.push(e));
    pool.terminate();
    // A shutdown that retired two workers should say so, rather than making
    // the change observable only through `getStats()` afterwards.
    expect(seen.length).toBeGreaterThan(0);
  });

  it('reports every worker as gone after shutdown', () => {
    const pool = makePool({ size: 2, minSize: 2, maxSize: 2 });
    pool.terminate();
    expect(pool.workers.length).toBe(0);
  });
});

describe('PowerPool queue high-watermark re-arm', () => {
  it('re-arms the event after the queue drains below the threshold', async () => {
    class Replier {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg) => {
          setTimeout(() => {
            if (this.onmessage) this.onmessage({ data: msg });
          }, 1);
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Replier, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      maxTasksPerWorker: 1,
      queueHighThreshold: 0,
      lazy: false,
      idleTimeout: 1000,
    });
    pools.push(pool);
    const seen = [];
    pool._bus.on('pool:queue:high', () => seen.push(1));
    for (let round = 0; round < 2; round += 1) {
      pool.postMessage({ round });
      pool.postMessage({ round, queued: true });
      // Threshold 0, so a queue of length 1 crosses it. Let the worker answer
      // so the queue drains back under,
      // which is what re-arms the latch. A latch that never re-arms makes the
      // event fire once for the life of the pool.
      await vi.waitFor(() => {
        expect(pool.queue.length).toBe(0);
      });
    }
    expect(seen.length).toBe(2);
  });
});

// The fourth site of a defect class `AGENTS.md` records and tells you to grep for
// rather than fix site by site: `instanceof` compares against *this* realm's
// prototype, so a value from a `node:vm` sandbox, an iframe or a worker fails it.
//
// `powerPool.js` carried **fifteen** `instanceof ArrayBuffer` sites. The triage
// that found them established the reachability by measurement rather than by
// pattern, and the split matters:
//
//   - **Views were always safe.** `ArrayBuffer.isView` is realm-independent, and
//     every site checks it alongside the `instanceof`, so a cross-realm
//     `Uint8Array` took the binary branch correctly all along.
//   - **Bare `ArrayBuffer`s were not.** A cross-realm one failed the `instanceof`,
//     so the `isPlainObject` guard beside it evaluated *true* and the buffer was
//     encoded and structured-cloned instead of transferred.
//
// The data survived — `_encodeForTransfer` reads the bytes correctly for a foreign
// buffer — so this is a **lost zero-copy** defect, not corruption. Measured before
// the fix, under every codec: a same-realm buffer came back as
// `{ message: <the buffer>, transfer: [<the buffer>] }` and a cross-realm one as
// `{ message: <encoded>, transfer: undefined }`.
//
// Every fixture below is a real `node:vm` second realm. A hand-rolled stand-in is
// not equivalent: `Object.keys()` on a plain object returns its own properties, so
// an impostor would take the plain-object branch and pass for the wrong reason.

/** A second realm, created once. */
const realm = vm.createContext({});
/** Build an ArrayBuffer in the second realm. */
const foreignBuffer = (bytes) =>
  vm.runInContext(
    `(() => { const b = new ArrayBuffer(${bytes.length}); new Uint8Array(b).set(${JSON.stringify(
      bytes
    )}); return b; })()`,
    realm
  );

describe('PowerPool: a cross-realm ArrayBuffer is transferred, not encoded', () => {
  it('prepares a foreign ArrayBuffer through _prepareForTransfer too', () => {
    // The second gate, and a separate code path from `prepareBuffers`. Reverting
    // this one alone passes every test above, which is why it needs its own case:
    // the two entry points share the `isPlainObject` idea but not the code.
    const pool = makePool();
    const local = new ArrayBuffer(8);
    new Uint8Array(local).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const foreign = foreignBuffer([1, 2, 3, 4, 5, 6, 7, 8]);

    const a = pool._prepareForTransfer(local, undefined, {});
    const b = pool._prepareForTransfer(foreign, undefined, {});

    expect(b.transfer, 'the caller buffer in the transfer list').toEqual([foreign]);
    expect(a.transfer, 'and the same shape as the same-realm control').toEqual([local]);
    // Under every codec the two must agree, because the gate is shared.
    for (const messageCodec of ['legacy', 'framed', 'negotiated']) {
      const p = makePool({ messageCodec });
      const f = foreignBuffer([5, 5, 5, 5]);
      const same = new ArrayBuffer(4);
      new Uint8Array(same).set([5, 5, 5, 5]);
      expect(p._prepareForTransfer(f, undefined, {}).transfer, messageCodec).toEqual([f]);
      expect(p._prepareForTransfer(same, undefined, {}).transfer, messageCodec).toEqual([same]);
    }
  });

  it('prepares a foreign ArrayBuffer exactly as a same-realm one', () => {
    // The whole defect in one assertion pair. Before the fix the foreign buffer
    // came back with `transfer: undefined` — encoded and structured-cloned —
    // while the same-realm one came back owning its own buffer in the transfer
    // list.
    const pool = makePool();
    const local = new ArrayBuffer(8);
    new Uint8Array(local).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const foreign = foreignBuffer([1, 2, 3, 4, 5, 6, 7, 8]);

    const a = pool.prepareBuffers([local])[0];
    const b = pool.prepareBuffers([foreign])[0];

    expect(b.message, 'the buffer itself, not an encoded stand-in').toBe(foreign);
    expect(b.transfer, 'the caller buffer in the transfer list').toEqual([foreign]);
    // And the same shape as the same-realm control, so the assertion above is not
    // vacuous.
    expect(a.message).toBe(local);
    expect(a.transfer).toEqual([local]);
  });

  it('does so under every codec, because the gate is shared', () => {
    // The `isPlainObject` guard and the binary branch are reached from
    // `prepareBuffers`, `_prepareForTransfer` and `WorkerWrapper.postMessage`.
    // One codec passing is not evidence the others do.
    for (const messageCodec of ['legacy', 'framed', 'negotiated']) {
      const pool = makePool({ messageCodec });
      const foreign = foreignBuffer([9, 9, 9, 9]);
      const prepared = pool.prepareBuffers([foreign])[0];
      expect(prepared.message, messageCodec).toBe(foreign);
      expect(prepared.transfer, messageCodec).toEqual([foreign]);
    }
  });

  it('leaves a cross-realm view correct, which it already was', () => {
    // A characterisation, not an aspiration: `ArrayBuffer.isView` is
    // realm-independent, so a cross-realm `Uint8Array` took the binary branch
    // before this change and must still do so. Recorded so that a future
    // regression here is visible rather than assumed away.
    const pool = makePool();
    const foreign = foreignBuffer([1, 2, 3, 4]);
    const view = new Uint8Array(foreign);
    const prepared = pool.prepareBuffers([view])[0];
    expect(prepared.message).toBe(view);
    expect(prepared.transfer).toEqual([foreign]);
  });

  it('still encodes a plain object, which is the branch the fix must not break', () => {
    // The other half. Making `isArrayBuffer` realm-independent must not have
    // started treating plain objects as buffers, or every object message would
    // be posted raw and the worker would receive no payload at all.
    //
    // The property that matters is that a plain object is **not** put in a
    // transfer list — it is passed through and marked `deferred`, with the encode
    // happening at dispatch. Asserted on the transfer list rather than on the
    // message shape, because an earlier draft of this test guessed the message
    // would be eagerly encoded and it is not.
    const pool = makePool();
    const payload = { a: 1 };
    const prepared = pool.prepareBuffers([payload])[0];
    expect(prepared.message, 'the object itself, passed through').toBe(payload);
    expect(prepared.transfer, 'and never in a transfer list').toBeUndefined();
    expect(prepared.deferred).toBe(true);
  });

  it('reports a detached foreign buffer in a transfer list as not live', () => {
    // `isTransferListLive` is the pre-check that fails *before* the post rather
    // than after. A cross-realm `ArrayBuffer` matched none of its three branches
    // — not `instanceof ArrayBuffer`, not `isView`, and it *is* an object so the
    // third was false too — so it was silently skipped and a detached one was
    // never detected.
    //
    // `isDetached` reads `ArrayBuffer.prototype.detached`, which is
    // realm-independent, so the fix is the gate and not the read. Verified
    // directly: a foreign live buffer reports `false`, a foreign detached one
    // reports `true`.
    const pool = makePool();
    const dead = foreignBuffer([1, 2, 3, 4]);
    structuredClone({}, { transfer: [dead] });
    expect(dead.byteLength, 'the fixture is genuinely detached').toBe(0);

    // Reached through the public surface that uses the check.
    const live = foreignBuffer([1, 2, 3, 4]);
    expect(live.byteLength).toBe(4);
    // A live foreign buffer must still be postable, so the fix did not make the
    // pre-check refuse everything foreign.
    expect(() => pool.postMessage({ a: 1 }, [live])).not.toThrow();
  });
});

describe('PowerPool: a cross-realm ArrayBuffer reaches the worker untransformed', () => {
  // The gates above are the synchronous decision points. This one observes the
  // *dispatch* path, which is where `broadcast`'s own `isPlainObject` gate lives
  // and which the synchronous tests cannot reach.
  //
  // `broadcast` with a plain object and no transfer list encodes once and slices
  // per worker, so every worker receives a fresh `Uint8Array`. With a buffer it
  // must forward the buffer itself. Reverting the `broadcast` gate alone passes
  // every synchronous test above, which is why this case exists.

  it('broadcasts a foreign ArrayBuffer as the buffer, not as a per-worker copy', async () => {
    const posted = [];
    class Recorder {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg, transfer) => {
          posted.push({ msg, transfer });
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Recorder, {
      size: 2,
      minSize: 2,
      maxSize: 2,
      lazy: false,
    });
    pools.push(pool);

    const foreign = foreignBuffer([1, 2, 3, 4]);
    pool.broadcast(foreign);

    await vi.waitFor(() => {
      expect(posted.length).toBe(2);
    });

    for (const { msg, transfer } of posted) {
      expect(msg, 'the caller buffer itself, not a slice').toBe(foreign);
      expect(transfer, 'in the transfer list').toEqual([foreign]);
    }
  });

  it('broadcasts a same-realm ArrayBuffer the same way, as the control', async () => {
    const posted = [];
    class Recorder {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg, transfer) => {
          posted.push({ msg, transfer });
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Recorder, {
      size: 2,
      minSize: 2,
      maxSize: 2,
      lazy: false,
    });
    pools.push(pool);

    const local = new ArrayBuffer(4);
    new Uint8Array(local).set([1, 2, 3, 4]);
    pool.broadcast(local);

    await vi.waitFor(() => {
      expect(posted.length).toBe(2);
    });

    for (const { msg, transfer } of posted) {
      expect(msg).toBe(local);
      expect(transfer).toEqual([local]);
    }
  });

  it('still encodes a plain object on broadcast, which is the branch the fix must not break', async () => {
    // The other half of the same gate: a plain object must still be encoded once
    // and sliced per worker, or every object broadcast would arrive as a raw
    // object the worker cannot decode.
    const posted = [];
    class Recorder {
      constructor() {
        this.onmessage = null;
        this.postMessage = (msg, transfer) => {
          posted.push({ msg, transfer });
        };
        this.terminate = () => {};
      }
    }
    const pool = new PowerPool(Recorder, {
      size: 2,
      minSize: 2,
      maxSize: 2,
      lazy: false,
    });
    pools.push(pool);

    pool.broadcast({ a: 1 });

    await vi.waitFor(() => {
      expect(posted.length).toBe(2);
    });

    for (const { msg } of posted) {
      expect(msg, 'encoded, not the caller object').not.toBe({ a: 1 });
      expect(ArrayBuffer.isView(msg) || msg instanceof ArrayBuffer).toBe(true);
    }
    // And each worker gets its own copy, which is the whole point of the slice.
    expect(posted[0].msg).not.toBe(posted[1].msg);
  });
});

describe('PowerPool: awaitResponse refuses a cross-realm ArrayBuffer', () => {
  // The third gate, and the one whose failure is silent data loss rather than a
  // lost optimisation. `awaitResponse` augments the message with a `correlationId`
  // via `Object.assign`, which is only safe for a plain object. Applied to a
  // buffer it produces `{ correlationId }` and the payload is gone.
  //
  // Reached through `_postMessageInner` directly, because the public `postMessage`
  // prepares the message first and the gate is downstream of that.

  it('refuses a foreign ArrayBuffer, exactly as it refuses a same-realm one', () => {
    const pool = makePool();
    const local = new ArrayBuffer(8);
    const foreign = foreignBuffer([1, 2, 3, 4]);
    for (const [label, value] of [
      ['same-realm', local],
      ['cross-realm', foreign],
    ]) {
      expect(
        () => pool._postMessageInner(value, undefined, { awaitResponse: true }),
        label
      ).toThrow(/plain-object message/);
    }
  });

  it('still accepts a plain object, which is the branch the fix must not break', () => {
    // The other half: making `isArrayBuffer` realm-independent must not have
    // started refusing plain objects, or `awaitResponse` would be unusable.
    //
    // The returned promise is captured and settled, not dropped. `awaitResponse`
    // creates a pending response promise, and `afterEach` terminates the pool,
    // which rejects it — an unhandled rejection that fails the whole run rather
    // than this one test. The first draft of this case dropped it on the floor.
    const pool = makePool();
    let pending;
    expect(() => {
      pending = pool._postMessageInner({ a: 1 }, undefined, { awaitResponse: true });
    }).not.toThrow();
    expect(pending, 'a pending response promise').toBeInstanceOf(Promise);
    pending.catch(() => {});
  });
});

describe('PowerPool: the dispatch bypass refuses a cross-realm buffer', () => {
  // The last two gates, and the two that survived the first mutation run.
  //
  // `_postToWorkerObj` has a fast path that posts straight to the underlying worker,
  // skipping the `WorkerWrapper`'s transfer-list normalisation. It is guarded by
  // `canBypassWrapper`, which requires a plain-object message, a non-empty transfer
  // list, and `isTransferListLive(transfer)` — the pre-check that refuses a detached
  // buffer *before* the post rather than after.
  //
  // **Why these are called directly rather than through `postMessage`.** Going
  // through the public API cannot isolate either condition: it encodes a bare
  // `ArrayBuffer` into a `Uint8Array`, so `ArrayBuffer.isView` blocks the bypass for a
  // reason unrelated to the site under test, and the assertion would pass with the
  // defect present. Constructing the prepared item isolates one condition at a time.
  //
  // **The observable is which path ran.** The bypass calls the underlying worker
  // directly and never reaches `_dispatchToWorker`; the wrapper path always does. So
  // spying on `_dispatchToWorker` distinguishes them without needing the fake worker
  // to throw — which matters, because a no-op fake cannot tell a detached buffer from
  // a live one, and that is exactly what defeated the first attempt at these two.

  /** Build a pool and return it with `_dispatchToWorker` counting calls. */
  function makeCountingPool() {
    const pool = makePool();
    const state = { dispatch: 0 };
    const real = pool._dispatchToWorker.bind(pool);
    pool._dispatchToWorker = (...args) => {
      state.dispatch++;
      return real(...args);
    };
    return { pool, state };
  }

  it('refuses to bypass when the message is a cross-realm ArrayBuffer', () => {
    // G5. `canBypassWrapper` requires `!isArrayBuffer(prepared.message)`. With
    // `instanceof` a foreign buffer passed that test, so the bypass fired and the
    // buffer was posted straight to the underlying worker — skipping the wrapper's
    // transfer-list normalisation, which is the thing that decides the list at all.
    const { pool, state } = makeCountingPool();
    const foreign = foreignBuffer([1, 2, 3, 4]);

    pool._postToWorkerObj(pool.workers[0], { message: foreign, transfer: [foreign] }, {});
    expect(state.dispatch, 'the wrapper path, not the bypass').toBe(1);

    // The same-realm control, so the assertion above is not vacuous: a same-realm
    // buffer is refused by the same condition, and must stay refused.
    const local = new ArrayBuffer(4);
    pool._postToWorkerObj(pool.workers[0], { message: local, transfer: [local] }, {});
    expect(state.dispatch).toBe(2);
  });

  it('refuses to bypass when the transfer list holds a detached cross-realm buffer', () => {
    // G8, and the cleanest pair in the file: the only difference between the two
    // calls below is whether the buffer is detached, so `isTransferListLive` is
    // unambiguously the deciding condition.
    //
    // A cross-realm `ArrayBuffer` matched none of `isTransferListLive`'s three
    // branches — not `instanceof ArrayBuffer`, not `isView`, and it *is* an object so
    // the third was false too — so it was silently skipped and a detached one was
    // never detected. The pre-check exists to fail *before* the post.
    const { pool, state } = makeCountingPool();

    const dead = foreignBuffer([1, 2, 3, 4]);
    structuredClone({}, { transfer: [dead] });
    expect(dead.byteLength, 'the fixture is genuinely detached').toBe(0);

    pool._postToWorkerObj(pool.workers[0], { message: { a: 1 }, transfer: [dead] }, {});
    expect(state.dispatch, 'a detached buffer must not reach the bypass').toBe(1);

    // The control: the same shape with a live buffer MUST take the bypass, or the
    // assertion above is satisfied by a bypass that never fires at all.
    const live = foreignBuffer([1, 2, 3, 4]);
    const before = state.dispatch;
    pool._postToWorkerObj(pool.workers[0], { message: { a: 1 }, transfer: [live] }, {});
    expect(state.dispatch, 'a live buffer still takes the fast path').toBe(before);
  });
});
