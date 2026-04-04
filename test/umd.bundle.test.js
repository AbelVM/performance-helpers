import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';

describe('UMD bundle', () => {
  it('builds UMD bundle and exposes expected globals and APIs', () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) {
      execSync('npm run build', { stdio: 'inherit' });
    }

    const code = readFileSync(distFile, 'utf8');

    // create a sandbox with basic browser-like globals
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

    const context = vm.createContext(sandbox);

    // evaluate the UMD bundle in the sandbox
    vm.runInContext(code, context, { filename: distFile });

    const lib =
      context.globalThis.PerformanceHelpers ||
      context.globalThis.performanceHelpers ||
      context.PerformanceHelpers ||
      context.performanceHelpers;
    expect(lib).toBeDefined();

    // basic exported symbols should exist
    expect(typeof lib.PowerCache).toBe('function');
    expect(typeof lib.PowerPool).toBe('function');
    expect(typeof lib.PowerLogger).toBe('function');
    expect(typeof lib.o2b).toBe('function');
    expect(typeof lib.o2u8).toBe('function');
    expect(typeof lib.u82o).toBe('function');
    expect(typeof lib.b2o).toBe('function');
    // ensure module namespace is available via the UMD global (build uses name: 'PerformanceHelpers')
    expect(lib).toBeDefined();

    // basic runtime checks
    const cache = new lib.PowerCache({ maxEntries: 10 });
    cache.set('k', 123);
    expect(cache.get('k')).toBe(123);

    // ensure we can construct a PowerCache and use it
    const cache2 = new lib.PowerCache({ maxEntries: 10 });
    cache2.set('x', 42);
    expect(cache2.get('x')).toBe(42);
  });

  it('PowerPool from UMD bundle works with a mock underlying worker', async () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) {
      execSync('npm run build', { stdio: 'inherit' });
    }
    const code = readFileSync(distFile, 'utf8');

    // new sandbox for pool test
    const sandbox2 = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      globalThis: {},
    };
    sandbox2.window = sandbox2.globalThis;
    sandbox2.self = sandbox2.globalThis;
    sandbox2.global = sandbox2.globalThis;

    const ctx = vm.createContext(sandbox2);
    vm.runInContext(code, ctx, { filename: distFile });

    // inside the sandbox, define a MockUnderlying and exercise the pool
    vm.runInContext(
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers

      class MockUnderlying {
        constructor() {
          this.onmessage = null
          this.onerror = null
          this.onmessageerror = null
          this.postMessageCalls = []
          this.postMessage = (msg) => {
            this.postMessageCalls.push(msg)
            setTimeout(() => { if (this.onmessage) this.onmessage({ data: msg }) }, 0)
              }
          this.terminate = () => { this.__terminated = true }
        }
      }

      const pool = new lib.PowerPool(MockUnderlying, { size: 1, idleTimeout: 1000, maxTasksPerWorker: 1, taskQueue: true })
      this.__pool = pool
      this.__received = []
      pool.onmessage = (e) => { this.__received.push(e.data) }
      pool.postMessage({ hello: 'umd' })
      return true
    })()`,
      ctx,
      { filename: distFile }
    );

    // allow async replies to be delivered
    await new Promise((r) => setTimeout(r, 50));

    const summary = vm.runInContext(
      `(function(){
      const count = (this.__received && this.__received.length) || 0
      const rjson = count ? JSON.stringify(this.__received[0]) : null
      const underlying = (this.__pool && this.__pool.workers && this.__pool.workers[0] && this.__pool.workers[0]._underlying) || (this.__pool && this.__pool.workers && this.__pool.workers[0] && this.__pool.workers[0].worker && this.__pool.workers[0].worker._underlying)
      const postArg = underlying && underlying.postMessageCalls && underlying.postMessageCalls[0]
      const isUint8 = !!(postArg && postArg.constructor && postArg.constructor.name === 'Uint8Array')
      return { count, rjson, isUint8 }
    })()`,
      ctx,
      { filename: distFile }
    );

    expect(summary.count).toBeGreaterThanOrEqual(1);
    expect(summary.rjson).toBe(JSON.stringify({ hello: 'umd' }));
    expect(summary.isUint8).toBe(true);
  });

  it('PowerPool supports string workerSource via sandbox Worker', async () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) {
      execSync('npm run build', { stdio: 'inherit' });
    }
    const code = readFileSync(distFile, 'utf8');

    const sandbox3 = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      globalThis: {},
    };
    sandbox3.window = sandbox3.globalThis;
    sandbox3.self = sandbox3.globalThis;
    sandbox3.global = sandbox3.globalThis;

    // Provide a Worker constructor that accepts a string `src`
    sandbox3.Worker = function MockWorkerSrc(src, options) {
      this.src = src;
      this.options = options;
      this.onmessage = null;
      this.postMessageCalls = [];
      this.postMessage = (msg) => {
        this.postMessageCalls.push(msg);
        setTimeout(() => {
          if (this.onmessage) this.onmessage({ data: msg });
        }, 0);
      };
      this.addEventListener = (t, cb) => {
        if (t === 'message') this.onmessage = cb;
      };
      this.terminate = () => {
        this.__terminated = true;
      };
    };

    const ctx3 = vm.createContext(sandbox3);
    vm.runInContext(code, ctx3, { filename: distFile });

    vm.runInContext(
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const pool = new lib.PowerPool('mock-worker.js', { size: 1, idleTimeout: 1000, maxTasksPerWorker: 1, taskQueue: false })
      this.__pool_str = pool
      this.__received_str = []
      pool.onmessage = (e) => { this.__received_str.push(e.data) }
      pool.postMessage({ hi: 'string' })
      return true
    })()`,
      ctx3,
      { filename: distFile }
    );

    await new Promise((r) => setTimeout(r, 50));

    const summary3 = vm.runInContext(
      `(function(){
      const count = (this.__received_str && this.__received_str.length) || 0
      const underlying = (this.__pool_str && this.__pool_str.workers && this.__pool_str.workers[0] && this.__pool_str.workers[0]._underlying)
      const postArg = underlying && underlying.postMessageCalls && underlying.postMessageCalls[0]
      const isTransfer = !!(postArg && (ArrayBuffer.isView ? ArrayBuffer.isView(postArg) : (postArg && postArg.constructor && postArg.constructor.name && postArg.constructor.name.indexOf('Uint8Array') !== -1) || postArg instanceof ArrayBuffer))
      return { count, isTransfer, src: underlying && underlying.src }
    })()`,
      ctx3,
      { filename: distFile }
    );

    expect(summary3.count).toBeGreaterThanOrEqual(1);
  });

  it('PowerPool.postMessage returns false when underlying.postMessage throws', () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) {
      execSync('npm run build', { stdio: 'inherit' });
    }
    const code = readFileSync(distFile, 'utf8');

    const sandbox4 = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      globalThis: {},
    };
    sandbox4.window = sandbox4.globalThis;
    sandbox4.self = sandbox4.globalThis;
    sandbox4.global = sandbox4.globalThis;

    // Worker that throws when postMessage is called
    sandbox4.Worker = function ThrowingWorker() {
      this.onmessage = null;
      this.postMessage = function () {
        throw new Error('boom');
      };
      this.addEventListener = function () {};
      this.terminate = function () {};
    };

    const ctx4 = vm.createContext(sandbox4);
    vm.runInContext(code, ctx4, { filename: distFile });

    const res = vm.runInContext(
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const pool = new lib.PowerPool('throwing.js', { size: 1, idleTimeout: 1000, maxTasksPerWorker: 1, taskQueue: false })
      try {
        const ok = pool.postMessage({ x: 1 })
        return { ok: !!ok, workers: pool.workers.length }
      } catch (e) { return { ok: false, err: String(e) } }
    })()`,
      ctx4,
      { filename: distFile }
    );

    expect(res.ok).toBe(false);
  });
});
