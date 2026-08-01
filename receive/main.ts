// Receiver: camera → WASM QR decode in workers → fountain decoder → file.
//
// Field lessons baked in:
// - iOS treats `frameRate: {ideal: 60}` as a suggestion and delivers 30.
//   Demand `exact` first (it works at 1280-wide), fall back to `ideal`.
// - requestVideoFrameCallback chains survive a stopped stream and resume on
//   the next one — a generation counter prevents zombie capture loops.
// - Progress must track frames COLLECTED: LT peeling back-loads its solve
//   cascade, so blocks-solved looks stalled and then teleports to done.

import { LTDecoder } from "../shared/fountain";
import {
  fnv1a,
  parseFrame,
  unwrapPayload,
  type FrameHeader,
} from "../shared/protocol";
import { hasStrongColor } from "../shared/color";

const OVERHEAD_EST = 1.18; // expected frames ≈ K × this (robust-soliton ε)

const startBtn = document.getElementById("start") as HTMLButtonElement;
const video = document.getElementById("video") as HTMLVideoElement;
const preview = document.getElementById("preview")!;
const stats = document.getElementById("stats")!;
const progressEl = document.getElementById("progress")!;
const bar = document.getElementById("bar")!;
const result = document.getElementById("result")!;
const cover = document.getElementById("cover")!;
const coverImg = document.getElementById("cover-img") as HTMLImageElement;
const coverStatus = document.getElementById("cover-status")!;
const colorWarn = document.getElementById("color-warn")!;
const cfgColor = document.getElementById("cfg-color") as HTMLInputElement;
const settings = document.getElementById("settings") as HTMLDetailsElement;
const metricsEl = document.getElementById("metrics")!;
const metric = (id: string) => document.getElementById(id)!;

let stream: MediaStream | null = null;
let decoder: LTDecoder | null = null;
let sessionId = 0;
let startTs = 0;
let captureGen = 0;
let done = false;
let colorMode = false;
let colorFails = 0;
let capturedN = 0;

// Progressive-preview state: leading frames (seq < tnBlocks) carry raw
// thumbnail chunks outside the fountain stream.
let tnBlocks = 0;
let thumbBuf: Uint8Array | null = null;
let thumbSeen: Uint8Array | null = null;
let thumbGot = 0;
let coverShown = false;
let coverUrl: string | null = null;

const workers: Worker[] = [];
const busy: boolean[] = [];
const captureTimes: number[] = [];
const decodeTimes: number[] = [];

