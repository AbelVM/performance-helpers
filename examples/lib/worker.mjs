/**
 * The worker used by `../pool.mjs`.
 *
 * It lives in `lib/` so that `npm run example` does not offer it as a runnable
 * example — it has no output and no main, and a list of things you can run
 * should contain only things you can run.
 *
 * Four things about writing a pool worker are not obvious, and the reason this
 * file is more commented than a ten-line worker usually is:
 *
 * 1. **Node workers listen on `parentPort`, not `self`.** The browser idiom
 *    `self.onmessage = …` is silently inert in a Node worker — nothing throws,
 *    the handler is simply never called, and every reply times out. In Node use
 *    `parentPort.on('message', …)`.
 *
 * 2. The message arrives **framed**, as a `Uint8Array`, not as your object.
 *    The pool encodes every plain object into a codec envelope before posting
 *    it, so `data.someField` is `undefined` and the body never runs correctly.
 *    Decode it with `decodeMessage`.
 *
 * 3. **Echoing `correlationId` is not optional.** When the caller asks for
 *    `awaitResponse`, the pool attaches an id to the outgoing message and
 *    matches the reply by it. A reply without one cannot be attributed, and
 *    the caller's promise sits there until it times out.
 *
 * 4. An **ESM worker with imports is not ready when `new Worker()` returns.**
 *    The pool posts as soon as the worker exists, which is fine for a worker
 *    with no imports, but a message can arrive before this module has finished
 *    evaluating. Keep the worker's dependency graph small, or make it CommonJS.
 *
 * The loop is deliberately slow enough (200k–300k iterations) to make dispatch
 * visible. A worker that answers instantly would make every call look like it
 * was handled by the first worker, which is the one thing the pool example
 * needs to show is *not* happening.
 */
import { parentPort } from 'node:worker_threads';
import { decodeMessage, encodeMessage } from 'performance-helpers';

parentPort.on('message', (data) => {
  const { value } = decodeMessage(data);
  const { n } = value;

  let total = 0;
  for (let i = 0; i < n; i += 1) total += i;

  parentPort.postMessage(
    encodeMessage({
      ...value, // carries `correlationId` back untouched
      total,
      threadId: parentPort.threadId,
    })
  );
});
