import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { PowerEventBus } from '../src/helpers/powerEventBus.js';
import { PowerSubscriberSet } from '../src/helpers/powerSubscriberSet.js';

const run = promisify(execFile);
const BUS_PATH = new URL('../src/helpers/powerEventBus.js', import.meta.url).pathname;

/**
 * Run a snippet in a real child process.
 *
 * The process is the assertion. "The rejection did not reach the process" is not
 * observable from inside the process that would have died, so those cases cannot
 * be written in band: a `waitFor`, a fake timer or a try/catch all pass against
 * the broken code, because the failure is a *later* exit rather than a thrown
 * error. This is the same reasoning as `test/WorkerAgnostic.pureEsm.test.js` —
 * behaviour that needs a real runtime is tested in a real runtime.
 *
 * @param {string} body - ESM source; `PowerEventBus` is already imported.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function inSubprocess(body) {
  return run(process.execPath, [
    '--input-type=module',
    '-e',
    `import { PowerEventBus } from '${BUS_PATH}';\n${body}`,
  ]);
}

/**
 * `OBS-003`: a rejecting `async` listener escaped the bus entirely.
 *
 * The shape of the defect matters more than its size. `emit` wrapped each
 * listener call in `try`/`catch` and its JSDoc said errors were swallowed — true
 * of a synchronous throw, false of a promise, and the difference is fatal rather
 * than noisy: an unobserved rejection reaches the process, and **Node's default
 * `--unhandled-rejections=throw` since v15 terminates it.** An `async` listener
 * that threw killed its host from inside a fire-and-forget notification.
 */
describe('PowerEventBus observes a listener promise (OBS-003)', () => {
  it('does not let a rejecting async listener reach the process', async () => {
    // On the child's default settings, with no `--unhandled-rejections` flag: if
    // `emit` did not observe the promise, the child would exit non-zero and the
    // rejection text would be on its stderr.
    const { stderr } = await inSubprocess(`
      const bus = new PowerEventBus();
      bus.on('e', async () => { throw new Error('async listener blew up'); });
      bus.on('e', () => { throw new Error('sync listener blew up'); });
      if (bus.emit('e', 1) !== true) process.exit(3);
      // A macrotask turn, by which a handler attached at emit time has run and an
      // unobserved rejection would already have been reported.
      setTimeout(() => { process.exit(0); }, 50);
    `);
    expect(stderr).not.toMatch(/async listener blew up/);
  });

  it('observes a thenable that is not a real promise', async () => {
    // `typeof result.then === 'function'` rather than `result instanceof Promise`,
    // because a hand-rolled thenable — a deferred, a `PromiseLike` from another
    // realm — rejects just as unobserved.
    const { stderr } = await inSubprocess(`
      const bus = new PowerEventBus();
      bus.on('e', () => ({ then: (resolve, reject) => reject(new Error('thenable rejected')) }));
      bus.emit('e');
      setTimeout(() => { process.exit(0); }, 50);
    `);
    expect(stderr).not.toMatch(/thenable rejected/);
  });

  it('observes a promise returned from a once-listener too', async () => {
    // The other half, and it needed a second change to reach:
    // `PowerSubscriberSet.addOnce` wrapped the listener in
    // `try { fn(...) } finally { this.delete(fn) }` and **discarded the return
    // value**, so the promise died inside the wrapper and `emit` had nothing left
    // to observe. The wrapper now returns it.
    const { stderr } = await inSubprocess(`
      const bus = new PowerEventBus();
      bus.once('e', async () => { throw new Error('once async listener blew up'); });
      bus.emit('e');
      setTimeout(() => { process.exit(0); }, 50);
    `);
    expect(stderr).not.toMatch(/once async listener blew up/);
  });

  it('leaves a rejecting listener subscribed, and still reports success', () => {
    // A listener that throws is not a listener that unsubscribed. Dropping it
    // would turn one bad event into a permanently missing one — and `emit`
    // reports `true` because the listener *was* notified.
    const bus = new PowerEventBus();
    bus.on('e', () => {
      throw new Error('nope');
    });
    bus.on('e', async () => {
      throw new Error('nope');
    });
    expect(bus.emit('e')).toBe(true);
    expect(bus._listeners.get('e').size).toBe(2);
  });

  it('notifies every listener even when the first one rejects', () => {
    const bus = new PowerEventBus();
    const seen = [];
    bus.on('e', async () => {
      seen.push('first');
      throw new Error('first');
    });
    bus.on('e', () => {
      seen.push('second');
    });
    bus.emit('e');
    expect(seen).toEqual(['first', 'second']);
  });

  it('a once-listener still unsubscribes, and passes its return value through', () => {
    // The wrapper now returns what the listener returned, so assert the two
    // things that could have regressed with it: once-ness, and the sync return.
    const set = new PowerSubscriberSet();
    let calls = 0;
    set.addOnce(() => {
      calls += 1;
      return 'the return value';
    });
    const [wrapped] = [...set];
    expect(wrapped('payload')).toBe('the return value');
    expect(set.size).toBe(0);
    expect(calls).toBe(1);
  });

  it('does not treat a non-thenable return as a promise', () => {
    // The fix is one property access on the sync path, and this is the case that
    // keeps it that way: a listener returning an object with a `then` property
    // that is *not* a function, or a number, must not be handled as a thenable.
    const bus = new PowerEventBus();
    const calls = [];
    bus.on('a', () => ({ then: 1 }));
    bus.on('b', () => 42);
    bus.on('c', () => 'string');
    bus.on('d', () => null);
    for (const name of ['a', 'b', 'c', 'd']) {
      calls.push(bus.emit(name));
    }
    expect(calls).toEqual([true, true, true, true]);
  });

  it('emitAsync still swallows an async listener rejection, as documented', async () => {
    // `emitAsync` awaits each listener, so it observed the rejection already; the
    // point is that routing through `notifyListener` did not change its contract.
    const bus = new PowerEventBus();
    bus.on('e', async () => {
      throw new Error('async');
    });
    await expect(bus.emitAsync('e')).resolves.toBe(true);
  });
});
