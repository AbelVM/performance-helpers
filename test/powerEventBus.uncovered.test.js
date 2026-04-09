import { describe, it, expect, vi } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus uncovered branches', () => {
  it('stores raw functions when WeakRef is unavailable and weak=true', () => {
    const origWR = global.WeakRef;
    try {
      // simulate environment without WeakRef
      // eslint-disable-next-line no-undef
      global.WeakRef = undefined;
      const bus = new PowerEventBus({ weak: true });
      const fn = vi.fn();
      const unsub = bus.on('evt', fn);
      const listeners = bus.listeners('evt');
      expect(listeners.length).toBe(1);
      expect(listeners[0]).toBe(fn);
      unsub();
      expect(bus.listeners('evt')).toEqual([]);
    } finally {
      global.WeakRef = origWR;
    }
  });

  it('cleanup removes simulated dead weak refs', () => {
    const bus = new PowerEventBus({ weak: true });
    // inject a dead weak-ref-like entry and a live one
    const dead = { deref: () => null };
    const liveFn = () => {};
    const live = { deref: () => liveFn };
    bus._listeners.set('x', new Set([dead, live]));
    bus.cleanup();
    expect(bus.listeners('x')).toEqual([liveFn]);
  });

  it('emit cleans up dead weak refs while emitting', () => {
    const bus = new PowerEventBus({ weak: true });
    bus._listeners.set('z', new Set([{ deref: () => null }]));
    // emit should process the set, delete the dead ref and return true
    expect(bus.emit('z', 1)).toBe(true);
    expect(bus.listeners('z')).toEqual([]);
  });

  it('emitAsync iterates legacy Set buckets lazily and cleans dead refs', async () => {
    const bus = new PowerEventBus({ weak: true });
    let calls = 0;
    const live = async () => {
      calls += 1;
    };
    bus._listeners.set('async-z', new Set([{ deref: () => null }, { deref: () => live }]));

    const ok = await bus.emitAsync('async-z', 123, { concurrency: 1 });

    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect(bus.listeners('async-z')).toEqual([live]);
  });
});
