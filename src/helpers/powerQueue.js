import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { POWER_QUEUE_INITIAL_CAPACITY } from './constants.js';
/**
 * PowerQueue
 *
 * Lightweight resizable ring-buffer queue with O(1) enqueue/dequeue.
 * Designed as a small, dependency-free helper for high-throughput queues.
 *
 * @class PowerQueue
 * @public
 * @example
 * const q = new PowerQueue(8);
 * q.push(1);
 * q.push(2);
 * q.shift(); // 1
 */
export class PowerQueue {
  /**
   * @typedef {import('./jsdoc-types.js').PowerQueueOptions} PowerQueueOptions
   */
  /**
   * Create a PowerQueue.
   * @param {number} [initialCapacity=16] Initial capacity (rounded up to power-of-two).
   */
  constructor(initialCapacity = POWER_QUEUE_INITIAL_CAPACITY) {
    // An options object as the sole argument means the caller reached for the
    // obvious shape, and it used to be rejected outright with a message naming a
    // number they had just passed an object for. `PowerTTLMap` already normalises
    // both forms; so now do these.
    // An options object is recognised only when it carries at least one known
    // option key. A bare `{}` still falls through to the numeric path and is
    // rejected as before — which `test/powerLatch.reset.test.js` pins as a
    // property: whatever the constructor rejects, `reset()` must reject too.
    if (
      initialCapacity &&
      typeof initialCapacity === 'object' &&
      'initialCapacity' in initialCapacity
    ) {
      const opts = /** @type {{initialCapacity?: number}} */ (initialCapacity);
      assertKnownOptions(opts, ['initialCapacity'], 'PowerQueue');
      initialCapacity = opts.initialCapacity;
    }
    // A power-of-two buffer length is required for the bitmask indexing, so a
    // small request is rounded *up* rather than rejected - 1 and 2 are
    // legitimate hints. A non-finite or negative request is a configuration
    // error and now says so instead of silently becoming 16.
    const requested = assertLimitRequired(initialCapacity, {
      name: 'initialCapacity',
      className: 'PowerQueue',
      min: 0,
      fallback: 16,
    });
    const cap = Math.max(2, requested);
    // internal buffer length always a power-of-two for fast masking
    this._capacity = 1;
    while (this._capacity < cap) this._capacity <<= 1;
    this._mask = this._capacity - 1;
    this._buffer = new Array(this._capacity);
    this._head = 0; // index of next to shift
    this._tail = 0; // index to write next
    this._size = 0;
  }

  /**
   * Enqueue an item at the tail.
   * @param {any} item Item to enqueue.
   * @returns {number} New queue length after push.
   */
  push(item) {
    if (this._size === this._capacity) this._grow();
    this._buffer[this._tail] = item;
    this._tail = (this._tail + 1) & this._mask;
    this._size++;
    return this._size;
  }

  /**
   * Dequeue and return the head item.
   * @returns {any|undefined} The dequeued item or `undefined` when empty.
   */
  shift() {
    if (this._size === 0) return undefined;
    const v = this._buffer[this._head];
    this._buffer[this._head] = undefined;
    this._head = (this._head + 1) & this._mask;
    this._size--;
    return v;
  }

  /**
   * Peek at the head item without removing it.
   * @returns {any|undefined} The head item or `undefined` when empty.
   */
  peek() {
    return this._size === 0 ? undefined : this._buffer[this._head];
  }

  /**
   * Remove all items from the queue.
   * @returns {void}
   */

  /**
   * Alias for {@link PowerQueue#clear}.
   *
   * `clear()` here empties the container, and "reset" is a natural second word
   * for exactly that - so a caller who reaches for `reset()` on this class gets
   * the obvious thing instead of a `TypeError`. No limiter gets this alias: for
   * `PowerThrottle` and `PowerPermitGate`, `reset()` *refills* and `clear()`
   * would read as the opposite, and the two are deliberately not synonyms.
   *
   * @returns {void}
   */
  reset() {
    this.clear();
  }

  clear() {
    if (this._size === 0) return;
    let i = this._head;
    for (let n = 0; n < this._size; n++) {
      this._buffer[i] = undefined;
      i = (i + 1) & this._mask;
    }
    this._head = this._tail = 0;
    this._size = 0;
  }

