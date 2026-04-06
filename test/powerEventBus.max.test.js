import { describe, it, expect, vi } from 'vitest';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';

describe('PowerEventBus maxListeners', () => {
  it('default is unlimited (0) and allows many listeners', () => {
    const bus = new PowerEventBus();
    for (let i = 0; i < 50; i++) bus.on('evt', () => {});
    expect(bus.listeners('evt').length).toBe(50);
  });

  it('throws when adding more than an explicit small maxListeners', () => {
    const bus = new PowerEventBus({ maxListeners: 2 });
    bus.on('e', () => {});
    bus.on('e', () => {});
    expect(() => bus.on('e', () => {})).toThrow();
  });

  it('allows adding again after a listener is removed under maxListeners', () => {
    const bus = new PowerEventBus({ maxListeners: 1 });
    const fn = () => {};
    bus.on('e', fn);
    bus.off('e', fn);
    expect(() => bus.on('e', () => {})).not.toThrow();
  });

  it('removes once listener when off is called with the original function', () => {
    const bus = new PowerEventBus({ maxListeners: 1 });
    const fn = vi.fn();
    bus.once('e', fn);
    bus.off('e', fn);
    bus.emit('e', 'payload');
    expect(fn).not.toHaveBeenCalled();
    expect(bus.listeners('e').length).toBe(0);
    expect(() => bus.on('e', () => {})).not.toThrow();
  });

  it('resets maxListeners count when clear(event) is called', () => {
    const bus = new PowerEventBus({ maxListeners: 1 });
    bus.on('e', () => {});
    bus.clear('e');
    expect(() => bus.on('e', () => {})).not.toThrow();
  });
});
