---
'performance-helpers': patch
---

Hide `_`-prefixed private members from generated `.d.ts` files via a post-processing script, reducing the published type surface. `_metrics` is preserved because it is deliberately emitted as a plain object type. Update the consumer type test and the metrics runtime test to stop reaching into private state.
