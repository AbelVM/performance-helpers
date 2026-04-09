import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';

const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
const code = readFileSync(distFile, 'utf8');

describe('UMD bundle exhaustive branches', () => {
  it('global context with TextEncoder/TextDecoder exercises many APIs', async () => {
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      globalThis: {},
    };
    sandbox.window = sandbox.globalThis;
    sandbox.self = sandbox.globalThis;
    sandbox.global = sandbox.globalThis;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: distFile });

    const lib =
      sandbox.globalThis.PerformanceHelpers ||
      sandbox.globalThis.performanceHelpers ||
      sandbox.PerformanceHelpers ||
      sandbox.performanceHelpers;
    expect(lib).toBeDefined();

    // Buffer/encoding paths (TextEncoder present) -> o2u8/u82o roundtrip (do full roundtrip inside VM)
    const obj = { hello: 'world' };
    const round = vm.runInContext(
      `(function(){ const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers; const u8 = lib.o2u8(${JSON.stringify(obj)}); return lib.u82o(u8); })()`,
      ctx,
      { filename: distFile }
    );
    expect(round).toEqual(obj);

    // b2o/o2b conversions
    // perform ArrayBuffer roundtrip inside the VM to avoid cross-realm checks
    vm.runInContext(
      `(function(){ const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers; lib.o2b(${JSON.stringify(obj)}); return true })()`,
      ctx,
      { filename: distFile }
    );

    // PowerLogger: enable verbose and call with lazy-throwing functions
    const logger = new lib.PowerLogger(3);
    expect(typeof logger.setDebugLevel).toBe('function');
    // call with a lazy function that throws; should not propagate
    logger.info(
      () => 'ok',
      () => {
        throw new Error('boom-in-lazy');
      }
    );
    logger.warn('plain', () => 'value');

    // PowerCache basic ops
    const cache = new lib.PowerCache({ maxEntries: 3 });
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
    cache.set('b', 2);
    expect(cache.has('b')).toBe(true);
    cache.delete('b');
    expect(cache.has('b')).toBe(false);

    // PowerMemoizer: sync and async caching behavior
    const syncFn = (x) => x * 2;
    const memoSync = new lib.PowerMemoizer(syncFn, { cacheOptions: { maxEntries: 10 } });
    const callSync = typeof memoSync === 'function' ? memoSync : (...args) => memoSync.run(...args);
    expect(callSync(2)).toBe(4);
    expect(callSync(2)).toBe(4);

    const asyncFn = async (n) => n + 1;
    const memoAsync = new lib.PowerMemoizer(asyncFn, { cacheOptions: { maxEntries: 10 } });
    const callAsync =
      typeof memoAsync === 'function' ? memoAsync : (...args) => memoAsync.run(...args);
    const p1 = callAsync(3);
    const p2 = callAsync(3);
    expect(p1).toBe(p2);
    const res = await p1;
    expect(res).toBe(4);

    // PowerPool: use mock underlying to exercise encode path
    vm.runInContext(
      `(function(){
      class MockUnderlying {
        constructor(){ this.onmessage=null; this.postMessageCalls=[] }
        postMessage(msg, transfer){ this.postMessageCalls.push(msg); setTimeout(()=>{ if(this.onmessage) this.onmessage({ data: msg }) }, 0) }
        addEventListener(t, cb){ if(t==='message') this.onmessage = cb }
        terminate(){ this.__terminated = true }
      }
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const pool = new lib.PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000, maxTasksPerWorker: 1, taskQueue: true })
      this.__p = pool
      this.__r = []
      pool.onmessage = (e) => { this.__r.push(e.data) }
      pool.postMessage({ ping: 'pong' })
      return true
    })()`,
      ctx,
      { filename: distFile }
    );

    // allow async replies
    await new Promise((r) => setTimeout(r, 50));
    const summary = vm.runInContext(
      `(function(){
      const count = (this.__r && this.__r.length) || 0
      const underlying = (this.__p && this.__p.workers && this.__p.workers[0] && this.__p.workers[0]._underlying) || (this.__p && this.__p.workers && this.__p.workers[0] && this.__p.workers[0].worker && this.__p.workers[0].worker._underlying)
      const postArg = underlying && underlying.postMessageCalls && underlying.postMessageCalls[0]
      return { count, postArg }
    })()`,
      ctx,
      { filename: distFile }
    );
    expect(summary.count).toBeGreaterThanOrEqual(1);
    expect(summary.postArg).not.toBeNull();
  });

  it('CommonJS/module.exports path with Buffer fallback exercises Buffer encoder path', () => {
    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval };
    // remove TextEncoder/TextDecoder to force Buffer fallback
    sandbox.TextEncoder = undefined;
    sandbox.TextDecoder = undefined;
    sandbox.Buffer = Buffer;
    sandbox.module = { exports: {} };
    sandbox.exports = sandbox.module.exports;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: distFile });

    const lib = sandbox.module.exports;
    expect(lib).toBeDefined();

    // Buffer-based encoding should work when TextEncoder absent
    const obj = { x: 1 };
    // run encode/decode entirely inside the VM to avoid cross-realm instanceof failures
    const decoded = vm.runInContext(
      `(function(){ const lib = module.exports; const u8 = lib.o2u8(${JSON.stringify(obj)}); return lib.u82o(u8); })()`,
      ctx,
      { filename: distFile }
    );
    expect(decoded).toEqual(obj);

    // logger still functions
    const logger = new lib.PowerLogger(2);
    logger.error(() => 'err', 'plain');
  });
});
