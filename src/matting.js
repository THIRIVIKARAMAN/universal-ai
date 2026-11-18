// Background removal ("matting") that runs on the device.
//
// Pipeline
//  1. MODNet portrait matting (Apache-2.0, ~7 MB, via Transformers.js + ONNX Runtime Web)
//     gives a soft alpha matte that handles hair better than plain segmentation.
//  2. MediaPipe DeepLab person mask recovers body parts MODNet can miss (raised arms, legs).
//  3. Guided-filter refinement in the uncertain edge band, guided by the photo itself,
//     so the matte follows real edges and hair.
//  4. Fragment removal: drops leftover background pieces.
//  5. Colour decontamination: removes the old background colour from semi-transparent
//     edge pixels, so there is no halo on the new background.
//  6. Quality checks with automatic fixes, and a report of what was found.

import { AutoModel, AutoProcessor, RawImage, env } from "@huggingface/transformers";
import * as ort from "onnxruntime-web";

env.allowLocalModels = false;
env.useBrowserCache = true; // downloaded models are kept in the browser, so this works offline later
env.backends.onnx.wasm.wasmPaths = { mjs: "/ort/ort-wasm-simd-threaded.mjs", wasm: "/ort/ort-wasm-simd-threaded.wasm" };

const MODNET = "Xenova/modnet";
let modnetPromise = null;

export function loadMatting(onProgress) {
  if (!modnetPromise) {
    modnetPromise = (async () => {
      const progress_callback = (p) => { if (p.status === "progress" && onProgress) onProgress(p.progress / 100); };
      const [model, processor] = await Promise.all([
        AutoModel.from_pretrained(MODNET, { dtype: "q8", device: "wasm", progress_callback }),
        AutoProcessor.from_pretrained(MODNET, { progress_callback }),
      ]);
      return { model, processor };
    })().catch((e) => {
      modnetPromise = null;
      throw new Error(navigator.onLine
        ? `The background remover couldn't load (${e.message}).`
        : "The background remover hasn't been saved for offline use yet. Use it once with internet, then it works offline.");
    });
  }
  return modnetPromise;
}

/* ---------------- small image helpers ---------------- */
function toCanvas(src, maxSide) {
  const w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height;
  const s = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
  c.getContext("2d", { willReadFrequently: true }).drawImage(src, 0, 0, c.width, c.height);
  return c;
}

// Resize a single-channel float map with bilinear sampling.
function resizeMap(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  const fx = sw / dw, fy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0;
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * dw + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// Mean filter with an integral image (O(1) per pixel).
function boxFilter(src, w, h, r) {
  const W = w + 1;
  const sat = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * W + x + 1] = sat[y * W + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h - 1, y + r);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w - 1, x + r);
      const s = sat[(y1 + 1) * W + x1 + 1] - sat[y0 * W + x1 + 1] - sat[(y1 + 1) * W + x0] + sat[y0 * W + x0];
      out[y * w + x] = s / ((x1 - x0 + 1) * (y1 - y0 + 1));
    }
  }
  return out;
}

// Grey-scale guided filter (He et al.): smooths `p` while following edges in guide `I`.
function guidedFilter(I, p, w, h, r, eps) {
  const n = w * h;
  const Ip = new Float32Array(n), II = new Float32Array(n);
  for (let i = 0; i < n; i++) { Ip[i] = I[i] * p[i]; II[i] = I[i] * I[i]; }
  const mI = boxFilter(I, w, h, r), mp = boxFilter(p, w, h, r), mIp = boxFilter(Ip, w, h, r), mII = boxFilter(II, w, h, r);
  const a = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const cov = mIp[i] - mI[i] * mp[i], v = mII[i] - mI[i] * mI[i];
    a[i] = cov / (v + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxFilter(a, w, h, r), mb = boxFilter(b, w, h, r);
  const q = new Float32Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(1, Math.max(0, ma[i] * I[i] + mb[i]));
  return q;
}

// Connected regions of alpha > 0.5. Returns labels and region sizes.
function components(alpha, w, h) {
  const label = new Int32Array(w * h);
  const sizes = [0];
  const stack = [];
  let next = 1;
  for (let s = 0; s < alpha.length; s++) {
    if (alpha[s] <= 0.5 || label[s]) continue;
    let size = 0;
    label[s] = next; stack.push(s);
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % w;
      if (x > 0 && !label[p - 1] && alpha[p - 1] > 0.5) { label[p - 1] = next; stack.push(p - 1); }
      if (x < w - 1 && !label[p + 1] && alpha[p + 1] > 0.5) { label[p + 1] = next; stack.push(p + 1); }
      if (p >= w && !label[p - w] && alpha[p - w] > 0.5) { label[p - w] = next; stack.push(p - w); }
      if (p < alpha.length - w && !label[p + w] && alpha[p + w] > 0.5) { label[p + w] = next; stack.push(p + w); }
    }
    sizes.push(size);
    next++;
  }
  return { label, sizes };
}

