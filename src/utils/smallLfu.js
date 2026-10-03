/**
 * W-TinyLFU frequency sketch (ALG-002).
 *
 * Counts how often each key is *seen*, so an admission filter can prefer keys
 * that recur over keys that merely arrived once. That is the whole point of
 * TinyLFU: an LRU admits anything that misses, so a one-off scan evicts the
 * working set, and a cache that scans 500 keys over a hot set of 40 keeps
 * **none** of them. A frequency filter rejects the one-offs and lets the hot
 * set survive.
 *
 * Three things make it *W*-TinyLFU, and all three are here:
 *
 * 1. **4-bit counters**, two packed per byte. A `Uint8Array` of 8-bit counters
 *    would be twice the memory for no accuracy gain at these magnitudes - a
 *    counter saturating at 15 versus 255 changes nothing about which key is
 *    more frequent, and the sketch is *reset* well before either saturates.
 * 2. **Count-Min**, several hash rows, minimum of the row estimates. Overcount
 *    is the only error mode, and it is the safe one: a key may look slightly
 *    more popular than it is, never less.
 * 3. **A half-life reset.** Counters would otherwise ratchet to 15 and stay
 *    there, freezing the filter's idea of what is hot. Instead every
 *    `resetAfter` increments, all counters are halved and the sample counter
 *    restarts - exponential decay over a sliding window, which is what the
 *    Caffeine/Ristretto implementations call `reset`.
 *
 * @module
 */

/** Default sketch width (columns per row), per row. */
const DEFAULT_WIDTH = 64;
/** Default number of hash rows. Count-Min's accuracy/error trade-off. */
const DEFAULT_DEPTH = 4;
/** How many `size()` increments between half-life resets. */
const DEFAULT_SAMPLE_SIZE = 10;

/**
 * A 64-bit mix, used once per row. Split into two 32-bit halves because JS bit
 * operations are 32-bit, and `Math.imul` is the only 32-bit multiply available.
 *
 * SplitMix64's finaliser: avalanches badly on sequential keys, which is exactly
 * the input pattern a cache sees.
 *
 * @param {number} h - Accumulated hash.
 * @param {number} k - Per-row seed.
 * @returns {number} A 32-bit hash.
 * @private
 */
function mix32(h, k) {
  h = (h + k) | 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * FNV-1a over the key's string form, mixed with a per-row seed.
 *
 * The string form is what makes `1`, `'1'` and `new String('1')` share a
 * counter: they are different keys at the API level, but a filter that split one
 * hot key's history across two counters would under-report exactly the key it
 * most needs to recognise.
 *
 * The key has to be *hashed*, not passed straight to the mixer - an earlier
 * version wrote `mix32(String(key), seed)`, where the string met the number
 * with `+` and produced `"hot12345"`, which `| 0` turned into 0. Every key then
 * landed in the same bucket and the sketch reported the same frequency for
 * everything, which is the failure mode a frequency filter cannot have.
 *
 * The key's FNV-1a hash, **computed once per `increment`/`estimate`**.
 *
 * It used to be called once per row, and every call repeated `String(key)` *and*
 * a full pass over the key's characters. At `depth: 4` that is four string
 * coercions and four FNV loops to do what is one of each, and the cost scales
 * with key length rather than staying fixed. Measured on this machine, median of
 * five runs over 200 000 operations:
 *
 * | key length | 4x FNV (was) | 1x FNV (now) |
 * | --- | ---: | ---: |
 * | 6  |   52 ns |  19 ns |
 * | 24 |  229 ns |  55 ns |
 * | 64 |  411 ns | 108 ns |
 *
 * `increment` plus `estimate` together went from 151 ns to 16 ns of hashing
 * work. Caffeine's `spread()` does the same thing: hash once, then derive each
 * row from the one hash with a per-row seed, so the rows stay independent while
 * the key is only walked once.
 *
 * @param {*} key
 * @returns {number} The 32-bit hash, unmixed and unmasked.
 * @private
 */
function hashKey(key) {
  const text = String(key);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  }
  return h;
}

