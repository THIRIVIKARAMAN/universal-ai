// Upscaling (2x / 4x) and sharpening, fully on the device.
//
// Upscaling uses Real-ESRGAN General x4v3 (BSD-3-Clause, by Xintao Wang), mixed 50/50 with its
// detail-keeping wdn version (the official default), converted to ONNX by scripts/convert-realesrgan.py
// and served by the app itself, so it works offline. In the photo test lab (21 photos), the
// "balanced" result (half AI, half careful resize) beat plain resizing on 18 of 21 photos at 2x and 4x.
// Sharpening is a classic "smart sharpen": it boosts real edges, ignores noise and stops halos.
import * as ort from "onnxruntime-web";
import { deblurPixels } from "./deblur.js";
export { deblurPixels };

let MODEL_URL = "/models/realesr-general-x4v3-dn05.onnx";
let sessionPromise = null;

/** For the test lab: try another model file. */
export function setModel(url) { MODEL_URL = url; sessionPromise = null; }

function loadModel() {
  if (!sessionPromise) {
    ort.env.wasm.wasmPaths = { mjs: "/ort/ort-wasm-simd-threaded.mjs", wasm: "/ort/ort-wasm-simd-threaded.wasm" };
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
    sessionPromise = ort.InferenceSession.create(MODEL_URL, { executionProviders: ["wasm"] }).catch((e) => {
      sessionPromise = null;
      throw new Error(navigator.onLine ? `The upscaler couldn't load (${e.message}).` : "The upscaler hasn't been saved for offline use yet. Open the app once with internet first.");
    });
  }
  return sessionPromise;
}

export function prepareUpscaler() { return loadModel(); }

function toCanvas(src, w = src.naturalWidth || src.width, h = src.naturalHeight || src.height) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.imageSmoothingQuality = "high";
  x.drawImage(src, 0, 0, w, h);
  return c;
}

/**
 * Run the 4x model over the image in tiles, and write the result at `outScale` (1, 2 or 4)
 * by averaging blocks of the 4x output. Tiling keeps memory low; overlaps hide tile seams.
 */
async function runX4(src, outScale, onProgress) {
  const session = await loadModel();
  const w = src.width, h = src.height;
  const data = src.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const OW = w * outScale, OH = h * outScale, f = 4 / outScale;
  const out = new ImageData(OW, OH);
  const T = 96, P = 8;
  const tiles = Math.ceil(w / T) * Math.ceil(h / T);
  let done = 0;
  for (let ty = 0; ty < h; ty += T) for (let tx = 0; tx < w; tx += T) {
    const x0 = Math.max(0, tx - P), y0 = Math.max(0, ty - P);
    const x1 = Math.min(w, tx + T + P), y1 = Math.min(h, ty + T + P);
    const tw = x1 - x0, th = y1 - y0;
    const input = new Float32Array(3 * tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const s = ((y0 + y) * w + x0 + x) * 4, d = y * tw + x;
      input[d] = data[s] / 255; input[tw * th + d] = data[s + 1] / 255; input[2 * tw * th + d] = data[s + 2] / 255;
    }
    const res = await session.run({ input: new ort.Tensor("float32", input, [1, 3, th, tw]) });
    const o = res.output.data, W4 = tw * 4, plane = W4 * th * 4;
    // Copy the tile's centre (without the overlap) into the output.
    const cx0 = tx - x0, cy0 = ty - y0, cw = Math.min(T, w - tx), ch = Math.min(T, h - ty);
    for (let y = 0; y < ch * outScale; y++) for (let x = 0; x < cw * outScale; x++) {
      let r = 0, g = 0, b = 0;
      const sy0 = (cy0 * outScale + y) * f, sx0 = (cx0 * outScale + x) * f;
      for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) {
        const k = (sy0 + dy) * W4 + sx0 + dx;
        r += o[k]; g += o[plane + k]; b += o[2 * plane + k];
      }
      const n = f * f, di = ((ty * outScale + y) * OW + tx * outScale + x) * 4;
      out.data[di] = (r / n) * 255; out.data[di + 1] = (g / n) * 255; out.data[di + 2] = (b / n) * 255; out.data[di + 3] = 255;
    }
    onProgress?.(++done / tiles);
    await new Promise((r) => setTimeout(r)); // keep the page responsive
  }
  const c = document.createElement("canvas");
  c.width = OW; c.height = OH;
  c.getContext("2d").putImageData(out, 0, 0);
  return c;
}

/** Biggest photo we upscale on a phone or laptop without running out of memory or patience. */
export const MAX_INPUT_PIXELS = { 2: 1_000_000, 4: 300_000 };