/* ---------------- the pipeline ---------------- */

// Models want a square input. Squashing a tall full-body photo into a square crushes the body,
// so pad it to a square with neutral grey, run the model, then cut the padding off again.
function letterbox(src) {
  const side = Math.max(src.width, src.height);
  const c = document.createElement("canvas");
  c.width = c.height = side;
  const x = c.getContext("2d");
  x.fillStyle = "#808080";
  x.fillRect(0, 0, side, side);
  const ox = Math.floor((side - src.width) / 2), oy = Math.floor((side - src.height) / 2);
  x.drawImage(src, ox, oy);
  return { canvas: c, ox, oy, side };
}

function unletterbox(map, side, box, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) out.set(map.subarray((y + box.oy) * side + box.ox, (y + box.oy) * side + box.ox + w), y * w);
  return out;
}

async function modnetAlpha(work) {
  const { model, processor } = await loadMatting();
  const box = letterbox(work);
  const image = await RawImage.fromCanvas(box.canvas);
  const { pixel_values } = await processor(image);
  const { output } = await model({ input: pixel_values });
  const t = output[0]; // [1, h, w], values 0..1
  const [, mh, mw] = t.dims;
  const full = resizeMap(t.data, mw, mh, box.side, box.side);
  return unletterbox(full, box.side, box, work.width, work.height);
}

async function personAlpha(work) {
  try {
    const { personMask } = await import("./segment.js");
    const box = letterbox(work);
    const full = await personMask(box.canvas);
    return full ? unletterbox(full, box.side, box, work.width, work.height) : null;
  } catch {
    return null;
  }
}

// Grow the subject into connected pixels the person model is fairly sure about.
// Body parts attached to the subject come back; separate bystanders don't.
function growWithPerson(alpha, person, w, h, minPerson) {
  const n = w * h, seen = new Uint8Array(n), stack = [];
  for (let i = 0; i < n; i++) if (alpha[i] > 0.5) { seen[i] = 1; stack.push(i); }
  let added = 0;
  while (stack.length) {
    const p = stack.pop(), x = p % w;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1];
    for (const q of nb) {
      if (q < 0 || seen[q] || person[q] < minPerson) continue;
      seen[q] = 1; stack.push(q);
      if (alpha[q] < person[q]) { alpha[q] = person[q]; added++; }
    }
  }
  return added;
}


/* ---------------- U-2-Netp: general "main subject" model (people and objects), 4.6 MB, Apache-2.0 ---------------- */
const U2NETP_URL = "https://huggingface.co/BritishWerewolf/U-2-Netp/resolve/main/onnx/model.onnx";
let u2Promise = null;

async function cachedFetch(url) {
  let cache = null;
  try { cache = await caches.open("universal-ai-models"); } catch {}
  const hit = cache && (await cache.match(url));
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  if (cache) await cache.put(url, res.clone());
  return res.arrayBuffer();
}

