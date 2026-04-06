import { describe, it, expect } from 'vitest';
import { PowerThrottle } from '../src/helpers/powerThrottle.js';

describe('PowerThrottle refill behavior', () => {
  it('does not double-count elapsed time and advances _lastRefill', () => {
    const t = new PowerThrottle({ capacity: 2, tokens: 0, refillRate: 1 }); // 1 token/sec
    const start = t._lastRefill;

    // simulate half-second elapsed -> no whole tokens yet, but _lastRefill should advance
    t._refill(start + 500);
    expect(t._lastRefill).toBe(start + 500);
    expect(t.tokens).toBe(0);

    // simulate another half-second -> should produce 1 token total
    t._refill(start + 1000);
    expect(t.tokens).toBe(1);

    // additional full second should add one more (cap at capacity)
    t._refill(start + 2000);
    expect(t.tokens).toBe(2);
  });
});
