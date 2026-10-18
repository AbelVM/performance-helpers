import { describe, it, expect } from 'vitest';
import { PowerRealtimeHub } from '../src/helpers/powerRealtimeHub.js';

/** A transport double that records every frame it is handed. */
function recorder(opts = {}) {
  const frames = [];
  const hub = new PowerRealtimeHub({
    send: (sub, frame) => {
      if (opts.fail) throw opts.fail;
      frames.push({ id: sub.id, frame });
    },
    close: opts.close,
    onError: opts.onError,
    batch: false,
  });
  return { hub, frames };
}

describe('PowerRealtimeHub presence', () => {
  it('returns id/topic/transport for every live subscriber', () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {}, { id: 'a', transport: { sock: 1 } });
    hub.subscribe('news', () => {}, { id: 'b', transport: { sock: 2 } });
    hub.subscribe('other', () => {}, { id: 'c' });

    const all = hub.presence();
    expect(all).toHaveLength(3);
    expect(all.map((p) => p.id).sort()).toEqual(['a', 'b', 'c']);
    const a = all.find((p) => p.id === 'a');
    expect(a.topic).toBe('news');
    expect(a.transport).toEqual({ sock: 1 });
    hub.close();
  });

  it('filters by topic when one is given', () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {}, { id: 'a' });
    hub.subscribe('news', () => {}, { id: 'b' });
    hub.subscribe('other', () => {}, { id: 'c' });

    const news = hub.presence('news');
    expect(news).toHaveLength(2);
    expect(news.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(hub.presence('other')).toHaveLength(1);
    expect(hub.presence('missing')).toHaveLength(0);
    hub.close();
  });

  it('excludes detached subscribers (unsubscribe)', () => {
    const { hub } = recorder();
    const off = hub.subscribe('t', () => {}, { id: 'a' });
    hub.subscribe('t', () => {}, { id: 'b' });
    off();
    const ids = hub.presence().map((p) => p.id);
    expect(ids).toEqual(['b']);
    hub.close();
  });

  it('excludes slow-consumer-disconnected subscribers', async () => {
    const { hub } = recorder();
    hub.subscribe('t', () => {}, { id: 'slow', maxQueue: 0, slowConsumer: 'disconnect' });
    hub.subscribe('t', () => {}, { id: 'ok' });
    hub.publish('t', 1);
    await hub.flush();
    const ids = hub.presence().map((p) => p.id);
    expect(ids).toEqual(['ok']);
    hub.close();
  });

  it('excludes all subscribers after hub close', () => {
    const { hub } = recorder();
    hub.subscribe('t', () => {}, { id: 'a' });
    hub.subscribe('t', () => {}, { id: 'b' });
    hub.close();
    expect(hub.presence()).toEqual([]);
  });

  it('is a snapshot: mutating the returned array does not affect the hub', () => {
    const { hub } = recorder();
    hub.subscribe('t', () => {}, { id: 'a' });
    const snap = hub.presence();
    snap.push({ id: 'ghost', topic: 't', transport: null });
    snap.length = 0;
    expect(hub.presence()).toHaveLength(1);
    hub.close();
  });

  it('is a snapshot: mutating a returned object does not affect the hub', () => {
    const { hub } = recorder();
    hub.subscribe('t', () => {}, { id: 'a', transport: { sock: 1 } });
    const snap = hub.presence();
    snap[0].id = 'mutated';
    snap[0].topic = 'mutated';
    snap[0].transport = { sock: 999 };
    const again = hub.presence();
    expect(again[0].id).toBe('a');
    expect(again[0].topic).toBe('t');
    expect(again[0].transport).toEqual({ sock: 1 });
    hub.close();
  });

  it('getPresence is an alias with identical results', () => {
    const { hub } = recorder();
    hub.subscribe('news', () => {}, { id: 'a', transport: { sock: 1 } });
    hub.subscribe('other', () => {}, { id: 'b' });
    expect(hub.getPresence()).toEqual(hub.presence());
    expect(hub.getPresence('news')).toEqual(hub.presence('news'));
    hub.close();
  });
});
