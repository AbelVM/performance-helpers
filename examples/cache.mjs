/**
 * Caching with `PowerCache`.
 *
 * Run: `npm run example cache`
 *
 * Three things are worth noticing, and none of them are visible from the
 * constructor:
 *
 *  1. Eviction is LRU *plus* weight, and it is lazy. A cache at its limit
 *     evicts on the next write rather than on a timer.
 *  2. `stats()` is the only honest measure of a cache. Timing one is how you
 *     end up "optimising" something the numbers say is already fast.
 *  3. Weight is what makes this a real LRU rather than a count. A 10 MB buffer
 *     and a 40 byte string both count as one entry otherwise, so the cache
 *     fills with large values and evicts far more than it holds.
 */
import { PowerCache } from 'performance-helpers';

const cache = new PowerCache({
  maxEntries: 100,
  maxWeight: 1_000,
  weightFn: (value) => (value instanceof Uint8Array ? value.byteLength : 40),
  defaultTTL: 60_000,
});

let computations = 0;
function expensive(n) {
  computations += 1;
  let total = 0;
  for (let i = 0; i < 50_000; i += 1) total += i % (n + 1);
  return total;
}

cache.set('seven', expensive(7));
const first = cache.get('seven');
const second = cache.get('seven');
console.log('first  get:', first);
console.log('second get:', second);
console.log('actual computations:', computations, '(1 — the second get was a hit)\n');

for (let i = 0; i < 150; i += 1) cache.set(`key-${i}`, i);
const stats = cache.stats();
console.log('after 150 writes:');
console.log('  size      :', stats.size);
console.log('  weight    :', stats.weight, '<= maxWeight 1000');
console.log('  hits      :', stats.hits);
console.log('  misses    :', stats.misses);
console.log('  evictions :', stats.evictions);
console.log(`  ^ size is ${stats.size}, not 100 — every value weighs 40, so`);
console.log('    maxWeight 1000 binds first and maxEntries never comes into play.');
console.log('    That is the point of a weightFn: an entry count is a bad proxy for');
console.log('    memory, so a cache bounded by entries alone will happily hold 100');
console.log('    10 MB buffers.\n');

// LRU is about *use*, not insertion. Fill the cache exactly, touch the oldest
// key so it becomes the most recently used, then write one more key. The
// eviction should now fall on the *second* oldest, not the one we just read.
const slots = cache.size; // 25 — maxWeight / weight
const lru = new PowerCache({
  maxEntries: 1000,
  maxWeight: 1_000,
  weightFn: () => 40,
});

for (let i = 0; i < slots; i += 1) lru.set(`k${i}`, i);
console.log(`\nLRU, with the cache exactly full (${slots} slots):`);
console.log('  k0 present before the read:', lru.has('k0'));

lru.get('k0'); // the promotion: k0 is now the most recently *used* entry
lru.set('newcomer', 'x');

console.log('  k0 present after one more write :', lru.has('k0'), '<- read, so kept');
console.log('  k1 present after one more write :', lru.has('k1'), '<- untouched, so evicted');
console.log('  newcomer present                :', lru.has('newcomer'));
console.log('  ^ this is the whole difference between LRU and FIFO. Under FIFO the');
console.log('    read would have been wasted and k0 would have gone. A cache whose');
console.log('    eviction is insertion-order throws away exactly the entries that were');
console.log('    popular enough to be looked up again.\n');

if (!lru.has('k0')) {
  console.error('\nFAIL: a key that was read was evicted — this is not LRU.');
  process.exit(1);
}
if (lru.has('k1')) {
  console.error('\nFAIL: the least recently used key survived.');
  process.exit(1);
}
if (computations !== 1) {
  console.error(`\nFAIL: expected exactly 1 computation, got ${computations}.`);
  process.exit(1);
}
console.log('OK');
