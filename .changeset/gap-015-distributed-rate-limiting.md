---
'performance-helpers': minor
---

Add distributed rate limiting via a user-supplied `sharedState` adapter. The adapter is consulted before the local legs, and on backend error the limiter degrades according to `degrade`: `'local'` falls back to local legs only, `'fail-closed'` refuses the request. The path taken is exposed through `stats().path` and the `lastPath` getter. This respects REJ-008: the user brings the client, and the N-is-unknown case is handled by the external store.
