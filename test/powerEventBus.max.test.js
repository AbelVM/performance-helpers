import { describe, it, expect } from 'vitest';
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
});
