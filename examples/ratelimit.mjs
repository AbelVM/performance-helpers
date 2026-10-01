/**
 * Rate limiting: a token bucket versus a leaky bucket.
 *
 * Run: `npm run example ratelimit`
 *
 * `PowerThrottle` is a **token bucket** — it accumulates a budget up to
 * `capacity` and refills at `refillRate` per interval. Bursts up to `capacity`
 * pass immediately, and that is the point: a bucket bounds the *average* rate
 * while permitting a burst.
 *
 * `PowerGCRA` is the **leaky bucket** (the "virtual scheduling" algorithm, the
 * same one nginx and Redis use). It has no stored balance — it tracks when you
 * are *allowed* to act and rejects anything earlier. Smoother, less state, at
 * the cost of not having a balance to read.
 *
 * Both accept an injected `now`, which is why every number below is exact
 * rather than "roughly". That is the same mechanism PERF-007 added, and it is
 * what makes a rate limiter testable without sleeping.
 */
import { PowerThrottle, PowerGCRA } from 'performance-helpers';

/** A clock we control. */
const makeClock = () => {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
    get ms() {
      return t;
    },
  };
};

function verdicts(limiter, n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(limiter.tryConsume() ? 'pass' : '429');
  return out;
}

// --- Token bucket: 10/s, bursting to 5 -------------------------------------
const clockA = makeClock();
const bucket = new PowerThrottle({
  capacity: 5,
  refillRate: 10,
  now: clockA.now,
});

console.log('PowerThrottle — 10/s, capacity 5');
console.log('  immediately  :', verdicts(bucket, 8).join(' '));
console.log('   ^ 5 pass (the burst), then 429 — the bucket is empty\n');

clockA.advance(500);
console.log('  after 500ms  :', verdicts(bucket, 3).join(' '));
console.log('   ^ half a refill period: 5 tokens back\n');

clockA.advance(500);
console.log('  after 1s     :', verdicts(bucket, 8).join(' '));
console.log('   ^ refilled to capacity 5, not to 8 — capacity is the ceiling');
console.log('   available()  :', bucket.available(), '\n');

// --- Leaky bucket: 10/s, burst 5 ------------------------------------------
const clockB = makeClock();
const gcra = new PowerGCRA({ rate: 10, per: 1000, burst: 5, now: clockB.now });

console.log('PowerGCRA — 10/s, burst 5');
const decisions = [];
for (let i = 0; i < 8; i += 1) {
  decisions.push(gcra.tryConsume() ? 'pass' : `429 (+${gcra.retryAfter()}ms)`);
}
console.log('  immediately  :', decisions.join(' '));
console.log('   ^ six passes, not five. `burst` is *additional* tolerance on top of');
console.log('     the base operation, so `burst: 0` still admits one call — the');
console.log('     100 ms the next one would otherwise need. Six is `1 + burst`, and');
console.log('     each refusal says exactly how long to wait rather than guessing.\n');

clockB.advance(1000);
console.log('  after 1s     :', verdicts(gcra, 6).join(' '));
console.log('   ^ full budget available again\n');

// The property that separates them: a token bucket can tell you its balance.
console.log('bucket.available() :', bucket.available(), '— a stored balance');
console.log('gcra.available()   :', gcra.available(), '— derived from the deadline');
console.log('\nThe practical difference: a token bucket is the better fit when you');
console.log('want to *spend* a budget you have been accumulating, and a leaky');
console.log('bucket when you want the smoothest possible spacing between calls.');

if (bucket.available() > 5) {
  console.error('\nFAIL: the bucket refilled past its capacity.');
  process.exit(1);
}
const gcraPasses = decisions.filter((d) => d === 'pass').length;
if (gcraPasses !== 6) {
  console.error(`\nFAIL: expected 6 immediate GCRA passes (1 + burst), got ${gcraPasses}.`);
  process.exit(1);
}
console.log('\nOK');
