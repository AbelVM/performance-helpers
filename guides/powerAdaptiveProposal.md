# PowerAdaptiveProposal

`PowerAdaptiveProposal` turns a bounded feedback signal into an explainable
value proposal. It does not apply the proposal to a pool, limiter, or queue;
the caller remains responsible for accepting or rejecting it.

```javascript
import { PowerAdaptiveProposal } from 'performance-helpers/powerAdaptiveProposal';

const controller = new PowerAdaptiveProposal({
  initial: 8,
  min: 1,
  max: 32,
  maxStep: 2,
  hysteresis: 0.25,
  cooldown: 1,
});

controller.propose(1.5); // congestion: { value: 6.5, changed: true, ... }
controller.propose(-1); // cooldown: held for one observation
controller.rollback(8); // restore a known-good value
```

Positive signals reduce the value, negative signals increase it, and signals
inside `hysteresis` hold steady. Bounds, step size, cooldown, and rollback make
the controller suitable for opt-in adaptation without hidden policy or
unbounded oscillation. Each result includes `reason`, `confidence`, and
`cooldown` fields for telemetry.

Use `snapshot()` and `restore(snapshot)` to carry bounded controller state
across a restart. Restore validates the saved value and cooldown against the
current controller bounds.

| Option       |    Default | Meaning                             |
| ------------ | ---------: | ----------------------------------- |
| `initial`    |        `1` | Starting value                      |
| `min`        |        `1` | Lower bound                         |
| `max`        |      `100` | Upper bound                         |
| `maxStep`    | `Infinity` | Maximum change per proposal         |
| `hysteresis` |        `0` | Signal deadband                     |
| `cooldown`   |        `0` | Observations to hold after a change |
