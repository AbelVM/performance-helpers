import { describe, it, expect, beforeAll } from 'vitest';
import { PowerPool, preloadNode, encodeMessage, decodeMessage } from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/**
 * A worker written the way a user should now write one: decode the frame.
 */
class FramedWorker {
  constructor() {
    this._listeners = [];
    this.received = [];
  }
  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }
  removeEventListener() {}
  postMessage(msg) {
    const payload = decodeMessage(msg).value;
    this.received.push(payload);
    for (const [t, fn] of this._listeners) {
      if (t === 'message') {
        // Reply as a frame, exactly as a real worker should. The pool reads
        // `correlationId` from the top level of the decoded object to settle the
        // pending response, so it has to be echoed there - not nested.
        queueMicrotask(() =>
          fn({
            data: encodeMessage(
              { duration: 1, correlationId: payload?.correlationId, echo: payload },
              { codec: 'json' }
            ),
          })
        );
      }
    }
  }
  terminate() {}
}

/** A 1.x-era worker: bare JSON bytes in, bare JSON bytes out. */
class LegacyWorker {
  constructor() {
    this._listeners = [];
  }
  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }
  removeEventListener() {}
  postMessage(msg) {
    const payload = JSON.parse(new TextDecoder().decode(msg));
    for (const [t, fn] of this._listeners) {
      if (t === 'message') {
        queueMicrotask(() =>
          fn({
            data: new TextEncoder().encode(
              JSON.stringify({ duration: 1, correlationId: payload?.correlationId, echo: payload })
            ),
          })
        );
      }
    }
  }
  terminate() {}
}

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('PowerPool framed protocol is the default (2.0)', () => {
  it('posts a decodable frame a worker can read', async () => {
    const worker = new FramedWorker();
    const pool = new PowerPool(() => worker, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
      awaitResponseTimeout: 0,
    });
    expect(pool._messageCodec).toBe('framed');

    const res = await pool.postMessage({ task: 'compute', n: 7 }, undefined, {
      awaitResponse: true,
    });
    expect(worker.received).toEqual([{ task: 'compute', n: 7, correlationId: expect.any(String) }]);
    expect(res.echo.task).toBe('compute');
    pool.shutdown();
  });

  it('preserves a binary task instead of JSON.parse-ing it into garbage', async () => {
    const worker = new FramedWorker();
    const pool = new PowerPool(() => worker, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
      awaitResponseTimeout: 0,
    });

    // 0xFF and 0xFE are not valid standalone JSON, so the 1.x sniff would
    // either throw or corrupt this.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x7f]);
    await pool.postMessage(bytes);
    await tick();

    const got = worker.received[0];
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Array.from(got)).toEqual([0xff, 0xfe, 0x00, 0x80, 0x7f]);
    pool.shutdown();
  });

  it('leaves an explicit transfer list alone: the caller owns that buffer', () => {
    const pool = new PowerPool(() => new FramedWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const prepared = pool._prepareForTransfer(bytes, [bytes.buffer]);
    // Documented contract: a supplied transfer list means "I am sending this
    // exact buffer, already in the form I want", so the pool does not wrap it.
    expect(prepared.message).toBe(bytes);
    expect(prepared.transfer).toEqual([bytes.buffer]);
    pool.shutdown();
  });

  it('passes a non-frame binary payload through instead of guessing at it', () => {
    const pool = new PowerPool(() => new FramedWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    const seen = [];
    pool.addEventListener('message', (e) => seen.push(e.data));
    const obj = pool.workers[0];
    // A worker posts bare JSON bytes - a 1.x peer, or a misbehaving one. The
    // pool must not JSON.parse them into nonsense; it surfaces the failure via
    // messageerror and leaves the payload alone.
    const errors = [];
    pool.addEventListener('messageerror', (e) => errors.push(e));
    const bare = new TextEncoder().encode('{"not":"a frame"}');
    for (const [t, fn] of obj.worker._underlying._listeners) {
      if (t === 'message') fn({ data: bare });
    }
    // The decode failure is reported rather than swallowed, and the bytes are
    // forwarded verbatim - not JSON.parse'd into a misleading object.
    expect(errors.length).toBeGreaterThan(0);
    expect(seen).toEqual([bare]);
    pool.shutdown();
  });

  it('routes a decode failure to messageerror rather than throwing', async () => {
    const errors = [];
    const pool = new PowerPool(() => new FramedWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    pool.addEventListener('messageerror', (e) => errors.push(e));
    const obj = pool.workers[0];
    // Simulate a worker posting garbage bytes: version 1, unknown codec id 9.
    const bogus = new Uint8Array([1, 9, 0, 0, 0, 0, 0]);
    for (const [t, fn] of obj.worker._underlying._listeners) {
      if (t === 'message') fn({ data: bogus });
    }
    expect(errors.length).toBeGreaterThan(0);
    pool.shutdown();
  });
});

describe("messageCodec: 'legacy' escape hatch", () => {
  it('restores the 1.x bare-JSON wire format', async () => {
    const worker = new LegacyWorker();
    const pool = new PowerPool(() => worker, {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
      awaitResponseTimeout: 0,
      messageCodec: 'legacy',
    });
    expect(pool._messageCodec).toBe('legacy');

    const res = await pool.postMessage({ task: 'compute' }, undefined, { awaitResponse: true });
    expect(res.echo.task).toBe('compute');
    pool.shutdown();
  });

  it('a framed worker and a legacy pool interoperate via the documented fallback', async () => {
    // The fixture/worker pattern documented in guides/powerPool.md: try the
    // frame, fall back to a bare body.
    const hybrid = {
      _listeners: [],
      addEventListener(t, f) {
        this._listeners.push([t, f]);
      },
      removeEventListener() {},
      postMessage(msg) {
        // Reply in the SAME shape that arrived. This matters: a legacy pool
        // sniffs replies with u82o, so a framed reply is unreadable to it. A
        // migration-friendly worker has to mirror the inbound shape, not just
        // accept both.
        let payload;
        let framed = true;
        try {
          payload = decodeMessage(msg).value;
        } catch {
          framed = false;
          payload = JSON.parse(new TextDecoder().decode(msg));
        }
        for (const [t, fn] of this._listeners) {
          if (t === 'message') {
            const body = {
              duration: 1,
              correlationId: payload?.correlationId,
              got: payload,
            };
            queueMicrotask(() =>
              fn({
                data: framed ? encodeMessage(body) : new TextEncoder().encode(JSON.stringify(body)),
              })
            );
          }
        }
      },
      terminate() {},
    };
    for (const codec of ['framed', 'legacy']) {
      const pool = new PowerPool(() => hybrid, {
        size: 1,
        minSize: 1,
        maxSize: 1,
        lazy: false,
        awaitResponseTimeout: 0,
        messageCodec: codec,
      });
      const res = await pool.postMessage({ n: 1 }, undefined, { awaitResponse: true });
      expect(res.got.n).toBe(1);
      pool.shutdown();
    }
  });
});

describe('PowerMessageCodec is the pool protocol, not a parallel implementation', () => {
  it('the pool emits exactly what encodeMessage produces for the same value', () => {
    const pool = new PowerPool(() => new FramedWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    // Compare the header and body of a prepared message against the codec.
    const value = { hello: 'world' };
    const prepared = pool._prepareForTransfer(value, undefined);
    const frame = decodeMessage(prepared.message);
    expect(frame.codec).toBe('json');
    expect(frame.value).toEqual(value);
    expect(prepared.message[0]).toBe(1); // protocol version byte
    expect(prepared.transfer).toEqual([prepared.message.buffer]);
    pool.shutdown();
  });

  it('the encode cache is still what absorbs the serialize cost', () => {
    const pool = new PowerPool(() => new FramedWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    pool.postMessage({ repeat: 1 });
    const afterFirst = pool._encodeCache.size;
    pool.postMessage({ repeat: 1 });
    pool.postMessage({ repeat: 1 });
    // Same JSON body -> one cache entry, reused across frames.
    expect(pool._encodeCache.size).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(0);
    pool.shutdown();
  });
});