  /**
   * Release memory held by a burst, by reallocating the buffer smaller.
   *
   * The buffer only ever grows: `_grow()` doubles it and nothing halves it, so a
   * queue that took 5 000 items once keeps an 8 192-slot buffer for the rest of
   * its life. `clear()` empties the slots but does not release them, and that is
   * the right behaviour for a container whose purpose is bounding memory.
   * Measured: 5 000 pushes, then drained or cleared, leaves `capacity` at 8 192
   * with `length` 0.
   *
   * **Explicit rather than automatic, and the reason is the hot path.** The
   * obvious alternative is to shrink inside `shift()` whenever
   * `size < capacity / 2`, which costs a comparison and a branch on every
   * dequeue forever to reclaim memory only after a burst. A caller that has just
   * finished a burst knows when to pay; the dequeue path does not.
   *
   * `minimum` is the capacity to keep — a floor for a queue that is expected to
   * refill to a known size, so a burst followed by steady traffic does not
   * reallocate on every cycle. It is rounded **up** to a power of two like the
   * constructor, and never below 2, which is the same floor the constructor
   * applies. Passing anything smaller than the current length is a no-op: the
   * buffer cannot hold what is in it.
   *
   * @param {number} [minimum=POWER_QUEUE_INITIAL_CAPACITY] Capacity to keep.
   * @returns {number} The capacity after the call.
   */
  shrink(minimum = POWER_QUEUE_INITIAL_CAPACITY) {
    const requested = assertLimitRequired(minimum, {
      name: 'minimum',
      className: 'PowerQueue',
      min: 0,
      fallback: POWER_QUEUE_INITIAL_CAPACITY,
    });
    // The buffer has to hold what is already queued, so the floor is the larger
    // of what the caller asked to keep and the current length.
    const want = Math.max(2, requested, this._size);
    let cap = 1;
    while (cap < want) cap <<= 1;
    if (cap >= this._capacity) return this._capacity;
    // Same copy shape as `_grow`, so the ring is rebuilt in order with
    // `_head` reset. Shrinking is the same operation in the other direction and
    // duplicating six lines here would be a second place for the index maths to
    // go wrong.
    const nb = new Array(cap);
    for (let i = 0; i < this._size; i++) {
      nb[i] = this._buffer[(this._head + i) & this._mask];
    }
    this._buffer = nb;
    this._capacity = cap;
    this._mask = cap - 1;
    this._head = 0;
    this._tail = this._size & this._mask;
    return this._capacity;
  }

  /**
   * Enqueue `count` copies of `item` without building an intermediate array.
   *
   * Exists for the one caller that wanted it: filling a window with `n` equal
   * timestamps used to be `new Array(n)`, a loop to populate the holes, and then
   * `pushMany` to walk the result — a temporary allocation and a second pass on
   * a path that runs per `tryConsume(n)` with `n > 1`.
   *
   * @param {any} item The value to enqueue `count` times.
   * @param {number} count How many copies.
   * @returns {number} New queue length after the pushes.
   */
  fill(item, count = 1) {
    // `integer: true` because a fractional count would otherwise loop to
    // `Math.ceil` copies: `fill(v, 2.5)` pushing three is not a rounding a
    // caller could have meant.
    const n = assertLimitRequired(count, {
      name: 'count',
      className: 'PowerQueue',
      min: 0,
      integer: true,
      fallback: 0,
    });
    for (let i = 0; i < n; i++) {
      if (this._size === this._capacity) this._grow();
      this._buffer[this._tail] = item;
      this._tail = (this._tail + 1) & this._mask;
      this._size++;
    }
    return this._size;
  }

  /**
   * Internal buffer capacity (always a power-of-two).
   * @returns {number}
   */
  get capacity() {
    return this._capacity;
  }

  /**
   * Whether the queue is empty.
   * @returns {boolean}
   */
  get isEmpty() {
    return this._size === 0;
  }

  /**
   * Iterator (non-destructive) yielding items in FIFO order.
   * Allows `for...of` and spread (`[...queue]`) without consuming the queue.
   * @returns {Iterator<any>}
   */
  *[Symbol.iterator]() {
    const i = this._head;
    for (let n = 0; n < this._size; n++) {
      yield this._buffer[(i + n) & this._mask];
    }
  }

