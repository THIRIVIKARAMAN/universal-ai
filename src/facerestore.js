// Face restoration: finds faces, lines each one up, rebuilds it with RestoreFormer++
// (Wang et al., Apache-2.0; browser export by Saimon8420, int8 weights, 74 MB), and blends it back.
// It runs on the graphics chip (WebGPU) when the browser allows it, otherwise on the processor.
// Important: this REDRAWS the face from what the AI learned about faces. It is labelled as such in the app.
import * as ort from "onnxruntime-web/webgpu";
import { FilesetResolver, FaceDetector } from "@mediapipe/tasks-vision";

const FACE_MODEL = "https://huggingface.co/Saimon8420/restoreformer-pp-web/resolve/main/restoreformer_pp_int8w.onnx";
const DETECTOR = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
// FFHQ 512x512 face template: left eye, right eye, nose tip, mouth centre (image coordinates).
const TEMPLATE = [[192.98, 239.95], [318.9, 240.19], [256.63, 314.02], [257.18, 371.28]];
const SIZE = 512;

async function cachedFetch(url, onProgress) {
  let cache = null;
  try { cache = await caches.open("universal-ai-models"); } catch {}
  const hit = cache && (await cache.match(url));
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    if (total) onProgress?.(got / total);
  }
  const blob = new Blob(parts);
  if (cache) await cache.put(url, new Response(blob));
  return blob.arrayBuffer();
}

let sessionPromise = null, backend = "";
/** For the test lab: force the processor (no graphics chip). */
export function forceProcessor() { sessionPromise = null; forceCpu = true; }
let forceCpu = false;
export function currentBackend() { return backend; }
function loadSession(onProgress) {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      ort.env.wasm.wasmPaths = "/ort/";
      const buf = await cachedFetch(FACE_MODEL, onProgress);
      let slowGpu = false;
      try { slowGpu = localStorage.getItem("universal-ai-face-gpu-slow") === "1"; } catch {}
      const gpu = !forceCpu && !slowGpu && "gpu" in navigator && (await navigator.gpu.requestAdapter().catch(() => null));
      if (gpu) {
        try { const s = await ort.InferenceSession.create(buf, { executionProviders: ["webgpu"] }); backend = "graphics chip (WebGPU)"; return s; } catch (e) { console.warn("WebGPU failed, using the processor", e); }
      }
      backend = "processor";
      return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    })().catch((e) => {
      sessionPromise = null;
      throw new Error(navigator.onLine ? `The face restorer couldn't load (${e.message}).` : "The face restorer hasn't been downloaded yet. Use it once with internet (74 MB), then it works offline.");
    });
  }
  return sessionPromise;
}

export function isFaceModelSaved() {
  return caches.open("universal-ai-models").then((c) => c.match(FACE_MODEL)).then(Boolean).catch(() => false);
}

let detectorPromise = null;
function loadDetector() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe");
      return FaceDetector.createFromOptions(fileset, { baseOptions: { modelAssetPath: DETECTOR, delegate: "CPU" }, runningMode: "IMAGE", minDetectionConfidence: 0.5 });
    })().catch((e) => { detectorPromise = null; throw e; });
  }
  return detectorPromise;
}

/** Faces with their eye / nose / mouth points (pixels). Small detections are ignored. */
export async function findFaces(canvas) {
  const det = await loadDetector();
  const w = canvas.width, h = canvas.height;
  const res = det.detect(canvas);
  return (res.detections || []).map((d) => {
    const k = d.keypoints.map((p) => [p.x * w, p.y * h]);
    const eyes = [k[0], k[1]].sort((a, b) => a[0] - b[0]);
    return { points: [eyes[0], eyes[1], k[2], k[3]], box: d.boundingBox, score: d.categories?.[0]?.score || 0 };
  }).filter((f) => Math.hypot(f.points[1][0] - f.points[0][0], f.points[1][1] - f.points[0][1]) > 8);
}

// Similarity transform (rotation + scale + shift) that maps src points onto dst points (least squares).
function similarity(src, dst) {
  const n = src.length;
  const ms = src.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  const md = dst.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  let a = 0, b = 0, norm = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i][0] - ms[0], py = src[i][1] - ms[1], qx = dst[i][0] - md[0], qy = dst[i][1] - md[1];
    a += px * qx + py * qy; b += px * qy - py * qx; norm += px * px + py * py;
  }
  const c = a / norm, s = b / norm;
  return { c, s, tx: md[0] - (c * ms[0] - s * ms[1]), ty: md[1] - (s * ms[0] + c * ms[1]) };
}

