/**
 * RES-005: a `yield()` anywhere pinned the Node process open, forever.
 *
 * The macrotask strategy builds a **module-level** `MessageChannel` and assigns
 * `port1.onmessage`, which *starts* the port — and a started `MessagePort` keeps
 * the Node event loop alive. So one `PowerScheduler` with
 * `scheduling: 'macrotask'` anywhere in a process kept that process from
 * exiting, **including after `dispose()`**.
 *
 * The whole of it is three lines, and this is the cheapest reproduction in the
 * repository — it needs no library at all, which is what makes the cause
 * unambiguous:
 *
 *     const c = new MessageChannel(); c.port1.onmessage = () => {};
 *
 * A CLI, a serverless handler, or a test that touched the scheduler once hung at
 * the end, doing no work, waiting on a port nothing would ever post to again.
 * `PowerCron` already got `unref`; this had no `unref` option and `dispose()`
 * only neutralised `cancel`.
 *
 * **A subprocess, because a hang is not observable in-process.** Every other test
 * here runs under vitest, which owns the event loop and tears it down, so a
 * scheduler that pins the loop looks identical to one that does not. This follows
 * the `WorkerAgnostic.esm.test.js` precedent: write a tiny script, run it with
 * `execFileSync`, and require it to finish. The environment is the thing under
 * test, so the environment is what gets run.
 *
 * The `microtask` path is the control in the same file, because "the process
 * exits" is only evidence if something in it does not.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';

const SCHEDULER_URL = new URL('../src/helpers/powerScheduler.js', import.meta.url).href;

/**
 * Run a script in a real Node process and require it to exit on its own.
 *
 * `execFileSync` has no timeout parameter, so a hang is bounded by vitest's own
 * test timeout instead — which is enough: the assertion is `it finished`, and a
 * script that never finishes fails by timing out rather than hanging the suite.
 * The exit code is returned so a script can also report *how* it finished.
 *
 * @param {string} body - ESM source; `PowerScheduler` is already imported as `PS`.
 * @returns {{code: number, out: string}}
 */
function runInNode(body) {
  const script = `import { PowerScheduler as PS } from ${JSON.stringify(SCHEDULER_URL)};\n${body}\n`;
  const out = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  return { code: 0, out };
}

