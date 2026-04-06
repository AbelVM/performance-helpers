import { describe, it, expect } from 'vitest';
import { PowerBulkhead } from '../src/helpers/powerBulkhead.js';

describe('PowerBulkhead', () => {
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

    await expect(bulkhead.run(() => 'overflow')).rejects.toThrow('PowerBulkhead queue is full');
    expect(await queued).toBe('queued');
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
