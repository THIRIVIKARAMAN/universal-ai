// Test lab for upscaling and sharpening. Every photo has an exact answer: the original.
//  - Upscale 2x / 4x: shrink the original, upscale it back, compare with the original.
//  - Sharpen: blur and JPEG-compress the original (like a shaky phone photo), sharpen, compare.
// Each AI method is compared with the plain method, so we can see whether the AI actually helps.
import cases from "../tests/photo-lab/cases.json";
import * as face from "./facerestore.js";
import { upscale, aiSharpen, smartSharpen, removeBlur, removeBlurInBackground, psnr, ssim, sharpness, setModel } from "./superres.js";

const $ = (id) => document.getElementById(id);
const SIZE = 512;

const loadImage = (url) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = () => rej(new Error(`Couldn't download ${url}`)); i.src = url; });
function canvasOf(src, w, h, filter = "none") {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  x.imageSmoothingQuality = "high"; x.filter = filter;
  x.drawImage(src, 0, 0, w, h);
  return c;
}
async function jpeg(c, q) { const img = await loadImage(c.toDataURL("image/jpeg", q)); return canvasOf(img, c.width, c.height); }

function score(out, ref) { return { psnr: psnr(out, ref), ssim: ssim(out, ref), sharp: sharpness(out) }; }

async function runAll() {
  $("run").disabled = true;
  $("cases").innerHTML = "";
  const photos = [...cases.backgrounds.map((b) => ({ title: b.title, url: b.url, page: b.page, license: b.license })), ...cases.real];
  const results = [];
  for (const [k, p] of photos.entries()) {
    $("status").textContent = `Testing ${k + 1} of ${photos.length}: ${p.title}`;
    const r = { name: p.title };
    try {
      const img = await loadImage(p.url);
      const s = Math.min(1, SIZE / Math.max(img.width, img.height));
      // Size divisible by 4 so the shrunk copies line up exactly.
      const W = Math.floor(img.width * s / 4) * 4, H = Math.floor(img.height * s / 4) * 4;
      const orig = canvasOf(img, W, H);
      const t0 = performance.now();
      // 2x
      const low2 = canvasOf(orig, W / 2, H / 2);
      r.x2 = { plain: score(canvasOf(low2, W, H), orig), ai: score(await upscale(low2, 2), orig) };
      // 4x
      const low4 = canvasOf(orig, W / 4, H / 4);
      const ai4 = await upscale(low4, 4);
      r.x4 = { plain: score(canvasOf(low4, W, H), orig), ai: score(ai4, orig) };
      // Sharpen: blur + JPEG
      const bad = await jpeg(canvasOf(orig, W, H, "blur(1.2px)"), 0.7);
      const smart = smartSharpen(bad), ai = await aiSharpen(bad);
      r.sharpen = { input: score(bad, orig), smart: score(smart, orig), ai: score(ai, orig), orig: { sharp: sharpness(orig) } };
      // Remove blur: out of focus (light, medium, heavy) and hand shake.
      const shake = (c, len) => { const o = document.createElement("canvas"); o.width = c.width; o.height = c.height; const x = o.getContext("2d"); const a = (k * 37) % 180 * Math.PI / 180; for (let i = 0; i < len; i++) { const t = i - (len - 1) / 2; x.globalAlpha = 1 / (i + 1); x.drawImage(c, t * Math.cos(a), t * Math.sin(a)); } return o; };
      r.deblur = {};
      for (const [name, make] of [["focus1", (c) => canvasOf(c, W, H, "blur(1px)")], ["focus2", (c) => canvasOf(c, W, H, "blur(2px)")], ["focus3", (c) => canvasOf(c, W, H, "blur(3px)")], ["shake9", (c) => shake(c, 9)]]) {
        const blurred = await jpeg(make(orig), 0.8);
        const fixed = removeBlur(blurred), sharp = smartSharpen(blurred);
        r.deblur[name] = { input: score(blurred, orig), sharpen: score(sharp, orig), fixed: score(fixed.canvas, orig), kind: fixed.kind, sigma: fixed.sigma };
      }
      r.ms = Math.round(performance.now() - t0);
      // Visual: zoomed crop from the centre for 4x and sharpening.
      const crop = (c, scale = 1) => { const cw = 128, ch = 128; const o = document.createElement("canvas"); o.width = 256; o.height = 256; const x = o.getContext("2d"); x.imageSmoothingEnabled = false; x.drawImage(c, (c.width - cw * scale) / 2 / 1, (c.height - ch * scale) / 2, cw * scale, ch * scale, 0, 0, 256, 256); return o; };
      const row = document.createElement("div"); row.className = "case";
      const fig = (c, t) => { const f = document.createElement("figure"); f.append(c); const cap = document.createElement("figcaption"); cap.textContent = t; f.append(cap); return f; };
      row.append(fig(crop(canvasOf(low4, W, H)), "4x: plain resize"), fig(crop(ai4), "4x: AI upscale"), fig(crop(bad), "Blurred + JPEG"), fig(crop(smart), "Smart sharpen"));
      const m = document.createElement("div"); m.className = "meta";
      const f = (o) => `${o.psnr.toFixed(2)} dB / SSIM ${o.ssim.toFixed(3)}`;
      m.innerHTML = `<b>${p.title}</b>
        <div>2x plain ${f(r.x2.plain)}<br>2x AI ${f(r.x2.ai)}</div>
        <div>4x plain ${f(r.x4.plain)}<br>4x AI ${f(r.x4.ai)}</div>
        <div>blurred ${f(r.sharpen.input)}<br>smart ${f(r.sharpen.smart)}<br>AI ${f(r.sharpen.ai)}</div>
        <div>${(r.ms / 1000).toFixed(1)} s · <a href="${p.page}" target="_blank" rel="noopener">source</a> (${p.license})</div>`;
      row.append(m); $("cases").append(row);
    } catch (e) { r.error = e.message; }
    results.push(r);
    summary(results, photos.length);
  }
  window.__enhanceResults = results;
  $("status").textContent = `Done: ${results.length} photos.`;
  $("run").disabled = false;
}

