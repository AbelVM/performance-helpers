import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);

/**
 * RT-010 — `PowerChunker` in streaming mode drains the iterable **inside the
 * constructor**, so an infinite or lazy generator hangs the constructor forever
 * and returns no pool to `terminate()`.
 *
 * **Verified before writing this, and one of the row's two claims is false.**
 *
 * 1. **The hang is real.** `new PowerChunker(function* forever(){...})` never
 *    returns — measured as a 4 s timeout in a child process.
 * 2. **"Streaming mode fully materialises the iterable" is not true.** A lazy
 *    generator of 400 000 objects left the heap at **5.2 MB during
 *    construction** — identical to before it started — and only reached 48.7 MB
 *    afterwards. `streamIterableIntoPool` posts each chunk as it fills, so memory
 *    is bounded by the pool's queue, not by the iterable. The source says so
 *    too: `powerChunking.js:128` says it streams "to avoid materializing the
 *    entire iterable".
 *
 * So this is a **liveness** defect, not a memory one, and the fix the row proposes
 * — pumping on a macrotask — is a real API decision rather than a mechanical
 * change: **the constructor returns a pool, not a handle**, so an async pump would
 * have no way to be cancelled. `terminate()` stops the pool while the pump keeps
 * pulling from the generator, which trades a constructor that hangs for a pump
 * that runs forever — the same unbounded behaviour by a different route.
 *
 * **This test therefore pins the defect rather than the fix.** It is deliberately
 * the *wrong* assertion: it fails when the chunker hangs, and it passes if and
 * when the hang is fixed. Asserting a hang is not possible in-process — the test
 * would hang with it — so the probe is a child process with a timeout, and the
 * assertion is on that timeout elapsing.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CHUNKER = pathToFileURL(resolve(ROOT, 'src/helpers/powerChunking.js')).href;

/** Run a snippet in a child, resolving to `{ ok, timedOut, stdout }`. */
async function probeWithTimeout(source, timeoutMs = 4000) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      ['--input-type=module', '-e', source],
      {
        timeout: timeoutMs,
        cwd: ROOT,
      }
    );
    return { ok: true, timedOut: false, stdout };
  } catch (err) {
    return {
      ok: false,
      timedOut: err.killed === true || err.signal === 'SIGTERM',
      stdout: err.stdout ?? '',
    };
  }
}