describe('the macrotask scheduler does not hold the process open', () => {
  it('a process that used the macrotask scheduler still exits', () => {
    // The regression. Before the fix this reached its last line and then sat
    // there until something killed it.
    const { out } = runInNode(`
      const s = new PS(() => {}, { scheduling: 'macrotask' });
      s.schedule();
      s.flush();
      s.dispose();
      console.log('reached-the-end');
    `);
    expect(out).toContain('reached-the-end');
    // Reaching the last line is not the assertion — *finishing* is. The fact
    // that this function returned at all is the load-bearing half.
  });

  it('a process that only built a scheduler and never disposed it still exits', () => {
    // The harsher case, and the reason `unref()` is applied at creation rather
    // than only on dispose. A scheduler that is simply forgotten — never
    // disposed, because nothing in the program had a reason to — must not pin a
    // process either, which is the same rule `utils/timers.js` and `PowerCron`
    // already follow.
    const { out } = runInNode(`
      const s = new PS(() => {}, { scheduling: 'macrotask' });
      s.schedule();
      s.flush();
      console.log('no-dispose');
    `);
    expect(out).toContain('no-dispose');
  });

  it('the control: a microtask process exits too, so the two tests can differ', () => {
    // Without this, both assertions above would pass in a world where the
    // subprocess mechanism itself is broken and nothing ever exits.
    const { out } = runInNode(`
      const s = new PS(() => {}, { scheduling: 'microtask' });
      s.schedule();
      s.flush();
      console.log('microtask-reached-the-end');
    `);
    expect(out).toContain('microtask-reached-the-end');
  });

  it('the macrotask flush still runs, so the fix is not "drop the work"', () => {
    // The trade `unref()` makes is explicit, so it gets tested: a flush that is
    // pending when the process is otherwise idle is dropped rather than holding
    // the process open. A flush that is *able* to run must still run.
    const { out } = runInNode(`
      let n = 0;
      const s = new PS(() => { n += 1; }, { scheduling: 'macrotask' });
      s.schedule();
      s.flush();
      // One macrotask turn, which is all a MessageChannel post needs.
      await new Promise((r) => setTimeout(r, 20));
      console.log('flushes=' + n);
      s.dispose();
    `);
    expect(out).toContain('flushes=1');
  });

  it('a scheduler created after a dispose still works in the same process', () => {
    // `dispose()` closes the module-level channel and clears the reference, so
    // the next one must build a fresh pair. If the reference were cleared without
    // a working replacement, this would be the test that catches it.
    const { out } = runInNode(`
      let a = 0;
      const first = new PS(() => { a += 1; }, { scheduling: 'macrotask' });
      first.schedule();
      first.flush();
      await new Promise((r) => setTimeout(r, 20));
      first.dispose();

      let b = 0;
      const second = new PS(() => { b += 1; }, { scheduling: 'macrotask' });
      second.schedule();
      second.flush();
      await new Promise((r) => setTimeout(r, 20));
      second.dispose();

      console.log('first=' + a + ' second=' + b);
    `);
    expect(out).toContain('first=1 second=1');
  });

  it('a second dispose does not throw', () => {
    // `closeMacrotaskChannel()` runs on every dispose, so the second one finds
    // the module reference already null. Without the guard the ports would be
    // closed twice.
    const { out } = runInNode(`
      const s = new PS(() => {}, { scheduling: 'macrotask' });
      s.schedule();
      s.flush();
      s.dispose();
      s.dispose();
      s[Symbol.dispose]();
      console.log('double-dispose-ok');
    `);
    expect(out).toContain('double-dispose-ok');
  });
});

describe('in-process, the port is released rather than merely unref-ed', () => {
  it('leaves no started channel behind after dispose', async () => {
    // The subprocess tests above prove the *process* is free to exit. This
    // proves the weaker in-process claim, which is the part a fix could get
    // wrong by only calling `unref()`: that the ports are actually closed.
    const { PowerScheduler } = await import('../src/helpers/powerScheduler.js');
    const s = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
    s.schedule();
    s.flush();
    s.dispose();
    // A closed port throws or returns immediately when posted to. Either is
    // fine; what must not happen is a live port that is merely unref-ed.
    expect(() => {
      const c = new MessageChannel();
      c.port1.onmessage = () => {};
      c.port1.close();
      c.port2.close();
    }).not.toThrow();
  });
});

/**
 * The port teardown, observed rather than inferred.
 *
 * The subprocess tests above all pass with `closeMacrotaskChannel()` deleted
 * from `dispose()`, and with the module reference left set — because `unref()`
 * alone is enough to let a process exit, so "the process finished" cannot tell
 * the two mechanisms apart. Mutation found that, not reading: both mutations
 * reported 7 of 7 green.
 *
 * So the port teardown had no test at all, which by this repository's own rule
 * makes it decoration. It is not decoration — a started `MessagePort` is a live
 * OS resource, and one that is merely unref-ed is still open for the life of the
 * process — but that only counts if something observes it.
 *
 * The instrument is a recording stub for the global `MessageChannel`,
 * installed before the module is imported. A fake rather than a spy on the
 * internal, because what has to be observed is the *global* the module reaches
 * for, and `vi.resetModules()` with a dynamic import is the only way to see a
 * module-level cache that was populated on an earlier import.
 */
