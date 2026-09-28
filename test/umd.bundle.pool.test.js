import { describe, it, expect } from 'vitest';
import {
  createBundleContext,
  evalInBundle,
  receivedCountExpression,
  waitForBundleValue,
} from './helpers/umdBundle.js';

// Tests specific PowerPool behaviors against the UMD bundle
describe('UMD bundle - PowerPool (extra)', () => {
  it('PowerPool broadcast and stopThePress behave in sandboxed UMD', async () => {
    const { ctx } = createBundleContext();

    // create a pool with 2 workers and broadcast a message; define MockWorker inside the VM
    evalInBundle(
      ctx,
      `(function(){
        class MockWorker {
          constructor() {
            this.onmessage = null;
            this.postMessageCalls = [];
            this.postMessage = (msg, tr) => {
              this.postMessageCalls.push({ msg, tr });
              setTimeout(() => { if (this.onmessage) this.onmessage({ data: msg }) }, 0);
            };
            this.addEventListener = (t, cb) => { if (t === 'message') this.onmessage = cb };
            this.terminate = () => { this.__terminated = true };
          }
        }
        const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
        const pool = new lib.PowerPool(MockWorker, { size: 2, idleTimeout: 1000, maxTasksPerWorker: 1, taskQueue: false })
        this.__p = pool
        this.__received = []
        pool.onmessage = (e) => { this.__received.push(e.data) }
        pool.postMessage({ hello: 'broadcast' })
        return true
      })()`
    );

    await waitForBundleValue(ctx, receivedCountExpression('__received'), {
      description: 'a broadcast reply',
    });

    const summary = evalInBundle(
      ctx,
      `(function(){
        return {
          receivedCount: (this.__received && this.__received.length) || 0,
          workers: (this.__p && this.__p.workers && this.__p.workers.length) || 0,
          firstPost: (this.__p && this.__p.workers && this.__p.workers[0] && this.__p.workers[0]._underlying && this.__p.workers[0]._underlying.postMessageCalls && this.__p.workers[0]._underlying.postMessageCalls[0]) || null
        }
      })()`
    );

    expect(summary.receivedCount).toBeGreaterThanOrEqual(1);
    expect(summary.workers).toBe(2);
    expect(summary.firstPost).toBeDefined();

    // Now call stopThePress and ensure reaper interval cleared when recreateWorkers=false
    evalInBundle(
      ctx,
      '(function(){ this.__p._reaperInterval = setInterval(()=>{},10000); this.__p.stopThePress(null, undefined, { recreateWorkers: false }); return !!this.__p._reaperInterval })()'
    );
    const reaperLeft = evalInBundle(ctx, '(function(){ return this.__p._reaperInterval })()');
    expect(reaperLeft).toBeNull();
  });

  it('PowerPool awaitResponse via UMD returns Promise-like entries', () => {
    const { ctx } = createBundleContext();

    const res = evalInBundle(
      ctx,
      `(function(){
        class MockWorker2 {
          constructor() { this.onmessage = null }
          postMessage(msg) { setTimeout(() => { if (this.onmessage) this.onmessage({ data: { correlationId: msg && msg.correlationId, response: 'ok' } }) }, 0) }
          addEventListener(t, cb) { if (t === 'message') this.onmessage = cb }
          terminate() {}
        }
        const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
        const pool = new lib.PowerPool(MockWorker2, { size: 1, idleTimeout: 1000, maxTasksPerWorker: 1, taskQueue: false })
        const out = pool.postMessageBatch([{ message: { a:1 } }], { awaitResponse: true })
        return { isArray: Array.isArray(out), hasThen: typeof out[0].then === 'function' }
      })()`
    );

    expect(res.isArray).toBe(true);
    expect(res.hasThen).toBe(true);
  });
});
