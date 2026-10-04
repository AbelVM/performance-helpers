import { describe, it, expect, vi, beforeAll } from 'vitest';
import { fileURLToPath } from 'url';
import { PowerPool, WorkerAgnostic, preloadNode } from '../src/index.js';

const DATA_FIELD_WORKER = fileURLToPath(new URL('./fixtures/datafield.worker.js', import.meta.url));

beforeAll(async () => {
  await preloadNode();
});

/**
 * WRK-004: `PowerPool` routes its worker events through `WorkerAgnostic`.
 *
 * The row was written as a *decision* — adopt the class, or give the class its
 * own test file at the same rigour — because `PowerPool` called only the static
 * `WorkerAgnostic.create`, so 485 lines of the class had no consumer and two
 * copies of the same event-normalisation ladder were live in the tree. It also
 * recorded that they "already disagree". They did, and the disagreement was not
 * cosmetic: the pool's rule was right for a browser `MessageEvent` and wrong for
 * Node, where `worker.on('message', value)` hands over the payload itself.
 *
 * These tests are the "a works-in-every-runtime claim needs the runtime in a
 * test" rule applied to that: each of the three native models `WorkerAgnostic`
 * supports is driven here, and the Node case is driven by a **real**
 * `worker_threads` worker, because a fake emits whatever shape its author
 * decided the pool should expect and therefore cannot witness the bug.
 */

/**
 * A fake on the EventEmitter model — what a real Node worker is.
 *
 * `_emit` delivers the value, which is the whole point: Node has no event
 * wrapper to unwrap.
 */
function emitterWorker() {
  const listeners = new Map();
  return {
    listeners,
    posted: [],
    offCalls: [],
    on(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(cb);
    },
    off(ev, cb) {
      this.offCalls.push(ev);
      listeners.get(ev)?.delete(cb);
    },
    emit(ev, value) {
      for (const cb of listeners.get(ev) ?? []) cb(value);
    },
    postMessage(msg, transfer) {
      this.posted.push({ msg, transfer });
    },
    terminate() {},
  };
}

/** A fake on the DOM model — a browser `Worker`, reached via `addEventListener`. */
function listenerWorker() {
  const listeners = new Map();
  return {
    listeners,
    detached: [],
    addEventListener(ev, cb) {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev).add(cb);
    },
    removeEventListener(ev, cb) {
      this.detached.push(ev);
      listeners.get(ev)?.delete(cb);
    },
    /** A browser delivers a `MessageEvent`; the payload is on `.data`. */
    emitMessage(payload, extra = {}) {
      for (const cb of listeners.get('message') ?? []) {
        cb({ type: 'message', data: payload, origin: 'https://example.test', ...extra });
      }
    },
    postMessage() {},
    terminate() {},
  };
}

/** A fake with neither method: the `onmessage` property model. */
function propertyWorker() {
  return {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage() {},
    terminate() {},
  };
}

const poolFor = (source, options = {}) =>
  new PowerPool(source, { size: 1, minSize: 1, maxSize: 1, lazy: false, ...options });

describe('WRK-004: PowerPool holds a WorkerAgnostic', () => {
  it('creates one per worker, and the pool wires events through it', () => {
    const pool = poolFor(() => emitterWorker());
    try {
      const agnostic = pool.workers[0]._agnostic;
      // Adoption, not decoration: the wrapper is what the pool subscribes to,
      // and the raw worker is reachable through it rather than instead of it.
      expect(agnostic).toBeInstanceOf(WorkerAgnostic);
      expect(agnostic.worker).toBe(pool.workers[0].worker._underlying);
      expect(pool.workers[0]._agnostic._nativeModel).toBe('emitter');
    } finally {
      pool.shutdown();
    }
  });

  it('picks the model from the worker, for a browser-shaped fake too', () => {
    const pool = poolFor(() => listenerWorker());
    try {
      expect(pool.workers[0]._agnostic._nativeModel).toBe('listener');
    } finally {
      pool.shutdown();
    }
  });

  it('routes a handler failure to the pool logger rather than dropping it', () => {
    // Asserted through the wiring, not by contriving a throw: every caller-
    // supplied callback inside the pool's own message handler is already guarded,
    // so there is no honest way to make it throw from outside, and a test that
    // built one would be testing its own scaffolding.
    const pool = poolFor(() => emitterWorker());
    try {
      const agnostic = pool.workers[0]._agnostic;
      expect(typeof agnostic._onError).toBe('function');

      const logged = [];
      pool._logger = { ...pool._logger, error: (err, msg) => logged.push(msg) };
      agnostic._notifyError(new Error('boom'), { type: 'message' });

      // WRK-003's rule, applied to the pool: a listener that stops being called
      // looks exactly like a worker that went quiet, so the throw must be visible.
      expect(logged).toHaveLength(1);
      expect(String(logged[0])).toContain('message');
    } finally {
      pool.shutdown();
    }
  });
});

