import { describe, it, expect } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus branches extra', () => {
  it('on throws when listener not function', () => {
    const b = new PowerEventBus();
    expect(() => b.on('x', null)).toThrow();
  });

  it('maxListeners enforced', () => {
    const b = new PowerEventBus({ maxListeners: 1 });
    b.on('e', () => {});
    expect(() => b.on('e', () => {})).toThrow();
  });

  it('once removes listener after first emit and emit swallows errors', () => {
    const b = new PowerEventBus();
    let count = 0;
    b.once('n', () => {
      count += 1;
      throw new Error('boom');
    });
    const ok = b.emit('n', 1);
    expect(ok).toBe(true);
    // second emit should be false (listener removed)
    expect(b.emit('n', 1)).toBe(false);
    expect(count).toBe(1);
  });

  it('listeners returns a copy and clear deletes entries', () => {
    const b = new PowerEventBus();
    const fn = () => {};
    b.on('z', fn);
    const arr = b.listeners('z');
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBe(1);
    b.clear('z');
    expect(b.listeners('z').length).toBe(0);
  });

  it('cleanup removes dead weak refs and listeners removes dead refs', () => {
    const b = new PowerEventBus({ weak: true });
    // simulate a dead weak ref entry
    const dead = { deref: () => undefined };
    b._listeners.set('x', new Set([dead]));
    // cleanup should remove the dead entry and drop the event
    b.cleanup();
    expect(b.listeners('x').length).toBe(0);
  });

  it('constructor handles missing FinalizationRegistry when weak true', () => {
    const origFR = global.FinalizationRegistry;
    try {
      // simulate environment without FinalizationRegistry
      global.FinalizationRegistry = undefined;
      const b = new PowerEventBus({ weak: true });
      expect(b._fr).toBeNull();
    } finally {
      global.FinalizationRegistry = origFR;
    }
  });

  it('on cleans up dead weak refs before counting', () => {
    const b = new PowerEventBus({ weak: true });
    // put a dead weak-ref like entry into set
    b._listeners.set('e', new Set([{ deref: () => undefined }]));
    // should not throw when adding a new listener
    expect(() => b.on('e', () => {})).not.toThrow();
  });
});
