/**
 * Real-time fan-out: `PowerRealtimeHub`.
 *
 * Run: `npm run example realtime`
 *
 * The naive fan-out is `for (const client of clients) client.send(msg)`, and it
 * has one failure mode that dominates everything else: **one slow consumer
 * stalls the publisher.** If a client is on a congested connection its socket
 * buffer fills, `send` starts buffering in memory, and the loop keeps going
 * until the process runs out of memory — taking every healthy client with it.
 *
 * A real-time primitive therefore has to decide, per subscriber, what to do
 * when that subscriber cannot keep up. The policy is the interesting part, and
 * there are only three honest options:
 *
 *   drop-oldest   keep the freshest data. Right for telemetry, where a late
 *                 sample is worthless.
 *   drop-newest   refuse the newcomer and keep what is queued. Right for state
 *                 sync, where ordering and completeness beat freshness.
 *   disconnect    give up on a consumer that is not reading. The only option
 *                 that actually bounds memory.
 *
 * The hub is transport-agnostic: you supply a `send(subscriber, frame)` adapter
 * and it does the queueing, the batching and the policy. It never touches a
 * socket itself — which is why the *slow* client here is a function that takes
 * 25 ms, rather than a real WebSocket.
 */
import { PowerRealtimeHub, decodeMessage } from 'performance-helpers';

/** A fake client whose send can be made slow. */
function makeClient(name, { delayMs = 0 } = {}) {
  return {
    name,
    received: [],
    send(frame) {
      // A real socket queues when the connection is congested. This models
      // that: the callback fires late, and the hub must not wait for it.
      setTimeout(() => {
        const { value } = decodeMessage(frame);
        // With `batch: true` a frame carries an *array* of messages, not one.
        // A client written to expect a single message per frame will read
        // `undefined` out of every field and silently deliver nothing — which
        // looks exactly like a slow-consumer problem and is not one.
        this.received.push(...(Array.isArray(value) ? value : [value]));
      }, delayMs);
    },
  };
}

const slow = makeClient('slow', { delayMs: 25 });
const fast = makeClient('fast', { delayMs: 0 });
const clients = new Map([
  ['slow', slow],
  ['fast', fast],
]);

const hub = new PowerRealtimeHub({
  // You own the transport. The hub batches, encodes and applies the policy.
  send: (subscriber, frame) => clients.get(subscriber.id)?.send(frame),
  close: (subscriber) => {
    console.log(`  (closing ${subscriber.id})`);
  },
  batch: true,
  batchDelayMs: 1,
});

console.log('PowerRealtimeHub — batching on, drop-oldest by default\n');

hub.subscribe('ticks', () => {}, { maxQueue: 3, slowConsumer: 'drop-oldest', id: 'slow' });
// The same bound on the fast client would drop the same messages, because
// `maxQueue` is what binds — the client being fast does not help a 10-message
// burst into a 3-slot queue. Give it room and the difference appears.
hub.subscribe('ticks', () => {}, { maxQueue: 32, slowConsumer: 'drop-oldest', id: 'fast' });

// The hub's flush is a `unref()`d timer, so it will not by itself hold a Node
// process open. A server always has a socket keeping it alive; a script like
// this one has to say so, or the flush never runs and everything is dropped.
const keepAlive = setInterval(() => {}, 5);

const started = Date.now();
for (let i = 0; i < 10; i += 1) hub.publish('ticks', { i });
const publishMs = Date.now() - started;

console.log('  published 10 messages in', publishMs, 'ms');
console.log('  ^ `publish()` returns before anything is sent. That is the whole');
console.log('    design: the publisher is decoupled from the slowest thing');
console.log('    downstream, so one congested client cannot slow the others.\n');

await new Promise((r) => setTimeout(r, 300));
clearInterval(keepAlive);

const s = hub.stats();
console.log(
  '  stats:',
  {
    published: s.published,
    delivered: s.delivered,
    dropped: s.dropped,
    perSubscriber: s.list.map((l) => `${l.id}(dropped=${l.dropped})`).join(' '),
  },
  '\n'
);

console.log('  fast client received:', fast.received.map((m) => m.i).join(', '));
console.log('  slow client received:', slow.received.map((m) => m.i).join(', '));
console.log('  ^ the difference is the *bound*, not the client. The slow subscriber');
console.log('    has a 3-slot queue, so a 10-message burst keeps the freshest three;');
console.log('    the fast one has room for all ten. Neither blocked the publisher,');
console.log('    and neither lost anything the other had.\n');
console.log('  Both dropped counts are reported, because a policy you cannot measure');
console.log('  is one you cannot tune. Note what is *not* here: no exception, no');
console.log('  backpressure, no stalled publish(). The lossy path is the normal path.\n');

hub.close();

if (s.published !== 10) {
  console.error(`\nFAIL: expected 10 publishes, got ${s.published}.`);
  process.exit(1);
}
if (fast.received.length !== 10) {
  console.error(
    `\nFAIL: the fast client should have received all 10, got ${fast.received.length}.`
  );
  process.exit(1);
}
if (slow.received.length !== 3) {
  console.error(`\nFAIL: the slow client should have kept 3, got ${slow.received.length}.`);
  process.exit(1);
}

console.log('The three policies, and when each is right:');
console.log('  drop-oldest  — telemetry, metrics, prices. A late sample is worthless.');
console.log('  drop-newest  — state sync, chat history. Ordering beats freshness.');
console.log('  disconnect   — anything with a memory ceiling. The only true bound.');
console.log('\nOK');
