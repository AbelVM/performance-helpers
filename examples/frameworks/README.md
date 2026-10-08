# Framework integrations

These snippets show where `performance-helpers` belongs in common UI
frameworks. The repository does not install React, Vue, or Angular, so they are
copyable integration examples rather than executable examples.

All three use `PowerObserver` as the small reactive boundary. The same
ownership rule applies to `PowerCache`, `PowerPool`, limiters, and transports:
create them at the feature/provider/service boundary, and dispose only the
instance whose lifetime you own.

- [React](react.jsx) uses `useSyncExternalStore` and a stable observer.
- [Vue](vue.js) uses a composable and `onScopeDispose`.
- [Angular](angular.ts) uses an injectable service and `DestroyRef`.
- [Request recipes](recipes.md) show caching, loading, errors, and teardown in
  all three frameworks.
- [Testing](testing.md) covers scheduled updates, fake clocks, and ownership.

`PowerObserver` uses microtask delivery by default and coalesces rapid writes.
Call `flush()` in deterministic tests; use `{ async: false }` only when
synchronous notifications are part of the application contract. For SSR,
React consumers should pass `getServerSnapshot`; browser-only workers and
transports should be constructed from a client-only lifecycle or after a
capability check.

The runnable [frameworks.mjs](../frameworks.mjs) smoke example verifies the
subscribe, update, and dispose lifecycle without requiring a framework
installation.
