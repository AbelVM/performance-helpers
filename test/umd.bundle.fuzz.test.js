import { describe, it, expect } from 'vitest';
import { createBundleContext, evalInBundle } from './helpers/umdBundle.js';

describe('UMD bundle broader exercise', () => {
  it('runs a wide set of operations to exercise branches', () => {
    // `Buffer` is injected so the bundle's Node fallback path is reachable.
    const { ctx } = createBundleContext({ sandbox: { Buffer: globalThis.Buffer } });

    const res = evalInBundle(
      ctx,
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const cache = new lib.PowerCache({ maxEntries: 50, maxWeight: 1000 })

      // circular object to make JSON.stringify throw
      const a = { }
      a.self = a
      try { cache.set('circ', a) } catch(e){}

      // object with toJSON throwing
      const bad = { toJSON(){ throw new Error('bad') } }
      try { cache.set('bad', bad) } catch(e){}

      // DataView
      const buf = new ArrayBuffer(8);
      const dv = new DataView(buf);
      dv.setUint8(0, 42);
      cache.set('dv', dv);
      const dvOk = cache.hasEqual('dv', new DataView(buf));

      // Buffer (Node)
      const bufNode = Buffer.from([1,2,3]);
      cache.set('nodebuf', bufNode);
      const bufOk = cache.hasEqual('nodebuf', Buffer.from([1,2,3]));

      // Map/Set edgecases
      const m = new Map([[{k:1}, 2]]);
      cache.set('m2', m);
      const s = new Set([1,2,3]);
      cache.set('s2', s);

      // Pool interactions: create a mock worker factory
      const WorkerCtor = function(){
        this.postMessage = (msg, transfer)=>{}
        this.addEventListener = ()=>{}
        this.removeEventListener = ()=>{}
        this.terminate = ()=>{}
        this.onmessage = null
        this.onerror = null
        this.onmessageerror = null
      }
      const pool = new lib.PowerPool(WorkerCtor)
      const posted = pool.postMessage({a:1})

      return { dvOk, bufOk, posted }
    })()`
    );

    expect(res.dvOk).toBe(true);
    expect(res.bufOk).toBe(true);
    expect(res.posted).toBe(true);
  });
});
