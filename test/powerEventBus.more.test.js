import { describe, it, expect } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus additional branches', () => {
  it('constructor handles missing FinalizationRegistry when weak true', () => {
    const origFR = global.FinalizationRegistry;
    // simulate environment without FinalizationRegistry
    // eslint-disable-next-line no-undef
    global.FinalizationRegistry = undefined;
    const bus = new PowerEventBus({ weak: true });
    expect(bus._fr).toBeNull();
    global.FinalizationRegistry = origFR;
  });

  it('cleanup removes dead weak refs', () => {
    const bus = new PowerEventBus({ weak: true });
    const dead = { deref: () => null };
    const live = { deref: () => () => {} };
    bus._listeners.set('ev', new Set([dead, live]));
    bus.cleanup();
    const remaining = bus._listeners.get('ev');
    expect(remaining && remaining.size).toBe(1);
  });

  it('on with weak true but no WeakRef stores raw functions', () => {
    const origWR = global.WeakRef;
    global.WeakRef = undefined;
    const bus = new PowerEventBus({ weak: true });
    const fn = () => {};
    const unsub = bus.on('x', fn);
    const listeners = bus.listeners('x');
    expect(listeners.length).toBe(1);
    expect(listeners[0]).toBe(fn);
    unsub();
    global.WeakRef = origWR;
  });

  it('emit swallows listener errors and returns true when listeners exist', () => {
    const bus = new PowerEventBus();
    bus.on('err', () => {
      throw new Error('boom');
    });
    expect(bus.emit('err', 1)).toBe(true);
  });

  it('listeners returns empty array for unknown event and clear() deletes entries', () => {
    const bus = new PowerEventBus();
    expect(bus.listeners('nope')).toEqual([]);
    bus.on('a', () => {});
    bus.clear();
    expect(bus.listeners('a')).toEqual([]);
  });

  it('uses FinalizationRegistry.register/unregister when available', () => {
    const origFR = global.FinalizationRegistry;
    class FakeFR {
      constructor(cb) {
        this.cb = cb;
        FakeFR.last = this;
      }
      register(fn, token, ref) {
        this.registered = token;
        this.ref = ref;
      }
      unregister(ref) {
        this.unregistered = ref;
      }
    }
    global.FinalizationRegistry = FakeFR;
    const bus = new PowerEventBus({ weak: true });
    const fn = () => {};
    const unsub = bus.on('z', fn);
    // register should have been called
    expect(FakeFR.last.registered.event).toBe('z');
    unsub();
    expect(FakeFR.last.unregistered).toBeTruthy();
    global.FinalizationRegistry = origFR;
  });

  it('tracks weak listener registrations per event for the same callback', () => {
    const origFR = global.FinalizationRegistry;
    class FakeFR {
      constructor() {
        this.registered = [];
        this.unregistered = [];
        FakeFR.last = this;
      }
      register(fn, token, ref) {
        this.registered.push({ fn, token, ref });
      }
      unregister(ref) {
        this.unregistered.push(ref);
      }
    }

    global.FinalizationRegistry = FakeFR;
    try {
      const bus = new PowerEventBus({ weak: true });
      const fn = () => {};

      const unsubA = bus.on('a', fn);
      const unsubB = bus.on('b', fn);

      const registry = bus._fr;

      expect(registry.registered.length).toBe(2);
      expect(registry.registered.map((r) => r.token.event).sort()).toEqual(['a', 'b']);

      unsubA();
      expect(registry.unregistered.length).toBe(1);

      // listener for event b should remain active
      expect(bus.emit('b', 1)).toBe(true);

      unsubB();
      expect(registry.unregistered.length).toBe(2);
    } finally {
      global.FinalizationRegistry = origFR;
    }
  });
});
