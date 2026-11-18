// After `vite build`: list every file the app may need offline, for the service worker.
import fs from "node:fs";
import path from "node:path";

const dist = path.resolve("dist");
const files = [];
for (const dir of ["assets", "mediapipe", "icons", "ort", "models"]) {
  const full = path.join(dist, dir);
  if (!fs.existsSync(full)) continue;
  for (const f of fs.readdirSync(full)) if (!/^lab|jsep|LICENSE/.test(f) && !(dir === "assets" && /asyncify/.test(f))) files.push({ url: `/${dir}/${f}`, size: fs.statSync(path.join(full, f)).size });
}
// Small files are cached when the app installs; big ones (engines, models) right after, in the background.
const BIG = 400 * 1024;
const manifest = {
  core: files.filter((f) => f.size < BIG).map((f) => f.url),
  heavy: [
    ...files.filter((f) => f.size >= BIG).map((f) => f.url),
    "https://storage.googleapis.com/mediapipe-models/image_segmenter/deeplab_v3/float32/1/deeplab_v3.tflite",
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
  ],
};
fs.writeFileSync(path.join(dist, "precache.json"), JSON.stringify(manifest, null, 1));
console.log(`precache: ${manifest.core.length} core files, ${manifest.heavy.length} heavy files`);
