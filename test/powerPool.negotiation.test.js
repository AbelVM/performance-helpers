import { describe, it, expect, beforeAll } from 'vitest';
import {
  PowerPool,
  preloadNode,
  decodeInbound,
  encodeMessage,
  encodeNativeEnvelope,
  announceCapabilities,
  isNativeEnvelope,
  isCapabilityAnnouncement,
  collectTransferables,
} from '../src/index.js';

beforeAll(async () => {
  await preloadNode();
});

/**
 * A worker that behaves the way `guides/powerMessageCodec.md` tells a worker to
 * behave: read anything with `decodeInbound`, and — if it can read the native
 * carrier — say so once at start-up.
 *
 * `advertise: false` models the worker that has not been migrated yet. Both
 * kinds have to work against the same pool, which is the state a rollout
 * actually passes through.
 */
class NegotiationWorker {
  constructor({ advertise = true, name = 'w' } = {}) {
    this.name = name;
    this._listeners = [];
    /** Every carrier the pool posted, in order. */
    this.receivedCarriers = [];
    this.received = [];
    if (advertise) this._announce();
  }

  _announce() {
    queueMicrotask(() => this._emit(announceCapabilities()));
  }

  addEventListener(type, fn) {
    this._listeners.push([type, fn]);
  }
  removeEventListener() {}

  postMessage(msg) {
    const { codec, value } = decodeInbound(msg);
    this.receivedCarriers.push(codec);
    this.received.push(value);
    queueMicrotask(() => {
      const body = {
        duration: 1,
        correlationId: value?.correlationId,
        echo: value,
      };
      // Mirror the inbound carrier, which is what the migration guide asks for.
      this._emit(
        codec === 'native'
          ? encodeNativeEnvelope(body, { correlationId: value?.correlationId })
          : encodeMessage(body, { codec: 'json' })
      );
    });
  }

  _emit(data) {
    for (const [type, fn] of this._listeners) {
      if (type === 'message') fn({ data });
    }
  }

  terminate() {}
}

const poolFor = (factory, options = {}) =>
  new PowerPool(factory, {
    size: 1,
    minSize: 1,
    maxSize: 1,
    lazy: false,
    awaitResponseTimeout: 0,
    messageCodec: 'negotiated',
    ...options,
  });

const tick = () => new Promise((r) => setTimeout(r, 10));

describe("messageCodec: 'negotiated' upgrades a worker that advertises, and only that one", () => {
  it('a worker that advertises native receives the native carrier', async () => {
    const worker = new NegotiationWorker();
    const pool = poolFor(() => worker);

    // The ratchet, pinned rather than waited out: the first message is framed,
    // because that is what the pool posts until an announcement arrives, and a
    // worker is allowed to be mid-start-up. The second is native. A test that
    // slept until the upgrade had happened would hide exactly this.
    await pool.postMessage({ task: 'first' }, undefined, { awaitResponse: true });
    expect(worker.receivedCarriers).toEqual(['json']);

    const res = await pool.postMessage({ task: 'compute', n: 7 }, undefined, {
      awaitResponse: true,
    });
    expect(res.echo.task).toBe('compute');
    expect(worker.receivedCarriers).toEqual(['json', 'native']);
    pool.shutdown();
  });

  it('request returns the response and forwards request options', async () => {
    const worker = new NegotiationWorker({ advertise: false });
    const pool = poolFor(() => worker);

    const res = await pool.request({ task: 'compute', n: 7 }, { correlationId: 'request-1' });

    expect(res.echo.task).toBe('compute');
    expect(res.echo.correlationId).toBe('request-1');
    pool.shutdown();
  });

  it('a worker that does not advertise still receives the framed carrier', async () => {
    const worker = new NegotiationWorker({ advertise: false });
    const pool = poolFor(() => worker);

    const res = await pool.postMessage({ task: 'compute' }, undefined, { awaitResponse: true });
    expect(res.echo.task).toBe('compute');
    expect(worker.receivedCarriers).toEqual(['json']);
    pool.shutdown();
  });

  it('one pool serves a mixed fleet: the upgraded worker goes native, the other does not', async () => {
    // The rollout state. A per-pool switch could not express this, which is the
    // whole reason the decision is made per worker.
    const native = new NegotiationWorker({ advertise: true, name: 'native' });
    const legacy = new NegotiationWorker({ advertise: false, name: 'legacy' });
    const queue = [native, legacy];
    const pool = poolFor(() => queue.shift() ?? native, { size: 2, minSize: 2, maxSize: 2 });

    for (const w of [native, legacy]) {
      const obj = pool.workers.find((x) => x.worker._underlying === w);
      await tick();
      void obj;
    }
    await pool.postMessage({ n: 1 });
    await tick();

    expect(native.receivedCarriers).toContain('native');
    expect(legacy.receivedCarriers).not.toContain('native');
    expect(pool.getStats().protocol.nativeWorkers).toBe(1);
    pool.shutdown();
  });
});

