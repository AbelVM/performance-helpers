import { describe, it, expect } from 'vitest';
import PowerEventBus from '../src/helpers/powerEventBus.js';

describe('PowerEventBus once/off behavior', () => {
  it('off(originalFn) removes wrapped once-listener', () => {
    const bus = new PowerEventBus();
    let called = 0;
    const fn = () => {
      called++;
    };
    bus.once('ev', fn);
    // remove by original function
    bus.off('ev', fn);
    bus.emit('ev', {});
    expect(called).toBe(0);
  });
});
