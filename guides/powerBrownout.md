# PowerBrownout

`PowerBrownout` is a small caller-controlled policy for shedding optional work under pressure. It does not decide which application operations are optional; callers name the kinds they want to protect.

```js
import { PowerBrownout, getResourcePressure } from 'performance-helpers';

const brownout = new PowerBrownout({ threshold: 0.8, disabledKinds: ['prefetch'] });
const pressure = getResourcePressure({ eventLoopPressure: monitor.stats().eventLoopPressure });
if (pressure !== null) brownout.setPressure(pressure);

if (brownout.allows('prefetch')) await prefetch();
```

`getResourcePressure` reads Node heap pressure when available and combines it with an optional normalized event-loop signal. It never starts a sampler. `stats()` reports the current pressure, threshold, disabled kinds, decisions, and shed count.

## Adaptive threshold

Pass `adaptive: true` (or an options object) to let the threshold track observed
pressure instead of staying fixed. When pressure is at or above the current
threshold the helper is shedding, so the threshold is lowered (multiplicative
decrease) to shed more aggressively next time; when pressure is below the
threshold the helper is allowing work, so the threshold is raised (additive
increase) to shed less. The result is clamped to `[min, max]` (defaults `0` and
`1`).

```js
const brownout = new PowerBrownout({
  threshold: 0.8,
  adaptive: { alpha: 0.2, min: 0.3, max: 0.95, additiveIncrease: 0.05, beta: 0.8 },
});
```

`stats()` then reports `baseThreshold` (the configured value), `adaptive: true`,
and `pressureEwma` (the EWMA of observed pressure) in addition to the effective
`threshold`.
