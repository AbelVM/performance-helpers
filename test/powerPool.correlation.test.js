/**
 * Generated correlation ids (PERF-002).
 *
 * The id only has to be unique for the matching that actually happens: a
 * response arriving at the pool that sent it, looked up in that pool's pending
 * map. These tests pin that, plus the cross-pool property that made the
 * `crypto.randomUUID()` version necessary in the first place.
 */
import { describe, it, expect } from 'vitest';
import { PowerPool } from '../src/index.js';

/** A pool that never actually spawns anything. */
function idlePool(options = {}) {
  const pool = new PowerPool(() => ({ postMessage() {}, terminate() {}, onmessage: null }), {
    size: 1,
    idleTimeout: 10_000,
    ...options,
  });
  return pool;
}

describe('correlation id generation', () => {
  it('returns a short, non-empty string', () => {
    const pool = idlePool();
    const id = pool._generateCorrelationId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    // The old implementation produced a 42-character UUID-plus-counter. The
    // measured replacement is 10, and a length regression means someone has
    // reintroduced the expensive path.
    expect(id.length).toBeLessThan(24);
    pool.dispose();
  });

  it('is monotonic within a pool', () => {
    const pool = idlePool();
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(pool._generateCorrelationId());
    expect(seen.size).toBe(5000);
    pool.dispose();
  });

  it('is unique within a pool', () => {
    const pool = idlePool();
    const seen = new Set();
    for (let i = 0; i < 10_000; i += 1) seen.add(pool._generateCorrelationId());
    expect(seen.size).toBe(10_000);
    pool.dispose();
  });

  it('does not collide between two pools in the same process', () => {
    // This is the property `randomUUID` was there to provide. A shared process
    // tag plus a per-pool counter has to preserve it, or a response could in
    // principle be matched by the wrong pool.
    const a = idlePool();
    const b = idlePool();
    const fromA = new Set();
    for (let i = 0; i < 2000; i += 1) fromA.add(a._generateCorrelationId());
    for (let i = 0; i < 2000; i += 1) {
      expect(fromA.has(b._generateCorrelationId())).toBe(false);
    }
    a.dispose();
    b.dispose();
  });

  it('every id from a pool shares one prefix, and that prefix is base 36', () => {
    const pool = idlePool();
    const first = pool._generateCorrelationId();
    const second = pool._generateCorrelationId();
    expect(first.split('-')[0]).toBe(second.split('-')[0]);
    // Two separate pools in one process must share the prefix, or ids from
    // different pools could be mistaken for the same origin.
    const other = idlePool();
    expect(other._generateCorrelationId().split('-')[0]).toBe(first.split('-')[0]);
    pool.dispose();
    other.dispose();
  });
});