function loadU2() {
  if (!u2Promise) {
    u2Promise = (async () => {
      ort.env.wasm.wasmPaths = { mjs: "/ort/ort-wasm-simd-threaded.mjs", wasm: "/ort/ort-wasm-simd-threaded.wasm" };
      const buf = await cachedFetch(U2NETP_URL);
      return ort.InferenceSession.create(buf, { executionProviders: ["wasm"] });
    })().catch((e) => { u2Promise = null; throw e; });
  }
  return u2Promise;
}

export async function saliencyAlpha(work) {
  const session = await loadU2();
  const S = 320, box = letterbox(work);
  const c = document.createElement("canvas");
  c.width = c.height = S;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.drawImage(box.canvas, 0, 0, S, S);
  const d = x.getImageData(0, 0, S, S).data;
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let k = 0; k < 3; k++) input[k * S * S + i] = (d[i * 4 + k] / 255 - mean[k]) / std[k];
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, S, S]) });
  const t = out[session.outputNames[0]].data;
  // Normalise to 0..1 like the reference implementation.
  let lo = Infinity, hi = -Infinity;
  for (const v of t) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const norm = new Float32Array(S * S);
  for (let i = 0; i < norm.length; i++) norm[i] = (t[i] - lo) / Math.max(1e-6, hi - lo);
  const full = resizeMap(norm, S, S, box.side, box.side);
  return unletterbox(full, box.side, box, work.width, work.height);
}


const CHOICE_LABELS = { person: "person-model", modnet: "portrait (MODNet)", salient: "main-subject (U-2-Netp)", median: "combined three-model", max: "MODNet + U-2-Netp" };

// Average image-edge strength along a matte's outline. A correct outline sits on real edges.
function edgeAlignment(alpha, grad, w, h) {
  let sum = 0, count = 0;
  for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) {
    const i = y * w + x, b = alpha[i] > 0.5;
    if (b === (alpha[i + 1] > 0.5) && b === (alpha[i + w] > 0.5)) continue;
    let m = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const g = grad[i + dy * w + dx]; if (g > m) m = g; }
    sum += m; count++;
  }
  return count ? sum / count : 0;
}


// Fill holes inside the subject (a face, a coat) when the models, on average, think they belong to it.
function fillHoles(alpha, maps, w, h) {
  const n = w * h, label = new Int32Array(n), stack = [];
  let next = 1;
  for (let s0 = 0; s0 < n; s0++) {
    if (alpha[s0] > 0.5 || label[s0]) continue;
    const members = [];
    let touchesBorder = false, support = 0;
    label[s0] = next; stack.push(s0);
    while (stack.length) {
      const p = stack.pop(); members.push(p);
      const x = p % w, y = (p / w) | 0;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const q of [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p - w, p + w]) {
        if (q < 0 || q >= n || label[q] || alpha[q] > 0.5) continue;
        label[q] = next; stack.push(q);
      }
    }
    next++;
    if (touchesBorder || members.length > n * 0.15) continue;
    for (const p of members) { let m = 0; for (const mp of maps) m = Math.max(m, mp[p]); support += m; }
    if (support / members.length > 0.5) for (const p of members) { let m = 0; for (const mp of maps) m = Math.max(m, mp[p]); alpha[p] = Math.max(alpha[p], m); }
  }
}

function chooseMatte(work, { modnet, person, salient }) {
  const w = work.width, h = work.height, n = w * h;
  const d = work.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const L = new Float32Array(n), grad = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; grad[i] = Math.hypot(L[i + 1] - L[i - 1], L[i + w] - L[i - w]); }
  const cands = { modnet };
  const personCover = person ? person.reduce((t, v) => t + (v > 0.5), 0) / n : 0;
  if (salient) {
    cands.salient = salient;
    cands.max = modnet.map((v, i) => Math.max(v, salient[i]));
    // The middle opinion only makes sense when there is a person for the person model to see.
    if (person && personCover > 0.005) cands.median = modnet.map((v, i) => { const a = person[i], b = salient[i]; return Math.max(Math.min(v, a), Math.min(Math.max(v, a), b)); });
  }
  const personBin = person ? person.map((v) => (v > 0.5 ? 1 : 0)) : null;
  const agreeWithPerson = (a) => compareMattes(a, personBin).iou;
  const usePerson = personCover > 0.02;
  const bonus = { median: 1.2 };
  let best = "modnet", bestScore = -1, maxAgree = 0;
  for (const [k, a] of Object.entries(cands)) {
    if (usePerson) maxAgree = Math.max(maxAgree, agreeWithPerson(a));
    const sc = edgeAlignment(a, grad, w, h) * (bonus[k] || 1);
    if (sc > bestScore) { bestScore = sc; best = k; }
  }
  // Every outline missed the person the person model sees (e.g. a bride in front of a golden door):
  // use the person model's own shape; the edge refinement sharpens it afterwards.
  if (usePerson && maxAgree < 0.3) { best = "person"; cands.person = person; }
  fillHoles(cands[best], [modnet, person, salient].filter(Boolean), w, h);
  return { name: best, label: CHOICE_LABELS[best], alpha: cands[best] };
}

