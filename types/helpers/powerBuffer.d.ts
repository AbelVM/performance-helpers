export function o2u8(obj: any): Uint8Array;
export function u82o(buf: ArrayBuffer | TypedArray | Buffer | Uint8Array): any;
export function o2b(obj: any): ArrayBuffer;
export function b2o(buf: ArrayBuffer | TypedArray | Buffer): any;
export type BufferEncoder = {
    encode: (s: string) => Uint8Array;
};
export type BufferDecoder = {
    decode: (u8: Uint8Array) => string;
};
