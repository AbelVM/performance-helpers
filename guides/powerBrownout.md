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
