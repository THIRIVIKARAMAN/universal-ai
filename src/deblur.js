// Blur removal: the pixel work only (no canvas, no AI runtime), so it can run in a worker.
/* ---------------- blur removal ---------------- */
// Out-of-focus blur: estimate how blurred the photo is (from how edges respond to extra blur,
// Zhuo & Sim 2011), then undo it with Richardson-Lucy deconvolution.
// Shaky-hand blur (blur in one direction): measuring the exact shake from one photo wasn't
// reliable in our tests (it made photos worse about half the time), so we only sharpen gently.

function gauss1d(sigma) {
  const r = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return { k, r };
}

// Gaussian blur approximated by three box blurs (Kutskir's method): the cost per pixel
// stays the same however big the blur is, which matters because deblurring runs it ~40 times.
function boxSizes(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

function boxPass(src, dst, w, h, r, horizontal, buf) {
  const len = horizontal ? w : h, lines = horizontal ? h : w, n = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    for (let i = -r; i < len + r; i++) {
      let j = i; while (j < 0 || j >= len) j = j < 0 ? -j - 1 : 2 * len - j - 1;
      buf[i + r] = horizontal ? src[line * w + j] : src[j * w + line];
    }
    let s = 0;
    for (let t = 0; t < n; t++) s += buf[t];
    for (let i = 0; i < len; i++) {
      if (horizontal) dst[line * w + i] = s / n; else dst[i * w + line] = s / n;
      s += buf[i + n] - buf[i];
    }
  }
}

function gaussBlur(src, w, h, sigma) {
  const buf = new Float32Array(Math.max(w, h) + 2 * Math.ceil(sigma * 4) + 8);
  let a = Float32Array.from(src), b = new Float32Array(w * h);
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) >> 1;
    if (r < 1) continue;
    boxPass(a, b, w, h, r, true, buf);
    boxPass(b, a, w, h, r, false, buf);
  }
  return a;
}

/** Blur size (Gaussian sigma, in pixels) for edges facing each direction (0-165 degrees, 15-degree steps). */
function blurByDirection(L, w, h) {
  const n = w * h, g1 = new Float32Array(n), ang = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, gx = (L[i + 1] - L[i - 1]) / 2, gy = (L[i + w] - L[i - w]) / 2;
    g1[i] = Math.hypot(gx, gy);
    ang[i] = ((Math.atan2(gy, gx) * 180) / Math.PI + 180) % 180;
  }
  const B = gaussBlur(L, w, h, 2), g2 = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x; g2[i] = Math.hypot((B[i + 1] - B[i - 1]) / 2, (B[i + w] - B[i - w]) / 2); }
  // Strong edges: top 3 % of gradients.
  const sample = [];
  for (let i = 0; i < n; i += 7) sample.push(g1[i]);
  sample.sort((a, b) => a - b);
  const thr = Math.max(8, sample[Math.floor(sample.length * 0.97)] || 8);
  const bins = {};
  for (let th = 0; th < 180; th += 15) bins[th] = [];
  for (let i = 0; i < n; i++) {
    if (g1[i] <= thr) continue;
    const R = g1[i] / Math.max(g2[i], 1e-6);
    if (R <= 1.01) continue;
    const s = 2 / Math.sqrt(R * R - 1);
    for (let th = 0; th < 180; th += 15) { const d = Math.abs(((ang[i] - th + 270) % 180) - 90); if (d < 15) bins[th].push(s); }
  }
  const out = {};
  for (const [th, arr] of Object.entries(bins)) if (arr.length >= 30) { arr.sort((a, b) => a - b); out[th] = arr[arr.length >> 1]; }
  return out;
}

/**
 * The pixel work of blur removal, on raw RGBA data (so it can run in a background worker).
 * Returns { kind, sigma }; data is changed in place for kind "focus". For "shake" and "light"
 * the caller sharpens instead.
 */
// Local minimum or maximum in a (2r+1) square, separable.
function localExtreme(src, w, h, r, pick) {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let m = src[y * w + x];
    for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = pick(m, src[y * w + k]);
    tmp[y * w + x] = m;
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
    let m = tmp[y * w + x];
    for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = pick(m, tmp[k * w + x]);
    out[y * w + x] = m;
  }
  return out;
}

export function deblurPixels(d, w, h, { maxSigma = Infinity, force = 0 } = {}) {
  const n = w * h, L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const dirs = blurByDirection(L, w, h), vals = Object.values(dirs);
  if (!vals.length) return { kind: "light", sigma: 0 };
  const [thMax, sMax] = Object.entries(dirs).sort((a, b) => b[1] - a[1])[0];
  const sPerp = dirs[(Number(thMax) + 90) % 180] ?? Math.min(...vals);
  if (sMax > 1.5 * sPerp && sMax > 1.2) return { kind: "shake", sigma: sMax };
  vals.sort((a, b) => a - b);
  const s = vals[vals.length >> 1], floor = 0.6; // sharp photos already measure about 0.6
  let sd = force || Math.sqrt(Math.max(0, s * s - floor * floor));
  const measured = sd;
  sd = Math.min(sd, maxSigma);
  // Tested on 21 photos: sharp photos measure 0.45 or less, lightly blurred ones 0.8 or more.
  // Sharpening an already-sharp photo made it worse, so below 0.6 we leave it alone.
  if (sd < 0.6) return { kind: "sharp", sigma: sd };
  if (sd < 0.9) return { kind: "light", sigma: sd };
  // Strong blur: reversing it here creates halos and blotchy skin (seen on a real user photo),
  // so the caller rebuilds the photo with the AI instead.
  if (sd > 2.4 && !force) return { kind: "heavy", sigma: sd };
  // Richardson-Lucy deconvolution on brightness.
  const iters = Math.round(5 * sd) + 4;
  const x = Float32Array.from(L), ratio = new Float32Array(n);
  for (let it = 0; it < iters; it++) {
    const est = gaussBlur(x, w, h, sd);
    for (let i = 0; i < n; i++) ratio[i] = L[i] / Math.max(est[i], 1e-3);
    const corr = gaussBlur(ratio, w, h, sd);
    for (let i = 0; i < n; i++) x[i] = Math.min(255, Math.max(0, x[i] * corr[i]));
  }
  // Halo guard: no pixel may become brighter or darker than its blurred neighbourhood was
  // (plus a little), which stops the white outlines that deblurring draws around dark hair.
  const r = Math.max(1, Math.round(sd)), lo = localExtreme(L, w, h, r, Math.min), hi = localExtreme(L, w, h, r, Math.max);
  for (let i = 0; i < n; i++) {
    const v = Math.min(hi[i] + 6, Math.max(lo[i] - 6, x[i])), delta = v - L[i];
    d[i * 4] += delta; d[i * 4 + 1] += delta; d[i * 4 + 2] += delta;
  }
  return { kind: "focus", sigma: measured, used: sd };
}

