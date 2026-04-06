import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

describe('PowerThrottle reserve/release', () => {
  it('reserves tokens and releases them', () => {
    const t = new PowerThrottle({ capacity: 2, tokens: 2, refillRate: 0 });
    const token = t.reserve(1);
    expect(token).toBeTruthy();
    expect(t.tokens).toBe(1);

    t.release(token);
    expect(t.tokens).toBe(2);
  });

  it('reserve fails when not enough tokens', () => {
    const t = new PowerThrottle({ capacity: 1, tokens: 0, refillRate: 0 });
    const token = t.reserve(1);
    expect(token).toBeNull();
  });
});
