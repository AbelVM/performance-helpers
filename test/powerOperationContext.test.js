import { describe, expect, it } from 'vitest';
import { createOperationContext } from '../src/index.js';

describe('createOperationContext', () => {
  it('creates a frozen explicit coordination object', () => {
    const signal = new AbortController().signal;
    const context = createOperationContext({
      signal,
      deadlineAt: 123,
      priority: 2,
      correlationId: 'job-1',
    });
    expect(context).toMatchObject({ signal, deadlineAt: 123, priority: 2, correlationId: 'job-1' });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('rejects conflicting or invalid deadlines', () => {
    expect(() => createOperationContext({ deadlineAt: 1, deadlineMs: 2 })).toThrow(TypeError);
    expect(() => createOperationContext({ deadlineMs: -1 })).toThrow(RangeError);
    expect(() => createOperationContext(null)).toThrow(TypeError);
    expect(() => createOperationContext([])).toThrow(TypeError);
    expect(() => createOperationContext({ deadlineAt: -1 })).toThrow(RangeError);
    expect(() => createOperationContext({ signal: null })).toThrow(TypeError);
    expect(() => createOperationContext({ correlationId: 1 })).toThrow(TypeError);
    expect(() => createOperationContext({ priority: Infinity })).toThrow(TypeError);
  });

  it('materializes relative deadlines and preserves optional coordination data', () => {
    const before = Date.now();
    const retryBudget = { remaining: 2 };
    const context = createOperationContext({ deadlineMs: 100, retryBudget });

    expect(context.deadlineAt).toBeGreaterThanOrEqual(before + 100);
    expect(context.retryBudget).toBe(retryBudget);
    expect(context.priority).toBe(0);
  });
});
