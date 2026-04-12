import { describe, expect, it } from 'vitest';

describe('package exports', () => {
  it('supports the root package entry through self-reference', async () => {
    const mod = await import('performance-helpers');

    expect(mod.PowerCache).toBeTypeOf('function');
    expect(mod.nowMs).toBeTypeOf('function');
  });

  it('supports importing individual helpers', async () => {
    const mod = await import('performance-helpers/powerCache');

    expect(mod.PowerCache).toBeTypeOf('function');
    expect(mod.PowerMemoizer).toBeTypeOf('function');
  });

  it('supports importing individual utilities', async () => {
    const mod = await import('performance-helpers/now');

    expect(mod.nowMs).toBeTypeOf('function');
    expect(mod.measureAsync).toBeTypeOf('function');
  });

  it('supports importing errors utilities directly', async () => {
    const mod = await import('performance-helpers/errors');

    expect(mod.normalizeError).toBeTypeOf('function');
    expect(mod.formatErrorObj).toBeTypeOf('function');
  });
});