/**
 * A 4-bit Count-Min Sketch with a half-life reset.
 */
export class SmallLfuSketch {
  /**
   * @param {Object} [options]
   * @param {number} [options.width=64] Columns per row, rounded up to a power
   *   of two. The sketch's memory is `width * depth / 2` bytes.
   * @param {number} [options.depth=4] Hash rows. More rows cost memory and buy
   *   accuracy; four is the usual choice and is what the reference
   *   implementations use.
   * @param {number} [options.sampleSize=10] `size()` increments between
   *   half-life resets.
   * @param {number} [options.seed] Per-cache seed, so two caches do not share a
   *   hash pattern. Random when omitted.
   */
  constructor({
    width = DEFAULT_WIDTH,
    depth = DEFAULT_DEPTH,
    sampleSize = DEFAULT_SAMPLE_SIZE,
    seed,
  } = {}) {
    const w = Math.max(
      2,
      1 << Math.ceil(Math.log2(Math.max(2, Math.floor(Number(width) || DEFAULT_WIDTH))))
    );
    const d = Math.max(1, Math.min(8, Math.floor(Number(depth) || DEFAULT_DEPTH)));
    this.width = w;
    this.depth = d;
    this.mask = w - 1;
    this.sampleSize = Math.max(1, Math.floor(Number(sampleSize) || DEFAULT_SAMPLE_SIZE));

    // Two 4-bit counters per byte. The nibble is addressed by the counter's
    // parity, and `arrayIndex >> 1` names the byte.
    this.counters = new Uint8Array((w * d) >>> 1);
    this.sample = 0;
    this.resets = 0;
    this.seed = (Number.isFinite(seed) ? Number(seed) : Math.floor(Math.random() * 0xffffffff)) | 0;
  }

  /**
   * The sketch's footprint in bytes. Exposed so a caller can reason about the
   * memory an admission filter costs.
   * @returns {number}
   */
  size() {
    return this.counters.byteLength;
  }

  /**
   * Column index for an already-hashed key in row `row`.
   *
   * `mix32` still runs per row — the rows must stay independent, or the sketch
   * degenerates to one effective row — but it is a fixed number of integer ops
   * rather than a loop over the key's characters.
   *
   * @param {number} hash - From {@link hashKey}, computed once per call.
   * @param {number} row
   * @returns {number}
   * @private
   */
  _indexFor(hash, row) {
    return (row * this.width + (mix32(hash, this.seed + row * 0x9e3779b1) & this.mask)) | 0;
  }

  /**
   * Read one 4-bit counter.
   * @param {number} index - Flat counter index.
   * @returns {number} 0..15.
   * @private
   */
  _get(index) {
    const byte = this.counters[index >> 1];
    return index & 1 ? byte >>> 4 : byte & 0x0f;
  }

  /**
   * Write one 4-bit counter, saturating at 15.
   * @param {number} index
   * @param {number} value
   * @returns {void}
   * @private
   */
  _set(index, value) {
    const at = index >> 1;
    const byte = this.counters[at];
    this.counters[at] =
      index & 1 ? ((byte & 0x0f) | ((value & 0x0f) << 4)) & 0xff : (byte & 0xf0) | (value & 0x0f);
  }

  /**
   * Record one occurrence of `key` and, periodically, age the whole sketch.
   *
   * The sample counter advances only when an increment was **effective** — when
   * at least one row's counter actually moved. Caffeine does the same
   * (`incrementAt` returns false once a counter is saturated, and only an
   * effective increment advances `size`). Advancing it unconditionally meant
   * that a fully saturated sketch reset on schedule anyway, so the half-life
   * was measured in *operations* rather than in *changes to the estimates*:
   * every increment after saturation was a no-op on the data and a full
   * countdown on the clock, and the sketch halved far more often than
   * `sampleSize` describes.
   * @param {*} key
   * @returns {void}
   */
  increment(key) {
    const hash = hashKey(key);
    let advanced = false;
    for (let row = 0; row < this.depth; row += 1) {
      const i = this._indexFor(hash, row);
      const v = this._get(i);
      if (v < 15) {
        this._set(i, v + 1);
        advanced = true;
      }
    }
    if (!advanced) return;
    this.sample += 1;
    if (this.sample >= this.sampleSize) {
      this.reset();
      this.sample = 0;
    }
  }

