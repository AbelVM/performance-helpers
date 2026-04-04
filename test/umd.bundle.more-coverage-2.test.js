import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';

const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
const code = readFileSync(distFile, 'utf8');

describe('UMD bundle more coverage permutations', () => {
  it('exercises map/set/typed-array key cases and buffer decode errors', () => {
    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      TextEncoder,
      TextDecoder,
      Buffer: global.Buffer,
      globalThis: {},
    };
    sandbox.window = sandbox.globalThis;
    sandbox.self = sandbox.globalThis;
    sandbox.global = sandbox.globalThis;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: distFile });

    const res = vm.runInContext(
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const cache = new lib.PowerCache({ maxEntries: 50 })

      // Map with typed-array key
      const key = new Uint8Array([1,2,3])
      const m = new Map(); m.set(key, 'v')
      cache.set('mapt', m)
      const mapRes = cache.hasEqual('mapt', new Map([[new Uint8Array([1,2,3]), 'v']]))

      // Set primitive vs complex
      const s1 = new Set([1,2,3])
      cache.set('s1', s1)
      const s1ok = cache.hasEqual('s1', new Set([1,2,3]))

      const s2 = new Set([{a:1}])
      cache.set('s2', s2)
      const s2ok = cache.hasEqual('s2', new Set([{a:1}]))

      // u82o error for unsupported value (simulate by passing number)
      let threw = false
      try { lib.u82o(123) } catch(e){ threw = true }

      return { mapRes, s1ok, s2ok, threw }
    })()`,
      ctx,
      { filename: distFile }
    );

    // mapRes should be false (different key references)
    expect(res.mapRes).toBe(false);
    expect(res.s1ok).toBe(true);
    expect(res.s2ok).toBe(true);
    expect(res.threw).toBe(true);
  });
});
