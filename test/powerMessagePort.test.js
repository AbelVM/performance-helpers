import { describe, it, expect } from 'vitest';
import { PowerMessagePort } from '../src/helpers/powerMessagePort.js';
import { encodeNativeEnvelope } from '../src/helpers/powerMessageCodec.js';

/**
 * RT-019: `MessagePort` transport for `PowerRealtimeHub`.
 *
 * Tests the adapter in isolation: send/close/dispose lifecycle, listener
 * cleanup, and native-envelope decoding on the inbound side.
 */

class FakePort {
  constructor() {
    this._listeners = new Map();
    this._closed = false;
    this.sent = [];
  }

  postMessage(data) {
    if (this._closed) throw new Error('port is closed');
    this.sent.push(data);
  }

  close() {
    this._closed = true;
    this._fire('close');
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }

  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (list) {
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  fire(type, event) {
    for (const fn of [...(this._listeners.get(type) || [])]) fn(event);
  }

  get onmessage() {
    return this._listeners.get('message')?.[0] ?? null;
  }
  set onmessage(fn) {
    this._listeners.set('message', fn ? [fn] : []);
  }
  get onmessageerror() {
    return this._listeners.get('messageerror')?.[0] ?? null;
  }
  set onmessageerror(fn) {
    this._listeners.set('messageerror', fn ? [fn] : []);
  }
  get onclose() {
    return this._listeners.get('close')?.[0] ?? null;
  }
  set onclose(fn) {
    this._listeners.set('close', fn ? [fn] : []);
  }
}

describe('PowerMessagePort', () => {
  it('sends a frame to the port', () => {
    const port = new FakePort();
    const adapter = new PowerMessagePort(port);
    const frame = new Uint8Array([1, 2, 3]);

    const result = adapter.send({}, frame);

    expect(result).toBe(true);
    expect(port.sent).toHaveLength(1);
    expect(port.sent[0]).toBe(frame);
  });

  it('returns false when the port is disposed', () => {
    const port = new FakePort();
    const adapter = new PowerMessagePort(port);
    adapter.dispose();

    const result = adapter.send({}, new Uint8Array([1]));

    expect(result).toBe(false);
    expect(port.sent).toHaveLength(0);
  });

  it('closes the port', () => {
    const port = new FakePort();
    const adapter = new PowerMessagePort(port);

    adapter.close({});

    expect(port._closed).toBe(true);
  });

  it('close is idempotent', () => {
    const port = new FakePort();
    const adapter = new PowerMessagePort(port);

    adapter.close({});
    adapter.close({});

    // no throw
  });

  it('dispose detaches listeners and closes the port', () => {
    const port = new FakePort();
    const adapter = new PowerMessagePort(port);

    adapter.dispose();

    expect(port._closed).toBe(true);
    expect(port.onmessage).toBeNull();
    expect(port.onmessageerror).toBeNull();
    expect(port.onclose).toBeNull();
  });

  it('dispose is idempotent', () => {
    const port = new FakePort();
    const adapter = new PowerMessagePort(port);

    adapter.dispose();
    adapter.dispose();

    // no throw
  });

  it('decodes a native envelope and calls onMessage', () => {
    const port = new FakePort();
    const received = [];
    new PowerMessagePort(port, {
      onMessage: (value, correlationId) => {
        received.push({ value, correlationId });
      },
    });

    const envelope = encodeNativeEnvelope(new Map([['a', 1]]), { correlationId: 'abc' });
    port.fire('message', { data: envelope });

    expect(received).toHaveLength(1);
    expect(received[0].value).toBeInstanceOf(Map);
    expect(received[0].value.get('a')).toBe(1);
    expect(received[0].correlationId).toBe('abc');
  });

  it('decodes a framed JSON message and calls onMessage', () => {
    const port = new FakePort();
    const received = [];
    new PowerMessagePort(port, {
      onMessage: (value) => received.push(value),
    });

    // Build a real JSON frame: v1, json codec, payload = [1, 2]
    const payload = new TextEncoder().encode(JSON.stringify([1, 2]));
    const frame = new Uint8Array(6 + payload.length);
    frame[0] = 1; // version
    frame[1] = 0; // json codec
    frame[2] = payload.length & 0xff;
    frame[3] = (payload.length >>> 8) & 0xff;
    frame[4] = (payload.length >>> 16) & 0xff;
    frame[5] = (payload.length >>> 24) & 0xff;
    frame.set(payload, 6);

    port.fire('message', { data: frame });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual([1, 2]);
  });

  it('calls onError for a truncated frame', () => {
    const port = new FakePort();
    const errors = [];
    new PowerMessagePort(port, {
      onError: (err) => errors.push(err),
    });

    // A 3-byte body is shorter than the 6-byte header — truncated frame.
    const frame = new Uint8Array([1, 0, 0, 0, 0, 3, 1, 2, 3]);
    port.fire('message', { data: frame });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
  });

  it('calls onClose when the port closes', () => {
    const port = new FakePort();
    const closes = [];
    new PowerMessagePort(port, {
      onClose: () => closes.push(1),
    });

    port.fire('close', {});

    expect(closes).toHaveLength(1);
  });

  it('ignores inbound messages after dispose', () => {
    const port = new FakePort();
    const received = [];
    const adapter = new PowerMessagePort(port, {
      onMessage: (value) => received.push(value),
    });

    adapter.dispose();
    const envelope = encodeNativeEnvelope(new Map([['a', 1]]));
    port.fire('message', { data: envelope });

    expect(received).toHaveLength(0);
  });

  it('ignores close events after dispose', () => {
    const port = new FakePort();
    const closes = [];
    const adapter = new PowerMessagePort(port, {
      onClose: () => closes.push(1),
    });

    adapter.dispose();
    port.fire('close', {});

    expect(closes).toHaveLength(0);
  });

  it('decodes Date, Set and BigInt from a native envelope', () => {
    const port = new FakePort();
    const received = [];
    new PowerMessagePort(port, {
      onMessage: (value) => received.push(value),
    });

    const envelope = encodeNativeEnvelope({
      date: new Date(1234567890123),
      set: new Set([1, 2, 3]),
      big: 10n,
    });
    port.fire('message', { data: envelope });

    expect(received).toHaveLength(1);
    expect(received[0].date).toBeInstanceOf(Date);
    expect(received[0].date.getTime()).toBe(1234567890123);
    expect(received[0].set).toBeInstanceOf(Set);
    expect(received[0].set.has(2)).toBe(true);
    expect(received[0].big).toBe(10n);
  });

  it('throws on construction for a non-port', () => {
    expect(() => new PowerMessagePort(null)).toThrow(TypeError);
    expect(() => new PowerMessagePort({})).toThrow(TypeError);
  });
});
