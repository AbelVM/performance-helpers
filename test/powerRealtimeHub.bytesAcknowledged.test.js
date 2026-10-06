import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/index.js';

/**
 * WT-004: per-subscriber transport-reported byte acknowledgement.
 *
 * `bytesSent` is the hub's own count of bytes handed to the adapter — it is
 * exact and free, but it counts *offered* bytes, not *acknowledged* ones. On
 * HTTP/2 a transport reports per-stream acknowledgement, which is a strictly
 * better figure, and on transports that do not report it the callback is
 * simply not supplied. So the hub keeps `bytesSent` as the floor and exposes
 * this as an **optional** callback wired up at subscribe time.
 *
 * The shape is a function rather than a number because the value moves: a
 * number captured at subscribe time would be stale by the next flush. The
 * callback is invoked in the same statement that increments `bytesSent`, so
 * the two move together — which is the property the reconcile test pins.
 */
describe('PowerRealtimeHub bytesAcknowledged (WT-004)', () => {
  function recorder() {
    const acked = [];
    const hub = new PowerRealtimeHub({
      send: () => {},
      batch: false,
    });
    return { hub, acked };
  }

  it('invokes the callback with the frame length after the transport took it', async () => {
    const { hub, acked } = recorder();
    hub.subscribe('news', () => {}, {
      bytesAcknowledged: (bytes, sub) => acked.push({ bytes, id: sub.id }),
    });

    hub.publish('news', { n: 1 });
    await hub.flush();

    expect(acked).toHaveLength(1);
    expect(acked[0].bytes).toBeGreaterThan(0);
    expect(acked[0].id).toMatch(/^sub-/);
  });

  it('moves in the same statement as bytesSent', async () => {
    // The reconcile invariant: the callback is invoked in the same place
    // `bytesSent` is incremented, so for every frame handed over the two
    // advance together. A callback that lags behind `bytesSent` would be
    // reporting on a frame the transport had not yet taken, which is the
    // whole point of the field.
    const { hub, acked } = recorder();
    hub.subscribe('news', () => {}, { bytesAcknowledged: (bytes) => acked.push(bytes) });

    for (let i = 0; i < 5; i += 1) hub.publish('news', { n: i });
    await hub.flush();

    const list = hub.stats().list;
    expect(list[0].bytesSent).toBe(acked.reduce((n, b) => n + b, 0));
  });

  it('is per-subscriber: one callback does not receive another subscriber', async () => {
    const { hub, acked } = recorder();
    hub.subscribe('news', () => {}, {
      id: 'a',
      bytesAcknowledged: (bytes, sub) => acked.push({ bytes, id: sub.id }),
    });
    hub.subscribe('news', () => {}, { id: 'b' });

    hub.publish('news', { n: 1 });
    await hub.flush();

    expect(acked).toHaveLength(1);
    expect(acked[0].id).toBe('a');
  });

  it('is a no-op when the caller does not supply one', async () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {});
    hub.publish('news', { n: 1 });
    await hub.flush();

    // No callback means the hub keeps `bytesSent` as the floor and nothing
    // else is needed. The subscriber still has its byte count.
    expect(hub.stats().list[0].bytesSent).toBeGreaterThan(0);
  });

  it('rejects a non-function at subscribe time', () => {
    const { hub } = recorder();
    expect(() => hub.subscribe('t', () => {}, { bytesAcknowledged: 42 })).toThrow(
      /bytesAcknowledged.*function/
    );
    expect(() => hub.subscribe('t', () => {}, { bytesAcknowledged: null })).not.toThrow();
    // `null` is the explicit "not supplied" sentinel and is accepted, because
    // the field is typed `function | null` and a caller passing `null`
    // should get the no-op rather than an error.
  });

  it('a throwing callback is reported through onError and does not break delivery', async () => {
    const errors = [];
    const hub = new PowerRealtimeHub({
      send: () => {},
      batch: false,
      onError: (err) => errors.push(err),
    });
    let delivered = 0;
    hub.subscribe(
      'news',
      () => {
        delivered += 1;
      },
      {
        bytesAcknowledged: () => {
          throw new Error('bad accounting callback');
        },
      }
    );

    hub.publish('news', { n: 1 });
    await hub.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe('bad accounting callback');
    // The handler still ran: a bad accounting callback must not become a
    // delivery failure.
    expect(delivered).toBe(1);
  });

  it('does not change bytesSent when no callback is supplied', async () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {});
    hub.publish('news', { n: 1 });
    await hub.flush();

    // `bytesSent` is the floor and is unaffected by the absence of a
    // callback — the reconcile identity still holds.
    expect(hub.stats().bytesOut).toBe(hub.stats().list[0].bytesSent);
  });
});
