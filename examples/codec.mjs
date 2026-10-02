/**
 * The wire protocol: `PowerMessageCodec`.
 *
 * Run: `npm run example codec`
 *
 * A pool sends structured-cloneable values between threads, but the *framing*
 * is yours to choose, and the obvious choice is wrong. Delimited JSON —
 * `{...}\n` — breaks the moment a value contains a newline inside a string,
 * which is every value that contains user text. Newline-delimited JSON has this
 * bug in its own specification.
 *
 * `PowerMessageCodec` frames explicitly: `[u8 version][u8 codec][u32 length]
 * [payload]`. Length-prefixed, so the payload may contain anything at all, and
 * versioned, so a decoder never has to guess what it is looking at.
 *
 * The pool uses this automatically. You need it directly when you are writing
 * a worker, or when you are debugging what actually crossed the wire.
 */
// `decodeInbound` is deliberately *not* imported here: it appears below inside
// the worker snippet this script prints, and that snippet is the deliverable —
// it is text for the reader, not code this file runs. Importing it would leave
// a binding the linter is right to call unused.
import { encodeMessage, decodeMessage, selectCodec, isRawPayload } from 'performance-helpers';

// --- Why the length prefix, demonstrated -----------------------------------
console.log('The problem with newline-delimited JSON:');
const awkward = { text: 'line one\nline two\r\nline three' };
const ndjson = JSON.stringify(awkward);
console.log('  payload   :', JSON.stringify(awkward.text));
console.log('  NDJSON    :', ndjson);
console.log('  split("\\n"):', JSON.stringify(ndjson.split('\n')));
console.log('  ^ three "records" from one object. A reader cannot tell whether');
console.log('    that is one message with newlines or three messages.\n');

// --- The codec's framing, on the same value --------------------------------
const encoded = encodeMessage(awkward);
console.log('PowerMessageCodec framing the same value:');
console.log('  total bytes     :', encoded.byteLength);
console.log('  version byte    :', encoded[0]);
console.log('  codec byte      :', encoded[1], `(${codecName(encoded[1])})`);
console.log('  length (u32 BE) :', new DataView(encoded.buffer).getUint32(2), 'bytes');
console.log('  header overhead :', 6, 'bytes\n');

const decoded = decodeMessage(encoded);
console.log('  round-tripped   :', JSON.stringify(decoded.value));
console.log('  same as input   :', decoded.value.text === awkward.text);
console.log('  ^ the length prefix is what makes the newlines safe: the reader');
console.log('    knows exactly how many bytes to consume.\n');

// --- Versioning -------------------------------------------------------------
console.log('What versioning is for: a worker built against 1.x talking to a 2.x');
console.log('pool. A decoder that sniffs the payload either guesses wrong or has');
console.log('two code paths; an explicit version byte fails loudly, which is what');
console.log('you want during a rolling deploy when half your fleet is old.\n');

// --- Binary payloads -------------------------------------------------------
const raw = new Uint8Array([1, 2, 3, 4, 5]);
console.log('Binary is a different codec, not a different transport:');
console.log('  isRawPayload(Uint8Array) :', isRawPayload(raw));
console.log('  isRawPayload({a: 1})     :', isRawPayload({ a: 1 }));
console.log('  selectCodec(raw)         :', selectCodec(raw));
console.log('  selectCodec({a: 1})      :', selectCodec({ a: 1 }));
const framedRaw = encodeMessage(raw);
console.log('  encoded binary           :', framedRaw.byteLength, 'bytes');
console.log('  decoded binary           :', Array.from(decodeMessage(framedRaw).value));
console.log('  ^ round-trips byte-for-byte. Binary is not JSON-stringified, which');
console.log('    is the difference between a copy and a transfer.\n');

// --- Building your own codec ----------------------------------------------
console.log('When you are writing a worker, you decode rather than encode:');
console.log(`
  import { decodeInbound, encodeMessage } from 'performance-helpers';

  self.onmessage = ({ data }) => {
    // decodeInbound reads all three carriers a pool can send: a framed message,
    // a native structured-clone envelope, and a 1.x bare-JSON body. One worker
    // therefore survives the pool switching messageCodec, and survives its
    // fleet being half-migrated.
    const { value } = decodeInbound(data);
    self.postMessage(encodeMessage({ ...value, done: true }));
  };
`);
console.log('The worker never sees the framing, which is the point of it.');

function codecName(byte) {
  return { 0: 'json', 1: 'v8', 2: 'raw' }[byte] ?? 'unknown';
}

if (decoded.value.text !== awkward.text) {
  console.error('\nFAIL: the framed round-trip did not preserve the value.');
  process.exit(1);
}
console.log('OK');
