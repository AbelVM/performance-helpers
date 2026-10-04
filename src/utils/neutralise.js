/**
 * Neutralise a method on an instance, idempotently.
 *
 * Six helpers ship a `dispose()` whose job is to be callable twice, and each
 * spelled the same shadowing line by hand:
 *
 * ```js
 * this.reset = () => {};
 * ```
 *
 * That has two costs. A **second** `dispose()` re-assigns, so it allocates a
 * *fresh* arrow — two calls produce two different functions for the same method,
 * and anything holding a reference across disposal sees it swapped out from
 * underneath. And the own property it leaves behind is **enumerable**, so the
 * instance's shape changes at disposal: `for...in`, `Object.assign`, a spread
 * and a JSON serialisation all start reporting a `reset` that was not there
 * before.
 *
 * `defineProperty` fixes the second by making the shadow non-enumerable, and the
 * `hasOwnProperty` guard fixes the first by making the call a genuine no-op the
 * second time round.
 *
 * One thing this deliberately does **not** do is hide the property from
 * `Object.getOwnPropertyNames`. The method still exists — that is the point, since
 * a second `dispose()` must not throw — so an exact-reflection tool will still see
 * it. Deleting it, or assigning `undefined`, would turn every post-disposal call
 * into a `TypeError`, which is a louder failure than the one being fixed.
 *
 * @param {any} instance - The object whose method is being neutralised.
 * @param {string} name - The method name.
 * @returns {void}
 */
export function neutralise(instance, name) {
  // `Object.hasOwn` would read better and is not available on every runtime this
  // library supports, hence the `call`.
  if (Object.prototype.hasOwnProperty.call(instance, name)) return;
  Object.defineProperty(instance, name, {
    value: () => {},
    enumerable: false,
    writable: true,
    configurable: true,
  });
}