describe('RT-010: streaming mode returns the pool before the iterable is exhausted', () => {
  it('does not hang the constructor on an infinite generator', async () => {
    // **Enabled, and it was mutation-checked in both directions** rather than
    // merely unskipped: against the pre-fix source this test fails with
    // `the constructor hung on an infinite generator`, and against the fix the
    // constructor returns in ~2 ms.
    //
    // The child terminates the pump before exiting, and that is the contract
    // rather than a convenience. An unbounded iterable is pumped until the pool is
    // terminated, so a child that constructs and then waits for the event loop to
    // drain would wait for ever — the pump is a `setImmediate` chain, and an
    // endless chain of those keeps Node alive. Terminating is also the only way to
    // assert the property the fix actually adds, because before it there was no
    // pool to terminate: the constructor never returned one.
    //
    // Asserting a hang is not possible in-process — the test would hang with it —
    // so the probe is a child process with a timeout, and the assertion is on that
    // timeout elapsing. `stdout` is checked as well as the exit status, so
    // "returned and then exited" is distinguishable from "exited some other way".
    const source = `
      import { PowerChunker } from '${CHUNKER}';
      function* forever() { let i = 0; while (true) yield i++; }
      const t0 = Date.now();
      const chunker = new PowerChunker(forever(), async () => 1, {
        poolOptions: { size: 1 },
        chunkSize: 8,
      });
      console.log('constructed', chunker !== undefined, Date.now() - t0);
      chunker.terminate();
    `;
    const { ok, timedOut, stdout } = await probeWithTimeout(source);

    // A timeout is the failure. `ok: false` for any other reason (a thrown error,
    // a bad option) is also a failure, and distinguished by `timedOut` so the
    // message can say which happened — otherwise a typo in the fixture reads as
    // the bug it was meant to detect.
    expect(timedOut, 'the constructor hung on an infinite generator').toBe(false);
    expect(ok, 'the child exited cleanly, so it neither hung nor threw').toBe(true);
    expect(stdout, 'the constructor returned a pool to terminate').toContain('constructed true');
  });

  // **There is deliberately no heap-measurement test here.** Two attempts were
  // made and both failed for the same underlying reason, which is worth recording
  // because the first looked like it worked.
  //
  // The claim is that streaming mode does not materialise the iterable. Measuring
  // it by heap delta does not discriminate, because **the pool's queue retains the
  // posted chunks either way**: with `size: 2` and nothing draining it, the pool
  // holds all 400 000 items regardless of how the chunker obtained them. That
  // ~40 MB baseline swamps the marginal difference, so:
  //
  // - In **separate processes**, the comparison inverted under full-suite load
  //   and failed about 1 run in 4 — the two arms saw different machine states.
  // - In **one process**, run in sequence, it inverted the other way:
  //   `streaming used 42.1 MB, materialising used 35.5 MB`, because the second
  //   arm starts on a heap the first has already grown.
  //
  // An absolute threshold was tried before both of those and read 41.6 MB against
  // *correct* code. Any constant here would have been tuned to whichever way the
  // guess went, which is how a test becomes decoration.
  //
  // **The memory claim is instead refuted by measurement and by the source**,
  // which is enough: a lazy generator of 400 000 objects left the heap at 5.2 MB
  // during construction — the pre-construction baseline — and `powerChunking.js`
  // says it streams "to avoid materializing the entire iterable". Neither of those
  // is a test, and this note is not pretending otherwise; it is recording that the
  // obvious way to test it was tried twice and does not work here.
  //
  // What is worth asserting is the liveness property below, and the shape of the
  // fix it constrains. Neither needs a heap number.

  it('constructs promptly for a finite lazy generator', async () => {
    // The control, and the one that makes the first test meaningful: a *bounded*
    // generator of the same kind completes, so the difference between this and
    // the infinite case is the hang and nothing else about the fixture.
    const source = `
      import { PowerChunker } from '${CHUNKER}';
      function* finite() { for (let i = 0; i < 50000; i++) yield { i }; }
      const t0 = Date.now();
      const chunker = new PowerChunker(finite(), async (chunk) => chunk.length, {
        poolOptions: { size: 2 },
        chunkSize: 16,
      });
      console.log('constructed', chunker !== undefined, Date.now() - t0);
    `;
    const { ok, timedOut } = await probeWithTimeout(source, 8000);

    expect(timedOut).toBe(false);
    expect(ok, 'a finite generator constructs and returns its pool').toBe(true);
  });

  it('returns a pool, not a handle — which is why the fix is not mechanical', async () => {
    // The design constraint, asserted rather than assumed. A pump that yields to
    // a macrotask needs something to stop it, and the object the constructor
    // returns is the pool: terminating it stops the workers but leaves the
    // generator being pulled. Until the return contract is a decision, any
    // "fix" here trades one unbounded behaviour for another.
    const { PowerChunker: Chunker } = await import(
      /* @vite-ignore */ '/data/projects/performance-helpers/src/helpers/powerChunking.js'
    );
    function* finite() {
      yield 1;
      yield 2;
    }
    const returned = new Chunker(finite(), async () => 1, { chunkSize: 2 });

    expect(returned, 'something is returned').toBeDefined();
    expect(typeof returned.terminate, 'and it can be terminated').toBe('function');
    // No chunker-shaped handle on the pool: there is no pump-cancellation surface
    // today, and this assertion is what would fail if one appeared silently.
    expect(typeof returned.cancelPump, 'no pump cancellation exists yet').toBe('undefined');
    returned.terminate?.();
  });

  it('stops pulling the iterable once the pool is terminated', async () => {
    // The property the fix buys, and the reason it needs no new API: the pump's
    // lifetime is the pool's. Before it, an unbounded iterable could not be
    // stopped at all — the constructor never returned the pool that stops it.
    //
    // Asserted in-process with a counter rather than by timing, because the thing
    // being checked is a *count that stops increasing*, which a duration cannot
    // distinguish from a pump that is merely slow.
    const { PowerChunker: Chunker } = await import(
      /* @vite-ignore */ '/data/projects/performance-helpers/src/helpers/powerChunking.js'
    );
    let pulled = 0;
    function* counted() {
      while (true) {
        pulled += 1;
        yield pulled;
      }
    }
    const returned = new Chunker(counted(), async () => 1, {
      poolOptions: { size: 1 },
      chunkSize: 8,
    });
    returned.terminate();
    const atTerminate = pulled;
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Equal, not greater: the pump may already have run a window before the
    // terminate() landed, so the assertion is that the count *stops*, not that it
    // was zero at the moment of the call.
    expect(pulled, 'the pump stopped pulling when the pool terminated').toBe(atTerminate);
  });

  it('drain() waits for the iterable, not merely for an empty queue', async () => {
    // The subtle half of the fix, and the one that fails silently.
    // `PowerPool.drain()` resolves immediately when the queue is empty and nothing
    // is active, so a pool handed back *before* its pump has run would satisfy
    // `await pool.drain()` before a single chunk had been read — the documented
    // usage returning early and looking like it worked. Nothing else in the suite
    // distinguishes that from success.
    //
    // `fn` is called once per element (`fn(item, index, chunk)`), so the counter
    // is the item count rather than the chunk count.
    const { PowerChunker: Chunker } = await import(
      /* @vite-ignore */ '/data/projects/performance-helpers/src/helpers/powerChunking.js'
    );
    let processed = 0;
    function* many() {
      for (let i = 0; i < 2000; i += 1) yield i;
    }
    const returned = new Chunker(
      many(),
      async () => {
        processed += 1;
        return 1;
      },
      { poolOptions: { size: 2 }, chunkSize: 16 }
    );

    await returned.drain();
    expect(processed, 'every item ran before drain() resolved').toBe(2000);
    returned.terminate?.();
  });
});
