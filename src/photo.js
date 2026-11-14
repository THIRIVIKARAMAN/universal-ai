// Photo helpers that run entirely on the device (no internet needed).

// Load a File into an <img>.
export function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a photo this browser can open.")); };
    img.src = url;
  });
}

// Draw an image into a canvas no larger than maxSide pixels.
export function drawScaled(img, canvas, maxSide = 1400) {
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  canvas.width = Math.round((img.naturalWidth || img.width) * scale);
  canvas.height = Math.round((img.naturalHeight || img.height) * scale);
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// Export a canvas as { mimeType, data (base64), dataUrl } for the AI.
export function canvasToPart(canvas, maxSide = 1024, quality = 0.85) {
  let src = canvas;
  if (Math.max(canvas.width, canvas.height) > maxSide) {
    src = document.createElement("canvas");
    drawScaled(canvas, src, maxSide);
  }
  const dataUrl = src.toDataURL("image/jpeg", quality);
  return { mimeType: "image/jpeg", data: dataUrl.split(",")[1], dataUrl };
}

export function thumbnail(canvas, side = 240) {
  const t = document.createElement("canvas");
  drawScaled(canvas, t, side);
  return t.toDataURL("image/jpeg", 0.7);
}

// Percentile of a 256-bin histogram.
function percentile(hist, total, p) {
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= total * p) return i;
  }
  return 255;
}

/**
 * Enhance a photo of notes.
 *  mode "scan":  even out lighting, black-and-white, high contrast, sharpened
 *  mode "color": auto levels per channel, a little more saturation, sharpened
 *  strength 0..100
 */
export function enhance(srcCanvas, dstCanvas, mode = "scan", strength = 60) {
  dstCanvas.width = srcCanvas.width;
  dstCanvas.height = srcCanvas.height;
  const ctx = dstCanvas.getContext("2d");
  ctx.drawImage(srcCanvas, 0, 0);
  if (mode === "original") return dstCanvas;

  const { width: w, height: h } = dstCanvas;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const s = strength / 100;

  if (mode === "scan") {
    // 1. Luminance.
    const lum = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) lum[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];

    // 2. Estimate the paper colour with a coarse blurred background, to remove shadows.
    const cell = Math.max(8, Math.round(Math.min(w, h) / 24));
    const gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    const bg = new Float32Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
      for (let gx = 0; gx < gw; gx++) {
        // Paper is the bright part of each cell: take a high value, not the mean.
        let max1 = 0, max2 = 0;
        for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2) {
          for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) {
            const v = lum[y * w + x];
            if (v > max1) { max2 = max1; max1 = v; } else if (v > max2) max2 = v;
          }
        }
        bg[gy * gw + gx] = max2 || max1 || 255;
      }
    }

    // 3. Divide by the background (bilinear), then stretch contrast.
    const out = new Float32Array(w * h);
    const hist = new Uint32Array(256);
    for (let y = 0; y < h; y++) {
      const fy = Math.min(gh - 1.001, Math.max(0, y / cell - 0.5));
      const y0 = Math.floor(fy), ty = fy - y0;
      for (let x = 0; x < w; x++) {
        const fx = Math.min(gw - 1.001, Math.max(0, x / cell - 0.5));
        const x0 = Math.floor(fx), tx = fx - x0;
        const b = (bg[y0 * gw + x0] * (1 - tx) + bg[y0 * gw + x0 + 1] * tx) * (1 - ty) +
                  (bg[(y0 + 1) * gw + x0] * (1 - tx) + bg[(y0 + 1) * gw + x0 + 1] * tx) * ty;
        const v = Math.min(255, (lum[y * w + x] / Math.max(1, b)) * 255);
        out[y * w + x] = v;
        hist[v | 0]++;
      }
    }
    const lo = percentile(hist, w * h, 0.01 + 0.04 * s);
    const hi = Math.max(lo + 10, percentile(hist, w * h, 0.6));
    const gamma = 1 + 0.8 * s; // darker ink at higher strength
    for (let p = 0, i = 0; p < out.length; p++, i += 4) {
      let v = (out[p] - lo) / (hi - lo);
      v = Math.max(0, Math.min(1, v));
      v = Math.pow(v, gamma) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
  } else {
    // Colour: per-channel auto levels + saturation boost.
    const hists = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
    for (let i = 0; i < d.length; i += 4) { hists[0][d[i]]++; hists[1][d[i + 1]]++; hists[2][d[i + 2]]++; }
    const total = w * h;
    const lo = hists.map((hh) => percentile(hh, total, 0.005 + 0.02 * s));
    const hi = hists.map((hh, c) => Math.max(lo[c] + 10, percentile(hh, total, 0.995 - 0.03 * s)));
    const sat = 1 + 0.5 * s;
    for (let i = 0; i < d.length; i += 4) {
      const r = ((d[i] - lo[0]) / (hi[0] - lo[0])) * 255;
      const g = ((d[i + 1] - lo[1]) / (hi[1] - lo[1])) * 255;
      const b = ((d[i + 2] - lo[2]) / (hi[2] - lo[2])) * 255;
      const l = 0.299 * r + 0.587 * g + 0.114 * b;
      d[i] = l + (r - l) * sat;
      d[i + 1] = l + (g - l) * sat;
      d[i + 2] = l + (b - l) * sat;
    }
  }

  // Sharpen (unsharp mask with a 3x3 kernel).
  const amt = 0.4 + 0.8 * s;
  const copy = new Uint8ClampedArray(d);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const blur = (copy[i - 4 + c] + copy[i + 4 + c] + copy[i - w * 4 + c] + copy[i + w * 4 + c] + copy[i + c] * 4) / 8;
        d[i + c] = copy[i + c] + (copy[i + c] - blur) * amt;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
  return dstCanvas;
}