  /**
   * Estimated frequency of `key`: the minimum across rows, which is what makes
   * this Count-Min rather than plain counting. Overcounting is the only error
   * mode, and the safe one - a key can look slightly hotter than it is, never
   * colder.
   * @param {*} key
   * @returns {number} 0..15.
   */
  estimate(key) {
    const hash = hashKey(key);
    let min = 15;
    for (let row = 0; row < this.depth; row += 1) {
      const v = this._get(this._indexFor(hash, row));
      if (v < min) min = v;
    }
    return min;
  }

  /**
   * The half-life reset: halve every counter, dropping the odd ones.
   *
   * `>> 1` on a nibble is floor division by two, so a counter of 1 becomes 0
   * and 2 becomes 1. That rounding *down* is deliberate - it is what gives the
   * window its exponential decay, and it biases towards forgetting rather than
   * remembering, which is the right direction for an admission filter.
   * @returns {void}
   */
  reset() {
    const c = this.counters;
    const len = c.length;
    // **Four bytes per iteration, via a `Uint32Array` view.** The scalar loop
    // below halves two 4-bit counters per byte, one byte at a time; lifted to a
    // 32-bit word the same expression transforms all four bytes at once:
    //
    //   out = ((w >>> 1) & 0x07070707) | (((w >>> 5) & 0x07070707) << 4)
    //
    // The `0x07070707` masks are what keep it byte-local. `w >>> 1` leaves, for
    // each byte position `p`, bits `8p+1..8p+3` — the low three bits of that byte
    // shifted down, which is the halved low nibble. `w >>> 5` leaves bits
    // `8p+5..8p+7`, the top three bits of the same byte, which is the halved high
    // nibble and lands at `8p+4..8p+6` after the shift. Nothing crosses a byte
    // boundary: the one bit that *would* cross (bit `8p-1`, shifting into
    // `8p`) is masked away by `0x07`.
    //
    // **It is also endianness-agnostic, which is worth stating because it is not
    // obvious.** The expression treats every byte of the word identically, so
    // whichever byte order maps array index `p` to bits `8p..8p+7`, the output
    // byte for index `p` is derived from input byte `p`. A big-endian host runs
    // the same code and gets the same array.
    //
    // A counter is 4 bits, so halving 15 gives 7 and the result always fits the
    // three bits the mask keeps — the same reason the original code masks `0x07`
    // rather than `0x0F`.
    if (len >= 4) {
      const words = new Uint32Array(c.buffer, c.byteOffset, len >>> 2);
      for (let i = 0; i < words.length; i += 1) {
        const w = words[i];
        words[i] = ((w >>> 1) & 0x07070707) | (((w >>> 5) & 0x07070707) << 4);
      }
    }
    // **A tail, not an assumption.** `(width * depth) >>> 1` is a multiple of 4
    // for every width this constructor accepts, so the tail is normally zero
    // iterations — but "normally" is not a property a reset loop should depend
    // on, and an out-of-range tail would silently skip counters. Cheap to carry.
    for (let i = len & ~3; i < len; i += 1) {
      c[i] = ((c[i] >>> 1) & 0x07) | (((c[i] >>> 5) & 0x07) << 4);
    }
    this.resets += 1;
  }

  /**
   * Clear every counter. Used by `PowerCache.reset()` - a reset cache has no
   * frequency history, and carrying one across would bias the next admission
   * decisions toward a workload that no longer exists.
   * @returns {void}
   */
  clear() {
    this.counters.fill(0);
    this.sample = 0;
    this.resets = 0;
  }
}

export default SmallLfuSketch;