function summary(results, total) {
  const ok = results.filter((r) => !r.error);
  const avg = (f) => (ok.length ? ok.reduce((s, r) => s + f(r), 0) / ok.length : 0);
  const wins = (f) => ok.filter(f).length;
  const row = (label, a, b, w) => `<tr><th>${label}</th><td>${a}</td><td>${b}</td><td>${w} of ${ok.length}</td></tr>`;
  $("summary").innerHTML = `<table>
    <tr><th>Test (${ok.length} of ${total} photos done)</th><th>Plain / before</th><th>AI / after</th><th>Photos where AI is better</th></tr>
    ${row("Upscale 2x, PSNR dB (higher = closer to original)", avg((r) => r.x2.plain.psnr).toFixed(2), avg((r) => r.x2.ai.psnr).toFixed(2), wins((r) => r.x2.ai.psnr > r.x2.plain.psnr))}
    ${row("Upscale 2x, SSIM (1 = identical)", avg((r) => r.x2.plain.ssim).toFixed(3), avg((r) => r.x2.ai.ssim).toFixed(3), wins((r) => r.x2.ai.ssim > r.x2.plain.ssim))}
    ${row("Upscale 4x, PSNR dB", avg((r) => r.x4.plain.psnr).toFixed(2), avg((r) => r.x4.ai.psnr).toFixed(2), wins((r) => r.x4.ai.psnr > r.x4.plain.psnr))}
    ${row("Upscale 4x, SSIM", avg((r) => r.x4.plain.ssim).toFixed(3), avg((r) => r.x4.ai.ssim).toFixed(3), wins((r) => r.x4.ai.ssim > r.x4.plain.ssim))}
    ${row("Smart sharpen, PSNR dB", avg((r) => r.sharpen.input.psnr).toFixed(2), avg((r) => r.sharpen.smart.psnr).toFixed(2), wins((r) => r.sharpen.smart.psnr > r.sharpen.input.psnr))}
    ${row("Smart sharpen, SSIM", avg((r) => r.sharpen.input.ssim).toFixed(3), avg((r) => r.sharpen.smart.ssim).toFixed(3), wins((r) => r.sharpen.smart.ssim > r.sharpen.input.ssim))}
    ${row("AI sharpen, PSNR dB", avg((r) => r.sharpen.input.psnr).toFixed(2), avg((r) => r.sharpen.ai.psnr).toFixed(2), wins((r) => r.sharpen.ai.psnr > r.sharpen.input.psnr))}
    ${row("AI sharpen, SSIM", avg((r) => r.sharpen.input.ssim).toFixed(3), avg((r) => r.sharpen.ai.ssim).toFixed(3), wins((r) => r.sharpen.ai.ssim > r.sharpen.input.ssim))}
    ${row("Edge crispness (original: " + avg((r) => r.sharpen.orig.sharp).toFixed(1) + ")", avg((r) => r.sharpen.input.sharp).toFixed(1), "smart " + avg((r) => r.sharpen.smart.sharp).toFixed(1) + " / AI " + avg((r) => r.sharpen.ai.sharp).toFixed(1), "")}
    ${["focus1", "focus2", "focus3", "shake9"].map((t) => { const lab = { focus1: "Remove blur: light out-of-focus", focus2: "Remove blur: medium out-of-focus", focus3: "Remove blur: heavy out-of-focus", shake9: "Remove blur: hand shake" }[t];
      return row(lab + ", SSIM (sharpen only: " + avg((r) => r.deblur[t].sharpen.ssim).toFixed(3) + ")", avg((r) => r.deblur[t].input.ssim).toFixed(3), avg((r) => r.deblur[t].fixed.ssim).toFixed(3) + " · PSNR " + avg((r) => r.deblur[t].input.psnr).toFixed(2) + " → " + avg((r) => r.deblur[t].fixed.psnr).toFixed(2), wins((r) => r.deblur[t].fixed.ssim > r.deblur[t].input.ssim) + " (detected as out-of-focus: " + ok.filter((r) => r.deblur[t].kind === "focus").length + ")"); }).join("")}
    <tr><th>Errors</th><td colspan="3">${results.filter((r) => r.error).length}</td></tr>
    <tr><th>Average time per photo (all tests)</th><td colspan="3">${(avg((r) => r.ms) / 1000).toFixed(1)} s</td></tr>
  </table>`;
}

$("run").addEventListener("click", runAll);
Object.assign(window, { __face: face, __sr: { removeBlurInBackground, removeBlur, setModel, upscale, aiSharpen, smartSharpen, psnr, ssim, sharpness }, __cases: cases, __loadImage: loadImage, __canvasOf: canvasOf, __jpeg: jpeg });
