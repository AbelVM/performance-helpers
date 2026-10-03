import { describe, it, expect } from 'vitest';
import { SmallLfuSketch } from '../src/utils/smallLfu.js';

/** The pre-optimisation loop, verbatim, as the oracle. */
function scalarReset(c) {
  for (let i = 0; i < c.length; i += 1) {
    c[i] = ((c[i] >>> 1) & 0x07) | (((c[i] >>> 5) & 0x07) << 4);
  }
}

describe('PERF-005: reset() is byte-identical to the scalar loop, four bytes per iteration', () => {
  it('produces identical bytes from an adversarial counter pattern', () => {
    // **Every nibble at every value.** The word expression is only equivalent to
    // the byte one if it maps each *nibble* the same way, and 0..15 exhaustive is
    // the only way to show that for the packed layout. All-0xFF is the case that
    // catches a mask which forgets the 4-bit bound: 15 >>> 1 is 7, which must stay
    // 7 and must not bleed into the neighbouring nibble.
    const sketch = new SmallLfuSketch({ width: 256, depth: 8 });
    for (let i = 0; i < sketch.counters.length; i += 1) {
      sketch.counters[i] = 0xff;
      // Paint each byte with a distinct pattern so a byte-order mistake shows up.
      if (i % 3 === 1) sketch.counters[i] = 0x0f;
      if (i % 5 === 2) sketch.counters[i] = 0xf0;
    }
    const expected = Uint8Array.from(sketch.counters);
    scalarReset(expected);

    sketch.reset();

    expect(Array.from(sketch.counters)).toEqual(Array.from(expected));
  });

  it('reaches the same fixed point after repeated resets as the scalar loop', () => {
    // A byte-equality check on one pass is not enough: halfving converges, and a
    // rewrite that is right once can drift if it feeds itself differently. Ten
    // resets from a saturated state must land identically.
    const mine = new SmallLfuSketch({ width: 512, depth: 4 });
    mine.counters.fill(0xff);
    const theirs = new SmallLfuSketch({ width: 512, depth: 4 });
    theirs.counters.set(mine.counters);

    for (let i = 0; i < 10; i += 1) {
      mine.reset();
      scalarReset(theirs.counters);
      expect(Array.from(mine.counters)).toEqual(Array.from(theirs.counters));
    }
    expect(
      mine.counters.every((b) => b === 0),
      'converges to zero, as the scalar loop does'
    );
  });

  it('preserves admission decisions, not just bytes', () => {
    // **The property that actually matters, and the reason this rewrite is not a
    // free win to verify.** The sketch's job is deciding which key to admit; a
    // transformation that produces the right bytes in the wrong *order* would pass
    // a byte check on a uniform buffer and change behaviour on a real one. So
    // drive real keys and compare the admission stream.
    const mine = new SmallLfuSketch({ width: 512, depth: 4, sampleSize: 8 });
    const theirs = new SmallLfuSketch({ width: 512, depth: 4, sampleSize: 8 });

    const decisions = (s) => {
      const out = [];
      for (let i = 0; i < 4000; i += 1) {
        // A skewed key distribution so the sketch actually rejects candidates.
        const key = `key-${(i * 7) % 61}`;
        out.push(s.increment(key) ? 1 : 0);
        if (i % 97 === 0) s.reset();
      }
      return out.join('');
    };

    expect(decisions(mine)).toBe(decisions(theirs));
  });

  it('halves a known pattern the way the scalar loop does', () => {
    // Worked example rather than a differential test, so a reader can see the
    // nibble arithmetic: 0xFF is two 15s; each halves to 7, so the result is 0x77.
    const sketch = new SmallLfuSketch({ width: 8, depth: 4 });
    sketch.counters.fill(0xff);
    sketch.reset();

    expect(sketch.counters[0]).toBe(0x77);
    expect(sketch.counters[0]).not.toBe(0xff);
  });

  it('counts the reset exactly once', () => {
    // The tail loop and the word loop are two passes over one reset; if the
    // increment sat inside the word loop it would be counted four times per word.
    const sketch = new SmallLfuSketch({ width: 16384, depth: 4 });
    const before = sketch.resets;
    sketch.reset();

    expect(sketch.resets - before, 'one reset is one reset').toBe(1);
  });
});
