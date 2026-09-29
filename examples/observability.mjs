/**
 * Observability: quantiles and event-loop health.
 *
 * Run: `npm run example observability`
 *
 * Averaging a latency distribution is how you end up optimising the wrong
 * thing. If 1 % of your requests take 4 seconds and the rest take 10 ms, the
 * mean is 50 ms — which describes almost none of your traffic. p99 is the
 * number a user actually experiences when they say "this is slow".
 *
 * `PowerHistogram` is a DDSketch: relative-error bounded, so p50 and p99 are
 * both accurate to the configured `relativeAccuracy` regardless of scale. An
 * exact histogram has to fix a bucket width up front, which is either
 * expensive or useless outside the range you guessed.
 */
import { PowerHistogram, PowerEventLoopMonitor } from 'performance-helpers';

const h = new PowerHistogram({ relativeAccuracy: 0.01, maxValue: 10_000 });

// A deliberately lumpy distribution: mostly fast, with a heavy tail. This is
// what almost every real service looks like.
const samples = [];
for (let i = 0; i < 990; i += 1) samples.push(8 + (i % 7));
for (let i = 0; i < 10; i += 1) samples.push(3_500 + i * 50);
for (const v of samples) h.record(v);

console.log('PowerHistogram — 1000 samples, 1% relative error');
console.log('  p50 :', h.percentile(0.5).toFixed(1), 'ms');
console.log('  p90 :', h.percentile(0.9).toFixed(1), 'ms');
console.log('  p99 :', h.percentile(0.99).toFixed(1), 'ms');
console.log('  p999:', h.percentile(0.999).toFixed(1), 'ms');

const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
console.log('\n  the mean is', mean.toFixed(1), 'ms — which describes none of these');
console.log('  requests. The p99 is', h.percentile(0.99).toFixed(1), 'ms.');
console.log('  That gap is the whole reason percentiles exist.\n');

console.log('  snapshot():', h.snapshot(), '\n');

// Relative accuracy means the guarantee holds across scales, which is what
// lets one histogram be used for both microsecond and second timings.
const wide = new PowerHistogram({ relativeAccuracy: 0.01 });
wide.record(0.4);
wide.record(400_000);
console.log('  one histogram, six orders of magnitude:');
console.log('    p0  ~', wide.percentile(0).toFixed(3));
console.log('    p100~', wide.percentile(1).toFixed(0));
console.log('  ^ no bucket width was chosen in advance, so both ends are usable.');

// --- Event loop health ------------------------------------------------------
// Latency you measure inside your own code cannot see the thing that matters
// most: how long the runtime was busy running *other* work. That is what
// `PowerEventLoopMonitor` samples.
const monitor = new PowerEventLoopMonitor({ intervalMs: 5 });
monitor.start();

console.log('\nPowerEventLoopMonitor — 5ms sampling');
await new Promise((r) => setTimeout(r, 30));

// Block the loop and sample across it.
//
// The block is 100 ms rather than 40, and the assertion below asks for 40. A
// 5 ms sampler *under-reports* a stall — it can only observe the gap between
// two of its own ticks, so the figure it records is at most the block length
// minus a tick, and under load rather less. The first version of this example
// blocked for 40 ms and asserted 35, which failed roughly one run in five —
// and it was `test/examples.test.js`, the check added for exactly this
// purpose, that caught it.
await new Promise((r) => {
  setTimeout(() => {
    const end = Date.now() + 100;
    while (Date.now() < end) {
      /* deliberately blocking */
    }
    r();
  }, 0);
});
await new Promise((r) => setTimeout(r, 20));

const stats = monitor.stats();
console.log('  mean:', stats.mean?.toFixed(1) ?? stats.mean, 'ms');
console.log('  p99 :', stats.p99?.toFixed(1) ?? stats.p99, 'ms');
console.log('  max :', stats.max?.toFixed(1) ?? stats.max, 'ms  <- the 100ms block');
console.log('  p50 :', stats.p50?.toFixed(1) ?? stats.p50, 'ms');
console.log('  ^ `max` catching the stall is the useful signal, and `p50` shows why');
console.log('    it is needed: the mean and the median barely move for a single');
console.log('    stall in a long sample window. A blocked event loop is invisible to');
console.log('    per-request instrumentation by definition — you have to be');
console.log('    measuring the loop itself to see it.');

monitor.dispose();

const max = stats.max ?? 0;
if (!(max >= 40)) {
  console.error(`\nFAIL: expected the monitor to observe the stall, saw max=${max}ms.`);
  process.exit(1);
}
console.log('\nOK');
