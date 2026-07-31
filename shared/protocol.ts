// Frame protocol: every QR frame is fully self-describing, so there is NO
// handshake — the receiver locks onto a stream mid-flight, and a new session
// id on any frame simply starts a fresh transfer.
//
// Layout (little-endian), 20 bytes, followed by `blockLen` payload bytes:
//   0  u8   magic 0xD1
//   1  u8   magic 0x0C
//   2  u16  sessionId   random per sender start
//   4  u32  seq         drives the fountain PRNG (see fountain.ts)
//   8  u16  k           source block count
//  10  u16  blockLen    payload bytes per frame
//  12  u32  totalLen    file length in bytes
//  16  u32  payloadFnv  FNV-1a of the whole file — verified on completion

export const HEADER_LEN = 20;
const MAGIC0 = 0xd1;
const MAGIC1 = 0x0c;

export interface FrameHeader {
  sessionId: number;
  seq: number;
  k: number;
  blockLen: number;
  totalLen: number;
  payloadFnv: number;
}

export function packFrame(h: FrameHeader, block: Uint8Array): Uint8Array {
  const out = new Uint8Array(HEADER_LEN + block.length);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, MAGIC0);
  dv.setUint8(1, MAGIC1);
  dv.setUint16(2, h.sessionId, true);
  dv.setUint32(4, h.seq, true);
  dv.setUint16(8, h.k, true);
  dv.setUint16(10, h.blockLen, true);
  dv.setUint32(12, h.totalLen, true);
  dv.setUint32(16, h.payloadFnv, true);
  out.set(block, HEADER_LEN);
  return out;
}

export function parseFrame(
  bytes: Uint8Array,
): { header: FrameHeader; block: Uint8Array } | null {
  if (bytes.length <= HEADER_LEN) return null;
  if (bytes[0] !== MAGIC0 || bytes[1] !== MAGIC1) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: FrameHeader = {
    sessionId: dv.getUint16(2, true),
    seq: dv.getUint32(4, true),
    k: dv.getUint16(8, true),
    blockLen: dv.getUint16(10, true),
    totalLen: dv.getUint32(12, true),
    payloadFnv: dv.getUint32(16, true),
  };
  if (header.k === 0 || header.blockLen === 0 || header.totalLen === 0) return null;
  if (bytes.length !== HEADER_LEN + header.blockLen) return null;
  return { header, block: bytes.subarray(HEADER_LEN) };
}

export function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Payload metadata (file name + MIME type). Rather than squeezing these into
// the fixed 20-byte frame header, the sender prepends a small block to the
// file bytes before fountain encoding. The metadata therefore travels with
// the fountain stream itself (lossless, order-independent) instead of relying
// on any one frame arriving. Layout, before the file bytes:
//   0..3  magic "DMN\x01"
//   4  u16  nameLen
//   6  u16  mimeLen
//   8  name (UTF-8), then mime (UTF-8), then the file bytes

export interface PayloadMeta {
  name: string;
  mime: string;
  bytes: Uint8Array;
}

const META_MAGIC = [0x44, 0x4d, 0x4e, 0x01]; // "DMN\x01"
export const META_HEADER_LEN = 8;

export function wrapPayload(file: Uint8Array, name: string, mime: string): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const mimeBytes = new TextEncoder().encode(mime);
  if (nameBytes.length > 0xffff || mimeBytes.length > 0xffff) {
    throw new Error("file name or MIME type too long");
  }
  const out = new Uint8Array(META_HEADER_LEN + nameBytes.length + mimeBytes.length + file.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, (META_MAGIC[0]! << 24) | (META_MAGIC[1]! << 16) | (META_MAGIC[2]! << 8) | META_MAGIC[3]!, true);
  dv.setUint16(4, nameBytes.length, true);
  dv.setUint16(6, mimeBytes.length, true);
  out.set(nameBytes, META_HEADER_LEN);
  out.set(mimeBytes, META_HEADER_LEN + nameBytes.length);
  out.set(file, META_HEADER_LEN + nameBytes.length + mimeBytes.length);
  return out;
}

export function unwrapPayload(payload: Uint8Array): PayloadMeta {
  if (payload.length > META_HEADER_LEN) {
    const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const magic = dv.getUint32(0, true);
    if (
      magic === ((META_MAGIC[0]! << 24) | (META_MAGIC[1]! << 16) | (META_MAGIC[2]! << 8) | META_MAGIC[3]!)
    ) {
      const nameLen = dv.getUint16(4, true);
      const mimeLen = dv.getUint16(6, true);
      if (META_HEADER_LEN + nameLen + mimeLen <= payload.length) {
        const name = new TextDecoder().decode(
          payload.subarray(META_HEADER_LEN, META_HEADER_LEN + nameLen),
        );
        const mime = new TextDecoder().decode(
          payload.subarray(META_HEADER_LEN + nameLen, META_HEADER_LEN + nameLen + mimeLen),
        );
        return { name, mime, bytes: payload.subarray(META_HEADER_LEN + nameLen + mimeLen) };
      }
    }
  }
  // legacy payload sent without metadata — pass through untouched
  return { name: "file.bin", mime: "application/octet-stream", bytes: payload };
}

/** splitmix32 — deterministic across JS engines (integer ops only). */
export function splitmix32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    t ^= t >>> 15;
    return t >>> 0;
  };
}
