// Photo test lab: runs the background remover on 35 photos and measures the results.
//  - 22 "exact answer" tests: a transparent cut-out (person or object) is pasted onto a busy
//    background; the correct matte is the cut-out's own transparency.
//  - 13 real photos: no exact answer, so only the automatic quality checks and a visual check.
import cases from "../tests/photo-lab/cases.json";
import * as matting from "./matting.js";
const { removeBackground, compareMattes } = matting;

const $ = (id) => document.getElementById(id);
const PASS = { iou: 0.9, mse: 0.03 }; // thresholds for the exact-answer tests

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't download ${url}`));
    img.src = url;
  });
}

// Paste a cut-out onto a background (cover-fit), at most 1024 px on the long side.
function composite(cut, bg) {
  const s = Math.min(1, 1024 / Math.max(cut.width, cut.height));
  const w = Math.round(cut.width * s), h = Math.round(cut.height * s);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d", { willReadFrequently: true });
  const k = Math.max(w / bg.width, h / bg.height);
  x.drawImage(bg, (w - bg.width * k) / 2, (h - bg.height * k) / 2, bg.width * k, bg.height * k);
  x.drawImage(cut, 0, 0, w, h);
  // The correct answer: the cut-out's own transparency.
  const t = document.createElement("canvas");
  t.width = w; t.height = h;
  const tx = t.getContext("2d", { willReadFrequently: true });
  tx.drawImage(cut, 0, 0, w, h);
  const d = tx.getImageData(0, 0, w, h).data;
  const truth = new Float32Array(w * h);
  for (let i = 0; i < truth.length; i++) truth[i] = d[i * 4 + 3] / 255;
  return { canvas: c, truth, cutCanvas: t };
}

function alphaCanvas(alpha, w, h) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const img = new ImageData(w, h);
  for (let i = 0; i < alpha.length; i++) { const v = alpha[i] * 255; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  c.getContext("2d").putImageData(img, 0, 0);
  return c;
}

function figure(node, caption, checker) {
  const f = document.createElement("figure");
  const box = document.createElement("div");
  if (checker) box.className = "checker";
  box.append(node);
  const cap = document.createElement("figcaption");
  cap.textContent = caption;
  f.append(box, cap);
  return f;
}

function verdictFor(r) {
  if (r.error) return /^Broken test photo/.test(r.error) ? "skipped" : "fail";
  if (r.exact) return r.metrics.iou >= PASS.iou && r.metrics.mse <= PASS.mse ? "pass" : "fail";
  const c = r.report.checks;
  return c.coverage < 0.02 || c.coverage > 0.95 || c.fragments > 3 || c.haloScore > 0.3 ? "warn" : "ok";
}

