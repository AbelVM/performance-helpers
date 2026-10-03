/**
 * `settleHeartbeatProbe` — the reply half of the heartbeat, shared by
 * `PowerWebSocketClient` and `PowerSocketAdapter`.
 *
 * **Written because a mutant survived.** Removing the backwards-clock guard from the
 * helper failed *no* test in the suite: both classes' fakes ping and pong in the same
 * tick, so `rtt` is always `>= 0` and that branch is never reached through them. The
 * guard is inherited from RT-003 in the client, where it was equally untested — which is
 * the honest reason to test it here rather than carry it forward on trust.
 *
 * It is a pure function of its arguments, so every branch is reachable directly rather
 * than through a socket: four outcomes, each one a thing that can go wrong in production.
 */
import { describe, it, expect, vi } from 'vitest';
import { settleHeartbeatProbe } from '../src/utils/liveness.js';

/** A probe context with the callbacks spied, so each can be asserted independently. */
function probe(overrides = {}) {
  const clearDeadline = vi.fn();
  const onHeartbeat = vi.fn();
  const record = vi.fn();
  return {
    args: { pingSentAt: 1000, now: 1250, clearDeadline, onHeartbeat, record, ...overrides },
    clearDeadline,
    onHeartbeat,
    record,
  };
}

describe('settleHeartbeatProbe', () => {
  it('measures the round trip and records it', () => {
    const { args, onHeartbeat, record } = probe();
    expect(settleHeartbeatProbe(args)).toBe(250);
    expect(record).toHaveBeenCalledWith(250);
    expect(onHeartbeat).toHaveBeenCalledTimes(1);
  });

  it('clears the outstanding deadline first, always', () => {
    // The clear and the measurement are one function because they are one fact: the
    // clear settles *that* probe and the RTT is *that* probe's round trip. A stray pong
    // with nothing outstanding still clears, so a late reply cannot leave a timer armed.
    const { args, clearDeadline } = probe();
    settleHeartbeatProbe(args);
    expect(clearDeadline).toHaveBeenCalledTimes(1);
  });

  it('records nothing for a stray pong with no probe outstanding', () => {
    // A late reply to a probe already settled. Not an error, and not a measurement of
    // anything — which is why it returns `null` rather than `0`.
    const { args, onHeartbeat, record } = probe({ pingSentAt: 0 });
    expect(settleHeartbeatProbe(args)).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(onHeartbeat).not.toHaveBeenCalled();
  });

  it('refuses a clock that went backwards', () => {
    // **The mutant that survived.** A negative RTT is not a slow round trip, it is a
    // measurement taken against a clock that moved, and recording it would put a negative
    // sample into a percentile series that assumes otherwise.
    const { args, record, onHeartbeat } = probe({ pingSentAt: 2000, now: 1000 });
    expect(settleHeartbeatProbe(args)).toBeNull();
    expect(record).not.toHaveBeenCalled();
    expect(onHeartbeat).not.toHaveBeenCalled();
  });

  it('refuses a NaN clock, which is the same guard doing a second job', () => {
    // Written as a negated comparison rather than `rtt < 0` precisely so `NaN` fails it.
    // A `NaN` that slipped into a histogram would not show up as an outlier - it would
    // quietly corrupt every percentile, which is worse than dropping one sample.
    const { args, record } = probe({ now: Number.NaN });
    expect(settleHeartbeatProbe(args)).toBeNull();
    expect(record).not.toHaveBeenCalled();
  });

  it('accepts a zero RTT rather than treating it as absent', () => {
    // The other side of that guard: `0` is falsy and must not be mistaken for "nothing
    // measured". A same-millisecond round trip is real and is what a loopback transport
    // produces routinely.
    const { args, record } = probe({ pingSentAt: 1000, now: 1000 });
    expect(settleHeartbeatProbe(args)).toBe(0);
    expect(record).toHaveBeenCalledWith(0);
  });

  it('works without the optional callbacks', () => {
    // A caller that only wants the deadline cleared should not have to pass no-ops.
    expect(settleHeartbeatProbe({ pingSentAt: 1000, now: 1100, clearDeadline: () => {} })).toBe(
      100
    );
  });
});
