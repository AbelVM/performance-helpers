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

parentPort.on('message', async (msg) => {
  // Use high-resolution timing to measure decode and compute durations
  const decodeStart = process.hrtime.bigint();
  const data = decodeMessage(msg);
  const decodeDuration = Number(process.hrtime.bigint() - decodeStart) / 1e6;
  // (no-op) worker debug logging removed
  const id = data && (data.id ?? null);
  const iterations = data && (data.iterations ?? 0);
  const waitMs = data && typeof data.asyncWaitMs === 'number' ? data.asyncWaitMs : 0;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  const computeStart = process.hrtime.bigint();
  const res = heavy(iterations);
  const computeDuration = Number(process.hrtime.bigint() - computeStart) / 1e6;
  const resp = { id, result: res, duration: computeDuration, decodeDuration };
  if (data && data.correlationId != null) resp.correlationId = data.correlationId;
  parentPort.postMessage(resp);
});
