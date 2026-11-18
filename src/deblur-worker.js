// Background worker: runs blur removal off the main thread.
import { deblurPixels } from "./deblur.js";

self.onmessage = (e) => {
  const { data, w, h } = e.data;
  const d = new Uint8ClampedArray(data);
  const res = deblurPixels(d, w, h);
  self.postMessage({ ...res, data: d.buffer }, [d.buffer]);
};
