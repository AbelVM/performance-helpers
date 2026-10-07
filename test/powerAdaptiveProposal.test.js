import { describe, expect, it } from 'vitest';
import { PowerAdaptiveProposal } from '../src/helpers/powerAdaptiveProposal.js';

describe('PowerAdaptiveProposal', () => {
  it('bounds congestion and recovery changes and explains them', () => {
    const proposal = new PowerAdaptiveProposal({
      initial: 10,
      min: 2,
      max: 12,
      maxStep: 3,
      hysteresis: 0.2,
      cooldown: 1,
    });
    expect(proposal.propose(8)).toMatchObject({ value: 7, reason: 'congestion', changed: true });
    expect(proposal.propose(-8)).toMatchObject({ value: 7, reason: 'cooldown', changed: false });
    expect(proposal.propose(-8)).toMatchObject({ value: 10, reason: 'recovery', changed: true });
    expect(proposal.propose(0.1)).toMatchObject({ value: 10, reason: 'cooldown', changed: false });
    expect(proposal.propose(0.1)).toMatchObject({
      value: 10,
      reason: 'hysteresis',
      changed: false,
    });
    expect(proposal.rollback(12)).toMatchObject({ value: 12, reason: 'rollback' });
  });

  it('snapshots and restores bounded state', () => {
    const proposal = new PowerAdaptiveProposal({ initial: 10, min: 2, max: 12, cooldown: 2 });
    proposal.propose(1);
    const snapshot = proposal.snapshot();
    const restored = new PowerAdaptiveProposal({ initial: 2, min: 2, max: 12, cooldown: 2 });
    expect(restored.restore(snapshot)).toEqual(snapshot);
    expect(restored.value).toBe(proposal.value);
    expect(() => restored.restore({ ...snapshot, value: 99 })).toThrow(RangeError);
  });
});
