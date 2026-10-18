import { describe, it, expect } from 'vitest';
import { PowerCron } from '../src/helpers/powerCron.js';

describe('PowerCron timezone option', () => {
  it('defaults to null', () => {
    const cron = new PowerCron(() => {}, { intervalMs: 1000 });
    expect(cron.timezone).toBeNull();
    cron.dispose();
  });

  it('stores a valid IANA time zone', () => {
    const cron = new PowerCron(() => {}, { intervalMs: 1000, timezone: 'Europe/Berlin' });
    expect(cron.timezone).toBe('Europe/Berlin');
    cron.dispose();
  });

  it('throws TypeError for a non-string zone', () => {
    expect(() => new PowerCron(() => {}, { intervalMs: 1000, timezone: 42 })).toThrow(TypeError);
  });

  it('throws TypeError for an empty string', () => {
    expect(() => new PowerCron(() => {}, { intervalMs: 1000, timezone: '' })).toThrow(TypeError);
  });

  it('throws RangeError for an invalid zone', () => {
    expect(() => new PowerCron(() => {}, { intervalMs: 1000, timezone: 'Not/AZone' })).toThrow(
      RangeError
    );
  });

  it('is included in the known-options set (no throw on construction)', () => {
    const cron = new PowerCron(() => {}, { intervalMs: 1000, timezone: 'UTC' });
    expect(cron.timezone).toBe('UTC');
    cron.dispose();
  });
});