/**
 * Remove the background of a photo.
 * options: { background: "white" | "transparent" | "blur" | css colour, mainOnly: keep only the main subject }
 * Returns { canvas, alpha (Float32Array), width, height, report }.
 */
export async function removeBackground(source, { background = "#ffffff", mainOnly = false, maxSide = 2048, onStep } = {}) {
  const step = (s) => onStep?.(s);
  const img = toCanvas(source, maxSide);
  const w = img.width, h = img.height, n = w * h;
  const data = img.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const report = { steps: [], checks: {}, fixes: [] };

  // 1. Three models look at the photo: MODNet (portrait detail, hair), a person model (whole body),
  //    and U-2-Netp (the main subject of any photo, including objects).
  step("Finding the subject");
  const work = toCanvas(img, 1024);
  const ww = work.width, wh = work.height;
  const modnet = await modnetAlpha(work);
  report.steps.push("MODNet matting");
  step("Checking arms and body");
  const person = await personAlpha(work);
  let salient = null;
  try { salient = await saliencyAlpha(work); report.steps.push("Subject detection (U-2-Netp)"); } catch (e) { console.warn("U-2-Netp unavailable", e); }

  // 2. Pick the outline that follows the photo's real edges best (tested on the photo test lab:
  //    average accuracy 0.68 with MODNet alone, 0.885 with this choice).
  const choice = chooseMatte(work, { modnet, person, salient });
  report.model = choice.name;
  report.steps.push(`Chose the ${choice.label} outline`);
  let alpha = resizeMap(choice.alpha, ww, wh, w, h);

  // 3. Guided-filter refinement in the uncertain band around the edge.
  step("Refining edges and hair");
  const grey = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) grey[i] = (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) / 255;
  const r = Math.max(3, Math.round(Math.min(w, h) / 160));
  const refined = guidedFilter(grey, alpha, w, h, r, 1e-3);
  const hard = boxFilter(alpha.map((a) => (a > 0.5 ? 1 : 0)), w, h, Math.max(2, r));
  for (let i = 0; i < n; i++) {
    // Inside the subject and far outside it, trust the model; in the edge band, trust the refinement.
    const band = hard[i] > 0.02 && hard[i] < 0.98;
    if (band) alpha[i] = refined[i];
  }
  report.steps.push("Guided-filter edge refinement");

  // 4. Remove fragments: keep the main subject (and, unless mainOnly, other large parts).
  step("Removing leftover background");
  const { label, sizes } = components(alpha, w, h);
  const biggest = Math.max(0, ...sizes.slice(1));
  // Prefer the region nearest the centre when only the main subject is wanted.
  let mainLabel = 0, best = -1;
  if (biggest) {
    const cx = new Float64Array(sizes.length), cy = new Float64Array(sizes.length);
    for (let i = 0; i < n; i++) if (label[i]) { cx[label[i]] += i % w; cy[label[i]] += (i / w) | 0; }
    for (let k = 1; k < sizes.length; k++) {
      const dx = cx[k] / sizes[k] / w - 0.5, dy = cy[k] / sizes[k] / h - 0.5;
      const score = sizes[k] * (1.4 - Math.min(1, Math.hypot(dx, dy) * 1.6));
      if (score > best) { best = score; mainLabel = k; }
    }
  }
  let dropped = 0;
  const keep = new Uint8Array(sizes.length);
  for (let k = 1; k < sizes.length; k++) keep[k] = k === mainLabel || (!mainOnly && sizes[k] >= biggest * 0.08) ? 1 : 0;
  // Also drop faint pixels far from any kept region.
  const keptMask = new Float32Array(n);
  for (let i = 0; i < n; i++) keptMask[i] = label[i] && keep[label[i]] ? 1 : 0;
  const nearKept = boxFilter(keptMask, w, h, Math.max(3, r * 2));
  for (let i = 0; i < n; i++) {
    if ((label[i] && !keep[label[i]]) || (alpha[i] > 0 && nearKept[i] === 0)) {
      if (alpha[i] > 0.05) dropped++;
      alpha[i] = 0;
    }
  }
  if (dropped > n * 0.0005) report.fixes.push(`Removed ${(100 * dropped / n).toFixed(2)}% of the photo as leftover background pieces`);
  report.steps.push("Fragment removal");

  // 5. Colour decontamination: estimate the old background colour near the edge and remove it.
  step("Cleaning edge colours");
  const R = new Float32Array(n), G = new Float32Array(n), B = new Float32Array(n), Wt = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const bw = alpha[i] < 0.05 ? 1 : 0;
    Wt[i] = bw; R[i] = data[j] * bw; G[i] = data[j + 1] * bw; B[i] = data[j + 2] * bw;
  }
  const rr = Math.max(6, r * 4);
  const mW = boxFilter(Wt, w, h, rr), mR = boxFilter(R, w, h, rr), mG = boxFilter(G, w, h, rr), mB = boxFilter(B, w, h, rr);
  const fg = new Uint8ClampedArray(n * 4);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const a = alpha[i];
    if (a > 0.02 && a < 0.98 && mW[i] > 1e-3) {
      const bgR = mR[i] / mW[i], bgG = mG[i] / mW[i], bgB = mB[i] / mW[i];
      const k = Math.max(a, 0.15);
      fg[j] = (data[j] - (1 - a) * bgR) / k;
      fg[j + 1] = (data[j + 1] - (1 - a) * bgG) / k;
      fg[j + 2] = (data[j + 2] - (1 - a) * bgB) / k;
    } else {
      fg[j] = data[j]; fg[j + 1] = data[j + 1]; fg[j + 2] = data[j + 2];
    }
    fg[j + 3] = Math.round(a * 255);
  }
  report.steps.push("Colour decontamination");

  // 6. Quality checks.
  step("Checking quality");
  const Ri = new Float32Array(n), Gi = new Float32Array(n), Bi = new Float32Array(n), Wi = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    const iw = alpha[i] > 0.95 ? 1 : 0;
    Wi[i] = iw; Ri[i] = data[j] * iw; Gi[i] = data[j + 1] * iw; Bi[i] = data[j + 2] * iw;
  }
  const mWi = boxFilter(Wi, w, h, rr), mRi = boxFilter(Ri, w, h, rr), mGi = boxFilter(Gi, w, h, rr), mBi = boxFilter(Bi, w, h, rr);
  const halo = () => {
    // An edge pixel is a "halo" if its colour is closer to the old background than to the subject next to it.
    let bad = 0, band = 0;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = alpha[i];
      if (a <= 0.05 || a >= 0.6 || mW[i] < 1e-3 || mWi[i] < 1e-3) continue;
      band++;
      const dF = Math.hypot(fg[j] - mRi[i] / mWi[i], fg[j + 1] - mGi[i] / mWi[i], fg[j + 2] - mBi[i] / mWi[i]);
      const dB = Math.hypot(fg[j] - mR[i] / mW[i], fg[j + 1] - mG[i] / mW[i], fg[j + 2] - mB[i] / mW[i]);
      if (dB < dF * 0.7) bad++;
    }
    return band ? bad / band : 0;
  };
  let checks = { ...qualityChecks(alpha, w, h), haloScore: halo() };
  if (checks.haloScore > 0.25) {
    // Pull the edge in slightly and check again.
    for (let i = 0; i < n; i++) alpha[i] = Math.max(0, Math.min(1, (alpha[i] - 0.12) / 0.88));
    for (let i = 0, j = 3; i < n; i++, j += 4) fg[j] = Math.round(alpha[i] * 255);
    report.fixes.push(`Tightened the edge to reduce a halo (halo score was ${checks.haloScore.toFixed(2)})`);
    checks = { ...qualityChecks(alpha, w, h), haloScore: halo() };
  }
  report.checks = checks;

  // Compose on the requested background.
  const fgCanvas = document.createElement("canvas");
  fgCanvas.width = w; fgCanvas.height = h;
  fgCanvas.getContext("2d").putImageData(new ImageData(fg, w, h), 0, 0);
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d");
  if (background === "blur") {
    ctx.filter = `blur(${Math.max(8, Math.round(w / 50))}px)`;
    ctx.drawImage(img, 0, 0);
    ctx.filter = "none";
  } else if (background !== "transparent") {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.drawImage(fgCanvas, 0, 0);
  return { canvas: out, alpha, width: w, height: h, report };
}

