import { describe, it, expect, vi, afterEach } from 'vitest';
import { PowerLogger } from '../src/index.js';

/**
 * OBS-004 — `PowerLogger.error()` did its level check *after* formatting, and
 * OBS-005 — a throwing `output()` sink failed silently on the path nearly every
 * caller takes.
 *
 * Both were reproduced on the real call path before anything was edited.
 */

/** A logger whose sink records what it was handed. */
function capturingLogger(options = {}) {
  const seen = [];
  const log = new PowerLogger({ level: 1, output: (p) => seen.push(p), ...options });
  return { log, seen };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OBS-004: a disabled error level costs nothing', () => {
  it('does not read a logged object at all at level 0', () => {
    // **The row's headline claim, reproduced then fixed.** `error()` is the only
    // level that formats its arguments on the way through, and that map reads the
    // argument. The level check lived in `_emit`, *after* the map had already run —
    // so before the fix a level-0 build still paid for the formatting.
    //
    // **The shape is `{ get error() }`, and getting that wrong made this test
    // worthless for one round.** An earlier draft used `{ get code() }` and passed
    // at level 0 — for the wrong reason. Removing OBS-004's plain-object clause had
    // already stopped `normalizeError` reading `.code`, so the assertion held even
    // with the level gate **deleted**: mutation-check M1 (removing the gate)
    // survived 9/9. The two fixes were masking each other.
    //
    // `.error` is read by the first statement of the map (`if (a?.error)`), so it
    // is the getter that distinguishes "the map ran" from "the map was skipped" —
    // which is the only thing this test is about. A getter is the right shape
    // generally: logging an object whose `code` or `stack` getter touches a socket
    // or takes a lock means a build that disabled error logging was still paying.
    let touched = 0;
    const spy = {
      get error() {
        touched += 1;
        return true;
      },
      code: 'E',
    };
    new PowerLogger({ level: 0, output: () => {} }).error(spy);

    expect(touched, 'a logged object must not be read at level 0').toBe(0);
  });

  it('still reads a logged object it does format when the level is enabled', () => {
    // The other direction, and the one that stops a fix which "solves" this by
    // dropping the formatting. A gate that never opens is not a gate.
    let touched = 0;
    const spy = {
      get error() {
        touched += 1;
        return true;
      },
      code: 'E',
    };
    new PowerLogger({ level: 1, output: () => {} }).error(spy);

    // **`toBeGreaterThan(0)`, not an exact count.** The `.error` read happens more
    // than once — in `if (a?.error)` and again inside `formatErrorObj` — and
    // pinning the multiplicity would freeze an implementation detail rather than
    // the property under test. The discriminating assertion is the pair above:
    // **0 at level 0, at least 1 at level 1.**
    expect(touched, 'the formatter still reads a record it formats').toBeGreaterThan(0);
  });

  it('emits nothing at level 0 and something at level 1', () => {
    // The behavioural half, so the early return cannot pass by disabling the
    // method rather than by skipping its work.
    const { log, seen } = capturingLogger({ level: 0 });
    log.error('dropped');
    expect(seen).toHaveLength(0);

    const on = capturingLogger({ level: 1 });
    on.log.error('kept');
    expect(on.seen).toHaveLength(1);
  });

  it('leaves the other levels untouched by the new gate in error()', () => {
    // The gate is duplicated rather than hoisted, because `_emit` is the shared
    // path for every level. This pins that the duplication did not change any of
    // them — `warn` still gates at 2, `info` at 3.
    const { log, seen } = capturingLogger({ level: 1 });
    log.warn('w');
    log.info('i');
    expect(seen, 'warn and info are still gated above level 1').toHaveLength(0);

    const deeper = capturingLogger({ level: 3 });
    deeper.log.warn('w');
    deeper.log.info('i');
    expect(deeper.seen).toHaveLength(2);
  });
});

describe('OBS-005: a throwing output() sink is reported, not swallowed', () => {
  it('reports a throw from the structured output path', () => {
    // **The inconsistency the row found.** `_emitSinkError` was wired into the
    // formatter-returns-a-string branch and *not* into the `output(payload)` branch
    // three lines below it, whose catch was a bare `// swallow`. So the same
    // failure was loud on one path and silent on the other — and this is the path
    // a structured `output` transport takes, i.e. the one nearly every caller
    // uses. A sink failing on every log was indistinguishable from `level: 0`.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    new PowerLogger({
      level: 1,
      output: () => {
        throw new Error('sink died');
      },
    }).error('boom');

    expect(errors, 'the sink failure reached console.error').toHaveBeenCalled();
    expect(errors.mock.calls[0][0]).toMatch(/log sink threw/);
  });

  it('reports a throw from the formatter-string path too', () => {
    // The path that already worked. Pinned so the fix is understood as making the
    // two branches symmetric, not as adding a second report to one of them.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    new PowerLogger({
      level: 1,
      output: () => {
        throw new Error('sink died');
      },
      formatter: () => 'formatted string',
    }).error('boom');

    expect(errors).toHaveBeenCalled();
    expect(errors.mock.calls[0][0]).toMatch(/log sink threw/);
  });

  it('does not let a throwing sink take the logger down', () => {
    // The constraint that made the swallow tempting in the first place. A sink is
    // caller code on the logging path, and the pool, cache and circuit that own
    // the logger must survive it.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { log } = capturingLogger();
    log._output = () => {
      throw new Error('sink died');
    };

    expect(() => log.error('boom')).not.toThrow();
    expect(errors).toHaveBeenCalled();
  });

  it('reports through console.error and does not recurse when that fails too', () => {
    // `_emitSinkError` gives up if `console.error` itself throws — otherwise a
    // broken global console turns every log into a thrown error, which is the exact
    // outcome the swallow was there to prevent.
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('console is broken too');
    });
    const { log } = capturingLogger();
    log._output = () => {
      throw new Error('sink died');
    };

    expect(() => log.error('boom')).not.toThrow();
  });

  it('does not report anything when the sink succeeds', () => {
    // Otherwise the fix looks like it added a log line per log record.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { log } = capturingLogger();
    log.error('fine');

    expect(errors).not.toHaveBeenCalled();
  });
});