  /**
   * Return an iterator of values (alias of the default iterator).
   * @returns {Iterator<any>}
   */
  values() {
    return this[Symbol.iterator]();
  }

  /**
   * Return an iterator of keys (zero-based indexes from the head).
   * @returns {Iterator<number>}
   */
  *keys() {
    for (let n = 0; n < this._size; n++) yield n;
  }

  /**
   * Non-destructive entries iterator that yields [index, value] pairs where
   * index is the zero-based position in the queue (0 is the head).
   * @returns {Iterator<[number, any]>}
   */
  *entries() {
    for (let n = 0; n < this._size; n++) {
      yield [n, this._buffer[(this._head + n) & this._mask]];
    }
  }

  /**
   * Consuming drain iterator: yields items in FIFO order and removes them
   * from the queue as they are iterated.
   * Useful for streaming/processing and emptying the queue without manual loops.
   * @returns {IterableIterator<any>}
   */
  *drain() {
    while (this._size > 0) {
      yield this.shift();
    }
  }

  /**
   * Return a shallow array snapshot of the queue contents in FIFO order.
   * This is a convenience helper that does not consume the queue.
   * @returns {Array<any>}
   */
  toArray() {
    const out = new Array(this._size);
    for (let i = 0; i < this._size; i++) {
      out[i] = this._buffer[(this._head + i) & this._mask];
    }
    return out;
  }

  /**
   * Internal: double internal buffer capacity and reindex elements.
   *
   * This private helper allocates a new backing array with double the
   * previous capacity, copies items in logical order starting from `this._head`,
   * and resets internal indices so the queue remains contiguous.
   *
   * @private
   * @returns {void}
   */
  _grow() {
    const old = this._buffer;
    const oldCap = this._capacity;
    const newCap = oldCap << 1;
    const nb = new Array(newCap);
    // copy elements in order
    for (let i = 0; i < this._size; i++) {
      nb[i] = old[(this._head + i) & this._mask];
    }
    this._buffer = nb;
    this._capacity = newCap;
    this._mask = newCap - 1;
    this._head = 0;
    this._tail = this._size & this._mask;
  }

  /**
   * Enqueue multiple items in one call. Optimized to resize buffer once and
   * copy items in contiguous blocks when possible.
   * @param {Array<any>} items
   * @returns {number} New queue length after all pushes.
   */
  pushMany(items) {
    if (!Array.isArray(items) || items.length === 0) return this._size;
    const need = this._size + items.length;
    // grow until we have capacity for all items
    while (this._capacity < need) this._grow();

    // fast path: if tail has enough room contiguously
    const firstBlock = Math.min(items.length, this._capacity - this._tail);
    for (let i = 0; i < firstBlock; i++) {
      this._buffer[this._tail + i] = items[i];
    }
    this._tail = (this._tail + firstBlock) & this._mask;

    // remaining items (wrap-around)
    let idx = firstBlock;
    while (idx < items.length) {
      const block = Math.min(items.length - idx, this._capacity - this._tail);
      for (let j = 0; j < block; j++) {
        this._buffer[this._tail + j] = items[idx + j];
      }
      this._tail = (this._tail + block) & this._mask;
      idx += block;
    }

    this._size = need;
    return this._size;
  }

  /**
   * Number of items currently queued.
   * @returns {number}
   */
  get length() {
    return this._size;
  }

  /**
   * Prepend multiple items to the head of the queue.
   * The first element of `items` will become the next value returned by `shift()`.
   * @param {Array<any>} items
   * @returns {number} New queue length after all unshifts.
   */
  unshiftMany(items) {
    if (!Array.isArray(items) || items.length === 0) return this._size;
    const need = this._size + items.length;
    // grow until we have capacity for all items
    while (this._capacity < need) this._grow();

    // compute new head index where items[0] will be placed
    const start = (this._head - items.length) & this._mask;
    for (let i = 0; i < items.length; i++) {
      this._buffer[(start + i) & this._mask] = items[i];
    }
    this._head = start;
    this._size = need;
    return this._size;
  }
}