/**
 * Upscale 2x or 4x with Real-ESRGAN. Very large photos are first reduced to a size the device can handle.
 * detail: "balanced" (default; half AI, half careful resize: most faithful in tests) or "crisp" (AI only:
 * sharpest look, but it can smooth away fine texture).
 */
export async function upscale(source, scale = 2, { onProgress, detail = "balanced" } = {}) {
  let w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  const limit = MAX_INPUT_PIXELS[scale] || MAX_INPUT_PIXELS[2];
  const reduced = w * h > limit;
  if (reduced) { const k = Math.sqrt(limit / (w * h)); w = Math.round(w * k); h = Math.round(h * k); }
  const input = toCanvas(source, w, h);
  const ai = await runX4(input, scale, onProgress);
  if (detail !== "crisp") {
    const x = ai.getContext("2d");
    x.globalAlpha = 0.5;
    x.imageSmoothingQuality = "high";
    x.drawImage(input, 0, 0, ai.width, ai.height);
    x.globalAlpha = 1;
  }
  ai.reducedFirst = reduced;
  return ai;
}

/**
 * "AI sharpen": shrink the photo to half size, let Real-ESRGAN rebuild it at 2x (which restores
 * crisp edges and removes noise), so the result has the original size.
 */
export async function aiSharpen(source, { onProgress } = {}) {
  const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  const half = toCanvas(source, Math.max(1, Math.round(w / 2)), Math.max(1, Math.round(h / 2)));
  const out = await runX4(half, 2, onProgress);
  return out.width === w && out.height === h ? out : toCanvas(out, w, h);
}

/* ---------------- classic smart sharpen ---------------- */

function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h), n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += src[y * w + Math.min(w - 1, Math.max(0, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / n;
      s += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / n;
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}

/**
 * Smart sharpen. amount: 0..2 (1 = normal). Works on brightness only (no colour fringes),
 * skips flat noisy areas, and clamps to the local min/max so edges don't get bright halos.
 */
export function smartSharpen(source, { amount = 1, radius = 0 } = {}) {
  const c = toCanvas(source);
  const w = c.width, h = c.height, n = w * h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, w, h), d = img.data;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const r = radius || Math.max(1, Math.round(Math.min(w, h) / 600));
  // Three box blurs ~ a Gaussian blur.
  const blur = boxBlur(boxBlur(boxBlur(L, w, h, r), w, h, r), w, h, r);
  for (let i = 0; i < n; i++) {
    const detail = L[i] - blur[i], mag = Math.abs(detail);
    // Noise gate: tiny differences are mostly noise; real edges are bigger.
    const gate = Math.min(1, Math.max(0, (mag - 2) / 6));
    let v = L[i] + amount * 1.6 * detail * gate;
    // Halo control: stay within the 3x3 neighbourhood's range (plus a little).
    const x = i % w, y = (i / w) | 0;
    let lo = 255, hi = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(w - 1, Math.max(0, x + dx)), yy = Math.min(h - 1, Math.max(0, y + dy));
      const l = L[yy * w + xx];
      if (l < lo) lo = l; if (l > hi) hi = l;
    }
    v = Math.min(hi + 4, Math.max(lo - 4, v));
    const delta = v - L[i];
    d[i * 4] += delta; d[i * 4 + 1] += delta; d[i * 4 + 2] += delta;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

/* ---------------- quality measures (used by the test lab and the quality check) ---------------- */

export function psnr(a, b) {
  const da = a.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, a.width, a.height).data;
  const db = b.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, b.width, b.height).data;
  let s = 0, n = 0;
  for (let i = 0; i < da.length; i += 4) for (let k = 0; k < 3; k++) { const e = da[i + k] - db[i + k]; s += e * e; n++; }
  return 10 * Math.log10((255 * 255) / Math.max(1e-9, s / n));
}

function luma(c) {
  const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  const L = new Float32Array(c.width * c.height);
  for (let i = 0; i < L.length; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return L;
}

/** Structural similarity on brightness (1 = identical), 7x7 windows. */
export function ssim(a, b) {
  const w = a.width, h = a.height, x = luma(a), y = luma(b), n = w * h, r = 3;
  const xx = x.map((v) => v * v), yy = y.map((v) => v * v), xy = x.map((v, i) => v * y[i]);
  const mx = boxBlur(x, w, h, r), my = boxBlur(y, w, h, r), mxx = boxBlur(xx, w, h, r), myy = boxBlur(yy, w, h, r), mxy = boxBlur(xy, w, h, r);
  const C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const vx = mxx[i] - mx[i] * mx[i], vy = myy[i] - my[i] * my[i], cxy = mxy[i] - mx[i] * my[i];
    s += ((2 * mx[i] * my[i] + C1) * (2 * cxy + C2)) / ((mx[i] ** 2 + my[i] ** 2 + C1) * (vx + vy + C2));
  }
  return s / n;
}

