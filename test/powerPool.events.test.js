import { test, expect } from 'vitest';
import { PowerPool } from '../src/helpers/powerPool.js';

function makeUnderlyingFactory(processMs = 50) {
  return function Underlying() {
    const listeners = { message: [] };
    return {
      addEventListener(name, fn) {
        if (!listeners[name]) listeners[name] = [];
        listeners[name].push(fn);
      },
      removeEventListener(name, fn) {
        if (!listeners[name]) return;
        const i = listeners[name].indexOf(fn);
        if (i >= 0) listeners[name].splice(i, 1);
      },
      postMessage(msg, tr) {
        // emulate async work then echo a message event
        setTimeout(() => {
          const ev = { data: { response: 'ok' } };
          (listeners.message || []).forEach((h) => {
            try {
              h(ev);
            } catch (e) {
              /* ignore */
            }
          });
        }, processMs);
      },
      terminate() {},
    };
  };
}

test('emits pool:queue:high when queue crosses threshold', async () => {
  const pool = new PowerPool(makeUnderlyingFactory(200), {
    minSize: 1,
    maxSize: 1,
    maxTasksPerWorker: 1,
    taskQueue: true,
    lazy: false,
    queueHighThreshold: 0,
  });

  const p = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for queue high')), 2000);
    pool._bus.once('pool:queue:high', (payload) => {
      clearTimeout(to);
      resolve(payload);
    });
  });

  // Post two messages: first occupies worker, second should be queued and cross threshold (0)
  pool.postMessage({ i: 1 });
  pool.postMessage({ i: 2 });

  const payload = await p;
  expect(payload).toBeTruthy();
  expect(payload.length).toBeGreaterThanOrEqual(1);
  expect(payload.threshold).toBe(0);
});

test('emits pool:scale when adding and removing workers', async () => {
  const pool = new PowerPool(makeUnderlyingFactory(200), {
    size: 1,
    minSize: 1,
    maxSize: 2,
    maxTasksPerWorker: 1,
    taskQueue: true,
    lazy: false,
  });

  // listen for add (first scale event after creation may also have fired; listen next)
  const addP = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for scale add')), 2000);
    pool._bus.once('pool:scale', (payload) => {
      clearTimeout(to);
      resolve(payload);
    });
  });

  // trigger growth by posting more messages than single worker capacity
  pool.postMessage({ a: 1 });
  pool.postMessage({ a: 2 });

  const addPayload = await addP;
  expect(addPayload).toBeTruthy();
  expect(addPayload.action === 'add' || addPayload.added >= 1).toBeTruthy();

  // now test shrink via resize
  const removeP = new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('timeout waiting for scale remove')), 2000);
    pool._bus.once('pool:scale', (payload) => {
      clearTimeout(to);
      resolve(payload);
    });
  });

  pool.resize({ maxSize: 1 });
  const rem = await removeP;
  expect(rem).toBeTruthy();
  expect(rem.terminated && rem.terminated.length >= 0).toBeTruthy();
});
