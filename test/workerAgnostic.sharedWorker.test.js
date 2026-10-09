import { describe, it, expect, vi } from 'vitest';
import WorkerAgnostic, { detectEnv } from '../src/helpers/WorkerAgnostic.js';

/**
 * F1b — `SharedWorker` support.
 *
 * A `SharedWorker` is not a `Worker`: it has no `postMessage` of its own and no
 * `terminate()`. The caller gets a `MessagePort` off `.port` and every message
 * goes through that. So the adapter has exactly two jobs — route `postMessage`
 * to the port, and give `terminate()` a meaning — and both are easy to get
 * subtly wrong in ways that look like a working worker.
 *
 * Every test here drives a fake `SharedWorker` rather than a real one, because
 * the interesting behaviour is the *routing*, and a real `SharedWorker` would
 * also be testing the browser's message plumbing.
 */

/** A `MessagePort` double that records what it was asked to do. */
function fakePort() {
  const listeners = new Map();
  return {
    started: 0,
    closed: 0,
    posted: [],
    start() {
      this.started += 1;
    },
    close() {
      this.closed += 1;
    },
    postMessage(data, transfer) {
      this.posted.push({ data, transfer });
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type, event) {
      for (const h of listeners.get(type) ?? []) h(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** A `SharedWorker` double with its own error listeners, separate from the port's. */
function fakeSharedWorker() {
  const port = fakePort();
  const listeners = new Map();
  return {
    port,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    emit(type, event) {
      for (const h of listeners.get(type) ?? []) h(event);
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

/** Install a global `SharedWorker` double and return what it was constructed with. */
function withGlobalSharedWorker(sharedWorker) {
  const constructed = [];
  const Ctor = vi.fn(function (...args) {
    constructed.push(args);
    return sharedWorker;
  });
  // `stubGlobal` sets the property on `globalThis`, which is where
  // `resolveSharedWorker` looks first — so stubbing `globalThis` itself as well
  // is both redundant and fatal: it replaces the object vitest is running on.
  vi.stubGlobal('SharedWorker', Ctor);
  return { Ctor, constructed };
}

describe('F1b: SharedWorker support', () => {
  describe('the port adapter', () => {
    it('routes postMessage to the port, not the worker', () => {
      // The whole reason the adapter exists. A `SharedWorker` has no
      // `postMessage`, so calling it directly would throw — and the throw
      // arrives on the first send, long after construction looked fine.
      const shared = fakeSharedWorker();
      withGlobalSharedWorker(shared);
      const wa = new WorkerAgnostic('worker.js', { shared: true });

      const transfer = [new ArrayBuffer(8)];
      wa.postMessage({ hello: 'world' }, transfer);

      expect(shared.port.posted).toHaveLength(1);
      expect(shared.port.posted[0].data).toEqual({ hello: 'world' });
      expect(shared.port.posted[0].transfer).toBe(transfer);
    });

    it('starts the port, because addEventListener does not imply it', () => {
      // A `MessagePort` delivers nothing until `start()`. The browser calls it
      // implicitly only when `onmessage` is *assigned*, and this adapter
      // registers through `addEventListener` — so without the explicit start
      // the port would silently receive nothing, which is the hardest kind of
      // bug to see from outside.
      const shared = fakeSharedWorker();
      withGlobalSharedWorker(shared);
      new WorkerAgnostic('worker.js', { shared: true });
      expect(shared.port.started).toBe(1);
    });

    it('delivers port messages through the unified dispatcher', () => {
      const shared = fakeSharedWorker();
      withGlobalSharedWorker(shared);
      const wa = new WorkerAgnostic('worker.js', { shared: true });
      const seen = [];
      wa.on('message', (e) => seen.push(e));

      shared.port.emit('message', { data: 42 });
      // The unified dispatcher wraps the native event and keeps it on
      // `originalEvent`, so the handler sees the payload plus the raw event.
      // Asserting the bare `{ data: 42 }` was my error — the wrapper is the
      // documented shape every other event on this class arrives in.
      expect(seen).toHaveLength(1);
      expect(seen[0].data).toBe(42);
      expect(seen[0].originalEvent).toEqual({ data: 42 });
    });

    it('forwards error from both the worker and the port', () => {
      // The two fire it for different reasons: the `SharedWorker` for a script
      // that fails to load or throws during evaluation, the port for a
      // deserialization failure. Forwarding only one drops the other, and a
      // dropped script-load error reads as a worker that never starts.
      const shared = fakeSharedWorker();
      withGlobalSharedWorker(shared);
      const wa = new WorkerAgnostic('worker.js', { shared: true });
      const errors = [];
      wa.on('error', (e) => errors.push(e));

      shared.emit('error', { type: 'script-load' });
      shared.port.emit('error', { type: 'deserialize' });

      expect(errors).toEqual([{ type: 'script-load' }, { type: 'deserialize' }]);
    });

    it('detaches from both targets on dispose', () => {
      // Registered on two targets, so it has to be removed from two. Leaving
      // the worker's listener behind keeps a closure over a disposed wrapper
      // alive for the life of the page.
      const shared = fakeSharedWorker();
      withGlobalSharedWorker(shared);
      const wa = new WorkerAgnostic('worker.js', { shared: true });
      expect(shared.listenerCount('error')).toBe(1);
      expect(shared.port.listenerCount('error')).toBe(1);

      wa.dispose();

      expect(shared.listenerCount('error')).toBe(0);
      expect(shared.port.listenerCount('error')).toBe(0);
    });
  });

  describe('terminate is a port close, not a worker kill', () => {
    it('closes the port and leaves the shared worker alone', () => {
      // The semantic that makes `SharedWorker` worth having: it is shared by
      // every client connected to the same URL, so closing one client's port
      // must not kill the script the others are still using.
      const shared = fakeSharedWorker();
      withGlobalSharedWorker(shared);
      const wa = new WorkerAgnostic('worker.js', { shared: true });

      wa.terminate();

      expect(shared.port.closed).toBe(1);
      // There is no `terminate` on a SharedWorker to call, and inventing one
      // would be the bug this test exists to prevent.
      expect(shared.terminate).toBeUndefined();
    });

    it('tolerates a second terminate', () => {
      // `MessagePort.close()` throws once the port is detached, and a teardown
      // path that calls terminate twice is normal.
      const shared = fakeSharedWorker();
      shared.port.close = () => {
        shared.port.closed += 1;
        throw new Error('port is detached');
      };
      withGlobalSharedWorker(shared);
      const wa = new WorkerAgnostic('worker.js', { shared: true });

      expect(() => wa.terminate()).not.toThrow();
      expect(() => wa.terminate()).not.toThrow();
      expect(shared.port.closed).toBe(2);
    });
  });

  describe('option handling', () => {
    it('strips `shared` before the native constructor sees it', () => {
      // `shared` is this library's option, not the platform's. Forwarding it
      // would be the same hygiene problem `onError` already is — harmless today,
      // and a bug the day some implementation validates its options bag.
      const shared = fakeSharedWorker();
      const { constructed } = withGlobalSharedWorker(shared);
      new WorkerAgnostic('worker.js', { shared: true, name: 'pool' });

      expect(constructed[0][0]).toBe('worker.js');
      expect(constructed[0][1]).toEqual({ name: 'pool' });
      expect(constructed[0][1].shared).toBeUndefined();
    });

    it('takes the shared path even in a browser that also has Worker', () => {
      // A browser has both globals. Without the flag being checked first, the
      // string source would take the plain-Worker branch and `shared` would be
      // silently ignored — the misspelled-option failure this library refuses.
      const shared = fakeSharedWorker();
      const { Ctor } = withGlobalSharedWorker(shared);
      vi.stubGlobal('Worker', vi.fn());

      new WorkerAgnostic('worker.js', { shared: true });

      expect(Ctor).toHaveBeenCalledTimes(1);
    });

    it('rejects a non-string source', () => {
      // A `SharedWorker` is constructed from a script URL, so a factory function
      // has nothing to be shared between. Refusing it here is better than
      // constructing a SharedWorker from `String(fn)`.
      withGlobalSharedWorker(fakeSharedWorker());
      expect(() => new WorkerAgnostic(() => {}, { shared: true })).toThrow(/string worker source/);
    });

    it('throws a clear error when the runtime has no SharedWorker', () => {
      vi.stubGlobal('SharedWorker', undefined);
      expect(() => new WorkerAgnostic('worker.js', { shared: true })).toThrow(
        /requires a global `SharedWorker`/
      );
    });

    it('leaves the plain-Worker path untouched when shared is absent', () => {
      // The default must not change. `shared` is opt-in, and a caller who never
      // mentions it gets exactly the worker they got before F1b.
      const shared = fakeSharedWorker();
      const { Ctor } = withGlobalSharedWorker(shared);
      // A plain function, not `vi.fn(() => …)`: an arrow is not constructable,
      // and `new GlobalWorker(...)` needs one that is.
      vi.stubGlobal('Worker', function Worker() {
        return { postMessage: () => {} };
      });

      new WorkerAgnostic('worker.js');

      expect(Ctor).not.toHaveBeenCalled();
    });
  });

  describe('detectEnv is unchanged', () => {
    it('still reports the environment it always did', () => {
      // The adapter is additive. `detectEnv()` drives the plain-Worker branch
      // selection, and changing it would move behaviour for every existing
      // caller.
      expect(['browser', 'webworker', 'node', 'unknown']).toContain(detectEnv());
    });
  });
});