/** Sharpness score: average edge strength (higher = crisper). */
export function sharpness(c) {
  const w = c.width, h = c.height, L = luma(c);
  let s = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; s += Math.abs(L[i + 1] - L[i - 1]) + Math.abs(L[i + w] - L[i - w]); }
  return s / ((w - 2) * (h - 2));
}

function prepare(source, maxPixels) {
  let w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  if (w * h > maxPixels) { const k = Math.sqrt(maxPixels / (w * h)); w = Math.round(w * k); h = Math.round(h * k); }
  const c = toCanvas(source, w, h);
  return { c, ctx: c.getContext("2d", { willReadFrequently: true }), w, h };
}

/* ---------------- blur removal (pixel work is in deblur.js) ---------------- */

/**
 * Strong blur: shrink the photo until the blur is about 1 pixel, then let Real-ESRGAN rebuild it
 * at full size. It can't invent lost detail, but it gives clean edges without halos.
 */
export async function aiRebuild(source, sigma, { onProgress } = {}) {
  const w = source.naturalWidth || source.width, h = source.naturalHeight || source.height;
  // Shrinking by the blur size leaves about 1 pixel of blur, which the AI then rebuilds crisply.
  // (Tried on a real user photo: shrinking less, or blending with a plain resize, left it blurry.)
  const f = Math.max(1, sigma);
  const small = toCanvas(source, Math.max(16, Math.round(w / f)), Math.max(16, Math.round(h / f)));
  const scale = f > 2.5 ? 4 : 2;
  const up = await upscale(small, scale, { detail: "crisp", onProgress });
  return toCanvas(up, w, h);
}


/**
 * Remove blur (on this thread). Returns { canvas, kind, sigma }:
 *  kind "focus": out-of-focus blur, undone with deconvolution;
 *  kind "shake": blur in one direction (hand shake), only gently sharpened;
 *  kind "light": barely blurred, gently sharpened;
 *  kind "sharp": already sharp, returned unchanged.
 */
export function removeBlur(source, { maxPixels = 2_000_000, maxSigma, force } = {}) {
  const { c, ctx, w, h } = prepare(source, maxPixels);
  const img = ctx.getImageData(0, 0, w, h);
  let res = deblurPixels(img.data, w, h, { maxSigma, force });
  if (res.kind === "heavy") res = deblurPixels(img.data, w, h, { force: Math.min(res.sigma, 2.4) }); // AI rebuild needs the async version
  if (res.kind === "sharp") return { canvas: c, ...res };
  if (res.kind !== "focus") return { canvas: smartSharpen(c, { amount: res.kind === "shake" ? 1.3 : 0.6 }), ...res };
  ctx.putImageData(img, 0, 0);
  return { canvas: c, ...res };
}

/** Same as removeBlur, but in a background worker so the app stays responsive. */
export async function removeBlurInBackground(source, { maxPixels = 2_000_000 } = {}) {
  const { c, ctx, w, h } = prepare(source, maxPixels);
  const img = ctx.getImageData(0, 0, w, h);
  let res;
  try {
    const worker = new Worker(new URL("./deblur-worker.js", import.meta.url), { type: "module" });
    res = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => { resolve(e.data); worker.terminate(); };
      worker.onerror = (e) => { reject(e); worker.terminate(); };
      worker.postMessage({ data: img.data.buffer, w, h }, [img.data.buffer]);
    });
  } catch (e) {
    console.warn("Background deblur unavailable, running on the page", e);
    return removeBlur(source, { maxPixels });
  }
  if (res.kind === "sharp") return { canvas: c, kind: res.kind, sigma: res.sigma };
  if (res.kind === "heavy") return { canvas: await aiRebuild(c, res.sigma), kind: "heavy", sigma: res.sigma };
  if (res.kind !== "focus") return { canvas: smartSharpen(c, { amount: res.kind === "shake" ? 1.3 : 0.6 }), kind: res.kind, sigma: res.sigma };
  ctx.putImageData(new ImageData(new Uint8ClampedArray(res.data), w, h), 0, 0);
  return { canvas: c, kind: res.kind, sigma: res.sigma };
}

/** Free the upscaler's memory (it reloads from the saved copy next time). */
export async function releaseUpscaler() {
  if (!sessionPromise) return;
  const p = sessionPromise; sessionPromise = null;
  try { (await p).release(); } catch {}
}
