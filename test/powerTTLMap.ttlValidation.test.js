import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerTTLMap } from '../src/helpers/powerTTLMap.js';
import { PowerCache } from '../src/helpers/powerCache.js';

/**
 * CACHE-015 — `PowerTTLMap` still had the immortal-TTL defect that CACHE-003
 * fixed in `PowerCache`.
 *
 * `PowerCache` was repaired by extracting its check into `powerCache.js`, and
 * `powerCache.js` exports **nothing** — so `PowerTTLMap` could not reach it and
 * kept `Number(ttl) || 0`. Verified before the fix, side by side on the shipped
 * build: `PowerCache.set(k, 1, { ttl: 'abc' })` threw a `TypeError` naming the
 * value, while `PowerTTLMap.set(k, 1, 'abc')` stored `expiresAt === 0` — an
 * entry that **never expires**. `[]` and `true` did the same.
 *
 * That is the worst failure direction a TTL container has: silent, unbounded,
 * and indistinguishable from correct behaviour. And it survived *inside the
 * repository*, in the class next door, after a row existed specifically to fix
 * it — the same lesson as QUAL-001, where a validator put in a leaf module left
 * sixteen constructors to hand-roll their own.
 *
 * CACHE-016 is the structural half: one `normalizeTtl` in `utils/options.js`,
 * used by both classes, so the next "tighten it" change lands on both.
 */
describe('PowerTTLMap ttl validation matches PowerCache exactly', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a non-numeric ttl is rejected rather than making the entry immortal', () => {
    // The regression. `expiresAt === 0` is this class's "no expiry" sentinel,
    // which is exactly what `Number('abc') || 0` produced — so the failing input
    // and the "never expires" input were the same value.
    // `{}` is deliberately **not** here: it is the options object with no `ttl`
    // field, which this class has always read as "use `defaultTTL`", and a
    // caller writing `set(k, v, {})` means exactly that. `[]` is an array
    // reaching the options branch, which no caller means.
    for (const bad of ['abc', true, []]) {
      const m = new PowerTTLMap();
      expect(() => m.set('k', 1, bad), `set(k, 1, ${JSON.stringify(bad)})`).toThrow(TypeError);
      expect(m.size, 'a rejected set must not leave a resident entry').toBe(0);
    }
  });

  it('the same value is rejected by both classes, with the same message shape', () => {
    // CACHE-016's acceptance criterion, stated as the assertion: the two classes
    // must agree, not merely both reject. Two implementations that happen to
    // agree today diverge the next time either is edited.
    for (const bad of ['abc', true, [], NaN]) {
      let ttlMapMessage = null;
      try {
        new PowerTTLMap().set('k', 1, bad);
      } catch (e) {
        ttlMapMessage = e.message;
      }
      let cacheMessage = null;
      try {
        new PowerCache().set('k', 1, { ttl: bad });
      } catch (e) {
        cacheMessage = e.message;
      }
      expect(
        ttlMapMessage,
        `both must reject ${JSON.stringify(bad) ?? String(bad)}`
      ).not.toBeNull();
      // Same wording, different class name — the message is the contract.
      expect(ttlMapMessage.replace('PowerTTLMap', 'PowerCache')).toBe(cacheMessage);
    }
  });

  it('a negative ttl is rejected rather than granting immortal entries', () => {
    // CACHE-017. `-5` collapsed to `0`, so a caller who passed a negative TTL by
    // mistake asked for — and silently received — "never expires". Verified:
    // `m.set('neg', 1, -5)` then `m.get('neg') === 1`, indefinitely.
    const m = new PowerTTLMap();
    expect(() => m.set('k', 1, -5)).toThrow(RangeError);
    expect(m.size).toBe(0);
  });

  it('Infinity and zero keep meaning what they documented', () => {
    // The legitimate half, which a test that only asserted throwing would not
    // reach. `Infinity` is "no expiry" and is checked before normalisation;
    // `0` is also the stored sentinel for no expiry in this class.
    let t = 1000;
    const m = new PowerTTLMap({ now: () => t });
    m.set('inf', 1, Infinity);
    m.set('zero', 1, 0);
    expect(m._map.get('inf').expiresAt).toBe(0);
    expect(m._map.get('zero').expiresAt).toBe(0);
    t += 1_000_000;
    expect(m.get('inf'), 'Infinity must not expire').toBe(1);
    expect(m.get('zero'), '0 must not expire').toBe(1);
  });

  it('numeric strings, the options form and the default all still resolve', () => {
    // Every shape the class documented, so the tightening cannot have broken a
    // legitimate caller: `'2000'` from an environment variable, `{ ttl: 1000 }`
    // for parity with `PowerCache.set`, and no TTL at all for the default.
    const t = 1000;
    const m = new PowerTTLMap({ now: () => t, defaultTTL: 5000 });
    m.set('empty', 1, {}); // options object with no ttl => the default
    m.set('str', 1, '2000');
    m.set('obj', 1, { ttl: 1000 });
    m.set('def', 1);
    expect(m._map.get('str').expiresAt).toBe(3001); // 1000 + 2000 + the +1 slack
    expect(m._map.get('obj').expiresAt).toBe(2001);
    expect(m._map.get('def').expiresAt).toBe(6001); // the default, not zero
    expect(m._map.get('empty').expiresAt).toBe(6001);
  });

  it('touch() validates the same way set() does', () => {
    // `touch` resolves its TTL through the same `_resolveTtl`, so it inherits the
    // fix — but nothing pinned that, and a second call site is where a
    // half-applied fix shows up. An existing entry must be left as it was.
    const t = 1000;
    const m = new PowerTTLMap({ now: () => t });
    m.set('k', 1, 5000);
    const before = m._map.get('k').expiresAt;
    expect(() => m.touch('k', 'abc')).toThrow(TypeError);
    expect(m._map.get('k').expiresAt, 'a rejected touch must not half-apply').toBe(before);
    expect(() => m.touch('k', -1)).toThrow(RangeError);
  });

  it('an entry still expires on schedule after the tightening', () => {
    // End to end, so the fix is not merely "now it throws". Fake timers rather
    // than a sleep, per TEST-008: the class adds a `+1` slack internally, so the
    // clock has to be advanced past `ttl + 2` for the boundary to be exact.
    vi.useFakeTimers();
    let t = 1000;
    const m = new PowerTTLMap({ now: () => t });
    m.set('a', 'value', 60);
    expect(m.get('a')).toBe('value');
    t += 62;
    expect(m.get('a')).toBeUndefined();
  });
});