function featherMask() {
  const m = document.createElement("canvas");
  m.width = m.height = SIZE;
  const x = m.getContext("2d");
  const g = x.createRadialGradient(SIZE / 2, SIZE * 0.53, SIZE * 0.3, SIZE / 2, SIZE * 0.53, SIZE * 0.5);
  g.addColorStop(0, "rgba(0,0,0,1)"); g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g; x.fillRect(0, 0, SIZE, SIZE);
  return m;
}

/**
 * Restore every face in `source` and paint the results onto `target` (same size).
 * Returns { faces, backend, ms }. faces = 0 means no face was found (target unchanged).
 */
let queue = Promise.resolve();
/**
 * Same as restoreFacesNow, but one job at a time (running two at once can hang the graphics chip)
 * and with a safety timer: if it takes longer than `timeoutMs`, it gives up and leaves `target`
 * untouched, and the device is remembered as slow so next time the processor is used.
 */
export function restoreFaces(source, target, { onProgress, timeoutMs = 90000 } = {}) {
  const job = queue.then(async () => {
    const scratch = document.createElement("canvas");
    scratch.width = target.width; scratch.height = target.height;
    scratch.getContext("2d").drawImage(target, 0, 0);
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); });
    try {
      const res = await Promise.race([restoreFacesNow(source, scratch, { onProgress }), timeout]);
      target.getContext("2d").drawImage(scratch, 0, 0);
      return res;
    } catch (e) {
      if (e.message === "timeout") {
        if (backend.includes("WebGPU")) { try { localStorage.setItem("universal-ai-face-gpu-slow", "1"); } catch {} sessionPromise = null; }
        return { faces: 0, timedOut: true, backend, ms: timeoutMs };
      }
      throw e;
    } finally { clearTimeout(timer); }
  });
  queue = job.catch(() => {});
  return job;
}

async function restoreFacesNow(source, target, { onProgress } = {}) {
  const t0 = performance.now();
  const faces = await findFaces(source);
  if (!faces.length) return { faces: 0, backend: "", ms: 0 };
  const session = await loadSession((p) => onProgress?.({ stage: "download", p }));
  const out = target.getContext("2d");
  const mask = featherMask();
  for (const [i, f] of faces.slice(0, 6).entries()) {
    onProgress?.({ stage: "face", p: i / Math.min(6, faces.length) });
    const T = similarity(f.points, TEMPLATE);
    // 1. Line the face up on a 512 x 512 canvas.
    const crop = document.createElement("canvas");
    crop.width = crop.height = SIZE;
    const cx = crop.getContext("2d", { willReadFrequently: true });
    cx.imageSmoothingQuality = "high";
    cx.setTransform(T.c, T.s, -T.s, T.c, T.tx, T.ty);
    cx.drawImage(source, 0, 0);
    const d = cx.getImageData(0, 0, SIZE, SIZE).data, plane = SIZE * SIZE;
    const input = new Float32Array(3 * plane);
    for (let p = 0; p < plane; p++) for (let k = 0; k < 3; k++) input[k * plane + p] = d[p * 4 + k] / 127.5 - 1;
    // 2. Rebuild it.
    const res = await session.run({ input: new ort.Tensor("float32", input, [1, 3, SIZE, SIZE]) }, [session.outputNames[0]]);
    const o = res[session.outputNames[0]].data;
    const img = new ImageData(SIZE, SIZE);
    for (let p = 0; p < plane; p++) { for (let k = 0; k < 3; k++) img.data[p * 4 + k] = (o[k * plane + p] + 1) * 127.5; img.data[p * 4 + 3] = 255; }
    const face = document.createElement("canvas");
    face.width = face.height = SIZE;
    const fx = face.getContext("2d");
    fx.putImageData(img, 0, 0);
    // 3. Soft edge so it blends into the rest of the photo, then put it back where it came from.
    fx.globalCompositeOperation = "destination-in";
    fx.drawImage(mask, 0, 0);
    const k2 = T.c * T.c + T.s * T.s, ic = T.c / k2, is = -T.s / k2;
    out.save();
    out.imageSmoothingQuality = "high";
    out.setTransform(ic, is, -is, ic, -(ic * T.tx - is * T.ty), -(is * T.tx + ic * T.ty));
    out.drawImage(face, 0, 0);
    out.restore();
  }
  return { faces: faces.length, backend, ms: performance.now() - t0 };
}


/** Free the face restorer's memory (it reloads from the saved copy next time). */
export async function releaseFaceRestorer() {
  if (!sessionPromise) return;
  const p = sessionPromise; sessionPromise = null;
  try { (await p).release(); } catch {}
}
