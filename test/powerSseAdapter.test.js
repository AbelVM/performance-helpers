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
});
