import { describe, it, expect } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus weak listeners cleanup', () => {
  it('cleanup() removes dead weak-ref entries (simulated)', () => {
    const bus = new PowerEventBus({ weak: true, maxListeners: 5 });
    function alive() {}
    bus.on('x', alive);
    // simulate a dead weakref entry by inserting a fake entry
    const s = bus._listeners.get('x');
    // push a fake WeakRef-like object whose deref() returns undefined
    s.add({ deref: () => undefined });
    // before cleanup, listeners() will filter dead refs but we call cleanup explicitly
    bus.cleanup();
    const L = bus.listeners('x');
    expect(L).toEqual([alive]);
  });
});
