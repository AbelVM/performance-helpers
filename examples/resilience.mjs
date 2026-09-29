/**
 * Resilience: circuit breaker, retry, and deadline.
 *
 * Run: `npm run example resilience`
 *
 * These three solve different problems and are routinely confused:
 *
 *   `PowerCircuit`   stops calling something that is already broken. Fast to
 *                    open, and it stays open until a probe succeeds.
 *   `PowerRetry`     tries again after a transient failure. The important part
 *                    is the *jitter*: retries that are not decorrelated turn a
 *                    brief outage into a synchronised stampede.
 *   `PowerDeadline`  gives up when the whole operation has taken too long,
 *                    regardless of how many attempts are left.
 *
 * They compose: a deadline around a retry around a circuit. The order matters
 * and is the opposite of the order you would guess.
 */
import { PowerCircuit, PowerRetry, PowerDeadline, PowerRetryBudget } from 'performance-helpers';

// --- Circuit breaker --------------------------------------------------------
let backendHealthy = false;
let backendCalls = 0;

async function flakyBackend() {
  backendCalls += 1;
  if (!backendHealthy) throw new Error('503 Service Unavailable');
  return 'ok';
}

const circuit = new PowerCircuit({ threshold: 3, timeout: 5000 });

console.log('PowerCircuit — opens after 3 consecutive failures');
for (let i = 1; i <= 5; i += 1) {
  try {
    await circuit.call(flakyBackend);
    console.log(`  attempt ${i}: passed`);
  } catch (err) {
    console.log(`  attempt ${i}: ${err.name} (backend was called ${backendCalls}x total)`);
  }
}
console.log('  ^ after the third failure the circuit opens, so attempts 4 and 5');
console.log('    never reach the backend at all. That is the whole point: 2 calls');
console.log('    were saved, not 2 retried.\n');

backendHealthy = true;
circuit.reset?.();
console.log('  backend healthy again; state reset to:', circuit.state ?? 'closed', '\n');

// --- Retry with decorrelated jitter ----------------------------------------
let attempts = 0;
const delays = [];

// Decorrelated jitter is the interesting default. The other options are
// `exponential` (thundering herd), `linear`, and `fixed`.
const budget = new PowerRetryBudget({ ratio: 0.2 });

try {
  await PowerRetry.run(
    async () => {
      attempts += 1;
      if (attempts < 4) throw new Error('transient network blip');
      return 'succeeded on attempt ' + attempts;
    },
    {
      maxAttempts: 5,
      backoff: 'decorrelated',
      baseDelay: 10,
      maxDelay: 100,
      budget,
      onRetry: (attempt, err, delay) => {
        delays.push(delay);
        console.log(`  retry ${attempt}: ${err.message} -> waiting ${Math.round(delay)}ms`);
      },
    }
  );
  console.log('  result: succeeded on attempt', attempts);
} catch (err) {
  console.log('  exhausted:', err.message);
}
console.log('  ^ decorrelated jitter picks each delay from a *uniform random');
console.log('    draw*, not `base * 2^n`, so retries do not line up into a wave.');
console.log('  delays used:', delays.map((d) => Math.round(d)).join(', '), '\n');

// --- The retry budget -------------------------------------------------------
// A shared budget is what stops a retry storm from becoming an outage: the
// pool-wide ratio of retries to original calls is capped, not just the count
// per call. `recordRequest()` is called for each *original* request, and it
// releases budget; `tryConsumeRetry()` is called for each retry attempt.
const tight = new PowerRetryBudget({ ratio: 0.1, capacity: 2 });
let allowed = 0;
let throttled = 0;

for (let i = 0; i < 12; i += 1) {
  tight.recordRequest();
  if (tight.tryConsumeRetry()) allowed += 1;
  else throttled += 1;
}
console.log('PowerRetryBudget — ratio 0.1, capacity 2');
console.log('  12 requests, each wanting to retry:', allowed, 'allowed,', throttled, 'throttled');
console.log('  stats:', tight.stats());
console.log('  ^ a budget bounds retries *pool-wide*. Per-call `maxAttempts` alone');
console.log('    lets N callers each retry 5 times, which is the stampede.\n');

// --- Deadline ---------------------------------------------------------------
// The one that bounds the *whole* operation, including every retry.
const deadline = new PowerDeadline({ totalTimeout: 50 });

const started = Date.now();
try {
  await deadline.run(() => new Promise(() => {})); // never settles
  console.log('  FAIL: the deadline did not fire');
  process.exit(1);
} catch (err) {
  console.log('PowerDeadline — totalTimeout 50ms around a call that never returns');
  console.log(`  threw after ~${Date.now() - started}ms: ${err.message}`);
  console.log('  ^ without this the caller waits forever, and no per-attempt');
  console.log('    timeout would help because there is no next attempt.\n');
}

console.log('Composition order that follows from all three: the *outermost*');
console.log('concern is the deadline, then the circuit (stop asking), then retry');
console.log('(ask again). Retrying outside a circuit just retries into a dead');
console.log('backend; a deadline outside both is the backstop for the rest.');
console.log('\nOK');