async function runAll() {
  $("run").disabled = true;
  $("cases").innerHTML = "";
  const jobs = [];
  cases.cutouts.forEach((c, i) => {
    for (const b of [cases.backgrounds[(i * 2) % 8], cases.backgrounds[(i * 2 + 1) % 8]]) jobs.push({ kind: "exact", cut: c, bg: b, name: `${c.title} on ${b.name}`, tags: c.tags });
  });
  cases.real.forEach((r) => jobs.push({ kind: "real", photo: r, name: r.title, tags: r.tags }));

  const results = [];
  for (const [k, job] of jobs.entries()) {
    $("status").textContent = `Running ${k + 1} of ${jobs.length}: ${job.name}`;
    const r = { name: job.name, tags: job.tags, exact: job.kind === "exact" };
    const row = document.createElement("div");
    row.className = "case";
    try {
      let input, truth = null;
      if (job.kind === "exact") {
        const [cut, bg] = await Promise.all([loadImage(job.cut.url), loadImage(job.bg.url)]);
        const comp = composite(cut, bg);
        const cover = comp.truth.reduce((a, v) => a + (v > 0.5), 0) / comp.truth.length;
        if (cover > 0.97 || cover < 0.01) throw new Error("Broken test photo: the cut-out has no transparency, so there is no correct answer to compare with. Skipped.");
        input = comp.canvas; truth = comp.truth;
        r.credit = [job.cut, job.bg];
      } else {
        const img = await loadImage(job.photo.url);
        input = document.createElement("canvas");
        const s = Math.min(1, 1024 / Math.max(img.width, img.height));
        input.width = Math.round(img.width * s); input.height = Math.round(img.height * s);
        input.getContext("2d").drawImage(img, 0, 0, input.width, input.height);
        r.credit = [job.photo];
      }
      const t0 = performance.now();
      const out = await removeBackground(input, { background: "transparent", maxSide: 1024 });
      r.ms = Math.round(performance.now() - t0);
      r.report = out.report;
      if (truth) r.metrics = compareMattes(out.alpha, truth);
      row.append(
        figure(input, "Input"),
        figure(out.canvas, "Result (transparent)", true),
        figure(alphaCanvas(out.alpha, out.width, out.height), "Matte found"),
        truth ? figure(alphaCanvas(truth, out.width, out.height), "Correct matte") : figure(document.createElement("div"), "No exact answer for real photos"),
      );
    } catch (e) {
      r.error = e.message;
      row.append(figure(document.createElement("div"), `Error: ${e.message}`));
    }
    r.verdict = verdictFor(r);
    const meta = document.createElement("div");
    meta.className = "meta";
    const m = r.metrics, c = r.report?.checks;
    meta.innerHTML = `<b class="${r.verdict === "ok" ? "pass" : r.verdict}">${r.verdict.toUpperCase()}</b>
      <div>${job.tags}</div>
      ${m ? `<div>IoU ${m.iou.toFixed(3)} · MSE ${m.mse.toFixed(4)} · edge error ${m.edgeError.toFixed(3)}</div>` : ""}
      ${c ? `<div>coverage ${(c.coverage * 100).toFixed(1)}% · fragments ${c.fragments} · halo ${c.haloScore.toFixed(2)} · soft edge ${c.softEdge.toFixed(2)}</div>` : ""}
      ${r.ms ? `<div>${(r.ms / 1000).toFixed(1)} s</div>` : ""}
      ${r.report?.model ? `<div>Outline used: ${r.report.model}</div>` : ""}
      ${r.report?.fixes?.length ? `<div>Fixes: ${r.report.fixes.join("; ")}</div>` : ""}
      <div>${(r.credit || []).map((x) => `<a href="${x.page}" target="_blank" rel="noopener">${x.title}</a> (${x.license})`).join("<br>")}</div>`;
    row.append(meta);
    row.dataset.verdict = r.verdict;
    $("cases").append(row);
    results.push(r);
    renderSummary(results, jobs.length);
  }
  window.__labResults = results;
  $("status").textContent = `Done: ${results.length} photos.`;
  $("run").disabled = false;
}

function renderSummary(results, total) {
  const exact = results.filter((r) => r.exact && r.metrics);
  window.__labSummary = { passed: 0, total: 0 };
  const real = results.filter((r) => !r.exact);
  const passed = exact.filter((r) => r.verdict === "pass").length;
  const avg = (f) => (exact.length ? exact.reduce((s, r) => s + f(r), 0) / exact.length : 0);
  const persons = exact.filter((r) => !/not a person/.test(r.tags));
  const objects = exact.filter((r) => /not a person/.test(r.tags));
  const pAvg = (arr) => (arr.length ? (arr.reduce((s, r) => s + r.metrics.iou, 0) / arr.length).toFixed(3) : "–");
  $("summary").innerHTML = `<table>
    <tr><th>Progress</th><td>${results.length} of ${total}</td></tr>
    <tr><th>Exact-answer tests passed (IoU ≥ ${PASS.iou}, MSE ≤ ${PASS.mse})</th><td>${passed} of ${exact.length}</td></tr>
    <tr><th>Average IoU (1.0 = perfect)</th><td>${avg((r) => r.metrics.iou).toFixed(3)}</td></tr>
    <tr><th>Average IoU, people / objects</th><td>${pAvg(persons)} / ${pAvg(objects)}</td></tr>
    <tr><th>Average edge error (0 = perfect)</th><td>${avg((r) => r.metrics.edgeError).toFixed(3)}</td></tr>
    <tr><th>Real photos flagged by quality checks</th><td>${real.filter((r) => r.verdict === "warn" || r.verdict === "fail").length} of ${real.length}</td></tr>
    <tr><th>Broken test photos skipped</th><td>${results.filter((r) => r.verdict === "skipped").length}</td></tr>
    <tr><th>Errors</th><td>${results.filter((r) => r.error && r.verdict !== "skipped").length}</td></tr>
    <tr><th>Average time per photo</th><td>${(results.reduce((s, r) => s + (r.ms || 0), 0) / Math.max(1, results.length) / 1000).toFixed(1)} s</td></tr>
  </table>`;
}

$("run").addEventListener("click", runAll);
$("onlyFailed").addEventListener("change", (e) => {
  document.querySelectorAll(".case").forEach((c) => { c.hidden = e.target.checked && !["fail", "warn"].includes(c.dataset.verdict); });
});

// Debug hooks for tuning from the console.
Object.assign(window, { __matting: matting, __loadImage: loadImage, __composite: composite, __alphaCanvas: alphaCanvas, __cases: cases });
