// Read documents on the device and turn them into plain text.
// PDF via PDF.js; Word / Excel / PowerPoint by reading the XML inside the file (they are zip files).

function xmlText(xml, tag) {
  // Pull out the text inside <tag>…</tag> elements, e.g. w:t (Word) or a:t (PowerPoint).
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(decode(m[1]));
  return out;
}
function decode(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

async function readPdf(buf, onProgress) {
  const pdfjs = await import("pdfjs-dist");
  const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: buf }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    let text = "", lastY = null;
    for (const item of content.items) {
      const y = item.transform?.[5];
      if (lastY !== null && y !== undefined && Math.abs(y - lastY) > 2) text += "\n";
      text += item.str;
      if (item.hasEOL) text += "\n";
      lastY = y;
    }
    pages.push(`--- Page ${i} ---\n${text.trim()}`);
    onProgress?.(i / doc.numPages);
  }
  const text = pages.join("\n\n");
  return { text, meta: `${doc.numPages} page${doc.numPages > 1 ? "s" : ""}`, scanned: text.replace(/--- Page \d+ ---/g, "").trim().length < 20 };
}

async function readDocx(buf) {
  const zip = await (await import("jszip")).default.loadAsync(buf);
  const xml = await zip.file("word/document.xml")?.async("string");
  if (!xml) throw new Error("This doesn't look like a Word document.");
  const paras = xml.split(/<\/w:p>/).map((p) => xmlText(p.replace(/<w:tab\/>/g, "<w:t>\t</w:t>"), "w:t").join("")).filter((p) => p.trim());
  return { text: paras.join("\n"), meta: `${paras.length} paragraphs` };
}

async function readPptx(buf) {
  const zip = await (await import("jszip")).default.loadAsync(buf);
  const slides = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  const out = [];
  for (const [i, name] of slides.entries()) {
    const xml = await zip.file(name).async("string");
    const lines = xml.split(/<\/a:p>/).map((p) => xmlText(p, "a:t").join("")).filter((p) => p.trim());
    out.push(`--- Slide ${i + 1} ---\n${lines.join("\n")}`);
  }
  if (!out.length) throw new Error("This doesn't look like a PowerPoint file.");
  return { text: out.join("\n\n"), meta: `${out.length} slides` };
}

async function readXlsx(buf) {
  const zip = await (await import("jszip")).default.loadAsync(buf);
  const shared = xmlText((await zip.file("xl/sharedStrings.xml")?.async("string")) || "", "t");
  const wb = (await zip.file("xl/workbook.xml")?.async("string")) || "";
  const names = [...wb.matchAll(/<sheet[^>]*name="([^"]+)"/g)].map((m) => decode(m[1]));
  const sheets = Object.keys(zip.files)
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/g).pop()) - Number(b.match(/\d+/g).pop()));
  const out = [];
  for (const [si, name] of sheets.entries()) {
    const xml = await zip.file(name).async("string");
    const rows = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const c of row[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g)) {
        const attrs = c[1] || c[3] || "";
        const ref = attrs.match(/r="([A-Z]+)\d+"/)?.[1];
        const col = ref ? ref.split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
        const v = (c[2] || "").match(/<v>([^<]*)<\/v>/)?.[1];
        const inline = xmlText(c[2] || "", "t").join("");
        let val = "";
        if (/t="s"/.test(attrs) && v !== undefined) val = shared[Number(v)] ?? "";
        else if (/t="inlineStr"/.test(attrs)) val = inline;
        else if (v !== undefined) val = decode(v);
        cells[col] = val;
      }
      if (cells.some((x) => x !== undefined && String(x).trim())) rows.push(Array.from(cells, (x) => x ?? "").join(" | "));
      if (rows.length >= 2000) break;
    }
    out.push(`--- Sheet: ${names[si] || si + 1} (${rows.length} rows) ---\n${rows.join("\n")}`);
  }
  if (!out.length) throw new Error("This doesn't look like an Excel file.");
  return { text: out.join("\n\n"), meta: `${out.length} sheet${out.length > 1 ? "s" : ""}` };
}

/** Read a File and return { text, meta, scanned? }. */
export async function readDocument(file, onProgress) {
  const name = file.name.toLowerCase();
  const ext = name.split(".").pop();
  if (file.size > 40 * 1024 * 1024) throw new Error("That file is over 40 MB. Try a smaller one.");
  if (["txt", "md", "csv", "json", "html", "js", "py", "java", "c", "cpp"].includes(ext)) {
    const text = await file.text();
    return { text, meta: `${text.split("\n").length} lines` };
  }
  const buf = await file.arrayBuffer();
  if (ext === "pdf") return readPdf(buf, onProgress);
  if (ext === "docx") return readDocx(buf);
  if (ext === "pptx") return readPptx(buf);
  if (ext === "xlsx") return readXlsx(buf);
  if (["doc", "ppt", "xls"].includes(ext)) throw new Error(`Old .${ext} files aren't supported. Save it as .${ext}x and try again.`);
  throw new Error("This file type isn't supported. Try PDF, DOCX, XLSX, PPTX or a text file.");
}

/** Split text into chunks of about `size` characters, on paragraph boundaries. */
export function chunkText(text, size) {
  const parts = text.split(/\n{2,}|\n(?=--- )/);
  const chunks = [];
  let cur = "";
  for (const p of parts) {
    if ((cur + "\n\n" + p).length > size && cur) { chunks.push(cur); cur = ""; }
    if (p.length > size) {
      for (let i = 0; i < p.length; i += size) chunks.push(p.slice(i, i + size));
    } else {
      cur = cur ? cur + "\n\n" + p : p;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Pick the chunks that share the most words with a question. */
export function relevantChunks(chunks, question, max = 3) {
  const words = new Set(question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
  return chunks
    .map((c, i) => {
      const lower = c.toLowerCase();
      let score = 0;
      for (const w of words) if (lower.includes(w)) score++;
      return { c, i, score };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.c);
}