describe('WRK-004: the EventEmitter model does not unwrap a payload', () => {
  it('delivers a { data, id } payload whole, where the pool used to unwrap it', () => {
    const fake = emitterWorker();
    const pool = poolFor(() => fake);
    try {
      const seen = [];
      pool.onmessage = (e) => seen.push(e.data);

      fake.emit('message', { data: { rows: [1, 2, 3] }, id: 7 });

      // `id` is the assertion. The old rule read `.data` off the payload, so the
      // caller received `{rows:[1,2,3]}` and `id` vanished with no error.
      expect(seen).toEqual([{ data: { rows: [1, 2, 3] }, id: 7 }]);
    } finally {
      pool.shutdown();
    }
  });

  it('carries the correlation id a reply needs, without the payload unwrapping it', async () => {
    const fake = emitterWorker();
    const pool = poolFor(() => fake, { awaitResponseTimeout: 1000 });
    try {
      const pending = pool.postMessage({ task: 'go' }, undefined, { awaitResponse: true });
      fake.emit('message', {
        data: { rows: [] },
        id: 7,
        correlationId: pool._pendingResponses.keys().next().value,
        duration: 4,
      });

      // Before the fix the correlation id survived only because it sat on the
      // *native* event object, which the pool forwarded undecoded; the payload
      // was still wrong. Both have to hold at once for the reply to be usable.
      // The whole reply body is the payload — the worker put the id on the body,
      // so `correlationId`/`duration` come back with it.
      const res = await pending;
      expect(res.id).toBe(7);
      expect(res.data).toEqual({ rows: [] });
    } finally {
      pool.shutdown();
    }
  });

  it('against a real worker_threads worker, id survives the round trip', async () => {
    // The one that cannot be faked. `test/fixtures/datafield.worker.js` replies
    // with exactly the shape the old rule mangled, through the real Node port.
    const pool = new PowerPool(DATA_FIELD_WORKER, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
      workerOptions: { type: 'module' },
      awaitResponseTimeout: 5000,
    });
    try {
      const res = await pool.postMessage({ task: 'rows' }, undefined, { awaitResponse: true });
      expect(res.id).toBe(7);
      expect(res.data).toEqual({ rows: [1, 2, 3] });
    } finally {
      pool.shutdown();
    }
  });
});

describe('WRK-004: the DOM model still unwraps the event', () => {
  it('takes the payload off a MessageEvent, and keeps the event reachable', () => {
    const fake = listenerWorker();
    const pool = poolFor(() => fake);
    try {
      const seen = [];
      pool.onmessage = (e) => seen.push(e);

      fake.emitMessage({ hello: 'world' });

      expect(seen).toHaveLength(1);
      expect(seen[0].data).toEqual({ hello: 'world' });
      // The browser's own event is still one property hop away, which is how a
      // caller reaches `origin` — the pool no longer forwards the platform
      // object itself, because it attaches `correlationId` to what it forwards.
      expect(seen[0].originalEvent.origin).toBe('https://example.test');
    } finally {
      pool.shutdown();
    }
  });

  it('does not mutate the platform event when it attaches pool bookkeeping', async () => {
    // The old code forwarded the native `MessageEvent` and wrote `correlationId`
    // onto it. A browser can hand the same event to more than one listener, so
    // the second one saw fields the pool had invented.
    const fake = listenerWorker();
    const pool = poolFor(() => fake, { awaitResponseTimeout: 1000 });
    try {
      const pending = pool.postMessage({ task: 'go' }, undefined, { awaitResponse: true });
      // The correlation id travels *inside* the envelope, which is what makes
      // this the interesting case: the pool has to unwrap the payload and still
      // carry the id forward, and it can only do that on an object of its own.
      const native = {
        type: 'message',
        data: {
          __pp: 1,
          kind: 'envelope',
          value: { done: true },
          correlationId: pool._pendingResponses.keys().next().value,
          duration: 2,
        },
      };
      fake.emitMessage(native.data, native);

      await expect(pending).resolves.toEqual({ done: true });
      // The event the browser owns came back with nothing added to it.
      expect(Object.keys(native)).toEqual(['type', 'data']);
    } finally {
      pool.shutdown();
    }
  });
});

describe('WRK-004: the property model is unaffected', () => {
  it('reads an event-shaped value off onmessage, as it always did', () => {
    const pool = poolFor(propertyWorker);
    try {
      const seen = [];
      pool.onmessage = (e) => seen.push(e.data);
      const fake = pool.workers[0].worker._underlying;

      fake.onmessage({ data: { hello: 'world' } });

      expect(seen).toEqual([{ hello: 'world' }]);
    } finally {
      pool.shutdown();
    }
  });
});

