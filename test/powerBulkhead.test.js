import { describe, it, expect } from 'vitest';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';

describe('PowerBulkhead', () => {
  it('exposes constructor-derived getters and saturation state', () => {
    const bulkhead = new PowerBulkhead({ partitions: 3, maxConcurrency: 2, queueCapacity: 4 });
    expect(bulkhead.partitions).toBe(3);
    expect(bulkhead.maxConcurrency).toBe(2);
    expect(bulkhead.queueCapacity).toBe(4);
    expect(bulkhead.isFull).toBe(false);
  });

  it('executes tasks immediately while capacity remains in a partition', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 2, maxConcurrency: 2 });
    const results = await Promise.all([
      bulkhead.run(() => 1, { partitionKey: 'a' }),
      bulkhead.run(() => 2, { partitionKey: 'a' }),
    ]);

    expect(results).toEqual([1, 2]);
    expect(bulkhead.active).toBe(0);
    expect(bulkhead.pending).toBe(0);
  });

  it('queues tasks when partition concurrency is exceeded and dispatches them in FIFO order', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 10 });
    let running = false;

    const firstTask = bulkhead.run(
      () =>
        new Promise((resolve) => {
          running = true;
          setTimeout(() => {
            running = false;
            resolve('first');
          }, 20);
        })
    );

    const secondTask = bulkhead.run(() => 'second');

    expect(bulkhead.pending).toBe(1);
    expect(secondTask).toBeInstanceOf(Promise);

    const result = await secondTask;
    expect(result).toBe('second');
    expect(await firstTask).toBe('first');
    expect(bulkhead.pending).toBe(0);
    expect(bulkhead.active).toBe(0);
  });

  it('updates active and pending counters as queued work starts running', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 10 });
    let releaseFirst;
    let resolveFirstStarted;
    const firstStarted = new Promise((resolve) => {
      resolveFirstStarted = resolve;
    });
    let resolveSecondStarted;
    const secondStarted = new Promise((resolve) => {
      resolveSecondStarted = resolve;
    });

    const firstTask = bulkhead.run(
      () =>
        new Promise((resolve) => {
          releaseFirst = () => resolve('first');
          resolveFirstStarted();
        })
    );

    const secondTask = bulkhead.run(async () => {
      resolveSecondStarted();
      return 'second';
    });

    expect(bulkhead.active).toBe(1);
    expect(bulkhead.pending).toBe(1);

    await firstStarted;
    releaseFirst();
    await secondStarted;

    expect(bulkhead.active).toBe(1);
    expect(bulkhead.pending).toBe(0);

    await expect(secondTask).resolves.toBe('second');
    await expect(firstTask).resolves.toBe('first');
    expect(bulkhead.active).toBe(0);
    expect(bulkhead.pending).toBe(0);
  });

  it('isolates noisy partitions so one partition queue does not block other partitions', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 2, maxConcurrency: 1, queueCapacity: 10 });
    const executionOrder = [];

    const hot1 = bulkhead.run(
      () =>
        new Promise((resolve) => {
          executionOrder.push('hot-start');
          setTimeout(() => {
            executionOrder.push('hot-end');
            resolve('hot');
          }, 40);
        }),
      { partitionKey: 'hot' }
    );

    const hot2 = bulkhead.run(() => 'hot-queued', { partitionKey: 'hot' });

    const cold = bulkhead.run(
      () => {
        executionOrder.push('cold');
        return 'cold';
      },
      { partitionKey: 'cold' }
    );

    expect(bulkhead.pending).toBe(1);
    expect(await cold).toBe('cold');
    expect(await hot2).toBe('hot-queued');
    expect(await hot1).toBe('hot');
    expect(executionOrder).toEqual(['hot-start', 'cold', 'hot-end']);
  });

  it('rejects new tasks when global queue capacity is exceeded', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 1 });

    bulkhead.run(() => new Promise((resolve) => setTimeout(resolve, 20)));

    const queued = bulkhead.run(() => 'queued');
    expect(bulkhead.pending).toBe(1);
    expect(bulkhead.isFull).toBe(true);

    await expect(bulkhead.run(() => 'overflow')).rejects.toThrow('PowerBulkhead queue is full');
    expect(await queued).toBe('queued');
  });

  it('tryRun throws for invalid tasks and returns null when partition is busy', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 1 });

    expect(() => bulkhead.tryRun(null)).toThrow('PowerBulkhead.tryRun() requires a function');

    let release;
    let resolveStarted;
    const started = new Promise((resolve) => {
      resolveStarted = resolve;
    });
    const running = bulkhead.run(
      () =>
        new Promise((resolve) => {
          release = () => resolve('done');
          resolveStarted();
        })
    );

    await started;

    expect(bulkhead.tryRun(() => 'later')).toBeNull();
    release();
    await expect(running).resolves.toBe('done');
  });

  it('tryRun executes immediately when capacity is available', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 2, maxConcurrency: 1 });
    await expect(bulkhead.tryRun(() => 'ok')).resolves.toBe('ok');
    expect(bulkhead.active).toBe(0);
  });

  it('drain resolves immediately when already idle', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 2, maxConcurrency: 1 });
    await expect(bulkhead.drain()).resolves.toBeUndefined();
  });

  it('uses a custom partitioner when provided', async () => {
    const seen = [];
    const bulkhead = new PowerBulkhead({
      partitions: 2,
      maxConcurrency: 1,
      partitioner(key) {
        seen.push(key);
        return 1;
      },
    });

    await expect(bulkhead.run(() => 'ok', { partitionKey: 'custom' })).resolves.toBe('ok');
    expect(seen).toEqual(['custom']);
  });

  it('drain() resolves after all active and queued tasks finish', async () => {
    const bulkhead = new PowerBulkhead({ partitions: 1, maxConcurrency: 1, queueCapacity: 10 });
    const results = [];

    bulkhead.run(
      () =>
        new Promise((resolve) =>
          setTimeout(() => {
            results.push('first');
            resolve('first');
          }, 20)
        )
    );

    bulkhead.run(() => {
      results.push('second');
      return 'second';
    });

    await bulkhead.drain();
    expect(results).toEqual(['first', 'second']);
    expect(bulkhead.active).toBe(0);
    expect(bulkhead.pending).toBe(0);
  });
});
