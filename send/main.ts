// Sender: turn a file into an endless fountain-coded QR stream.
//
// Tuning notes from the experiments this PoC is distilled from:
// - Frame payload sets the QR version; denser wins on goodput as long as the
//   receiver can still decode it. 1465 bytes ≈ V27 is a safe middle ground
//   for arbitrary monitors; 2953 (V40) is the ceiling and works phone-to-
//   phone at close range.
// - The mask pattern is pinned (any declared mask is valid to a decoder);
//   this skips the spec's 8-way mask evaluation and speeds generation ~4×.
// - Displays need each frame shown for ≥2 refresh cycles or captures catch
//   the transition; 24 fps on a 60 Hz screen is comfortable.
// - Error correction stays at L by default: the fountain layer already
//   handles erasures, and a frame is either decoded whole or discarded.

import QRCode from "qrcode";
import { LTEncoder } from "../shared/fountain";
import {
  HEADER_LEN,
  fnv1a,
  packFrame,
  wrapPayload,
  type FrameHeader,
} from "../shared/protocol";

const MARGIN = 4; // quiet-zone modules
const LOOKAHEAD = 5;

const canvas = document.getElementById("qr") as HTMLCanvasElement;
const specs = document.getElementById("specs")!;
const cfgPayload = document.getElementById("cfg-payload") as HTMLSelectElement;
const cfgFile = document.getElementById("cfg-file") as HTMLInputElement;
const cfgFps = document.getElementById("cfg-fps") as HTMLSelectElement;
const cfgBytes = document.getElementById("cfg-bytes") as HTMLSelectElement;
const cfgEcc = document.getElementById("cfg-ecc") as HTMLSelectElement;
const cfgSize = document.getElementById("cfg-size") as HTMLInputElement;

const payloadCache = new Map<string, Uint8Array>();
const thumbCache = new Map<string, Uint8Array | null>();
let generation = 0; // bumped on every restart; stale loops see it and die
let custom: { bytes: Uint8Array; name: string; mime: string; thumb?: Uint8Array | null } | null =
  null;

async function loadPayload(url: string): Promise<Uint8Array | null> {
  const hit = payloadCache.get(url);
  if (hit) return hit;
  const res = await fetch(url);
  if (!res.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  payloadCache.set(url, bytes);
  return bytes;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const bin = atob(dataUrl.split(",")[1]!);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function drawThumb(source: CanvasImageSource, w: number, h: number): Promise<Uint8Array> {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(source, 0, 0, w, h);
  return dataUrlToBytes(c.toDataURL("image/jpeg", 0.3));
}

async function imageThumb(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: mime }));
    const scale = Math.min(1, 150 / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const out = await drawThumb(bmp, w, h);
    bmp.close();
    return out;
  } catch {
    return null;
  }
}

async function videoThumb(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  try {
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const v = document.createElement("video");
    v.src = url;
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res();
      v.onerror = () => rej(new Error("video load failed"));
    });
    if (v.currentTime < 0.5) {
      v.currentTime = 0.5; // capture the first useful frame
      await Promise.race([
        new Promise<void>((res) => {
          v.onseeked = () => res();
        }),
        new Promise<void>((res) => setTimeout(res, 3000)),
      ]);
    }
    const scale = Math.min(1, 150 / Math.max(1, v.videoWidth));
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const out = await drawThumb(v, w, h);
    URL.revokeObjectURL(url);
    return out;
  } catch {
    return null;
  }
}

async function makeThumb(bytes: Uint8Array, mime: string): Promise<Uint8Array | null> {
  if (mime.startsWith("image/")) return imageThumb(bytes, mime);
  if (mime.startsWith("video/")) return videoThumb(bytes, mime);
  return null;
}

async function main() {
  for (const el of [cfgPayload, cfgFps, cfgBytes, cfgEcc, cfgSize]) {
    el.addEventListener("change", () => void startStream());
  }
  cfgFile.addEventListener("change", () => void onFilePicked());
  await startStream();
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine without it */
  }
}

async function onFilePicked() {
  const f = cfgFile.files?.[0];
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  custom = { bytes, name: f.name, mime: f.type || "application/octet-stream" };
  cfgPayload.value = "custom";
  void startStream();
}

