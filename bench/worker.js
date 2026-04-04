import { parentPort } from 'worker_threads';
import { TextDecoder } from 'util';

const decoder = new TextDecoder();

function decodeMessage(data) {
  if (data && (data instanceof ArrayBuffer || ArrayBuffer.isView(data))) {
    const u8 = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
    try {
      const str = decoder.decode(u8);
      return JSON.parse(str);
    } catch (e) {
      return u8;
    }
  }
  return data;
}

function heavy(iterations) {
  let s = 0;
  for (let i = 0; i < iterations; i++) s += Math.sqrt(i);
  return s;
}

parentPort.on('message', (msg) => {
  const data = decodeMessage(msg);
  // (no-op) worker debug logging removed
  const id = data && (data.id ?? null);
  const iterations = data && (data.iterations ?? 0);
  const t0 = Date.now();
  const res = heavy(iterations);
  const dt = Date.now() - t0;
  const resp = { id, result: res, duration: dt };
  if (data && data.correlationId != null) resp.correlationId = data.correlationId;
  parentPort.postMessage(resp);
});
