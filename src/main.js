import { models, InferenceMode } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const els = {
  netChip: $("netChip"),
  deviceChip: $("deviceChip"),
  routing: $("routing"),
  routeHint: $("routeHint"),
  downloadBtn: $("downloadBtn"),
  progressWrap: $("progressWrap"),
  progressBar: $("progressBar"),
  input: $("input"),
  sendBtn: $("sendBtn"),
  answers: $("answers"),
};

/* ---------------- Tasks (what the student wants) ---------------- */
const TASKS = {
  ask: { placeholder: "Type your doubt, e.g. Why is the sky blue?", wrap: (t) => t },
  explain: {
    placeholder: "Paste a topic or hard paragraph to explain like I'm 12",
    wrap: (t) => `Explain this very simply, like to a 12-year-old, with one everyday Indian example:\n\n${t}`,
  },
  summary: {
    placeholder: "Paste your notes here to summarize",
    wrap: (t) => `Summarize these study notes into 5 short bullet points and 3 key terms:\n\n${t}`,
  },
  quiz: {
    placeholder: "Type a topic, e.g. Newton's laws of motion",
    wrap: (t) => `Make 3 multiple-choice questions (A-D) on this topic, then list the answers at the end:\n\n${t}`,
  },
};
let currentTask = "ask";
document.querySelectorAll(".task").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".task").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentTask = btn.dataset.task;
    els.input.placeholder = TASKS[currentTask].placeholder;
  })
);

/* ---------------- Network awareness ---------------- */
// navigator.connection is available in Chrome. effectiveType: "slow-2g" | "2g" | "3g" | "4g"
function getNetwork() {
  const c = navigator.connection;
  if (!navigator.onLine) return { label: "Offline", quality: "offline" };
  if (!c) return { label: "Online", quality: "fast" };
  const slow = c.effectiveType === "slow-2g" || c.effectiveType === "2g" || c.effectiveType === "3g" || c.saveData;
  const label = `${c.effectiveType.toUpperCase()}${c.downlink ? ` · ${c.downlink} Mbps` : ""}${c.saveData ? " · data saver" : ""}`;
  return { label, quality: slow ? "slow" : "fast" };
}

// Smart routing: fast internet → best quality (cloud). Slow or offline → on-device first.
function chooseMode() {
  const choice = els.routing.value;
  if (choice !== "auto") return choice;
  const { quality } = getNetwork();
  return quality === "fast" ? InferenceMode.PREFER_IN_CLOUD : InferenceMode.PREFER_ON_DEVICE;
}

const MODE_TEXT = {
  prefer_in_cloud: "→ cloud first (fast internet)",
  prefer_on_device: "→ on-device first (slow / offline)",
  only_on_device: "→ on-device only",
  only_in_cloud: "→ cloud only",
};

function renderNetwork() {
  const n = getNetwork();
  els.netChip.textContent = `📶 ${n.label}`;
  els.netChip.className = `chip ${n.quality}`;
  els.routeHint.textContent = MODE_TEXT[chooseMode()];
}
window.addEventListener("online", renderNetwork);
window.addEventListener("offline", renderNetwork);
navigator.connection?.addEventListener("change", renderNetwork);
els.routing.addEventListener("change", renderNetwork);

