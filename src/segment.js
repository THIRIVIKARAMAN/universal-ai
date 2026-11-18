// On-device background removal with MediaPipe (no internet needed once cached).
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

// DeepLab v3 finds people (and other objects). Category 15 = person.
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite";
const PERSON = 15;
let segmenterPromise = null;

function getSegmenter() {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks("/mediapipe");
      return ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
        runningMode: "IMAGE",
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
    })().catch((e) => {
      segmenterPromise = null;
      throw new Error(navigator.onLine
        ? `The background remover couldn't start (${e.message}).`
        : "The background remover hasn't been saved for offline use yet. Use it once with internet, then it works offline.");
    });
  }
  return segmenterPromise;
}

// Keep only the biggest connected person (the main subject), so a crowd behind is removed.
function keepMainSubject(conf, w, h) {
  const on = new Uint8Array(w * h);
  for (let i = 0; i < on.length; i++) on[i] = conf[i] > 0.5 ? 1 : 0;
  const label = new Int32Array(w * h);
  let best = 0, bestSize = 0, bestScore = 0, next = 1;
  const stack = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || label[start]) continue;
    let size = 0, cx = 0;
    label[start] = next; stack.push(start);
    while (stack.length) {
      const p = stack.pop(); size++;
      const x = p % w, y = (p / w) | 0;
      cx += Math.abs(x - w / 2) / w + Math.abs(y - h / 2) / h;
      for (const q of [p - 1, p + 1, p - w, p + w]) {
        if (q < 0 || q >= on.length || label[q] || !on[q]) continue;
        if ((q === p - 1 && x === 0) || (q === p + 1 && x === w - 1)) continue;
        label[q] = next; stack.push(q);
      }
    }
    // Prefer big regions near the middle of the photo.
    const score = size * (1.5 - Math.min(1, cx / size));
    if (score > bestScore) { bestScore = score; best = next; bestSize = size; }
    next++;
  }
  if (!bestSize) return null;
  const out = new Float32Array(w * h);
  // Keep soft edges for pixels next to the main subject.
  for (let i = 0; i < out.length; i++) {
    if (label[i] === best) out[i] = conf[i];
    else if (!on[i]) {
      const x = i % w;
      const near = (x > 0 && label[i - 1] === best) || (x < w - 1 && label[i + 1] === best) ||
                   (i >= w && label[i - w] === best) || (i < out.length - w && label[i + w] === best);
      out[i] = near ? conf[i] : 0;
    }
  }
  return out;
}

/**
 * Replace the background of a photo.
 * background: "white" | "transparent" | "blur" | any CSS colour
 * Returns a new canvas. Throws a readable Error if no person is found.
 */
export async function replaceBackground(source, background = "white") {
  const seg = await getSegmenter();
  const result = seg.segment(source);
  const mask = result.confidenceMasks?.[PERSON];
  if (!mask) { result.close?.(); throw new Error("Couldn't analyse this photo."); }
  const mw = mask.width, mh = mask.height;
  const conf = mask.getAsFloat32Array().slice();
  result.close?.();

  const alpha = keepMainSubject(conf, mw, mh);
  if (!alpha) throw new Error("I couldn't find a person in this photo. Background removal works best on photos of people.");

  // Mask as an image, scaled up smoothly to the photo size.
  const m = document.createElement("canvas");
  m.width = mw; m.height = mh;
  const mctx = m.getContext("2d");
  const img = mctx.createImageData(mw, mh);
  for (let i = 0; i < alpha.length; i++) {
    const a = Math.max(0, Math.min(1, (alpha[i] - 0.25) / 0.5)); // sharpen the edge a little
    img.data[i * 4 + 3] = a * 255;
  }
  mctx.putImageData(img, 0, 0);

  const w = source.width, h = source.height;
  const subject = document.createElement("canvas");
  subject.width = w; subject.height = h;
  const sctx = subject.getContext("2d");
  sctx.drawImage(source, 0, 0);
  sctx.globalCompositeOperation = "destination-in";
  sctx.filter = `blur(${Math.max(1, Math.round(w / 500))}px)`;
  sctx.drawImage(m, 0, 0, w, h);

  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const octx = out.getContext("2d");
  if (background === "blur") {
    octx.filter = `blur(${Math.max(6, Math.round(w / 60))}px)`;
    octx.drawImage(source, 0, 0);
    octx.filter = "none";
  } else if (background !== "transparent") {
    octx.fillStyle = background;
    octx.fillRect(0, 0, w, h);
  }
  octx.drawImage(subject, 0, 0);
  return out;
}

// Work out what background the person asked for.
export function backgroundFromText(text) {
  const t = text.toLowerCase();
  if (/transparent|see.?through|png|no background/.test(t)) return "transparent";
  if (/blur/.test(t)) return "blur";
  const colours = { black: "#000", blue: "#2f67d8", green: "#1e9e5a", red: "#d33", yellow: "#f5c400", grey: "#888", gray: "#888", pink: "#f4a6c0", orange: "#f28c28", purple: "#7a4fd0" };
  for (const [name, css] of Object.entries(colours)) if (t.includes(name)) return css;
  return "#ffffff";
}

/** Soft person mask (0..1 per pixel) at the size of `source`, or null if no person model is available. */
export async function personMask(source) {
  const seg = await getSegmenter();
  const result = seg.segment(source);
  const mask = result.confidenceMasks?.[PERSON];
  if (!mask) { result.close?.(); return null; }
  const out = resizeTo(mask.getAsFloat32Array().slice(), mask.width, mask.height, source.width, source.height);
  result.close?.();
  return out;
}

function resizeTo(src, sw, sh, dw, dh) {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, (y + 0.5) * sh / dh);
    for (let x = 0; x < dw; x++) out[y * dw + x] = src[(sy | 0) * sw + Math.min(sw - 1, ((x + 0.5) * sw / dw) | 0)];
  }
  return out;
}
