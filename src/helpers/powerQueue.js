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
   * @private
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
}
