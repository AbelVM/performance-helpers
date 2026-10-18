import { describe, expect, it } from 'vitest';
import {
  createOperationContext,
  runOperationContext,
  getOperationContext,
  withOperationContext,
} from '../src/index.js';

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

describe('runOperationContext / getOperationContext / withOperationContext', () => {
  it('runOperationContext returns fn result and binds context', async () => {
    const ctx = createOperationContext({ correlationId: 'r-1' });
    const result = runOperationContext(ctx, () => {
      expect(getOperationContext()).toBe(ctx);
      return 42;
    });
    expect(result).toBe(42);
    expect(getOperationContext()).toBeUndefined();
  });

  it('propagates through async chains', async () => {
    const ctx = createOperationContext({ correlationId: 'async-1' });
    await runOperationContext(ctx, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(getOperationContext()?.correlationId).toBe('async-1');
    });
    expect(getOperationContext()).toBeUndefined();
  });

  it('nested calls shadow outer context', async () => {
    const outer = createOperationContext({ correlationId: 'outer' });
    const inner = createOperationContext({ correlationId: 'inner' });
    await runOperationContext(outer, async () => {
      expect(getOperationContext()?.correlationId).toBe('outer');
      runOperationContext(inner, () => {
        expect(getOperationContext()?.correlationId).toBe('inner');
      });
      expect(getOperationContext()?.correlationId).toBe('outer');
    });
  });

  it('withOperationContext creates and runs', async () => {
    const result = await withOperationContext({ correlationId: 'w-1' }, async () => {
      expect(getOperationContext()?.correlationId).toBe('w-1');
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('throws TypeError when fn is not a function', async () => {
    const ctx = createOperationContext({});
    expect(() => runOperationContext(ctx, 5)).toThrow(TypeError);
  });

  it('accepts traceId and spanId', () => {
    const ctx = createOperationContext({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      spanId: 'b7ad6b7169203331',
    });
    expect(ctx.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(ctx.spanId).toBe('b7ad6b7169203331');
  });

  it('rejects non-string traceId/spanId', () => {
    expect(() => createOperationContext({ traceId: 1 })).toThrow(TypeError);
    expect(() => createOperationContext({ spanId: 1 })).toThrow(TypeError);
  });

  it('returns undefined outside any context', async () => {
    expect(getOperationContext()).toBeUndefined();
  });
});