describe('WRK-004: the pool subscribes to all three events', () => {
  // Added because mutation-checking found the hole rather than the suite: with
  // the pool subscribing to `message` only, every other test in this file still
  // passed — including the disposal ones, correctly, because `WorkerAgnostic`
  // wires all three natively whether or not anyone listens. The subscription is
  // the pool's half of the contract, and nothing was pinning it. Both existing
  // `*.messageerror` tests missed it as well: they drive a *decode failure*,
  // which reaches `_handleMessageError` as a direct call rather than as an
  // event off the worker.
  it('forwards a worker error to pool.onerror and to error listeners', () => {
    const fake = emitterWorker();
    const pool = poolFor(() => fake);
    try {
      const viaProperty = vi.fn();
      const viaListener = vi.fn();
      pool.onerror = viaProperty;
      pool.addEventListener('error', viaListener);

      const err = new Error('worker died');
      fake.emit('error', err);

      expect(viaProperty).toHaveBeenCalledWith(err);
      expect(viaListener).toHaveBeenCalledWith(err);
    } finally {
      pool.shutdown();
    }
  });

  it('forwards a worker messageerror to messageerror listeners', () => {
    const fake = emitterWorker();
    const pool = poolFor(() => fake);
    try {
      const spy = vi.fn();
      pool.addEventListener('messageerror', spy);

      const err = new Error('could not be cloned');
      fake.emit('messageerror', err);

      expect(spy).toHaveBeenCalledWith(err);
    } finally {
      pool.shutdown();
    }
  });

  it('forwards both on the DOM model, where they arrive as MessageEvents', () => {
    const fake = listenerWorker();
    const pool = poolFor(() => fake);
    try {
      const onError = vi.fn();
      const onMessageError = vi.fn();
      pool.onerror = onError;
      pool.addEventListener('messageerror', onMessageError);

      // `error`/`messageerror` are not normalised to `{ data }` — only `message`
      // is, because only `message` carries a payload. These two are forwarded as
      // the platform delivered them, which is the same contract as before.
      for (const cb of fake.listeners.get('error') ?? []) cb({ type: 'error', message: 'boom' });
      for (const cb of fake.listeners.get('messageerror') ?? []) cb({ type: 'messageerror' });

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toBe('boom');
      expect(onMessageError).toHaveBeenCalledTimes(1);
    } finally {
      pool.shutdown();
    }
  });

  it('stops forwarding all three once the worker is retired', () => {
    // The other half of disposal: a retired worker must not be able to report
    // an error into a pool that has already counted it as gone.
    const fake = emitterWorker();
    const pool = poolFor(() => fake);
    try {
      pool._terminateWorker(pool.workers[0], 'test');

      const onError = vi.fn();
      const onMessageError = vi.fn();
      pool.onerror = onError;
      pool.addEventListener('messageerror', onMessageError);

      fake.emit('error', new Error('late'));
      fake.emit('messageerror', new Error('late'));

      expect(onError).not.toHaveBeenCalled();
      expect(onMessageError).not.toHaveBeenCalled();
    } finally {
      pool.shutdown();
    }
  });
});

describe('WRK-004: retiring a worker releases what it attached', () => {
  it('detaches the three native listeners on the emitter model', () => {
    const fake = emitterWorker();
    const pool = poolFor(() => fake);
    try {
      pool._terminateWorker(pool.workers[0], 'test');
      // All three, and through `off` — the emitter model's detach. A partial
      // release here is what leaves a terminated worker holding the pool.
      expect([...new Set(fake.offCalls)].sort()).toEqual(['error', 'message', 'messageerror']);
    } finally {
      pool.shutdown();
    }
  });

  it('detaches them on the DOM model too', () => {
    const fake = listenerWorker();
    const pool = poolFor(() => fake);
    try {
      pool._terminateWorker(pool.workers[0], 'test');
      expect([...new Set(fake.detached)].sort()).toEqual(['error', 'message', 'messageerror']);
    } finally {
      pool.shutdown();
    }
  });

  it('stops a retired worker from reaching the pool at all', () => {
    // The observable consequence, and the reason this is worth a test rather
    // than an inspection: before the disposal call, a `message` that was already
    // in flight still ran the whole pool handler.
    const fake = emitterWorker();
    const pool = poolFor(() => fake);
    try {
      const workerObj = pool.workers[0];
      workerObj.tasks = 1;
      pool._activeTasks = 1;

      pool._terminateWorker(workerObj, 'test');
      const seen = [];
      pool.onmessage = (e) => seen.push(e);
      fake.emit('message', { data: 'late' });

      expect(seen).toEqual([]);
    } finally {
      pool.shutdown();
    }
  });

  it('releases on resize, which is the path that retires without shutting down', () => {
    const fake = emitterWorker();
    const pool = poolFor(() => fake, { maxSize: 1 });
    try {
      pool.addWorker();
      expect(pool.workers.length).toBe(2);

      pool.resize(1);

      // One worker retired, and its listeners went with it. Without the
      // disposal a resized pool keeps every worker it ever dropped reachable.
      expect(pool.workers).toHaveLength(1);
      expect(fake.offCalls.length).toBeGreaterThan(0);
    } finally {
      pool.shutdown();
    }
  });
});
