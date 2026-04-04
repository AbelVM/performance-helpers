import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import vm from 'vm';
import path from 'path';

describe('UMD bundle - branches', () => {
  it('loads under CommonJS (module.exports) branch and encodes/decodes via Buffer when TextEncoder missing', () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
    const code = readFileSync(distFile, 'utf8');

    const sandbox = { console, setTimeout, clearTimeout, setInterval, clearInterval };
    // Provide Buffer and Uint8Array but intentionally omit TextEncoder/TextDecoder
    sandbox.Buffer = Buffer;
    sandbox.Uint8Array = Uint8Array;
    // Provide CommonJS globals
    sandbox.module = { exports: {} };
    sandbox.exports = sandbox.module.exports;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: distFile });

    const lib = sandbox.module.exports;
    expect(lib).toBeDefined();
    expect(typeof lib.PowerCache).toBe('function');

    // Check encode/decode using Buffer path (since TextEncoder undefined)
    const encoded = lib.o2u8({ foo: 'bar' });
    expect(encoded).toBeInstanceOf(Uint8Array);
    const decoded = lib.u82o(encoded);
    expect(decoded).toEqual({ foo: 'bar' });
  });

  it('loads under AMD (define.amd) branch', () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
    const code = readFileSync(distFile, 'utf8');

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      globalThis: {},
    };
    // implement AMD define
    sandbox.__amd = null;
    sandbox.define = function (deps, factory) {
      const exports = {};
      factory(exports);
      sandbox.__amd = exports;
    };
    sandbox.define.amd = true;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: distFile });

    const lib = sandbox.__amd;
    expect(lib).toBeDefined();
    expect(typeof lib.PowerPool).toBe('function');
  });

  it('throws when no TextEncoder or Buffer is available for o2u8', () => {
    const distFile = path.resolve(process.cwd(), 'dist', 'performance-helpers.js');
    if (!existsSync(distFile)) execSync('npm run build', { stdio: 'inherit' });
    const code = readFileSync(distFile, 'utf8');

    const sandbox = {
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      globalThis: {},
    };
    // ensure no TextEncoder and no Buffer
    sandbox.TextEncoder = undefined;
    sandbox.TextDecoder = undefined;
    sandbox.Buffer = undefined;
    sandbox.module = { exports: {} };
    sandbox.exports = sandbox.module.exports;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(code, ctx, { filename: distFile });

    const lib = sandbox.module.exports;
    expect(lib).toBeDefined();

    // calling o2u8 should throw due to missing encoders
    let threw = false;
    try {
      lib.o2u8({ x: 1 });
    } catch (e) {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});
