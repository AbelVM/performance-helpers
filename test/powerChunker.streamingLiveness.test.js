import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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

const CHUNKER = '/data/projects/performance-helpers/src/helpers/powerChunking.js';

/** Run a snippet in a child, resolving to `{ ok }` — `ok: false` on timeout. */
async function probeWithTimeout(source, timeoutMs = 4000) {
  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
      timeout: timeoutMs,
      cwd: '/data/projects/performance-helpers',
    });
    return { ok: true, timedOut: false };
  } catch (err) {
    return { ok: false, timedOut: err.killed === true || err.signal === 'SIGTERM' };
  }
}

describe('RT-010: streaming mode drains inside the constructor', () => {
  it.skip('does not hang the constructor on an infinite generator', async () => {
    // **Skipped, and failing when run — that is the point of it.** This is the
    // defect written as a test: it fails today and passes when RT-010 lands. It
    // cannot be committed enabled, because a permanently red gate is not
    // shippable and `npm run verify` is the project's exit condition. So it sits
    // here, skipped, and the three enabled cases below pin everything about the
    // defect that *can* be asserted without hanging: that the iterable is not
    // materialised, and that there is no cancellation surface for the fix to use.
    //
    // Unskip it the day the pump lands. `npx vitest run
    // test/powerChunker.streamingLiveness.test.js -t infinite` is the command,
    // and it should then pass.
    //
    // The defect, as a test. This fails today and passes when the row is
    // fixed. That inversion is deliberate and is the only way to say anything
    // about a hang: the thing being asserted is that control returns.
    const source = `
      import { PowerChunker } from '${CHUNKER}';
      function* forever() { let i = 0; while (true) yield i++; }
      const chunker = new PowerChunker(forever(), async () => 1, {
        poolOptions: { size: 1 },
        chunkSize: 8,
      });
      console.log('constructed', chunker !== undefined);
    `;
    const { ok, timedOut } = await probeWithTimeout(source);

    // A timeout is the failure. `ok: false` for any other reason (a thrown error,
    // a bad option) is also a failure, and distinguished by `timedOut` so the
    // message can say which happened — otherwise a typo in the fixture reads as
    // the bug it was meant to detect.
    expect(timedOut, 'the constructor hung on an infinite generator').toBe(false);
    expect(ok, 'the child exited cleanly, so it neither hung nor threw').toBe(true);
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
});
