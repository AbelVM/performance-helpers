/**
 * TEST-003: `WorkerAgnostic`'s browser string-source path.
 *
 * The row records `WorkerAgnostic.js` at 73.42% branch coverage against an 80%
 * target, and separates the reasons: the pure-ESM lines are unreachable in
 * process (correct), while the rest is a category error (correct). This file
 * takes the second half.
 *
 * `createWebWorkerFromString` decides *where* a string worker source resolves
 * from. Under a `new URL(source, baseUrl)` — which is how a browser resolves a
 * relative worker path — getting this wrong means the worker 404s, and a 404 from
 * a worker constructor is indistinguishable from a typo in the path.
 *
 * It used to look for a base in three places, starting with `import.meta.url`.
 * **That first one was dead**, and this file's header asserted otherwise until
 * `WRK-001`: `new Function(...)` evaluates in global scope, so `import.meta` is a
 * syntax error there and the branch always returned `undefined`. The bases that
 * actually run are `document.currentScript.src` and then `location.href` — and in
 * a `<script type="module">` the first is `null` by spec, so the module's own URL
 * is never used. The fix is `options.baseUrl`, because the module URL is
 * unreachable from that code rather than merely awkward to get.
 *
 * All three fallbacks run under Node with a `Worker` stub, so this needs no
 * browser and no jsdom. What it does need is a global `Worker`, which is
 * exactly the environment the class exists to bridge.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WorkerAgnostic, { detectEnv } from '../src/helpers/WorkerAgnostic.js';

/** A `Worker` that records what it was constructed with, and where. */
function makeFakeWorker() {
  const constructed = [];
  class FakeWorker {
    constructor(source, options) {
      constructed.push({ source: String(source), options });
    }
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  }
  FakeWorker.constructed = constructed;
  return FakeWorker;
}

let FakeWorker;

beforeEach(() => {
  FakeWorker = makeFakeWorker();
  vi.stubGlobal('Worker', FakeWorker);
  // `window` is load-bearing: `detectEnv` calls an environment a browser only
  // when `window` *and* `document` are both present, and the string-source path
  // takes the browser branch only then. Stub `document` alone and the source
  // goes through the `node` arm instead, which is a silent difference — the
  // same test passes while exercising the other branch.
  vi.stubGlobal('window', { document: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // `delete`, not an assignment to `undefined`: `typeof location` is the thing
  // under test and an `undefined` property is not the same as an absent one.
  for (const key of ['document', 'location', 'window', 'self']) {
    delete globalThis[key];
  }
  vi.resetModules();
});

describe('string worker sources in a browser environment', () => {
  it('resolves a relative source against the currentScript', () => {
    vi.stubGlobal('document', { currentScript: { src: 'https://app.example/assets/app.js' } });
    vi.stubGlobal('location', { href: 'https://app.example/page' });
    const w = new WorkerAgnostic('./workers/task.js');
    expect(w.worker).toBeInstanceOf(FakeWorker);
    // A `URL`, not a bare string: this is the resolution a browser performs
    // before fetching, and passing the raw string through would make the
    // browser resolve it against the *document* instead of the bundle — which
    // works until the app is served from a subpath, and then does not.
    expect(FakeWorker.constructed[0].source).toBe('https://app.example/assets/workers/task.js');
  });

  it('falls back to location.href when there is no currentScript', () => {
    // A document with a null `currentScript` is the normal shape for a module
    // script, so this is the common case rather than the rare one.
    vi.stubGlobal('document', { currentScript: null });
    vi.stubGlobal('location', { href: 'https://app.example/index.html' });
    new WorkerAgnostic('./task.js');
    expect(FakeWorker.constructed[0].source).toBe('https://app.example/task.js');
  });

  it('resolves against an explicit baseUrl, which is the only way in a module script', () => {
    // `WRK-001`. In a `<script type="module">` `document.currentScript` is
    // `null` per the HTML spec, and the module's own URL is unreachable from
    // inside a `new Function` — that evaluates in global scope, where
    // `import.meta` is a syntax error. So the automatic fallbacks resolve a
    // module-relative worker path against the **page**, and the worker 404s with
    // an error that reads as a typo. The caller knows where its module is, and
    // this is the only honest way to let it say so.
    vi.stubGlobal('document', { currentScript: null });
    vi.stubGlobal('location', { href: 'https://app.example/index.html' });

    // Without the option, the page is the base — the wrong one here, which is the
    // whole defect. Asserted first so the next assertion has a contrast.
    new WorkerAgnostic('./workers/task.js');
    expect(FakeWorker.constructed[0].source).toBe('https://app.example/workers/task.js');

    new WorkerAgnostic('./workers/task.js', { baseUrl: 'https://cdn.example/app/main.js' });
    expect(FakeWorker.constructed[1].source).toBe('https://cdn.example/app/workers/task.js');
  });

  it('prefers baseUrl over currentScript when both are available', () => {
    // An explicit base must win even where the automatic one would have worked,
    // or the option is only usable in the case that is already broken.
    vi.stubGlobal('document', { currentScript: { src: 'https://app.example/assets/app.js' } });
    vi.stubGlobal('location', { href: 'https://app.example/index.html' });
    new WorkerAgnostic('./task.js', { baseUrl: 'https://cdn.example/bundle.js' });
    expect(FakeWorker.constructed[0].source).toBe('https://cdn.example/task.js');
  });

  it('passes the raw string through when no base URL can be found', () => {
    // No document, no location: the environment could not tell us anything, so
    // the source goes through unchanged and the environment decides. Passing an
    // invented `about:blank` base would be worse — it would resolve to a URL
    // the browser cannot fetch from, turning "no context" into "404".
    new WorkerAgnostic('./task.js');
    expect(FakeWorker.constructed[0].source).toBe('./task.js');
  });

  it('falls back to the plain string when URL resolution is refused', () => {
    // A source that `new URL()` cannot resolve — a bare token, say. The
    // browser's own `Worker(string)` may still accept it, so the fallback is
    // "try it", not "give up", and the throw is swallowed deliberately.
    new WorkerAgnostic('not-a-relative-path');
    expect(FakeWorker.constructed[0].source).toBe('not-a-relative-path');
  });

  it('detects this environment as a browser', () => {
    // The whole reason the string-source path is reachable at all: without a
    // `document` the class would take the Node branch and try to resolve a
    // browser path through `worker_threads`, which cannot fetch anything.
    vi.stubGlobal('document', { currentScript: null });
    expect(detectEnv()).toBe('browser');
  });

  it('a worker-global document does not make this a browser', () => {
    // A web worker has `self` and may have a `document` object in some
    // environments; what distinguishes it is the absence of `window`. Getting
    // this wrong routes a worker global through `createWebWorkerFromString`,
    // which needs a `Worker` constructor that a worker global does not have.
    delete globalThis.window;
    vi.stubGlobal('self', { importScripts: () => {} });
    vi.stubGlobal('document', {});
    expect(detectEnv()).not.toBe('browser');
  });
});
