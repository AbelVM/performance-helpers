import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';

const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
const code = readFileSync(distFile, 'utf8');

describe('UMD bundle additional deep-equality branches', () => {
  it('handles prototype mismatches and primitive set fast-path', () => {
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

    const result = vm.runInContext(
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const cache = new lib.PowerCache({ maxEntries: 20 })

      // Prototype mismatch
      const a = Object.create(null); a.x = 1
      const b = { x: 1 }
      cache.set('proto', a)
      const pmatch = cache.hasEqual('proto', b)

      // Set primitive fast-path
      const s = new Set([1,2,3])
      cache.set('primset', s)
      const primOk = cache.hasEqual('primset', new Set([1,2,3]))

      // Array mismatch
      const arr = [1, {x:2}, 3]
      cache.set('arr', arr)
      const arrOk = cache.hasEqual('arr', [1, {x:2}, 3])

      // TypedArray view with offset should cause slice branch in o2b/buffer helpers when used elsewhere
      const buf = new ArrayBuffer(10)
      const view = new Uint8Array(buf, 2, 4)
      cache.set('view', view)
      const viewOk = cache.hasEqual('view', new Uint8Array(buf, 2, 4))

      return { pmatch, primOk, arrOk, viewOk }
    })()`,
      ctx,
      { filename: distFile }
    );

    expect(result.pmatch).toBe(false);
    expect(result.primOk).toBe(true);
    expect(result.arrOk).toBe(true);
    expect(result.viewOk).toBe(true);
  });
});
