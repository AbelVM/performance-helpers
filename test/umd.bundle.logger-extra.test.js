import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';

const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
const code = readFileSync(distFile, 'utf8');

describe('UMD bundle logger extra branches', () => {
  it('invokes counter APIs and handles odd inputs', () => {
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

    const ok = vm.runInContext(
      `(function(){
      const lib = (typeof globalThis !== 'undefined' && (globalThis.PerformanceHelpers || globalThis.performanceHelpers)) || (typeof PerformanceHelpers !== 'undefined' && (PerformanceHelpers || performanceHelpers)) || this.PerformanceHelpers || this.performanceHelpers
      const logger = new lib.PowerLogger(2)
      logger.incrementCounter('k')
      const before = logger.getDebugCounters()
      logger.resetDebugCounters()
      const after = logger.getDebugCounters()
      // weird setDebugLevel input
      logger.setDebugLevel({ toString: () => { throw new Error('boom') } })
      return before && typeof after === 'object'
    })()`,
      ctx,
      { filename: distFile }
    );

    expect(ok).toBe(true);
  });
});