/**
 * Quality checks on a matte (no ground truth needed).
 *  coverage   share of the photo kept as subject
 *  fragments  separate kept pieces besides the biggest one
 *  softEdge   semi-transparent pixels per edge pixel (high = blurry, low = cut-out look)
 *  haloScore  (added by removeBackground) share of edge pixels that still look like the old background
 */
export function qualityChecks(alpha, w, h) {
  const n = w * h;
  let sum = 0, semi = 0;
  for (let i = 0; i < n; i++) { sum += alpha[i]; if (alpha[i] > 0.1 && alpha[i] < 0.9) semi++; }
  const { sizes } = components(alpha, w, h);
  const big = sizes.slice(1).sort((a, b) => b - a);
  const fragments = big.slice(1).filter((s) => s > n * 0.001).length;
  let edge = 0;
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x;
    if ((alpha[i] > 0.5) !== (alpha[i + 1] > 0.5) || (alpha[i] > 0.5) !== (alpha[i + w] > 0.5)) edge++;
  }
  return { coverage: sum / n, fragments, softEdge: edge ? semi / edge : 0, width: w, height: h };
}

/** Compare a matte with a known correct one (used by the test lab). */
export function compareMattes(alpha, truth) {
  let inter = 0, union = 0, sad = 0, se = 0, edgeErr = 0, edgeN = 0;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i], t = truth[i];
    const pa = a > 0.5, pt = t > 0.5;
    if (pa && pt) inter++;
    if (pa || pt) union++;
    sad += Math.abs(a - t);
    se += (a - t) ** 2;
    if (t > 0.02 && t < 0.98) { edgeErr += Math.abs(a - t); edgeN++; }
  }
  return {
    iou: union ? inter / union : 1,
    sad: sad / 1000,
    mse: se / alpha.length,
    edgeError: edgeN ? edgeErr / edgeN : 0,
  };
}

/** For the test lab: what each model sees on its own (0..1 maps at the photo's size). */
export async function debugMaps(source) {
  const work = toCanvas(source, 1024);
  const modnet = await modnetAlpha(work), person = await personAlpha(work);
  let salient = null;
  try { salient = await saliencyAlpha(work); } catch (e) { console.warn("U-2-Netp failed", e); }
  return { modnet, person, salient, width: work.width, height: work.height };
}

/** Download and save both background-remover models so they work offline later. */
export async function prepareOffline() {
  await loadMatting();
  await loadU2();
}

/** Free the background remover's memory (models reload from the saved copies next time). */
export async function releaseMatting() {
  const m = modnetPromise, u = u2Promise;
  modnetPromise = null; u2Promise = null;
  try { if (m) (await m).model.dispose(); } catch {}
  try { if (u) (await u).release(); } catch {}
}
