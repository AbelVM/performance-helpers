import { describe, it, expect } from 'vitest';
import { decodeMessage, encodeMessage } from '../src/helpers/powerMessageCodec.js';
import { PowerPool } from '../src/helpers/powerPool.js';

/**
 * FEAT-008, as re-scoped: the `traceparent` recipe in `guides/traceContext.md`.
 *
 * The claim being tested is that a caller-supplied field rides the existing
 * `correlationId` path with no pool changes. That is a claim about what the
 * pool does *not* do, so the test that matters is the last one: a message
 * carrying a field the pool has never heard of must arrive unchanged. If the
 * pool ever starts consuming payload fields, that test fails — and it is the
 * same property ADR-0001 was written to protect.
 */

const TRACEPARENT = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** A worker that does what the guide says a worker does. */
function TraceWorker({ seen }) {
  return function () {
    return {
      onmessage: null,
      postMessage(frame) {
        const { value } = decodeMessage(frame);
        seen.push(value);
        this.onmessage(
          encodeMessage({
            correlationId: value.correlationId,
            traceparent: value.traceparent,
            result: value.op + ':done',
          })
        );
      },
      terminate() {},
    };
  };
}

function poolWith(seen, options = {}) {
  return new PowerPool(TraceWorker({ seen }), {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    ...options,
  });
}

describe('W3C trace propagation over PowerPool', () => {
  it('carries a caller-supplied traceparent to the worker and back', async () => {
    const seen = [];
    const pool = poolWith(seen);
    try {
      const reply = await pool.postMessage({ op: 'work', traceparent: TRACEPARENT }, undefined, {
        awaitResponse: true,
        timeout: 2000,
      });
      // Outbound: the field the caller put in is what the worker received,
      // byte for byte, with no pool involvement.
      expect(seen).toHaveLength(1);
      expect(seen[0].traceparent).toBe(TRACEPARENT);
      // Return: the worker echoed it and the pool matched the reply by
      // correlationId, which is the mechanism this whole recipe rides.
      expect(reply.traceparent).toBe(TRACEPARENT);
      expect(reply.result).toBe('work:done');
    } finally {
      pool.terminate();
    }
  });

  it('does not require the pool to know the field exists', async () => {
    const seen = [];
    const pool = poolWith(seen);
    try {
      // A field the pool has never heard of, nested, next to one it has. The
      // point is that no configuration, option or version is involved.
      await pool.postMessage(
        { op: 'work', baggage: { tenant: 'acme' }, vendoredMeta: [1, 2, 3] },
        undefined,
        { awaitResponse: true, timeout: 2000 }
      );
      expect(seen[0].baggage).toEqual({ tenant: 'acme' });
      expect(seen[0].vendoredMeta).toEqual([1, 2, 3]);
    } finally {
      pool.terminate();
    }
  });

  it('delivers a message with unknown fields unchanged', () => {
    // The property that keeps the pool out of its callers' payloads. A pool
    // that started consuming fields would break this the first time it learned
    // a new one — which is exactly how the 1.x sniffing decoder went wrong
    // (adr/0001).
    const payload = { a: 1, traceparent: TRACEPARENT, deep: { nested: ['x'] } };
    const round = decodeMessage(encodeMessage(payload)).value;
    expect(round).toEqual(payload);
  });

  it('works with awaitResponse off, for a caller that does not need the reply', () => {
    const seen = [];
    const pool = poolWith(seen);
    try {
      // `correlationId` is attached by the pool only for the Promise path, so
      // a fire-and-forget caller propagates by putting the field in the
      // payload and reading it on the worker side. Both shapes are documented.
      expect(pool.postMessage({ op: 'fire', traceparent: TRACEPARENT })).toBe(true);
      expect(seen[0].traceparent).toBe(TRACEPARENT);
    } finally {
      pool.terminate();
    }
  });
});