describe('what the native carrier is actually for', () => {
  it('preserves the values the JSON frame destroys', async () => {
    const worker = new NegotiationWorker();
    const pool = poolFor(() => worker);
    await pool.postMessage({ probe: 1 });
    await tick();

    const sent = {
      m: new Map([['a', 1]]),
      s: new Set([1, 2]),
      d: new Date(1234567890123),
      big: 10n,
      inf: Infinity,
      nan: NaN,
    };
    const res = await pool.postMessage(sent, undefined, { awaitResponse: true });

    expect(res.echo.m).toBeInstanceOf(Map);
    expect(res.echo.m.get('a')).toBe(1);
    expect(res.echo.s).toBeInstanceOf(Set);
    // A `Date` arriving as a string is the sharpest failure of the framed path:
    // it looks right until the first `.getTime()`.
    expect(res.echo.d).toBeInstanceOf(Date);
    expect(res.echo.d.getTime()).toBe(1234567890123);
    expect(res.echo.big).toBe(10n);
    expect(res.echo.inf).toBe(Infinity);
    expect(Number.isNaN(res.echo.nan)).toBe(true);
    pool.shutdown();
  });

  it('the framed carrier loses the same values, which is what negotiation is for', async () => {
    // Characterisation, not aspiration: this pins the cost of the *default*
    // path so the reason to switch is measured rather than remembered. If the
    // frame ever becomes lossless, this test is the one that should fail.
    const worker = new NegotiationWorker({ advertise: false });
    const pool = poolFor(() => worker);
    const sent = { m: new Map([['a', 1]]), d: new Date(1234567890123), inf: Infinity };
    const res = await pool.postMessage(sent, undefined, { awaitResponse: true });

    expect(res.echo.m).toEqual({});
    expect(typeof res.echo.d).toBe('string');
    expect(res.echo.inf).toBeNull();
    pool.shutdown();
  });
});

describe('transfer safety', () => {
  it("does not detach a caller's buffer when posting native", async () => {
    const worker = new NegotiationWorker();
    const pool = poolFor(() => worker);
    await pool.postMessage({ warm: 1 });
    await tick();

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await pool.postMessage({ bytes }, undefined, { awaitResponse: true });
    // A transfer list naming the caller's own buffer would detach it here, and
    // the failure mode is silent: the post succeeds and the caller's data is
    // gone. `byteLength === 0` is what detachment looks like.
    expect(bytes.byteLength).toBe(4);
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(worker.received[worker.received.length - 1].bytes).toBeInstanceOf(Uint8Array);
    pool.shutdown();
  });

  it('collects transferables from nested positions only', () => {
    const a = new ArrayBuffer(8);
    const b = new ArrayBuffer(8);
    expect(collectTransferables({ x: { y: a }, z: [b] })).toEqual([a, b]);
    // Duplicates collapse: a transfer list naming one buffer twice detaches on
    // the first post and throws on the second.
    expect(collectTransferables({ p: a, q: a })).toEqual([a]);
    expect(collectTransferables({ s: 'no buffers here' })).toEqual([]);
  });
});