async function startStream() {
  const gen = ++generation;
  let raw: Uint8Array | null;
  let name: string;
  let mime: string;
  let thumb: Uint8Array | null;
  if (cfgPayload.value === "custom") {
    if (!custom) {
      specs.textContent = "✗ pick a file below to send it";
      return;
    }
    raw = custom.bytes;
    name = custom.name;
    mime = custom.mime;
    if (custom.thumb === undefined) custom.thumb = await makeThumb(raw, mime);
    thumb = custom.thumb;
  } else {
    raw = await loadPayload(cfgPayload.value);
    if (!raw) {
      specs.textContent = `✗ couldn't load ${cfgPayload.value}`;
      return;
    }
    name = cfgPayload.value.split("/").pop()!;
    mime = cfgPayload.value.toLowerCase().endsWith(".png") ? "image/png" : "application/octet-stream";
    if (!thumbCache.has(cfgPayload.value)) thumbCache.set(cfgPayload.value, await makeThumb(raw, mime));
    thumb = thumbCache.get(cfgPayload.value)!;
  }
  if (gen !== generation) return; // superseded while fetching
  const txFps = Number(cfgFps.value);
  const frameBytes = Number(cfgBytes.value);
  const ecc = cfgEcc.value as "L" | "M" | "Q" | "H";
  const displayPx = Number(cfgSize.value);

  const payload = wrapPayload(raw, name, mime);
  const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
  const blockLen = frameBytes - HEADER_LEN;
  const thumbLen = thumb?.length ?? 0;
  const tnBlocks = Math.ceil(thumbLen / blockLen);
  const encoder = new LTEncoder(payload, blockLen, sessionId);
  const header: FrameHeader = {
    sessionId,
    seq: 0,
    k: encoder.k,
    blockLen,
    totalLen: payload.length,
    payloadFnv: fnv1a(payload),
    thumbLen,
  };

  let version: number | undefined; // locked after the first frame
  let modules = 0;
  let scale = 1;
  const staging = document.createElement("canvas");
  const queue: ImageData[] = [];
  let nextSeq = 0;

  const sizeCanvas = () => {
    const dpr = window.devicePixelRatio || 1;
    const total = modules + 2 * MARGIN;
    const cssBudget = Math.min(0.9 * Math.min(window.innerWidth, window.innerHeight), displayPx);
    scale = Math.max(1, Math.floor((cssBudget * dpr) / total));
    staging.width = total;
    staging.height = total;
    canvas.width = total * scale;
    canvas.height = total * scale;
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = `${(total * scale) / dpr}px`;
  };

  const makeFrame = (): ImageData => {
    let block: Uint8Array;
    if (nextSeq < tnBlocks) {
      // reserved leading frames carry raw thumbnail bytes (progressive preview)
      const start = nextSeq * blockLen;
      block = new Uint8Array(blockLen);
      block.set(thumb!.subarray(start, Math.min(start + blockLen, thumbLen)));
    } else {
      block = encoder.encode(nextSeq);
    }
    const bytes = packFrame({ ...header, seq: nextSeq }, block);
    nextSeq++;
    const qr = QRCode.create([{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment], {
      errorCorrectionLevel: ecc,
      version,
      maskPattern: 4,
    });
    if (version === undefined) {
      version = qr.version;
      modules = qr.modules.size;
      sizeCanvas();
      specs.textContent =
        `${txFps} FPS · ${frameBytes} bytes per frame · V${version} · ECC ${ecc} · ` +
        `${name} (${Math.round(raw.length / 1024)} KB) · preview ${thumbLen}B · K=${encoder.k}`;
    }
    const size = qr.modules.size;
    const data = qr.modules.data;
    const total = size + 2 * MARGIN;
    const img = new ImageData(total, total);
    const px = new Uint32Array(img.data.buffer);
    px.fill(0xffffffff);
    for (let y = 0; y < size; y++) {
      const row = (y + MARGIN) * total + MARGIN;
      const src = y * size;
      for (let x = 0; x < size; x++) {
        if (data[src + x]) px[row + x] = 0xff000000;
      }
    }
    return img;
  };

  const pump = () => {
    if (gen !== generation) return; // superseded by a settings change
    try {
      while (queue.length < LOOKAHEAD) queue.push(makeFrame());
    } catch (err) {
      // e.g. frame bytes over capacity for the chosen ECC level
      specs.textContent = `✗ ${err instanceof Error ? err.message : String(err)}`;
      return;
    }
    setTimeout(pump, 0);
  };
  pump();

  const interval = 1000 / txFps;
  let nextAt = performance.now();
  const tick = (now: number) => {
    if (gen !== generation) return;
    requestAnimationFrame(tick);
    if (now < nextAt) return;
    const img = queue.shift();
    if (!img) {
      nextAt = now + interval;
      return;
    }
    staging.getContext("2d")!.putImageData(img, 0, 0);
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
    nextAt += interval;
    if (now - nextAt > 3 * interval) nextAt = now + interval; // fell behind — don't burst
  };
  requestAnimationFrame(tick);
}

void main();
