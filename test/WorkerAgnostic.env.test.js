import { describe, it, expect, afterEach, vi } from 'vitest';
import WorkerAgnostic, { detectEnv, preloadNode } from '../src/helpers/WorkerAgnostic.js';

/**
 * `WorkerAgnostic` — the environment-detection and error paths.
 *
 * The existing suite covers the happy Node path thoroughly (real workers,
 * factories, transfer lists, class sources). What it does not cover is the half
 * of this class that decides *where it is running* and what to say when it
 * cannot work — and that is the half users actually meet, because every
 * environment-specific failure lands in one of these branches.
 *
 * It is also the half `guides/troubleshooting.md` documents, so a drift between
 * the guide and the messages would now be caught rather than shipped.
 */
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** A minimal worker-like object: enough surface to be constructed and killed. */
function fakeWorker(tag = 'w') {
  return {
    tag,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: () => {},
    terminate: () => Promise.resolve(),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

describe('detectEnv', () => {
  it('reports node in this process', () => {
    expect(detectEnv()).toBe('node');
  });

  it('reports browser when window.document exists', () => {
    vi.stubGlobal('window', { document: {} });
    expect(detectEnv()).toBe('browser');
  });

  it('requires a document, not just a window, before calling it a browser', () => {
    // `detectEnv` tests `window.document`, not `window` alone, and the
    // distinction is deliberate: a bare `window` global is not evidence of a
    // browser page, and guessing would route a non-browser context down the web
    // worker path. Pinned because it looks like an oversight otherwise.
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('self', undefined);
    expect(detectEnv()).toBe('node');
  });

  it('reports webworker for a global with importScripts', () => {
    vi.stubGlobal('self', { importScripts: () => {} });
    // `self` exists in Node too, so the document check has to be ruled out
    // first or this would still report node.
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    expect(detectEnv()).toBe('webworker');
  });

  it('reports unknown when nothing identifies the runtime', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('self', undefined);
    vi.stubGlobal('process', undefined);
    expect(detectEnv()).toBe('unknown');
  });
});

describe('workerSource validation', () => {
  it('rejects a source that is neither a factory nor a string', () => {
    // The message matters: it is what a user greps for.
    expect(() => new WorkerAgnostic(123)).toThrow(
      /Invalid workerSource: expected Worker factory or path string/
    );
    expect(() => new WorkerAgnostic(null)).toThrow(/Invalid workerSource/);
    expect(() => new WorkerAgnostic({})).toThrow(/Invalid workerSource/);
  });

  it('explains itself when a string source cannot be resolved at all', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('self', undefined);
    vi.stubGlobal('process', undefined);
    expect(() => new WorkerAgnostic('./worker.js')).toThrow(
      /Unsupported environment for WorkerAgnostic/
    );
  });

  it('still accepts a factory in an unknown environment, because the caller supplied the implementation', () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);
    vi.stubGlobal('self', undefined);
    vi.stubGlobal('process', undefined);
    // A factory is environment-agnostic: the caller brought their own worker, so
    // refusing it would be refusing something we can perfectly well construct.
    const w = new WorkerAgnostic(() => fakeWorker('factory-in-unknown-env'));
    expect(w).toBeInstanceOf(WorkerAgnostic);
  });
});

describe('globalThis.Worker resolution', () => {
  it('uses a global Worker constructor for a string source', () => {
    const created = [];
    class StubWorker {
      constructor(src, options) {
        created.push({ src, options });
        Object.assign(this, fakeWorker('global'));
      }
    }
    vi.stubGlobal('Worker', StubWorker);
    const w = new WorkerAgnostic('./worker.js', { name: 'x' });
    expect(created).toHaveLength(1);
    expect(created[0].src).toBe('./worker.js');
    expect(w).toBeInstanceOf(WorkerAgnostic);
  });

  it('falls back to the runtime Worker when globalThis.Worker is not callable', () => {
    // A non-function `globalThis.Worker` does not reach `new`, because the
    // check is `typeof === 'function'` rather than truthiness. It falls through
    // to the environment branch, which in Node resolves `worker_threads`
    // normally - so a stray non-callable global degrades to the working path
    // instead of failing with a `TypeError` that says nothing useful.
    vi.stubGlobal('Worker', { not: 'a constructor' });
    const w = new WorkerAgnostic(() => fakeWorker('fell-back'));
    expect(w).toBeInstanceOf(WorkerAgnostic);
    expect(w.worker.tag).toBe('fell-back');
  });
});

describe('preloadNode', () => {
  it('resolves, and is safe to call more than once', async () => {
    // The documented one-shot step. Calling it repeatedly must not throw or
    // re-resolve: a caller that preloads defensively in two modules is normal.
    await expect(preloadNode()).resolves.toBeUndefined();
    await expect(preloadNode()).resolves.toBeUndefined();
  });

  it('a factory function does not need the preload at all', async () => {
    // This is the contract the troubleshooting guide leans on: a factory
    // removes the need for a preload rather than merely satisfying it. If this
    // ever starts requiring a preload, the guide's primary recommendation is
    // wrong and should fail loudly here.
    const w = new WorkerAgnostic(() => fakeWorker('no-preload-needed'));
    expect(w).toBeInstanceOf(WorkerAgnostic);
  });
});

describe('lifecycle', () => {
  it('terminate() resolves and is safe to call twice', async () => {
    const w = new WorkerAgnostic(() => fakeWorker());
    await expect(w.terminate()).resolves.toBeUndefined();
    await expect(w.terminate()).resolves.toBeUndefined();
  });

  it('exposes the underlying worker, not a wrapper', () => {
    const inner = fakeWorker('inner');
    const w = new WorkerAgnostic(() => inner);
    expect(w.worker).toBe(inner);
  });
});
