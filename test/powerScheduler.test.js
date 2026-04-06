import { describe, it, expect } from 'vitest';
import { PowerScheduler } from '../src/helpers/powerScheduler.js';

describe('PowerScheduler', () => {
  it('schedules a microtask flush and invokes the callback once', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(() => {
      called += 1;
    });

    scheduler.schedule();
    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    await Promise.resolve();
    expect(called).toBe(1);
    expect(scheduler.scheduled).toBe(false);
  });

  it('supports flushing immediately before the scheduled callback runs', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(() => {
      called += 1;
    });

    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    scheduler.flush();
    expect(called).toBe(1);
    expect(scheduler.scheduled).toBe(false);
    await Promise.resolve();
    expect(called).toBe(1);
  });

  it('cancels a scheduled flush and prevents callback invocation', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(() => {
      called += 1;
    });

    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    scheduler.cancel();
    expect(scheduler.scheduled).toBe(false);
    await Promise.resolve();
    expect(called).toBe(0);
  });

  it('supports macrotask scheduling', async () => {
    let called = 0;
    const scheduler = new PowerScheduler(
      () => {
        called += 1;
      },
      { scheduling: 'macrotask' }
    );

    scheduler.schedule();
    expect(scheduler.scheduled).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(called).toBe(1);
    expect(scheduler.scheduled).toBe(false);
  });
});
