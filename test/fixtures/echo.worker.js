import { parentPort } from 'worker_threads';

// Echoes any message back to the parent, tagging it with `echo: true`.
parentPort.on('message', (msg) => {
  parentPort.postMessage({ echo: true, received: msg });
});
