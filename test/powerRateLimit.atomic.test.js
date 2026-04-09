import { describe, it, expect } from 'vitest';
import { PowerRateLimit } from '../src/helpers/powerRateLimit.js';

describe('PowerRateLimit atomic semantics', () => {
  it('rolls back prior reservations when a later limiter fails', () => {
    let released = false;
    const okLimiter = {
      reserve: (n) => ({ reserved: n }),
      release: (token) => {
        if (token && token.reserved) released = true;
      },
    };

    const failingLimiter = {
      reserve: () => null,
    };

    const pr = new PowerRateLimit([okLimiter, failingLimiter], { atomic: true });
    const ok = pr.tryConsume(1, { atomic: true });
    expect(ok).toBe(false);
    expect(released).toBe(true);
  });
});

// Fake limiter without available(), but supporting tryConsume and addTokens (undo)
class FakeUndoLimiter {
  constructor(tokens = 0) {
    this.tokens = tokens;
  }
  tryConsume(n) {
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
  addTokens(n) {
    this.tokens += n;
  }
}

// Fake limiter without available() and without undo support
class FakeNoUndoLimiter {
  constructor(tokens = 0) {
    this.tokens = tokens;
  }
  tryConsume(n) {
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

describe('PowerRateLimit atomic semantics', () => {
  it('rolls back prior commits when a later limiter fails and supports undo', () => {
    const a = new FakeUndoLimiter(1);
    const b = new FakeNoUndoLimiter(0);
    const r = new PowerRateLimit([a, b], { atomic: true });

    const ok = r.tryConsume(1);
    expect(ok).toBe(false);
    // a should have been rolled back to 1 token
    expect(a.tokens).toBe(1);
  });

  it('refuses atomic consume when a limiter lacks undo capability', () => {
    const a = new FakeNoUndoLimiter(1);
    const b = new FakeNoUndoLimiter(1);
    const r = new PowerRateLimit([a, b], { atomic: true });

    // both have tokens=1 but they lack available() and undo, so atomic cannot be guaranteed
    const ok = r.tryConsume(1);
    expect(ok).toBe(false);
    // ensure no side-effects
    expect(a.tokens).toBe(1);
    expect(b.tokens).toBe(1);
  });
});
