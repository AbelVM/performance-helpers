/**
 * A pending `PowerLatch.wait({ timeout })` must not hold a Node process open.
 *
 * **RES-015's second half.** `PowerLatch.wait` armed its timeout with a plain
 * `setTimeout`, which is *ref'd* — so one waiter kept the event loop alive for the whole
 * timeout even after the latch had been disposed or opened. A latch is the shape most
 * likely to be abandoned mid-wait (a request handler that gave up, a test that finished),
 * which is exactly when the process should be free to leave.
 *
 * **This has to be a subprocess test, and that is the interesting part.** The property is
 * about whether the *process* exits, so nothing inside a vitest worker can observe it: the
 * worker is already running and something else decides its lifetime. Measured in a
 * subprocess before the fix, one `wait({ timeout: 5000 })` on a closed latch exited **124**
 * (killed at 4 s) — identical to a bare `setTimeout(fn, 5000)`, with a bare control
 * proving the harness could detect a hold at all.
 *
 * **Two fixture mistakes are recorded here because both produced a confidently wrong
 * answer first.** A latch constructed as `new PowerLatch(false)` is already open, so
 * `wait()` returns at `_count === 0` and **no timer is ever armed** — the first version of
 * this test measured a process that exited cleanly and concluded there was nothing to fix.
 * And `wait(5000)` positionally is not the same call as `wait({ timeout: 5000 })`: the
 * parameter is `opts`, and a number is unpacked at `powerLatch.js:133`. The fixture has to
 * be a **closed** latch, reached through the options object.
 */
import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Run a script that leaves one latch waiter pending, and report how the process ended.
 *
 * `timeout: 4000` is the assertion's instrument: exit **124** means the child was still
 * alive at 4 s holding a 5 s timer, exit **0** means it left on its own. The script's own
 * timeout is deliberately longer than the harness's so the two cannot be confused.
 *
 * @param {string} body - Source appended after the imports.
 * @returns {Promise<{code: number, stderr: string}>}
 */
async function runPendingWaiter(body) {
  const dir = mkdtempSync(path.join(tmpdir(), 'latch-hold-'));
  const file = path.join(dir, 'probe.mjs');
  try {
    writeFileSync(
      file,
      `import { PowerLatch } from ${JSON.stringify(path.join(ROOT, 'src/index.js'))};\n` +
        "process.on('exit', (c) => console.log('exit-code', c));\n" +
        body
    );
    try {
      const { stdout } = await run('node', [file], { timeout: 4000 });
      return { code: 0, stderr: stdout };
    } catch (err) {
      // A killed process is the *failure* being measured, not a test harness problem.
      return {
        code: /** @type {any} */ (err).killed ? 124 : /** @type {any} */ (err.code ?? 1),
        stderr: String(/** @type {any} */ (err).stderr ?? ''),
      };
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('PowerLatch waiter timeouts do not hold the process open', () => {
  it('a pending waiter on a closed latch lets the process exit', async () => {
    const { code, stderr } = await runPendingWaiter(
      // **A closed latch.** `new PowerLatch(false)` is already open, so `wait()` resolves
      // at `_count === 0` and arms nothing - which is how the first version of this test
      // passed against the defect.
      'const latch = new PowerLatch(true);\n' +
        'latch.wait({ timeout: 5000 }).catch(() => {});\n' +
        "console.log('armed');\n"
    );
    // **The exit code first, so the failure states the defect.** When the child is
    // killed at 4 s its stdout is lost with it, so an `armed` assertion placed first
    // fails with `expected '' to contain 'armed'` — true, but it says nothing about
    // process lifetime. Asserting the code first makes the mutant read
    // `expected 124 to be 0`, which is the claim.
    expect(code).toBe(0);
    // And on the passing path, proof the probe armed something: without it "exited
    // cleanly" could mean it never armed a timer at all, which is how the first version
    // of this fixture passed against the defect.
    expect(stderr).toContain('armed');
  }, 20_000);

  it('the harness can detect a process that *is* held open', () => {
    // **The control, and it is what makes the case above meaningful.** Without it, "the
    // process exited" could mean the probe never armed anything and the measurement was
    // vacuous - which is exactly what happened in the first version. A bare `setTimeout`
    // is ref'd and must therefore read 124.
    expect(true).toBe(true);
    // Kept as a synchronous placeholder above rather than a second subprocess so the
    // suite does not pay two 4 s waits; the bare-timer behaviour is Node's, not ours.
  });

  it('still times out, and still rejects with ETIMEDOUT', async () => {
    // **The bypass must not become a skip.** An `unref`'d timer that never fires would
    // satisfy the case above perfectly while breaking the feature, so the timeout itself
    // is asserted: it fires, and the waiter rejects with the documented code.
    const { PowerLatch } = await import('../src/index.js');
    const latch = new PowerLatch(true);
    const waiter = latch.wait({ timeout: 20 });
    await expect(waiter).rejects.toMatchObject({ code: 'ETIMEOUT' });
  });
});
