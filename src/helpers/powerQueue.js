/**
 * Lightweight resizable ring-buffer queue with O(1) enqueue/dequeue.
 * Designed as a small, dependency-free helper for high-throughput queues.
 *
 * @example
 * const q = new PowerQueue(8);
 * q.push(1);
 * q.push(2);
 * q.shift(); // 1
 */
export class PowerQueue {
  /**
   * Create a PowerQueue.
   * @param {number} [initialCapacity=16] Initial capacity (rounded up to power-of-two).
   */
  constructor(initialCapacity = 16) {
    const cap = Math.max(2, Number(initialCapacity) || 16);
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

  get length() {
    return this._size;
  }

  get capacity() {
    return this._capacity;
  }

  get isEmpty() {
    return this._size === 0;
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
    let start = (this._head - items.length) & this._mask;
    for (let i = 0; i < items.length; i++) {
      this._buffer[(start + i) & this._mask] = items[i];
    }
    this._head = start;
    this._size = need;
    return this._size;
  }
}
