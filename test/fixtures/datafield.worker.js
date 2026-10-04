import { parentPort } from 'worker_threads';
import { decodeInbound } from '../../src/helpers/powerMessageCodec.js';

/**
 * Replies with a payload that **has a `data` field of its own**.
 *
 * Exists for WRK-004, and it exists because the shape is not exotic: `{ data,
 * id }` is what a task that returns rows or a record produces. Under the old
 * pool-side normalisation (`e?.data !== undefined ? e.data : e`) the pool
 * unwrapped a level that only a browser `MessageEvent` has, so this reply
 * reached the caller as `data` alone — `id` and everything else silently gone,
 * with no error and no counter to notice it by.
 *
 * A fake cannot prove this, because a fake emits whatever shape its author
 * decided the pool should expect. Only a real `worker_threads` worker delivers
 * the value the way Node does, so the regression is only visible here.
 */
parentPort.on('message', (msg) => {
  const { value } = decodeInbound(msg);
  parentPort.postMessage({
    data: { rows: [1, 2, 3] },
    id: 7,
    correlationId: value?.correlationId,
    duration: 1,
  });
});
