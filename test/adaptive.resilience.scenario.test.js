import { describe, expect, it } from 'vitest';
import { PowerBackpressure } from '../src/helpers/powerBackpressure.js';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';
import { PowerRetryBudget } from '../src/helpers/powerRetry.js';

describe('adaptive resilience scenario', () => {
  it('tightens on external overload, sheds locally, and exposes recovery', async () => {
    const budget = new PowerRetryBudget({ capacity: 2 });
    budget.recordOutcome({ kind: 'throttled' });
    expect(budget.available()).toBe(1);

    const shed = [];
    const bulkhead = new PowerBulkhead({
      maxConcurrency: 1,
      queueCapacity: 0,
      onShed: (event) => shed.push(event),
    });
    bulkhead.run(() => new Promise(() => {}), { partitionKey: 0 });
    await expect(bulkhead.run(() => {}, { partitionKey: 0 })).rejects.toThrow(
      'PowerBulkhead queue is full'
    );

    const backpressure = new PowerBackpressure({
      capacity: 2,
      refillAmount: 1,
      adaptive: { enabled: true },
    });
    backpressure._aimdStep();

    expect(shed).toHaveLength(1);
    expect(bulkhead.stats().partitionStates[shed[0].partition]).toMatchObject({
      shed: 1,
      saturated: true,
    });
    expect(backpressure.stats()).toMatchObject({ adaptive: true, recoverySteps: 1 });
  });
});