/* ---------------- On-device model status & download ---------------- */
async function renderDeviceStatus() {
  if (!("LanguageModel" in self)) {
    setDeviceChip("🧠 Offline AI: not supported in this browser", "off");
    els.downloadBtn.disabled = true;
    return;
  }
  try {
    const a = await LanguageModel.availability({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
    const map = {
      available: ["🧠 Offline AI: ready", "ready"],
      downloadable: ["🧠 Offline AI: not downloaded yet", "warn"],
      downloading: ["🧠 Offline AI: downloading…", "warn"],
      unavailable: ["🧠 Offline AI: this device can't run it (cloud will be used)", "off"],
    };
    const [text, cls] = map[a] || [`🧠 Offline AI: ${a}`, "warn"];
    setDeviceChip(text, cls);
    els.downloadBtn.disabled = a === "available" || a === "unavailable";
  } catch (e) {
    setDeviceChip("🧠 Offline AI: unknown", "warn");
  }
}
function setDeviceChip(text, cls) {
  els.deviceChip.textContent = text;
  els.deviceChip.className = `chip ${cls}`;
}

// Must be called from a user click (Chrome rule for starting the model download).
els.downloadBtn.addEventListener("click", async () => {
  els.downloadBtn.disabled = true;
  els.progressWrap.classList.remove("hidden");
  try {
    await models[InferenceMode.PREFER_ON_DEVICE].initializeDeviceModel((p) => {
      els.progressBar.style.width = `${Math.round(p * 100)}%`;
    });
    els.progressBar.style.width = "100%";
  } catch (e) {
    console.error(e);
    alertInline(`Couldn't download the offline AI: ${e.message}`);
  }
  renderDeviceStatus();
});

/* ---------------- Asking the AI ---------------- */
els.sendBtn.addEventListener("click", ask);
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) ask();
});

async function ask() {
  const text = els.input.value.trim();
  if (!text) return els.input.focus();

  const mode = chooseMode();
  const net = getNetwork();
  const card = addAnswerCard(text);
  const body = card.querySelector(".body");
  const badge = card.querySelector(".badge");
  els.sendBtn.disabled = true;

  const start = performance.now();
  try {
    const result = await models[mode].generateContentStream(TASKS[currentTask].wrap(text));
    let out = "";
    for await (const chunk of result.stream) {
      out += chunk.text();
      body.innerHTML = formatText(out);
    }
    const response = await result.response;
    const secs = ((performance.now() - start) / 1000).toFixed(1);
    const src = response.inferenceSource;
    const onDevice = src === "on_device";
    badge.textContent = `${onDevice ? "⚡ On-device (Gemini Nano)" : "☁️ Cloud (Gemini)"} · ${secs}s · ${net.label}`;
    badge.className = `badge ${onDevice ? "device" : "cloud"}`;
  } catch (e) {
    console.error(e);
    badge.textContent = "⚠️ Error";
    badge.className = "badge error";
    body.textContent = explainError(e);
  } finally {
    els.sendBtn.disabled = false;
  }
}

function explainError(e) {
  const msg = String(e?.message || e);
  if (/app.?check|403|PERMISSION/i.test(msg))
    return "Cloud AI was blocked by App Check. On localhost, copy the debug token from the browser console into Firebase → App Check → Manage debug tokens. " + msg;
  if (!navigator.onLine)
    return "You're offline and the on-device AI isn't available on this device. Download the offline AI first (on a supported computer). " + msg;
  return msg;
}

function addAnswerCard(question) {
  const card = document.createElement("article");
  card.className = "card answer";
  card.innerHTML = `
    <div class="q"></div>
    <span class="badge pending">⏳ Thinking…</span>
    <div class="body"></div>`;
  card.querySelector(".q").textContent = question.length > 160 ? question.slice(0, 160) + "…" : question;
  els.answers.prepend(card);
  return card;
}

function alertInline(msg) {
  const card = addAnswerCard("Offline AI download");
  card.querySelector(".badge").textContent = "⚠️ Error";
  card.querySelector(".badge").className = "badge error";
  card.querySelector(".body").textContent = msg;
}

// Tiny safe formatter: escape HTML, then support **bold** and bullet lines.
function formatText(t) {
  const esc = t.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  return esc
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split("\n")
    .map((line) => (/^\s*[-*•]\s+/.test(line) ? `<li>${line.replace(/^\s*[-*•]\s+/, "")}</li>` : `<p>${line}</p>`))
    .join("")
    .replace(/<p><\/p>/g, "");
}

renderNetwork();
renderDeviceStatus();
