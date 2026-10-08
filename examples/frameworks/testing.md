# Testing framework integrations

Keep framework tests focused on the adapter boundary. The helper's own
behavior is already covered by its dedicated tests; these checks should prove
that the framework subscribes, renders the current value, and tears down cleanly.

## Scheduled observer updates

`PowerObserver` defaults to microtask delivery and coalesces rapid writes. Use
`flush()` when a test needs deterministic delivery:

```js
const observer = new PowerObserver(0);
const values = [];
const off = observer.subscribe((value) => values.push(value));

observer.value = 1;
observer.value = 2;
observer.flush();

expect(values).toEqual([2]);
off();
observer.dispose();
```

Use `{ async: false }` only when the application genuinely needs one synchronous
notification per write. Do not add arbitrary sleeps to framework tests.

## SSR and hydration snapshots

The server snapshot is the value the client must render during hydration. Keep
that initial value stable, then test scheduled updates separately with
`flush()`:

```js
const initial = { status: 'loading', data: null };
const observer = new PowerObserver(initial);
const serverSnapshot = observer.getServerSnapshot();

expect(observer.getSnapshot()).toBe(serverSnapshot);

observer.value = { status: 'ready', data: 'ok' };
expect(renderedValues).toEqual([]);

observer.flush();
expect(renderedValues).toEqual([{ status: 'ready', data: 'ok' }]);

observer.dispose();
```

For React, pass `getServerSnapshot` as the third argument to
`useSyncExternalStore`. Do not construct browser-only workers, transports, or
their observers during server rendering; create them in a client lifecycle or
behind a capability check.

## Cache expiry without waiting

Inject a clock into `PowerCache` and advance it directly:

```js
let now = 0;
const cache = new PowerCache({ defaultTTL: 100, now: () => now });
cache.set('profile:1', { name: 'Ada' });

now = 100;
expect(cache.get('profile:1')).toBeUndefined();
cache.dispose();
```

The same pattern applies to `PowerTTLMap` and the rate limiters. Their dedicated
guides document the exact expiry boundary and clock option.

## Teardown ownership

Test both sides of the ownership boundary:

- a component or composable unsubscribes without disposing shared state;
- the provider, service, or feature owner disposes the helper exactly once.

After teardown, assert that later helper updates do not reach the destroyed view.
This catches leaked subscriptions without depending on garbage collection.
