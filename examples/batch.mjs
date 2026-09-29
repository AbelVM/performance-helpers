/**
 * Batching: amortising a burst into one call.
 *
 * Run: `npm run example batch`
 *
 * `PowerBatch` is the fix for the N+1 write pattern: 500 individual log lines
 * or 500 graph points each becoming its own request is 500 round trips, and no
 * amount of connection pooling makes that cheap. Batching turns them into one.
 *
 * The trade is latency, and the trade is explicit. `maxSize` bounds how much is
 * held; `maxWaitMs` bounds how long the oldest item waits. Which one you should
 * care about depends entirely on whether the tail of your request is latency-
 * or throughput-bound, and picking both small is the usual mistake.
 */
import { PowerBatch } from 'performance-helpers';

const written = [];
const batch = new PowerBatch(
  (items) => {
    // One "round trip" for the whole batch.
    written.push(items);
    console.log(`  flush: ${items.length} items in one call`);
  },
  { maxSize: 100, maxWaitMs: 10 }
);

console.log('PowerBatch — maxSize 100, maxWaitMs 10ms\n');

// A burst well under maxSize: still one call, because maxWaitMs elapsed.
console.log('a burst of 8, then a wait:');
for (let i = 0; i < 8; i += 1) batch.add({ id: i });
await new Promise((r) => setTimeout(r, 30));
console.log('  flushes so far:', written.length, '\n');

// A burst over maxSize: splits as soon as the size limit is hit, without
// waiting for the timer at all. This is the property that stops one huge
// batch from becoming one huge payload.
console.log('a burst of 250 with maxSize 100:');
for (let i = 0; i < 250; i += 1) batch.add({ id: i });
await new Promise((r) => setTimeout(r, 30));
console.log('  flushes so far:', written.length, '\n');

// Force whatever is pending out now rather than waiting for the timer.
batch.add({ id: 'last' });
await batch.flush();
console.log('after an explicit flush:');
console.log('  flushes      :', written.length);
console.log(
  '  total items  :',
  written.reduce((n, w) => n + w.length, 0)
);
console.log('  sizes        :', written.map((w) => w.length).join(', '));

batch.dispose();

const total = written.reduce((n, w) => n + w.length, 0);
if (total !== 259) {
  console.error(`\nFAIL: expected 259 items to be written, got ${total}.`);
  process.exit(1);
}
if (written.some((w) => w.length > 100)) {
  console.error('\nFAIL: a flush exceeded maxSize.');
  process.exit(1);
}
console.log('\nEvery item was written, and no batch exceeded maxSize — that is the');
console.log('whole contract. Batching that can drop items is worse than no batching.');
console.log('\nOK');
