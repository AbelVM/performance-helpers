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
  });
});