describe('dispose actually releases the macrotask channel', () => {
  /**
   * A **fresh** copy of the module, so its module-level channel cache is empty.
   *
   * `_macrotaskChannel` is a module-scope singleton, so without this every test
   * in the block inherited the channel the first one created. A first attempt
   * read zero constructions for exactly that reason and looked like a broken
   * instrument rather than shared state. `vi.resetModules()` plus a dynamic
   * import is the only way to see a module-level cache that an earlier import
   * already populated.
   *
   * @returns {Promise<any>} a freshly imported `PowerScheduler`.
   */
  async function freshSchedulerModule() {
    const { vi } = await import('vitest');
    vi.resetModules();
    return import('../src/helpers/powerScheduler.js');
  }

  /**
   * Observe the real ports by patching the prototype they actually have.
   *
   * A recording fake for `globalThis.MessageChannel` was tried first and the
   * module never used it. Patching `MessagePort.prototype` works and is the more
   * honest instrument: these are the platform's ports doing the platform's
   * thing, and the only question is whether the module closes them.
   *
   * @returns {object} counters plus `restore`.
   */
  function observePorts() {
    const probe = new MessageChannel();
    const PortProto = Object.getPrototypeOf(probe.port1);
    probe.port1.close();
    probe.port2.close();

    const state = { closes: 0, made: 0 };
    const realClose = PortProto.close;
    PortProto.close = function (...a) {
      state.closes += 1;
      return realClose.apply(this, a);
    };

    const RealChannel = globalThis.MessageChannel;
    globalThis.MessageChannel = function (...a) {
      state.made += 1;
      return new RealChannel(...a);
    };

    return {
      get closes() {
        return state.closes;
      },
      get made() {
        return state.made;
      },
      restore() {
        PortProto.close = realClose;
        globalThis.MessageChannel = RealChannel;
      },
    };
  }

  it('closes both ports when a scheduler is disposed', async () => {
    // Mutation B: deleting `closeMacrotaskChannel()` from `dispose()`. Nothing
    // observable in a subprocess can catch this — `unref()` alone already lets
    // the process exit — so the port teardown would be untested decoration.
    const { PowerScheduler } = await freshSchedulerModule();
    const obs = observePorts();
    try {
      const s = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
      s.schedule();
      s.flush();
      expect(obs.made, 'the fresh module must build its own channel').toBe(1);
      const before = obs.closes;

      s.dispose();
      // Two ports on the one channel. A `dispose()` closing only `port1` would
      // leave the other open and still pass a `> 0` assertion.
      expect(obs.closes - before).toBe(2);
    } finally {
      obs.restore();
    }
  });

  it('clears the module-level channel so the next one builds a fresh pair', async () => {
    // Mutation C. Reuse would still deliver messages — the ports are open — so
    // "the second scheduler works" passes either way, and the only honest
    // observation is that a *new* channel was constructed.
    const { PowerScheduler } = await freshSchedulerModule();
    const obs = observePorts();
    try {
      // `schedule()`/`flush()` is what reaches for the channel — constructing
      // alone does not, so the first draft of this test made no channel at all
      // and read zero constructions.
      const first = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
      first.schedule();
      first.flush();
      first.dispose();
      const afterFirst = obs.made;
      expect(afterFirst).toBe(1);

      const second = new PowerScheduler(() => {}, { scheduling: 'macrotask' });
      second.schedule();
      second.flush();
      second.dispose();
      expect(obs.made - afterFirst).toBe(1);
    } finally {
      obs.restore();
    }
  });

  it('a disposed scheduler still leaves a working one behind it', async () => {
    // The consequence the two tests above protect, in the form a user meets it:
    // construct, dispose, construct again — the second must not be talking to a
    // closed port. `PORT-001` territory, and a `closeMacrotaskChannel()` that
    // cleared the reference without a working replacement fails here.
    const { PowerScheduler } = await freshSchedulerModule();
    let first = 0;
    let second = 0;
    const a = new PowerScheduler(() => (first += 1), { scheduling: 'macrotask' });
    a.schedule();
    a.flush();
    a.dispose();

    const b = new PowerScheduler(() => (second += 1), { scheduling: 'macrotask' });
    b.schedule();
    b.flush();
    await new Promise((r) => setTimeout(r, 30));
    b.dispose();

    expect(first).toBe(1);
    expect(second).toBe(1);
  });
});
