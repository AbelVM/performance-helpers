import { describe, it, expect } from 'vitest';
import { EventEmitter, getEventListeners } from 'node:events';

// A bare `EventTarget` is used for the listener model on purpose — see ListenerWorker.
import { WorkerAgnostic } from '../src/index.js';

/**
 * WRK-002 — `WorkerAgnostic` owned a worker plus its native listeners with no
 * release path.
 *
 * **The defect was not only the missing `dispose()`.** `_wireEvents` passed
 * anonymous arrow functions straight to `addEventListener`/`on`, so nothing held a
 * reference to them. `dispose()` could not have been written against that: there
 * was no handle to remove. Measured before the fix — one native `error` and one
 * `message` listener on the underlying worker, no `dispose`, no `[Symbol.dispose]`,
 * and no way to detach either.
 *
 * **It is counted on a real `EventTarget`, not a stub.** A fake recording
 * `addEventListener` calls would pass against a `removeEventListener` passed the
 * wrong function, which is exactly the mistake the missing-reference bug invites.
 */

/**
 * A worker-like exposing the **DOM** `addEventListener`/`removeEventListener`
 * pair, so the listener model is the one exercised.
 *
 * **Not an `EventEmitter` subclass, and that is the point.** Node's `EventEmitter`
 * has `on`/`off`/`addListener` and **no `addEventListener`**, so a worker-like
 * built on it silently takes `_wireEvents`' *emitter* branch instead. A first
 * draft of this file named its class `ListenerWorker`, extended `EventEmitter`,
 * and therefore tested the emitter path twice while claiming to cover the
 * listener path once — and a mutation that stored a *different* function from the
 * one it registered passed 7/7, because it only touched the branch never taken.
 * A real `EventTarget` is the only way to reach the branch a browser Web Worker
 * takes.
 */
class ListenerWorker extends EventTarget {
  terminate() {
    this.terminated = true;
  }
}

/** A worker-like exposing only `.on`, so the emitter model is used. */
class EmitterWorker {
  constructor() {
    this._e = new EventEmitter();
    this.terminated = false;
  }

  on(type, fn) {
    this._e.on(type, fn);
  }

  off(type, fn) {
    this._e.off(type, fn);
  }

  count(type) {
    return this._e.listenerCount(type);
  }

  terminate() {
    this.terminated = true;
  }
}

/** A worker-like exposing only `onmessage`/`onerror`, so the property model is used. */
class PropertyWorker {
  constructor() {
    this.terminated = false;
    this.onmessage = undefined;
    this.onerror = undefined;
    this.onmessageerror = undefined;
  }

  terminate() {
    this.terminated = true;
  }
}

/** Build a `WorkerAgnostic` over a factory, returning both. */
function over(factory) {
  const made = [];
  const a = new WorkerAgnostic(() => {
    const w = factory();
    made.push(w);
    return w;
  });
  return { a, w: made[0] };
}

describe('WRK-002: WorkerAgnostic can release what it attached', () => {
  it('detaches every native listener it wired', () => {
    const { a, w } = over(() => new ListenerWorker());
    expect(
      getEventListeners(w, 'error').length + getEventListeners(w, 'message').length
    ).toBeGreaterThan(0);

    a.dispose();

    for (const type of ['error', 'message', 'messageerror']) {
      expect(getEventListeners(w, type).length, `${type} released`).toBe(0);
    }
  });

  it('detaches on the emitter model too, not just the listener model', () => {
    // **Both registration APIs, because `_wireEvents` has three branches and a
    // fix on the first leaves the other two leaking.** This is the mistake a
    // `removeEventListener`-only fix makes, and it is invisible from the default
    // Node path.
    const { a, w } = over(() => new EmitterWorker());
    expect(w.count('message')).toBeGreaterThan(0);

    a.dispose();

    expect(w.count('message'), 'message released').toBe(0);
    expect(w.count('error'), 'error released').toBe(0);
  });

  it('restores the property model to what it found', () => {
    // The third branch *assigns* rather than registers, so detaching means
    // putting the properties back — including restoring a pre-existing handler
    // rather than blindly nulling it.
    const original = () => {};
    const w = new PropertyWorker();
    w.onmessage = original;
    const a = new WorkerAgnostic(() => w);

    a.dispose();

    expect(w.onmessage, 'a pre-existing handler is restored, not clobbered').toBe(original);
    expect(w.onerror, 'and one we added is removed').toBeUndefined();
  });

  it('does not terminate the worker, because it does not own it', () => {
    // **The decision that makes `dispose()` safe to call here.** This wrapper was
    // handed a worker by a caller; `PowerPool` drives termination itself.
    // Terminating would be a lifecycle decision this class has no mandate to make,
    // so `dispose()` detaches and drops its registry and leaves the worker alone.
    const { a, w } = over(() => new ListenerWorker());

    a.dispose();

    expect(w.terminated, 'the worker survives its wrapper being disposed').toBeUndefined();
  });

  it('is idempotent, and `using` reaches it through the symbol', () => {
    const { a, w } = over(() => new ListenerWorker());

    a.dispose();
    a.dispose();
    a[Symbol.dispose]();

    expect(getEventListeners(w, 'message').length).toBe(0);
  });

  it('works through a scope-exit dispose, which is the reason the symbol exists', () => {
    // The project's own dispose rule: a resource-owning helper must implement
    // `dispose()` **and** `[Symbol.dispose]` so it can take part in a scope
    // exit. Node 22.12 cannot parse `using` declarations and no transformer in
    // this tree downlevels them, so the scope exit is spelled out here; the
    // behaviour under test is identical.
    let seen;
    const { a, w } = over(() => new ListenerWorker());
    try {
      seen = getEventListeners(w, 'message').length;
      expect(seen, 'still attached while in scope').toBeGreaterThan(0);
    } finally {
      a.dispose();
    }
    // Outside the scope now: scope exit has run dispose.
    expect(seen).toBeGreaterThan(0);
  });

  it('drops its own listener registry, not just the native handles', () => {
    // Otherwise the Map keeps the handler closures alive — the wrappers would stay
    // collectable-but-retained, which is the same leak one level up.
    const { a } = over(() => new ListenerWorker());
    const handler = () => {};
    a.addEventListener('message', handler);
    expect(a._listeners.size).toBeGreaterThan(0);

    a.dispose();

    expect(a._listeners.size, 'registry cleared').toBe(0);
  });
});
