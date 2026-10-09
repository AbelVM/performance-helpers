import { assertLimitRequired, assertKnownOptions } from '../utils/options.js';
import { POWER_QUEUE_INITIAL_CAPACITY } from './constants.js';

/** @param {any} item */
function itemPriority(item) {
  if (item == null) return 0;
  const p = item.priority;
  if (typeof p === 'number' && Number.isFinite(p)) return p;
  const w = item.weight;
  if (typeof w === 'number' && Number.isFinite(w)) return w;
  return 0;
}

/**
 * PowerPriorityQueue
 *
 * Binary heap-based priority queue. Higher priority values are dequeued first.
 * When priorities are equal, FIFO order is preserved for stability.
 *
 * @class PowerPriorityQueue
 * @public
 */
export class PowerPriorityQueue {
  /**
   * @typedef {import('./jsdoc-types.js').PowerPriorityQueueOptions} PowerPriorityQueueOptions
   */
  /**
   * @param {number | {initialCapacity?: number}} [initialCapacity]
   */
  constructor(initialCapacity = POWER_QUEUE_INITIAL_CAPACITY) {
    /** @type {any} */ let capInput = initialCapacity;
    // Validate **any** object, not only one carrying `initialCapacity`. The
    // guard used to be inside the `'initialCapacity' in capInput` branch, so
    // `new PowerPriorityQueue({ initialCap: 4 })` skipped it entirely and fell
    // through to `assertLimitRequired`, which reported "must be a finite
    // number (received [object Object])" — a message about the wrong thing,
    // for a misspelling the option check exists to name.
    if (capInput !== null && typeof capInput === 'object') {
      const opts = /** @type {{initialCapacity?: number}} */ (capInput);
      assertKnownOptions(opts, ['initialCapacity'], 'PowerPriorityQueue');
      capInput = opts.initialCapacity;
    }
    const requested = assertLimitRequired(capInput, {
      name: 'initialCapacity',
      className: 'PowerPriorityQueue',
      min: 0,
      fallback: 16,
    });
    const cap = Math.max(2, Math.floor(requested));
    this._capacity = cap;
    this._heap = new Array(this._capacity);
    this._size = 0;
    this._seq = 0;
  }

  /**
   * @param {any} item
   */
  push(item) {
    if (this._size >= this._capacity - 1) {
      this._grow();
    }
    const entry = { item, priority: itemPriority(item), seq: this._seq++ };
    this._size++;
    this._heap[this._size] = entry;
    this._siftUp(this._size);
    return this._size;
  }

  shift() {
    if (this._size === 0) return undefined;
    const root = this._heap[1];
    const last = this._heap[this._size];
    this._heap[this._size] = undefined;
    this._size--;
    if (this._size > 0) {
      this._heap[1] = last;
      this._siftDown(1);
    }
    return root.item;
  }

  /**
   * Remove and return the item that would be delivered **last**.
   *
   * The mirror of `shift()`, and the reason it is here rather than in the
   * caller: a bounded priority queue has to evict something when it is full,
   * and evicting the *best* item — which is what a naive `shift()` in the
   * drop path does — throws away exactly the message the ordering existed to
   * protect. `PowerRealtimeHub`'s `drop-oldest` policy needs this under
   * `messagePriority`, and a caller maintaining their own bounded queue needs
   * it for the same reason.
   *
   * "Worst" is the exact inverse of `_isBetter`: lowest priority, and among
   * equal priorities the one inserted **most recently**, because that is the
   * one `shift()` would reach last. So `popLowest()` is a true mirror of
   * `shift()` — drain from both ends and you consume the queue in order from
   * each side.
   *
   * O(n) rather than O(log n), because finding the minimum of a max-heap is a
   * scan. That is the right trade for an eviction path, which runs only when
   * the queue is already full.
   *
   * @returns {any} The worst item, or `undefined` when empty.
   */
  popLowest() {
    if (this._size === 0) return undefined;
    let worst = 1;
    for (let i = 2; i <= this._size; i++) {
      if (this._isBetter(this._heap[worst], this._heap[i])) worst = i;
    }
    const entry = this._heap[worst];
    const last = this._heap[this._size];
    this._heap[this._size] = undefined;
    this._size--;
    // `worst` can be the slot just vacated, in which case there is nothing to
    // move into it.
    if (worst <= this._size) {
      this._heap[worst] = last;
      // Both directions, because the element moved from the bottom of the heap
      // can belong above *or* below its new parent. Doing only one leaves the
      // heap property broken in the case the other would have fixed.
      this._siftDown(worst);
      this._siftUp(worst);
    }
    return entry.item;
  }

  peek() {
    if (this._size === 0) return undefined;
    return this._heap[1].item;
  }

  clear() {
    for (let i = 1; i <= this._size; i++) {
      this._heap[i] = undefined;
    }
    this._size = 0;
    this._seq = 0;
  }

  reset() {
    this.clear();
  }

  get length() {
    return this._size;
  }

  get size() {
    return this._size;
  }

  isEmpty() {
    return this._size === 0;
  }

  /** @param {any} candidate @param {any} current */ _isBetter(candidate, current) {
    if (candidate.priority !== current.priority) {
      return candidate.priority > current.priority;
    }
    return candidate.seq < current.seq;
  }

  /**
   * Restore the heap property upwards from `i`.
   *
   * Extracted from `push()` because `popLowest()` moves an element from the
   * bottom of the heap into an arbitrary slot, and that element can belong
   * above its new parent. Two copies of this loop is two places for the
   * comparison to drift.
   * @param {number} i
   */
  _siftUp(i) {
    while (i > 1) {
      const parent = Math.floor(i / 2);
      if (!this._isBetter(this._heap[i], this._heap[parent])) break;
      this._swap(i, parent);
      i = parent;
    }
  }

  /**
   * Restore the heap property downwards from `i`.
   * @param {number} i
   */
  _siftDown(i) {
    while (true) {
      const left = 2 * i;
      const right = 2 * i + 1;
      let best = i;
      if (left <= this._size) {
        if (this._isBetter(this._heap[left], this._heap[best])) {
          best = left;
        }
      }
      if (right <= this._size) {
        if (this._isBetter(this._heap[right], this._heap[best])) {
          best = right;
        }
      }
      if (best === i) break;
      this._swap(i, best);
      i = best;
    }
  }

  /** @param {number} i @param {number} j */ _swap(i, j) {
    const tmp = this._heap[i];
    this._heap[i] = this._heap[j];
    this._heap[j] = tmp;
  }

  _grow() {
    const newCap = Math.max(4, this._capacity * 2);
    const next = new Array(newCap);
    for (let i = 0; i < this._heap.length; i++) {
      next[i] = this._heap[i];
    }
    this._heap = next;
    this._capacity = newCap;
  }

  dispose() {
    this.clear();
  }

  [Symbol.dispose]() {
    this.dispose();
  }

  async [Symbol.asyncDispose]() {
    this.dispose();
    return;
  }
}

export default PowerPriorityQueue;