describe('the announcement is protocol traffic, not a task', () => {
  it('is not forwarded to message listeners', async () => {
    const worker = new NegotiationWorker();
    const pool = poolFor(() => worker);
    const seen = [];
    pool.addEventListener('message', (e) => seen.push(e.data));
    await pool.postMessage({ n: 1 });
    await tick();

    // The listener sees the reply, never the announcement it never sent.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((d) => isCapabilityAnnouncement(d))).toBe(false);
    pool.shutdown();
  });

  it('leaves task accounting alone', async () => {
    const worker = new NegotiationWorker();
    const pool = poolFor(() => worker);
    await pool.postMessage({ n: 1 });
    await tick();
    // An announcement decremented as a completed task would push the counter
    // below the tasks actually run, and `_isIdle` would go true early.
    expect(pool.getStats().activeTasks).toBe(0);
    pool.shutdown();
  });

  it('emits pool:protocol with the previous carrier list', async () => {
    const worker = new NegotiationWorker();
    const pool = poolFor(() => worker);
    const events = [];
    pool.addEventListener('pool:protocol', (e) => events.push(e));
    await pool.postMessage({ n: 1 });
    await tick();

    expect(events.length).toBe(1);
    expect(events[0].codecs).toEqual(['json', 'native']);
    expect(events[0].previous).toEqual(['json']);
    pool.shutdown();
  });
});

describe('correlation and stats survive the carrier', () => {
  it('settles a reply whose payload is not a plain object', async () => {
    // The correlationId rides the envelope, not the payload, because the
    // payload here is a Map — writing pool bookkeeping onto it is not an option.
    class MapReplier extends NegotiationWorker {
      postMessage(msg) {
        const { codec, value } = decodeInbound(msg);
        this.received.push(value);
        this._emit(
          codec === 'native'
            ? encodeNativeEnvelope(new Map([['ok', true]]), { correlationId: value.correlationId })
            : msg
        );
      }
    }
    const worker = new MapReplier();
    const pool = poolFor(() => worker);
    await pool.postMessage({ warm: 1 });
    await tick();

    const res = await pool.postMessage({ n: 1 }, undefined, { awaitResponse: true });
    expect(res).toBeInstanceOf(Map);
    expect(res.get('ok')).toBe(true);
    pool.shutdown();
  });

  it('reports per-worker carriers, defaulting to json', () => {
    const pool = new PowerPool(() => new NegotiationWorker({ advertise: false }), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
    });
    // Default pool, un-negotiated: nothing is native and nothing was asked.
    const { protocol } = pool.getStats();
    expect(protocol.mode).toBe('framed');
    expect(protocol.nativeWorkers).toBe(0);
    expect(protocol.workers[0].codecs).toEqual(['json']);
    pool.shutdown();
  });
});

describe('an unknown codec name degrades to the documented default', () => {
  it('falls back to framed rather than selecting an unasked-for protocol', () => {
    const pool = new PowerPool(() => new NegotiationWorker(), {
      size: 1,
      minSize: 1,
      maxSize: 1,
      lazy: false,
      messageCodec: 'framd',
    });
    expect(pool._messageCodec).toBe('framed');
    pool.shutdown();
  });
});

describe('the codec primitives the pool relies on', () => {
  it('round-trips a value through an envelope', () => {
    const env = encodeNativeEnvelope({ a: 1 });
    expect(isNativeEnvelope(env)).toBe(true);
    expect(isNativeEnvelope({ a: 1 })).toBe(false);
    expect(decodeInbound(env)).toMatchObject({ codec: 'native', value: { a: 1 } });
  });

  it('always advertises json, whatever the caller claims', () => {
    // `json` is what the pool sends until the announcement lands. A worker that
    // advertised `native` alone would be saying it cannot read the messages it
    // has already been sent.
    expect(announceCapabilities({ codecs: ['native'] }).codecs).toEqual(['json', 'native']);
    expect(announceCapabilities({ codecs: ['bogus'] }).codecs).toEqual(['json']);
  });
});