startBtn.onclick = () => void start();

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On insecure origins the API doesn't exist AT ALL — this is the plain-
    // http-over-LAN case. localhost is exempt; other hosts need https.
    stats.textContent =
      "✗ camera needs a secure context — this page must be served over " +
      "https to use the camera from another device (npm run dev:https).";
    return;
  }
  const captureWidth = Number((document.getElementById("cfg-width") as HTMLSelectElement).value);
  const captureFps = Number((document.getElementById("cfg-capfps") as HTMLSelectElement).value);
  const workerCount = Number((document.getElementById("cfg-workers") as HTMLSelectElement).value);
  colorMode = cfgColor.checked;
  colorFails = 0;
  capturedN = 0;
  colorWarn.style.display = "none";
  settings.style.display = "none";
  startBtn.style.display = "none";
  preview.style.display = "block";
  metricsEl.style.display = "grid";
  const base: MediaTrackConstraints = {
    facingMode: "environment",
    width: { ideal: captureWidth, max: 3840 },
    height: { ideal: Math.round((captureWidth * 3) / 4), max: 2160 },
  };
  try {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { exact: captureFps } },
      });
    } catch {
      // Chrome on Android throttles to battery-friendly profiles unless asked
      // loudly: floor the rate at 30 and let `ideal` climb to 90/120 where the
      // sensor supports it.
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { ...base, frameRate: { ideal: captureFps, min: Math.min(30, captureFps) } },
      });
    }
  } catch (err) {
    stats.textContent = `✗ camera: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  video.srcObject = stream;
  await video.play().catch(() => undefined);
  stats.textContent = `camera ${stream.getVideoTracks()[0]?.getSettings().width}×${stream.getVideoTracks()[0]?.getSettings().height}@${stream.getVideoTracks()[0]?.getSettings().frameRate} — searching for a stream…`;

  for (let i = 0; i < workerCount; i++) {
    const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    const slot = i;
    w.onmessage = (e: MessageEvent) => {
      const { id, bytes, confidence } = e.data as {
        id: number;
        bytes: Uint8Array | null;
        confidence: number;
      };
      if (id === -1) return; // warm-up
      busy[slot] = false;
      if (bytes) {
        colorFails = 0;
        colorWarn.style.display = "none";
        onDecoded(bytes, confidence);
      } else if (colorMode) {
        colorFails++;
        if (colorFails > 12) {
          colorWarn.textContent =
            "Lettura colori poco affidabile — passa alla modalità B/N o riavvia il flusso.";
          colorWarn.style.display = "block";
        }
      }
    };
    workers.push(w);
    busy.push(false);
  }

  captureGen++;
  scheduleFrame(captureGen);
  setInterval(updateStats, 500);
  try {
    await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<unknown> } })
      .wakeLock?.request("screen");
  } catch {
    /* fine */
  }
}

type VideoRVFC = HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };

function scheduleFrame(gen: number) {
  if (done || gen !== captureGen) return;
  const v = video as VideoRVFC;
  const next = () => {
    if (done || gen !== captureGen) return;
    captureFrame();
    scheduleFrame(gen);
  };
  if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

const grab = document.createElement("canvas");
let frameId = 0;

function captureFrame() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;
  captureTimes.push(performance.now());
  const slot = busy.indexOf(false);
  if (slot === -1) return; // all workers busy — drop the frame, no harm done
  if (grab.width !== vw || grab.height !== vh) {
    grab.width = vw;
    grab.height = vh;
  }
  const ctx = grab.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0);
  const img = ctx.getImageData(0, 0, vw, vh);
  if (!colorMode && capturedN++ % 15 === 0 && hasStrongColor(img)) {
    // B/N mode but the sender looks colored — nudge the user.
    colorWarn.textContent = "Stream a colori rilevato — attiva la Modalità Colori.";
    colorWarn.style.display = "block";
  }
  busy[slot] = true;
  workers[slot]!.postMessage({ id: frameId++, buf: img.data.buffer, w: vw, h: vh, color: colorMode }, [
    img.data.buffer,
  ]);
}

function onDecoded(bytes: Uint8Array, confidence = 1) {
  decodeTimes.push(performance.now());
  const parsed = parseFrame(bytes);
  if (!parsed || done) return;
  const { header, block } = parsed;
  if (!decoder || sessionId !== header.sessionId) {
    decoder = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
    sessionId = header.sessionId;
    startTs = performance.now();
    progressEl.style.display = "block";
    tnBlocks = Math.ceil(header.thumbLen / header.blockLen);
    thumbBuf = null;
    thumbSeen = null;
    thumbGot = 0;
    coverShown = false;
    if (coverUrl) URL.revokeObjectURL(coverUrl);
    coverUrl = null;
    cover.style.display = "none";
  }
  if (header.thumbLen > 0 && header.seq < tnBlocks) {
    collectThumb(header, block);
    return;
  }
  decoder.addFrame(header.seq, block);
  const progress = Math.min(0.99, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  bar.style.width = `${(progress * 100).toFixed(1)}%`;

  if (decoder.isComplete) {
    const payload = decoder.assemble()!;
    const seconds = (performance.now() - startTs) / 1000;
    const ok = fnv1a(payload) === header.payloadFnv;
    finish(payload, ok, seconds, header.totalLen);
  }
}

function collectThumb(header: FrameHeader, block: Uint8Array) {
  if (thumbBuf === null) {
    thumbBuf = new Uint8Array(header.thumbLen);
    thumbSeen = new Uint8Array(tnBlocks);
    thumbGot = 0;
  }
  const i = header.seq;
  if (thumbSeen![i]) return;
  thumbSeen![i] = 1;
  thumbGot++;
  const start = i * header.blockLen;
  const len = Math.min(header.blockLen, header.thumbLen - start);
  thumbBuf.set(block.subarray(0, len), start);
  coverStatus.textContent = `preview ${thumbGot}/${tnBlocks}…`;
  if (thumbGot >= tnBlocks) showCover();
}

function showCover() {
  if (coverShown || !thumbBuf) return;
  coverShown = true;
  coverStatus.textContent = "";
  coverUrl = URL.createObjectURL(new Blob([thumbBuf.slice()], { type: "image/jpeg" }));
  coverImg.src = coverUrl;
  cover.style.display = "block";
  coverImg.style.filter = "blur(20px)"; // sharpens as progress climbs
}

function finish(payload: Uint8Array, hashOk: boolean, seconds: number, totalLen: number) {
  done = true;
  captureGen++;
  stream?.getTracks().forEach((t) => t.stop());
  preview.style.display = "none";
  bar.style.width = "100%";
  if (coverUrl) URL.revokeObjectURL(coverUrl);
  coverUrl = null;
  cover.style.display = "none";

  const meta = unwrapPayload(payload);
  const kb = Math.round(meta.bytes.length / 1024);
  const rate = (meta.bytes.length / 1024 / seconds).toFixed(1);
  stats.textContent = `${meta.name} · ${kb} KB in ${seconds.toFixed(1)} s · ${rate} KB/s · hash ${hashOk ? "verified ✓" : "MISMATCH ✗"}`;

  const url = URL.createObjectURL(new Blob([meta.bytes.slice()], { type: meta.mime }));
  const heading = document.createElement("div");
  heading.className = "done";
  heading.textContent = "Transfer Complete!";

  const body = document.createElement("div");
  if (meta.mime.startsWith("image/")) {
    const img = document.createElement("img");
    img.className = "received";
    img.alt = meta.name;
    img.src = url;
    body.append(img);
  } else if (meta.mime.startsWith("video/")) {
    const v = document.createElement("video");
    v.className = "received";
    v.src = url;
    v.controls = true;
    v.playsInline = true;
    body.append(v);
  } else {
    const open = document.createElement("a");
    open.className = "download";
    open.href = url;
    open.target = "_blank";
    open.rel = "noopener";
    open.textContent = `open ${meta.name}`;
    body.append(open);
  }
  const dl = document.createElement("a");
  dl.className = "download";
  dl.href = url;
  dl.download = meta.name;
  dl.textContent = `Download ${meta.name}`;
  body.append(dl);

  result.append(heading, body);
}

function updateStats() {
  if (done) return;
  const now = performance.now();
  const prune = (a: number[]) => {
    while (a.length > 0 && a[0]! < now - 2000) a.shift();
  };
  prune(captureTimes);
  prune(decodeTimes);
  // Average frame rate over the retained 2s window, straight from timestamps —
  // no fixed divisor, so 90/120 fps (or anything the sensor delivers) reports
  // exactly, with no software cap.
  const fps = (a: number[]) =>
    a.length >= 2 ? ((a.length - 1) * 1000) / (a[a.length - 1]! - a[0]!) : 0;
  metric("m-cap").textContent = fps(captureTimes).toFixed(0);
  metric("m-dec").textContent = fps(decodeTimes).toFixed(1);
  if (!decoder) return;
  // Blur fades proportionally to fountain progress: 20px at 0%, 0px at 100%.
  const progress = Math.min(1, decoder.framesNew / (decoder.k * OVERHEAD_EST));
  if (coverShown) coverImg.style.filter = `blur(${(20 * (1 - progress)).toFixed(1)}px)`;
  const elapsed = (now - startTs) / 1000;
  const kbs = (decoder.framesNew * decoder.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed);
  metric("m-rate").textContent = `${kbs.toFixed(1)} KB/s`;
  metric("m-time").textContent = `${elapsed.toFixed(0)} s`;
  metric("m-frames").textContent = `${decoder.framesNew}/${decoder.framesDup}`;
  metric("m-k").textContent = String(decoder.k);
  metric("m-block").textContent = `${decoder.blockLen} B`;
  metric("m-payload").textContent = `${Math.round(decoder.totalLen / 1024)} KB`;
}
