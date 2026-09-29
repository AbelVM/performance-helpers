/**
 * Bounding concurrency: permit gates and bulkheads.
 *
 * Run: `npm run example backpressure`
 *
 * "Too many concurrent requests" is the failure mode that is invisible in a
 * test and catastrophic in production. Both helpers here bound it, and the
 * difference is *where* the bound applies:
 *
 *   `PowerBulkhead`  partitions work by key. Tenant A cannot exhaust the pool
 *                    by being slow — each partition has its own permits. This
 *                    is the noisy-neighbour fix.
 *   `PowerPermitGate` is a single count. One gate, one limit. Simpler, and the
 *                    right answer when there is no notion of a partition.
 *
 * The thing both exist to avoid is a *blocking* semaphore. Parking a Node
 * thread while it waits for a permit converts a concurrency problem into a
 * latency problem affecting unrelated work. These hand back a promise you can
 * await, or a release callback you can ignore — neither blocks the thread.
 */
import { PowerBulkhead, PowerPermitGate, PowerBackpressure } from 'performance-helpers';

// --- Permit gate: one count, one limit -------------------------------------
const gate = new PowerPermitGate({ capacity: 2, queueCapacity: 3 });

let inFlight = 0;
let peak = 0;
async function work(id, ms) {
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  try {
    await new Promise((r) => setTimeout(r, ms));
    return id;
  } finally {
    inFlight -= 1;
  }
}

console.log('PowerPermitGate — capacity 2, queueCapacity 3');
console.log('  available now:', gate.available, '\n');

const outcomes = await Promise.allSettled(
  Array.from({ length: 8 }, (_, i) =>
    gate.acquire().then((release) => work(i, 10).finally(release))
  )
);

console.log('  results:', outcomes.map((o) => o.status).join(' '));
console.log('  ^ 2 admitted immediately, 3 queued, the rest refused outright.');
console.log('    Refusing is a feature: a queue with no bound is a memory leak');
console.log('    with a latency bug in front of it.\n');
console.log('  peak concurrency actually reached:', peak);
console.log('  ^ capacity 2 was the ceiling, and `tryAcquire` would have told you');
console.log('    the same thing without queueing at all.\n');

// --- Bulkhead: per-tenant partitions ----------------------------------------
const bulkhead = new PowerBulkhead({
  partitions: 2,
  maxConcurrency: 1,
  partitioner: (key) => String(key).slice(0, 1),
});

const tenantWork = async (tenant, ms) => {
  await new Promise((r) => setTimeout(r, ms));
  return tenant;
};

console.log('PowerBulkhead — 2 partitions, 1 concurrent task each');
const started = Date.now();
const results = await Promise.all([
  bulkhead.run(() => tenantWork('A1', 40), { partitionKey: 'tenantA' }),
  bulkhead.run(() => tenantWork('A2', 5), { partitionKey: 'tenantA' }),
  bulkhead.run(() => tenantWork('B1', 5), { partitionKey: 'tenantB' }),
]);
console.log(`  all three settled in ${Date.now() - started}ms:`, results.join(' '));
console.log('  ^ A1 and A2 share a partition, so they serialise (40ms then 5ms).');
console.log('    B1 is on its own partition and finished in 5ms, not 45ms. With a');
console.log('    single shared gate, tenant A would have occupied both permits and');
console.log('    B would have waited behind it. That is the noisy-neighbour case.\n');
console.log('  bulkhead.stats():', bulkhead.stats(), '\n');

// --- Backpressure: a gate that refills under pressure -----------------------
const bp = new PowerBackpressure({ capacity: 3, refillInterval: 10, refillAmount: 1 });
console.log('PowerBackpressure — capacity 3, refilling 1 permit every 10ms\n');

// Hold every permit, so the gate is empty.
const held = [];
for (let i = 0; i < 3; i += 1) held.push(bp.tryAcquire());
console.log(
  '  after 3 tryAcquire():',
  held.filter(Boolean).length,
  'permits held,',
  bp.available,
  'available'
);

console.log('  tryAcquire() while empty, without queueing:', bp.tryAcquire() === null);
await new Promise((r) => setTimeout(r, 35));
console.log('  35ms later, still available            :', bp.available);
console.log('  ^ nothing refilled, and that is the design: the refill is scheduled');
console.log('    from `pending`, not from a free-running timer. A bucket that refilled');
console.log('    on a timer whether or not anyone was waiting would be a rate limiter,');
console.log('    and would keep a timer alive in every process that constructed one.\n');

// Now create real pressure: two callers that will actually queue.
//
// The `heartbeat` below is not decoration. The library's timers are `unref()`d
// on purpose, so no background mechanism a helper schedules will hold a Node
// process open. That is the right default — you do not want a rate limiter
// keeping a finished CLI alive — but it means a script whose *only* remaining
// work is a pending refill exits instead of waiting. A server always has
// something else keeping it alive; this script has to say so explicitly, and
// a reader who copies the example without it will be surprised.
const heartbeat = setInterval(() => {}, 5);
const startedRefill = Date.now();
const waiting = [
  bp.acquire().then(() => ({ got: 'w1', at: Date.now() - startedRefill })),
  bp.acquire().then(() => ({ got: 'w2', at: Date.now() - startedRefill })),
];
console.log('  two callers queued; releasing one held permit:');
for (const release of held.slice(0, 1)) release();

const granted = await Promise.all(waiting);
for (const g of granted) console.log(`    ${g.got} was granted at +${g.at}ms`);
console.log('  ^ w1 took the released permit immediately; w2 waited for the refill');
console.log('    tick. The refill kicked in because there was a queue to relieve —');
console.log('    a gate that refilled eagerly would be a rate limiter.');
clearInterval(heartbeat);

if (bp.available < 0) {
  console.error('\nFAIL: the gate reported negative availability.');
  process.exit(1);
}
if (granted.length !== 2) {
  console.error('\nFAIL: not both queued callers were granted.');
  process.exit(1);
}
console.log('\nOK');
