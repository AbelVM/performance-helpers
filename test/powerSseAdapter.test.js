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
    // **Rewritten for AUD-025, and the expectation moved rather than loosened.**
    // This used to assert `lines[0]` matches `/^data: /`. It now starts with
    // `id: `, because the adapter emits an `id:` field before every `data:` line
    // — and that field is the entire fix. SSE reconnection is client-driven: a
    // browser `EventSource` reconnects on its own and sends `Last-Event-ID`
    // carrying the last `id:` the server emitted. With only `data:` lines there
    // was never an `id:` to remember, so the header was never sent, so every
    // reconnect silently dropped the gap.
    //
    // Still **one write per frame**: `id:` and `data:` are one SSE event block
    // and the spec dispatches them together, so they go out in a single stream
    // write rather than two.
    const transport = fakeTransport();
    const sub = {
      id: 'sub-1',
      transport,
    };
    adapter.register(sub);
    await adapter.send(sub, new Uint8Array([1, 2, 3]));
    expect(transport.lines).toHaveLength(1);
    expect(transport.lines[0]).toMatch(/^id: 1\n/);
    expect(transport.lines[0]).toMatch(/\ndata: /);
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

// --- AUD-025: the id: field that makes Last-Event-ID possible ----------------

describe('AUD-025: SSE event ids and Last-Event-ID', () => {
  /** @type {ReturnType<typeof createSseAdapter>} */
  let adapter;

  function fakeTransport(headers) {
    const lines = [];
    return {
      req: { headers: headers || {} },
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

  it('emits a monotonically increasing id with every frame', () => {
    // The `id:` field is what a browser `EventSource` remembers and sends back as
    // `Last-Event-ID` on reconnect. Without it the header is never sent and the
    // gap is silently dropped.
    const transport = fakeTransport();
    const sub = { id: 'sub-1', transport };
    adapter.register(sub);

    adapter.send(sub, new Uint8Array([1]));
    adapter.send(sub, new Uint8Array([2]));
    adapter.send(sub, new Uint8Array([3]));

    expect(transport.lines[0]).toMatch(/^id: 1\n/);
    expect(transport.lines[1]).toMatch(/^id: 2\n/);
    expect(transport.lines[2]).toMatch(/^id: 3\n/);
    expect(adapter.lastSentId(sub)).toBe(3);
  });

  it('keeps a separate sequence per subscriber', () => {
    // Two subscribers must not share a counter, or one client's resume point
    // would be another's — and replaying from it would send the wrong events.
    const t1 = fakeTransport();
    const t2 = fakeTransport();
    const a = { id: 'a', transport: t1 };
    const b = { id: 'b', transport: t2 };
    adapter.register(a);
    adapter.register(b);

    adapter.send(a, new Uint8Array([1]));
    adapter.send(a, new Uint8Array([2]));
    adapter.send(b, new Uint8Array([9]));

    expect(t1.lines[0]).toMatch(/^id: 1\n/);
    expect(t1.lines[1]).toMatch(/^id: 2\n/);
    expect(t2.lines[0]).toMatch(/^id: 1\n/);
    expect(adapter.lastSentId(a)).toBe(2);
    expect(adapter.lastSentId(b)).toBe(1);
  });

  it('reads Last-Event-ID from the request headers on register', () => {
    // The resume point. A reconnecting client sends it; without reading it the
    // caller cannot know where the client got to, and the gap is unfixable from
    // above.
    const transport = fakeTransport({ 'last-event-id': '41' });
    const sub = { id: 'sub-1', transport };
    adapter.register(sub);

    expect(adapter.lastEventId(sub)).toBe('41');
  });

  it('reports null for a first connect, where there is nothing to resume', () => {
    const transport = fakeTransport();
    const sub = { id: 'sub-1', transport };
    adapter.register(sub);

    expect(adapter.lastEventId(sub)).toBeNull();
  });

  it('accepts the header under its canonical capitalisation too', () => {
    // HTTP header names are case-insensitive and Node lower-cases them, but a
    // caller supplying their own transport shape is not bound by Node's
    // normalisation — so both spellings are read.
    const transport = fakeTransport({ 'Last-Event-ID': '7' });
    const sub = { id: 'sub-1', transport };
    adapter.register(sub);

    expect(adapter.lastEventId(sub)).toBe('7');
  });

  it('exposes the gap between where the client got to and where the server is', () => {
    // The two accessors exist as a pair: `lastEventId` is the client's position,
    // `lastSentId` is the server's, and the difference is exactly what a
    // reconnect has to replay.
    const transport = fakeTransport({ 'last-event-id': '10' });
    const sub = { id: 'sub-1', transport };
    adapter.register(sub);
    for (let i = 0; i < 5; i++) adapter.send(sub, new Uint8Array([i]));

    expect(adapter.lastEventId(sub)).toBe('10');
    expect(adapter.lastSentId(sub)).toBe(5);
  });

  it('returns null and 0 for an unknown subscriber rather than throwing', () => {
    // A caller asking about a subscriber that was never registered, or was
    // already detached, gets a defined answer rather than a crash on the
    // teardown path.
    expect(adapter.lastEventId({ id: 'nope' })).toBeNull();
    expect(adapter.lastSentId({ id: 'nope' })).toBe(0);
  });
});
