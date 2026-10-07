import { describe, it, expect, beforeEach } from 'vitest';
import { createSseAdapter } from '../src/helpers/powerSseAdapter.js';

/**
 * RT-005 — `createSseAdapter()` returns a hub `send`/`close` pair that writes
 * one SSE `data:` line per frame, base64-encoded, and closes the stream on
 * detach.
 */
describe('RT-005: createSseAdapter', () => {
  /** @type {ReturnType<typeof createSseAdapter>} */
  let adapter;

  function fakeTransport() {
    const lines = [];
    return {
      write(line) {
        lines.push(line);
        return true;
      },
      end() {
        lines.push('__end__');
      },
      lines,
    };
  }

  beforeEach(() => {
    adapter = createSseAdapter({ onError: () => {} });
  });

  it('writes one base64 data line per frame', async () => {
    const transport = fakeTransport();
    const sub = {
      id: 'sub-1',
      transport,
    };
    adapter.register(sub);
    await adapter.send(sub, new Uint8Array([1, 2, 3]));
    expect(transport.lines).toHaveLength(1);
    expect(transport.lines[0]).toMatch(/^data: /);
    expect(transport.lines[0]).toMatch(/\n\n$/);
  });

  it('closes the stream on hub detach', async () => {
    const transport = fakeTransport();
    const sub = {
      id: 'sub-1',
      transport,
    };
    adapter.register(sub);
    adapter.close(sub);
    expect(transport.lines).toContain('__end__');
  });

  it('reports response factory failures without registering a dead subscriber', async () => {
    const errors = [];
    const failingAdapter = createSseAdapter({
      createResponse: () => {
        throw new Error('response failed');
      },
      onError: (error) => errors.push(error),
    });
    const sub = { id: 'sub-1' };

    failingAdapter.register(sub);
    await failingAdapter.send(sub, new Uint8Array([1]));

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('response failed');
  });

  it('writes through a response writer and waits for backpressure', async () => {
    const writes = [];
    let waited = false;
    const writer = {
      write(line) {
        writes.push(line);
        return Promise.resolve().then(() => {
          waited = true;
        });
      },
      close: () => Promise.resolve(),
    };
    const responseAdapter = createSseAdapter({
      createResponse: () => ({ body: { getWriter: () => writer } }),
    });
    const sub = { id: 'writer-1' };

    responseAdapter.register(sub);
    await responseAdapter.send(sub, new Uint8Array([4]));

    expect(writes[0]).toContain('data: BA==');
    expect(waited).toBe(true);
  });

  it('reports write failures and makes close idempotent', async () => {
    const errors = [];
    const transport = {
      write: () => {
        throw new Error('write failed');
      },
      end: () => errors.push('end'),
    };
    const errorAdapter = createSseAdapter({ onError: (error) => errors.push(error) });
    const sub = { id: 'error-1', transport };
    errorAdapter.register(sub);

    await expect(errorAdapter.send(sub, new Uint8Array([1]))).rejects.toThrow('write failed');
    errorAdapter.close(sub);
    errorAdapter.close(sub);
    expect(errors.filter((value) => value === 'end')).toHaveLength(1);
    expect(errors.find((value) => value instanceof Error).message).toBe('write failed');
  });

  it('ignores duplicate registration and sends after a close only once', async () => {
    const transport = fakeTransport();
    const sub = { id: 'duplicate-1', transport };
    adapter.register(sub);
    adapter.register(sub);
    adapter.close(sub);
    await adapter.send(sub, new Uint8Array([1]));
    expect(transport.lines).toEqual(['__end__']);
  });
});
