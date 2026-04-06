import { describe, it, expect, vi } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus', () => {
  it('on/emit calls listeners and returns true', () => {
    const bus = new PowerEventBus();
    const calls = [];
    bus.on('x', (p) => calls.push(p));
    const ok = bus.emit('x', 1);
    expect(ok).toBe(true);
    expect(calls).toEqual([1]);
  });

  it('once listener only fires once', () => {
    const bus = new PowerEventBus();
    const fn = vi.fn();
    bus.once('a', fn);
    bus.emit('a', 1);
    bus.emit('a', 2);
    expect(fn.mock.calls.length).toBe(1);
  });

  it('off removes listener and clear clears all', () => {
    const bus = new PowerEventBus();
    const fn = vi.fn();
    bus.on('e', fn);
    bus.off('e', fn);
    expect(bus.emit('e', 1)).toBe(false);
    const fn2 = vi.fn();
    bus.on('e', fn2);
    bus.clear('e');
    expect(bus.emit('e', 1)).toBe(false);
    bus.on('z', fn2);
    bus.clear();
    expect(bus.emit('z', 1)).toBe(false);
  });

  it('listeners returns snapshot of handlers', () => {
    const bus = new PowerEventBus();
    const fn = () => {};
    bus.on('s', fn);
    const L = bus.listeners('s');
    expect(Array.isArray(L)).toBe(true);
    expect(L.length).toBe(1);
  });

  it('emitAsync supports async listeners and bounded concurrency', async () => {
    const bus = new PowerEventBus();
    const active = [];
    let maxActive = 0;

    for (let i = 0; i < 5; i += 1) {
      bus.on('x', async () => {
        active.push(i);
        maxActive = Math.max(maxActive, active.length);
        await new Promise((r) => setTimeout(r, 10));
        active.pop();
      });
    }

    const ok = await bus.emitAsync('x', null, { concurrency: 2 });
    expect(ok).toBe(true);
    expect(maxActive).toBe(2);
  });

  it('emitAsync swallows async listener errors', async () => {
    const bus = new PowerEventBus();
    bus.on('e', async () => {
      throw new Error('boom');
    });
    const ok = await bus.emitAsync('e', 1);
    expect(ok).toBe(true);
  });
});
