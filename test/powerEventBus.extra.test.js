import { describe, it, expect, vi } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus extra branches', () => {
  it('once() falls back to WeakMap bookkeeping when function cannot be extended', () => {
    const bus = new PowerEventBus();
    const fn = vi.fn();
    // Prevent attaching properties to the function to force the fallback path
    Object.preventExtensions(fn);

    // register once, then remove using the original function before it fires
    bus.once('x', fn);
    bus.off('x', fn);

    expect(bus.emit('x', 1)).toBe(false);
    expect(fn.mock.calls.length).toBe(0);
  });

  it('enforces maxListeners when configured', () => {
    const bus = new PowerEventBus({ maxListeners: 1 });
    bus.on('a', () => {});
    expect(() => bus.on('a', () => {})).toThrow();
  });

  it('emit swallows listener errors and still returns true', () => {
    const bus = new PowerEventBus();
    bus.on('err', () => {
      throw new Error('boom');
    });
    expect(bus.emit('err')).toBe(true);
  });

  it('cleanup is a no-op for non-weak buses', () => {
    const bus = new PowerEventBus({ weak: false });
    // should not throw
    expect(() => bus.cleanup()).not.toThrow();
  });

  it('off removes a wrapped once-listener when passed the wrapped function (fallback bookkeeping)', () => {
    const bus = new PowerEventBus();
    const fn = vi.fn();
    // force the once() attach fallback to WeakMap by preventing extensions
    Object.preventExtensions(fn);
    bus.once('w', fn);
    const s = bus._listeners.get('w');
    const wrapped = Array.from(s)[0];
    // remove using the wrapped function reference
    bus.off('w', wrapped);
    expect(bus.emit('w')).toBe(false);
  });

  it('works with WeakRef-enabled weak buses (on/unsubscribe via WeakRef)', () => {
    const bus = new PowerEventBus({ weak: true });
    const fn = vi.fn();
    const unsub = bus.on('z', fn);
    // listeners() should deref WeakRef and return the original function
    const L = bus.listeners('z');
    expect(L.length).toBe(1);
    expect(L[0]).toBe(fn);
    unsub();
    expect(bus.emit('z')).toBe(false);
  });

  it('once() fast-path with symbol-attached map cleans up wrapped weak entries when off(original) is called', () => {
    const bus = new PowerEventBus({ weak: true });
    const fn = vi.fn();
    bus.once('q', fn);
    // remove via original function (fast-path that uses the symbol-attached Map)
    bus.off('q', fn);
    expect(bus.emit('q')).toBe(false);
  });
});
