import { models, imageModels, InferenceMode, editImageInCloud } from "./firebase.js";
import { load, save, uid, escapeHtml } from "./store.js";
import { fileToImage, drawScaled, canvasToPart, thumbnail, enhance } from "./photo.js";
import { listen, stopListening, speak, stopSpeaking, canListen, canSpeak } from "./voice.js";
import { initWayback } from "./wayback.js";
import { initSchedule } from "./schedule.js";
import { showMenu, toast, setTheme, getTheme, ICONS } from "./ui.js";
import { readDocument, chunkText, relevantChunks } from "./docs.js";

const $ = (id) => document.getElementById(id);

/* =========================================================
   State: chats and projects live in this browser only.
   ========================================================= */
const CHATS_KEY = "universal-ai-chats";
const PROJECTS_KEY = "universal-ai-projects";
let chats = load(CHATS_KEY, []);
let projects = load(PROJECTS_KEY, []);
let currentId = null;           // open chat (null = new, unsaved chat)
let projectFilter = null;       // sidebar project filter
let view = "chat";

// Older versions saved single answers; fold them into one chat once.
const legacy = load("universal-ai-answers", null);
if (legacy && legacy.length && !chats.length) {
  chats = [{
    id: uid(), title: "Earlier answers", projectId: null, updated: Date.now(),
    messages: legacy.slice().reverse().flatMap((a) => [
      { role: "user", text: a.q, prompt: a.q, at: a.at },
      { role: "model", text: a.out, src: a.src, secs: a.secs, net: a.net, at: a.at },
    ]),
  }];
  save(CHATS_KEY, chats);
}

const persistChats = () => save(CHATS_KEY, chats.slice(0, 60).map((c) => ({
  ...c, messages: c.messages.map(({ imageFull, ...m }) => m),
})));
const persistProjects = () => save(PROJECTS_KEY, projects);
const currentChat = () => chats.find((c) => c.id === currentId) || null;

/* =========================================================
   Tasks
   ========================================================= */
const TASKS = {
  ask: { label: "Doubt", wrap: (t) => t },
  explain: { label: "Explain simply", wrap: (t) => `Explain this very simply, like to a 12-year-old, with one everyday Indian example:\n\n${t}` },
  summary: { label: "Summary", wrap: (t) => `Summarize these study notes into 5 short bullet points and 3 key terms:\n\n${t}` },
  quiz: { label: "Quiz", wrap: (t) => `Make 3 multiple-choice questions (A-D) on this topic, then list the answers at the end:\n\n${t}` },
};

/* =========================================================
   Network + routing
   ========================================================= */
function getNetwork() {
  const c = navigator.connection;
  if (!navigator.onLine) return { label: "No signal", quality: "offline" };
  if (!c || !c.effectiveType) return { label: "Online", quality: "fast" };
  const type = c.effectiveType.toUpperCase();
  const slow = ["SLOW-2G", "2G", "3G"].includes(type) || c.saveData;
  const speed = c.downlink ? `, ${c.downlink} Mbps` : "";
  return { label: `${type}${speed}${c.saveData ? ", data saver" : ""}`, quality: slow ? "slow" : "fast" };
}

let deviceState = "unknown";       // Gemini Nano for text
let deviceImageState = "unknown";  // Gemini Nano for photos

function chooseMode(hasImage) {
  const choice = $("routing").value;
  if (choice !== "auto") return choice;
  const ready = hasImage ? deviceImageState === "available" : deviceState === "available";
  if (getNetwork().quality !== "fast" && ready) return InferenceMode.PREFER_ON_DEVICE;
  return InferenceMode.PREFER_IN_CLOUD;
}

function expectedRoute(mode, hasImage) {
  const ready = hasImage ? deviceImageState === "available" : deviceState === "available";
  if (mode === "only_on_device") return "device";
  if (mode === "only_in_cloud") return "cloud";
  if (mode === "prefer_on_device") return ready ? "device" : "cloud";
  return navigator.onLine ? "cloud" : "device";
}

function explainRoute() {
  const n = getNetwork();
  if ($("routing").value !== "auto") {
    return expectedRoute(chooseMode(false), false) === "device"
      ? "You chose the device. Answers stay on this device and work without internet."
      : "You chose the cloud. Answers need internet but are more detailed.";
  }
  const ready = deviceState === "available";
  if (n.quality === "offline") return ready
    ? "<b>No signal.</b> Questions go to the AI on this device, so you can keep studying."
    : deviceState === "unavailable" || deviceState === "unsupported"
      ? "<b>No signal</b>, and this device can't run the offline AI. Try Chrome on a computer or phone that supports Gemini Nano."
      : "<b>No signal</b>, and the offline AI isn't downloaded yet. Download it next time you have Wi-Fi.";
  if (n.quality === "slow") return ready
    ? `<b>Weak signal (${n.label}).</b> Questions go to this device first, so you don't wait for the network.`
    : `<b>Weak signal (${n.label}).</b> The offline AI isn't ready on this device, so the cloud will answer. It may be slow.`;
  return `<b>Good signal (${n.label}).</b> Questions go to the cloud for the most detailed answers.`;
}

function renderRouting() {
  const n = getNetwork();
  $("netText").textContent = n.quality === "offline" ? "Offline" : "Online";
  $("netDetail").textContent = n.quality === "offline" ? "" : `, ${n.label}`;
  $("netChip").dataset.quality = n.quality;
  $("trackWrap").dataset.route = expectedRoute(chooseMode(false), false);
  $("routeHint").innerHTML = explainRoute();
}
addEventListener("online", renderRouting);
addEventListener("offline", renderRouting);
navigator.connection?.addEventListener("change", renderRouting);
$("routing").addEventListener("change", renderRouting);

/* =========================================================
   On-device model status + download
   ========================================================= */
const DEVICE_TEXT = {
  available: "Gemini Nano is ready",
  downloadable: "Gemini Nano isn't downloaded yet",
  downloading: "Gemini Nano is downloading",
  unavailable: "This device can't run Gemini Nano",
  unsupported: "This browser has no on-device AI",
  unknown: "Checking Gemini Nano",
};

async function availability(withImages) {
  if (!("LanguageModel" in self)) return "unsupported";
  try {
    return await LanguageModel.availability({
      expectedInputs: withImages ? [{ type: "text", languages: ["en"] }, { type: "image" }] : [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    });
  } catch {
    return withImages ? "unavailable" : "unknown";
  }
}

let downloadTarget = "text"; // what the download button fetches next

async function checkDevice() {
  deviceState = await availability(false);
  deviceImageState = deviceState === "available" ? await availability(true) : "unavailable";
  let text = DEVICE_TEXT[deviceState] || `Gemini Nano: ${deviceState}`;
  const btn = $("downloadBtn");
  btn.hidden = true;
  if (deviceState === "downloadable" || deviceState === "downloading") {
    downloadTarget = "text";
    btn.hidden = false;
    btn.textContent = deviceState === "downloading" ? "Show download progress" : "Download offline AI";
  } else if (deviceState === "available") {
    if (deviceImageState === "available") text = "Gemini Nano is ready, photos too";
    else if (deviceImageState === "downloadable" || deviceImageState === "downloading") {
      downloadTarget = "image";
      btn.hidden = !navigator.onLine;
      btn.textContent = deviceImageState === "downloading" ? "Show photo support progress" : "Download photo support";
      text = "Gemini Nano is ready (photos need a small extra download)";
    } else {
      text = "Gemini Nano is ready (text only on this device)";
    }
  }
  $("deviceChip").textContent = text;
  renderRouting();
  if (deviceState === "available") warmUpDevice();
}

// Load Gemini Nano into memory in the background, so the first offline answer starts quickly.
let warmSession = null;
function warmUpDevice() {
  if (warmSession || !("LanguageModel" in self)) return;
  const idle = self.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => {
    warmSession = LanguageModel.create({
      expectedInputs: [{ type: "text", languages: ["en"] }],
      expectedOutputs: [{ type: "text", languages: ["en"] }],
    }).catch(() => { warmSession = null; });
  });
}

$("downloadBtn").addEventListener("click", async () => {
  const forImages = downloadTarget === "image";
  const label = forImages ? "photo support" : "Gemini Nano";
  $("downloadBtn").hidden = true;
  $("progressWrap").hidden = false;
  $("deviceChip").textContent = `Downloading ${label}. Keep this tab open.`;
  try {
    await (forImages ? imageModels : models)[InferenceMode.PREFER_ON_DEVICE].initializeDeviceModel((p) => {
      const pct = Math.round(p * 100);
      $("progressBar").style.width = `${pct}%`;
      $("deviceChip").textContent = `Downloading ${label}: ${pct}%`;
    });
  } catch (e) {
    $("deviceChip").textContent = `Download stopped: ${e.message}`;
  }
  $("progressWrap").hidden = true;
  checkDevice();
});
addEventListener("online", checkDevice);

/* =========================================================
   Sidebar: projects + chats, views, mobile drawer
   ========================================================= */
const app = $("app");
const openSide = () => { app.classList.add("side-open"); $("scrim").hidden = false; };
const closeSide = () => { app.classList.remove("side-open"); $("scrim").hidden = true; };
$("openSide").addEventListener("click", openSide);
$("closeSide").addEventListener("click", closeSide);
$("scrim").addEventListener("click", closeSide);
addEventListener("keydown", (e) => { if (e.key === "Escape") closeSide(); });

function setView(v) {
  view = v;
  for (const id of ["chat", "schedule", "photo", "way", "docs", "voice"]) {
    const el = $(`view-${id}`);
    const show = id === v;
    if (show && el.hidden) { el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); }
    el.hidden = !show;
  }
  document.querySelectorAll(".nav-item").forEach((b) => b.toggleAttribute("aria-current", b.dataset.view === v));
  document.querySelectorAll(".nav-item[aria-current]").forEach((b) => b.setAttribute("aria-current", "page"));
  renderTop();
  renderSidebar();
  closeSide();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

function renderTop() {
  const titles = { schedule: "Study schedule", photo: "Photo cleaner", way: "Find my way back", docs: "Document AI", voice: "Voice" };
  const chat = currentChat();
  $("viewTitle").textContent = view === "chat" ? (chat ? chat.title : "New chat") : titles[view];
  const sel = $("chatProject");
  sel.hidden = !(view === "chat" && chat);
  if (!sel.hidden) {
    sel.innerHTML = `<option value="">No project</option>` + projects.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    sel.value = chat.projectId || "";
  }
}
$("chatProject").addEventListener("change", (e) => {
  const chat = currentChat();
  if (!chat) return;
  chat.projectId = e.target.value || null;
  persistChats();
  renderSidebar();
});

function renderSidebar() {
  $("projectList").innerHTML =
    `<li><button type="button" data-project="" ${projectFilter === null ? 'aria-current="true"' : ""}><span class="dot"></span><span class="label">All chats</span></button></li>` +
    projects.map((p) => {
      const n = chats.filter((c) => c.projectId === p.id).length;
      return `<li><button type="button" data-project="${p.id}" ${projectFilter === p.id ? 'aria-current="true"' : ""}><span class="dot" style="background:${p.color}"></span><span class="label">${escapeHtml(p.name)}</span><span class="meta">${n}</span></button><button class="del" type="button" data-del-project="${p.id}" aria-label="Delete project ${escapeHtml(p.name)}">✕</button></li>`;
    }).join("");

  const list = chats
    .filter((c) => projectFilter === null || c.projectId === projectFilter)
    .sort((a, b) => b.updated - a.updated);
  $("chatsHead").textContent = projectFilter ? `Chats in ${projects.find((p) => p.id === projectFilter)?.name || "project"}` : "Recent chats";
  $("chatList").innerHTML = list.length
    ? list.map((c) => `<li><button type="button" data-chat="${c.id}" ${view === "chat" && c.id === currentId ? 'aria-current="true"' : ""}><span class="label">${escapeHtml(c.title)}</span></button><button class="del" type="button" data-del-chat="${c.id}" aria-label="Delete chat">✕</button></li>`).join("")
    : `<li class="meta" style="padding:4px 10px">No chats yet.</li>`;
}

$("projectList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del-project]");
  if (del) {
    const id = del.dataset.delProject;
    projects = projects.filter((p) => p.id !== id);
    chats.forEach((c) => { if (c.projectId === id) c.projectId = null; });
    if (projectFilter === id) projectFilter = null;
    persistProjects(); persistChats(); renderSidebar(); renderTop(); schedule.render();
    return;
  }
  const b = e.target.closest("[data-project]");
  if (b) { projectFilter = b.dataset.project || null; renderSidebar(); }
});
$("chatList").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del-chat]");
  if (del) {
    chats = chats.filter((c) => c.id !== del.dataset.delChat);
    if (currentId === del.dataset.delChat) currentId = null;
    persistChats(); renderSidebar(); renderChat();
    return;
  }
  const b = e.target.closest("[data-chat]");
  if (b) { currentId = b.dataset.chat; setView("chat"); renderChat(); }
});

const PROJECT_COLORS = ["#2f67d8", "#0f8f68", "#b98200", "#c2392b", "#7a4fd0", "#0e8aa0"];
$("addProjectBtn").addEventListener("click", () => {
  $("projectForm").hidden = !$("projectForm").hidden;
  if (!$("projectForm").hidden) $("projectName").focus();
});
$("projectForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("projectName").value.trim();
  if (!name) return;
  const p = { id: uid(), name, color: PROJECT_COLORS[projects.length % PROJECT_COLORS.length] };
  projects.push(p);
  persistProjects();
  $("projectName").value = "";
  $("projectForm").hidden = true;
  projectFilter = p.id;
  renderSidebar(); renderTop(); schedule.render();
});

$("newChatBtn").addEventListener("click", () => {
  currentId = null;
  setView("chat");
  renderChat();
  $("input").focus();
});

/* =========================================================
   Chat rendering
   ========================================================= */
// Turn simple LaTeX the model sometimes writes into plain symbols.
function plainMath(t) {
  const sym = { times: "×", div: "÷", Omega: "Ω", omega: "ω", pi: "π", theta: "θ", alpha: "α", beta: "β", gamma: "γ",
    lambda: "λ", mu: "μ", Delta: "Δ", delta: "δ", sigma: "σ", rho: "ρ", cdot: "·", pm: "±", le: "≤", ge: "≥",
    leq: "≤", geq: "≥", neq: "≠", approx: "≈", infty: "∞", rightarrow: "→", to: "→", degree: "°", circ: "°" };
  return t
    .replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, (m, a, b) => `${/^\w+$/.test(a) ? a : `(${a})`}/${/^\w+$/.test(b) ? b : `(${b})`}`)
    .replace(/\\sqrt\{([^{}]*)\}/g, "√($1)")
    .replace(/\\(?:text|mathrm|mathbf)\{([^{}]*)\}/g, "$1")
    .replace(/\\([a-zA-Z]+)/g, (m, w) => sym[w] ?? w)
    .replace(/\^\{([^{}]*)\}/g, "^$1").replace(/_\{([^{}]*)\}/g, "$1")
    .replace(/\$\$?([^$]+)\$\$?/g, "$1");
}

function formatText(t) {
  const lines = escapeHtml(plainMath(t)).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").split("\n");
  let html = "", inList = false;
  for (const line of lines) {
    const bullet = /^\s*[-*•]\s+/.test(line);
    if (bullet && !inList) { html += "<ul>"; inList = true; }
    if (!bullet && inList) { html += "</ul>"; inList = false; }
    if (bullet) html += `<li>${line.replace(/^\s*[-*•]\s+/, "")}</li>`;
    else if (line.trim()) html += `<p>${line}</p>`;
  }
  return html + (inList ? "</ul>" : "");
}

function renderMessage(m) {
  const el = document.createElement("div");
  if (m.role === "user") {
    el.className = "msg-user";
    if (m.image) {
      const img = document.createElement("img");
      img.src = m.image; img.alt = "Photo you sent";
      el.append(img);
    }
    el.append(document.createTextNode(m.text || (m.image ? "" : "")));
    if (m.task && m.task !== "ask") {
      const tag = document.createElement("span");
      tag.className = "tag"; tag.textContent = TASKS[m.task].label;
      el.append(tag);
    }
    return el;
  }
  el.className = "msg-ai";
  el.dataset.src = m.src;
  const label = { device: "On this device", cloud: "Cloud", error: "Didn't go through", pending: "Thinking" }[m.src];
  const bits = [`<span class="pill">${label}${m.secs ? `, ${m.secs} s` : ""}</span>`];
  if (m.net) bits.push(`<span>${escapeHtml(m.net)}</span>`);
  if (canSpeak && (m.src === "device" || m.src === "cloud")) bits.push(`<button class="speak-btn" type="button">Read aloud</button>`);
  el.innerHTML = `<div class="stamp">${bits.join("")}</div><div class="body"></div>`;
  if (m.image) {
    const fig = document.createElement("figure");
    fig.className = "ai-image";
    const img = document.createElement("img");
    img.src = m.imageFull || m.image; img.alt = "Cleaned-up photo";
    const save = document.createElement("a");
    save.className = "link-btn"; save.textContent = "Save photo";
    save.href = m.imageFull || m.image; save.download = "universal-ai-photo.jpg";
    fig.append(img, save);
    el.append(fig);
  }
  const body = el.querySelector(".body");
  if (m.src === "error") body.textContent = m.text;
  else body.innerHTML = formatText(m.text || "");
  el.querySelector(".speak-btn")?.addEventListener("click", (e) => {
    const btn = e.currentTarget;
    if (btn.dataset.on) { stopSpeaking(); btn.textContent = "Read aloud"; delete btn.dataset.on; return; }
    btn.dataset.on = "1"; btn.textContent = "Stop reading";
    speak(m.text, () => { btn.textContent = "Read aloud"; delete btn.dataset.on; });
  });
  return el;
}

function renderChat() {
  const chat = currentChat();
  const thread = $("thread");
  thread.innerHTML = "";
  $("welcome").hidden = Boolean(chat && chat.messages.length);
  if (chat) chat.messages.forEach((m) => thread.append(renderMessage(m)));
  renderRecent();
  renderTop();
  renderSidebar();
  if (chat && chat.messages.length) scrollToEnd(); else $("chatScroller").scrollTop = 0;
}
const scrollToEnd = () => { const s = $("chatScroller"); s.scrollTop = s.scrollHeight; };

/* =========================================================
   Composer: text, photo, voice
   ========================================================= */
const input = $("input");
const autosize = () => { input.style.height = "auto"; input.style.height = Math.min(220, input.scrollHeight) + "px"; };
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("sendBtn").addEventListener("click", send);

let attached = null; // { canvas, enhanced:boolean }
function showAttachment() {
  $("attachment").hidden = !attached;
  if (!attached) return;
  $("attachThumb").src = thumbnail(attached.canvas, 160);
  $("attachNote").textContent = attached.enhanced ? "Photo attached (cleaned up)" : "Photo attached";
  $("attachEnhance").hidden = attached.enhanced;
}
async function attachFile(file) {
  try {
    const img = await fileToImage(file);
    attached = { canvas: drawScaled(img, document.createElement("canvas")), enhanced: false };
    showAttachment();
    if (!input.value.trim()) input.placeholder = "What should I do with this photo? e.g. Explain this page";
    input.focus();
  } catch (e) {
    hint(e.message);
  }
}
$("photoBtn").addEventListener("click", () => $("photoInput").click());
$("photoInput").addEventListener("change", (e) => { if (e.target.files[0]) attachFile(e.target.files[0]); e.target.value = ""; });
$("attachRemove").addEventListener("click", () => { attached = null; showAttachment(); input.placeholder = "Ask a doubt, paste notes, or ask a follow-up"; });
$("attachEnhance").addEventListener("click", () => {
  if (!attached) return;
  attached = { canvas: enhance(attached.canvas, document.createElement("canvas"), "scan", 60), enhanced: true };
  showAttachment();
});
// Paste a screenshot straight into the box.
input.addEventListener("paste", (e) => {
  const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith("image/"));
  if (file) { e.preventDefault(); attachFile(file); }
});

let hintTimer;
function hint(msg) {
  const h = $("composerHint");
  h.textContent = msg;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (h.textContent = "Enter sends, Shift + Enter adds a new line."), 7000);
}

const mic = $("micBtn");
if (!canListen) mic.title = "Voice input isn't supported in this browser";
mic.addEventListener("click", async () => {
  if (mic.getAttribute("aria-pressed") === "true") { stopListening(); return; }
  const before = input.value ? input.value.trimEnd() + " " : "";
  try {
    mic.setAttribute("aria-pressed", "true");
    hint("Listening… speak your question.");
    await listen({
      onText: (t) => { input.value = before + t; autosize(); },
      onEnd: () => { mic.setAttribute("aria-pressed", "false"); hint("Check the text, then press Enter to send."); },
      onError: (msg) => { mic.setAttribute("aria-pressed", "false"); hint(msg); },
    });
  } catch (e) {
    mic.setAttribute("aria-pressed", "false");
    hint(e.message);
  }
});

/* =========================================================
   Sending
   ========================================================= */
function runTrain(route) {
  const wrap = $("trackWrap");
  wrap.dataset.route = route;
  wrap.classList.add("running");
  try { $(route === "device" ? "runDevice" : "runCloud").beginElement(); } catch {}
  setTimeout(() => wrap.classList.remove("running"), 1200);
}

// Turn earlier messages into model "contents". Smaller window for the on-device model.
function buildContents(history, newParts, onDevice) {
  const maxMsgs = onDevice ? 6 : 20;
  const maxChars = onDevice ? 1200 : 6000;
  const turns = history
    .filter((m) => m.role === "user" || m.src === "device" || m.src === "cloud")
    .slice(-maxMsgs)
    .map((m) => ({ role: m.role === "user" ? "user" : "model", text: String(m.role === "user" ? m.prompt || m.text : m.text).slice(0, maxChars) }));
  // Merge back-to-back turns from the same side, and start with the user.
  const merged = [];
  for (const t of turns) {
    if (merged.length && merged.at(-1).role === t.role) merged.at(-1).text += "\n\n" + t.text;
    else merged.push({ ...t });
  }
  while (merged.length && merged[0].role !== "user") merged.shift();
  if (merged.length && merged.at(-1).role === "user") merged.pop(); // the new message replaces a dangling one
  if (onDevice && merged.length) {
    // Chrome's on-device model is strict about message roles, so give it the earlier
    // conversation as plain text inside one message instead.
    const transcript = merged.map((t) => `${t.role === "user" ? "Student" : "You"}: ${t.text}`).join("\n\n");
    const [first, ...rest] = newParts;
    return [{ role: "user", parts: [{ text: `Conversation so far:\n${transcript}\n\nStudent's new message: ${first.text}` }, ...rest] }];
  }
  return [...merged.map((t) => ({ role: t.role, parts: [{ text: t.text }] })), { role: "user", parts: newParts }];
}

async function streamWithTimeout(model, request, onText, firstTokenMs = 20000) {
  const timeout = () => new Promise((r) => setTimeout(() => r(null), firstTokenMs));
  const result = await Promise.race([model.generateContentStream(request), timeout()]);
  if (!result) return null;
  const it = result.stream[Symbol.asyncIterator]();
  const first = await Promise.race([it.next(), timeout()]);
  if (!first) return null;
  let out = "", step = first;
  while (!step.done) { out += step.value.text(); onText(out); step = await it.next(); }
  return { out, response: await result.response };
}

/* ---------- Photo edits from chat ---------- */
// The latest photo in each chat, kept at full size while the app is open.
const chatImages = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(drawScaled(img, document.createElement("canvas"), 1600));
    img.onerror = () => reject(new Error("Couldn't load that photo."));
    img.src = src;
  });
}

async function latestChatImage(chat) {
  if (!chat) return null;
  if (chatImages.has(chat.id)) return chatImages.get(chat.id);
  const m = [...chat.messages].reverse().find((x) => x.imageFull || x.image);
  return m ? loadImage(m.imageFull || m.image) : null;
}

function wantsEnhance(text) {
  return /\b(enhance|clean(\s*up)?|brighten|improve|clearer|make (it|this) (clear|readable|better|brighter)|fix (the |this )?(photo|image|pic|picture))\b/i.test(text);
}
function wantsUpscale(text) {
  return /\b(upscale|up-scale|enlarge|super.?res(olution)?|(higher|increase|more|better) (the )?(resolution|res)|bigger|larger|hd|4k|[24] ?x|[24] ?times|double the size)\b/i.test(text);
}
function wantsSharpen(text) {
  return /\b(sharpen|sharper|sharp|deblur|de-blur|unblur|blurry|blurred|out of focus|crisp|crisper|shaky|shaken)\b/i.test(text) ||
    /\b(remove|reduce|fix|clear|less)\b.{0,15}\bblur/i.test(text);
}
function wantsBackground(text) {
  return /\b(remove|erase|delete|cut|get rid of|hide|clear)\b.{0,30}\b(background|backdrop|bg|crowd|people|audience|fans|behind|surroundings?)\b/i.test(text) ||
    /\b(white|plain|transparent|blur(red|ry)?|black|blue|green|red|grey|gray)\s+(background|bg|screen|backdrop)\b/i.test(text) ||
    /\bbackground\b.{0,15}\b(white|transparent|blur|plain|black)\b/i.test(text) || /\bcut\s?out\b/i.test(text);
}
function wantsCloudEdit(text) {
  if (/^\s*(what|who|why|how|when|where|which|explain|describe|tell|is|are|can you see|identify)\b/i.test(text)) return false;
  return /\b(add|put|change|replace|turn|make|edit|draw|colou?r|remove|erase|swap|convert|give (him|her|it|them))\b/i.test(text);
}
// Without a new photo, only treat a message as an edit if the chat was just about a photo
// and the message talks about the picture (so "make it simpler" stays a normal question).
function isPhotoFollowUp(text) {
  const chat = currentChat();
  if (!chat) return false;
  const recent = chat.messages.slice(-2);
  if (!recent.some((m) => m.image)) return false;
  return /\b(photo|image|pic|picture|him|her|them|background|crowd|people|face|colou?r|bright|dark)\b/i.test(text) || wantsBackground(text) || wantsEnhance(text) || wantsUpscale(text) || wantsSharpen(text);
}

function photoEditKind(text) {
  if (wantsBackground(text)) return "background";
  if (wantsUpscale(text)) return "upscale";
  if (wantsSharpen(text)) return "sharpen";
  if (wantsEnhance(text)) return "enhance";
  if (wantsCloudEdit(text)) return "cloud";
  return null;
}

function canvasFrom(src) {
  if (src instanceof HTMLCanvasElement) return src;
  const c = document.createElement("canvas");
  c.width = src.naturalWidth || src.width; c.height = src.naturalHeight || src.height;
  c.getContext("2d").drawImage(src, 0, 0);
  return c;
}

async function editPhotoInChat(kind, text, source, fromAttachment) {
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: (text || "Photo").slice(0, 48), projectId: projectFilter, updated: Date.now(), messages: [] };
    chats.unshift(chat);
    currentId = chat.id;
  }
  chat.messages.push({ role: "user", text, prompt: text, task: "ask", at: Date.now(), image: fromAttachment ? thumbnail(source) : undefined });
  const aiMsg = { role: "model", src: "pending", text: kind === "cloud" ? "Editing your photo with the cloud AI…" : "Working on your photo on this device…", at: Date.now() };
  chat.messages.push(aiMsg);
  input.value = ""; autosize();
  attached = null; showAttachment();
  input.placeholder = "Ask a follow-up, or ask for another edit";
  renderChat();
  runTrain(kind === "cloud" ? "cloud" : "device");
  busy = true; $("sendBtn").disabled = true;
  const start = performance.now();
  try {
    let out, note = "", transparent = false;
    if (kind === "upscale") {
      const { upscale } = await import("./superres.js");
      const scale = /\b(4 ?x|4 ?times|four|4k|max(imum)?)\b/i.test(text) ? 4 : 2;
      const crisp = /\b(crisp|sharp|sharpest|maximum detail)\b/i.test(text);
      let last = 0;
      out = await upscale(source, scale, {
        detail: crisp ? "crisp" : "balanced",
        onProgress: (p) => { if (p - last >= 0.1 || p === 1) { last = p; aiMsg.text = `Upscaling ${scale}x on this device… ${Math.round(p * 100)}%`; renderChat(); } },
      });
      note = `Here's a ${scale}x bigger version (${out.width} × ${out.height} pixels), upscaled with Real-ESRGAN on your device, so it works without internet.`;
      if (out.reducedFirst) note += " The photo was very large, so I first reduced it to a size this device can handle.";
      note += crisp ? " I used the crispest setting; ask for \"balanced\" if textures look too smooth." : " Ask for \"crisp\" if you want an even sharper look.";
    } else if (kind === "sharpen") {
      const { removeBlurInBackground, sharpness } = await import("./superres.js");
      aiMsg.text = "Measuring the blur and removing it on this device…"; renderChat();
      const res = await removeBlurInBackground(source);
      out = res.canvas;
      // Faces: rebuild them with the face restorer (much sharper eyes, teeth and hair).
      let faceNote = "";
      if (res.kind !== "sharp" && !/\b(no|without|don'?t)\b.{0,12}\bface/i.test(text)) {
        try {
          const fr = await import("./facerestore.js");
          const saved = await fr.isFaceModelSaved();
          if (!saved && !navigator.onLine) faceNote = " Faces can look much sharper with the face restorer, but it needs internet once to download (74 MB).";
          else {
            // The face finder works on the original (sharp-looking blur, no edits), sized like the result.
            const original = document.createElement("canvas");
            original.width = out.width; original.height = out.height;
            original.getContext("2d").drawImage(source, 0, 0, out.width, out.height);
            const faceStart = performance.now();
            var faceTimer = setInterval(() => { // eslint-disable-line no-var
              if (/^Downloading/.test(aiMsg.text) && !/100%$/.test(aiMsg.text)) return;
              aiMsg.text = `Rebuilding the face on this device… ${Math.round((performance.now() - faceStart) / 1000)} s (the first time can take up to a minute)`;
              renderChat();
            }, 1000);
            const fixed = await fr.restoreFaces(original, out, {
              onProgress: ({ stage, p }) => {
                if (stage === "download") { aiMsg.text = `Downloading the face restorer, one time only (74 MB)… ${Math.round(p * 100)}%`; renderChat(); }
              },
            });
            clearInterval(faceTimer);
            if (fixed.timedOut) faceNote = " I tried to rebuild the face too, but this device's graphics chip was too slow, so I skipped it. Next time I'll use the processor instead, which takes about half a minute.";
            else if (fixed.faces) faceNote = ` I also rebuilt ${fixed.faces === 1 ? "the face" : `${fixed.faces} faces`} with an AI face restorer (on your ${fixed.backend}, ${(fixed.ms / 1000).toFixed(0)} s). It redraws faces from what it learned about faces, so it looks sharp and natural, but tiny details can differ slightly from the real person.`;
          }
        } catch (e) { clearInterval(faceTimer); console.warn("Face restorer unavailable", e); }
      }
      const before = sharpness(canvasFrom(source)), after = sharpness(out);
      const gain = Math.round((after / before - 1) * 100);
      if (res.kind === "focus") {
        note = `This photo was out of focus (blur size about ${res.sigma.toFixed(1)} pixels). I measured the blur and reversed it, so edges are about ${gain}% crisper. Done on your device, so it works without internet.`;
      } else if (res.kind === "heavy") {
        note = `This photo is very blurred (blur size about ${res.sigma.toFixed(1)} pixels). Reversing that much blur directly creates halos, so I rebuilt the photo with the AI upscaler instead: edges are cleaner, but detail that the blur fully erased (like eyelashes or fine text) can't be brought back. Done on your device.`;
      } else if (res.kind === "shake") {
        note = `This photo looks blurred by a shaky hand (blur in one direction). Reversing shake from a single photo isn't reliable yet, so I only sharpened it gently (edges about ${gain}% crisper). For shaky photos, retaking it is the best fix.`;
      } else if (res.kind === "light") {
        note = `This photo was only slightly soft, so I sharpened it gently: edges are about ${gain}% crisper. I left flat areas alone so noise doesn't get worse. Done on your device.`;
      } else {
        note = "This photo is already sharp, so I left it unchanged: sharpening it more would only add noise and halos. If it looks small or pixelated, ask me to upscale it instead.";
      }
      note += faceNote;
    } else if (kind === "enhance") {
      const isDoc = /\b(note|notes|page|document|book|textbook|handwrit|scan|board|paper)\b/i.test(text);
      out = enhance(source, document.createElement("canvas"), isDoc ? "scan" : "color", /\b(more|strong|extra|a lot|very)\b/i.test(text) ? 85 : 60);
      note = isDoc
        ? "Here's a cleaned-up scan: shadows removed, black-and-white, sharper text. Done on your device, so it works without internet."
        : "Here's a brighter, sharper version. Done on your device, so it works without internet.";
    } else if (kind === "background") {
      const { replaceBackground, backgroundFromText } = await import("./segment.js");
      const bg = backgroundFromText(text);
      transparent = bg === "transparent";
      // Professional engine first (MODNet matting + edge refinement + checks); the simpler engine if it can't load.
      let engineNote = "";
      try {
        const { removeBackground } = await import("./matting.js");
        const crowd = /\b(crowd|people|others|everyone else|strangers)\b/i.test(text);
        const res = await removeBackground(source, { background: bg === "white" ? "#ffffff" : bg, mainOnly: crowd, maxSide: 2048 });
        out = res.canvas;
        if (res.report.fixes.length) engineNote = ` Checks: ${res.report.fixes.join("; ")}.`;
      } catch (err) {
        console.warn("Matting engine unavailable, using the simple one:", err);
        out = await replaceBackground(source, bg);
      }
      note = bg === "blur" ? "I blurred the background and kept the main person sharp."
        : transparent ? "I removed the background. The saved photo is a PNG with a see-through background."
        : "I removed the background and the crowd and kept the main person.";
      note += " Done on your device, so it works without internet." + engineNote;
    } else {
      if (!navigator.onLine) throw new Error("Edits like this need the cloud AI, and there's no signal. Offline I can still remove the background or clean up the photo.");
      const part = canvasToPart(source, 1280, 0.9);
      const res = await editImageInCloud(part.data, text);
      out = await loadImage(`data:${res.mimeType};base64,${res.data}`);
      note = res.note?.trim() || "Here's your edited photo.";
    }
    chatImages.set(chat.id, out);
    Object.assign(aiMsg, {
      src: kind === "cloud" ? "cloud" : "device",
      text: note,
      secs: ((performance.now() - start) / 1000).toFixed(1),
      net: getNetwork().label,
      image: thumbnail(out, 480),
      imageFull: transparent ? out.toDataURL("image/png") : out.toDataURL("image/jpeg", 0.9),
    });
  } catch (e) {
    console.error(e);
    let msg = String(e?.message || e);
    if (/dynamically imported module|Failed to fetch|NetworkError/i.test(msg) && !navigator.onLine)
      msg = "This photo tool hasn't finished saving for offline use yet. Open the app once with internet and wait a minute, then it will work without signal.";
    Object.assign(aiMsg, {
      src: "error",
      text: /quota|billing|permission|not found|404|429|403/i.test(msg) && kind === "cloud"
        ? `The cloud photo editor isn't available on this project's free plan right now. I can still remove backgrounds and clean up photos on your device. (${msg})`
        : msg,
    });
  } finally {
    chat.updated = Date.now();
    persistChats();
    renderChat();
    busy = false; $("sendBtn").disabled = false;
    releasePhotoAIs();
  }
}

// Photo AIs use a lot of memory; on an 8 GB laptop that can stop Gemini Nano from starting.
// Free them after each photo job (they reload from the saved copies, so offline still works).
function releasePhotoAIs() {
  setTimeout(() => {
    import("./facerestore.js").then((m) => m.releaseFaceRestorer()).catch(() => {});
    import("./superres.js").then((m) => m.releaseUpscaler()).catch(() => {});
    import("./matting.js").then((m) => m.releaseMatting()).catch(() => {});
  }, 500);
}

let busy = false;
async function send() {
  if (busy) return;
  const text = input.value.trim();
  if (!text && !attached) return input.focus();
  const task = $("task").value;
  const hasImage = Boolean(attached);
  busy = true;
  // Chrome can report the model as not ready for a moment after it starts; check again.
  if (deviceState !== "available") await checkDevice();
  busy = false;
  // Photo edits: on the attached photo, or the latest photo in this chat.
  const kind = text ? photoEditKind(text) : null;
  if (kind && hasImage) return editPhotoInChat(kind, text, attached.canvas, true);
  if (kind && !hasImage && isPhotoFollowUp(text)) {
    const source = await latestChatImage(currentChat());
    if (source) return editPhotoInChat(kind, text, source, false);
  }
  if (hasImage && !navigator.onLine && deviceImageState !== "available") {
    hint(deviceImageState === "downloadable" || deviceImageState === "downloading"
      ? "Reading photos offline needs photo support. Connect to Wi-Fi and tap “Download photo support” under On this device."
      : "This device's offline AI can't read photos. Ask about the photo when you have signal.");
    return;
  }
  let mode = chooseMode(hasImage);
  // No signal: don't waste time trying the cloud first.
  if (!navigator.onLine && mode !== InferenceMode.ONLY_IN_CLOUD) mode = InferenceMode.ONLY_ON_DEVICE;
  const route = expectedRoute(mode, hasImage);
  const net = getNetwork();
  const set = hasImage ? imageModels : models;

  // Create the chat on first message.
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: (text || "Photo question").slice(0, 48), projectId: projectFilter, updated: Date.now(), messages: [] };
    chats.unshift(chat);
    currentId = chat.id;
  }
  const history = chat.messages.slice();
  const prompt = TASKS[task].wrap(text || "Explain what is in this photo, step by step, for a student.");
  const part = hasImage ? canvasToPart(attached.canvas) : null;
  if (hasImage) chatImages.set(chat.id, attached.canvas);
  const userMsg = { role: "user", text, prompt, task, at: Date.now(), image: hasImage ? thumbnail(attached.canvas) : undefined };
  chat.messages.push(userMsg);
  const aiMsg = { role: "model", src: "pending", text: "", at: Date.now() };
  chat.messages.push(aiMsg);

  input.value = ""; autosize();
  attached = null; showAttachment();
  input.placeholder = "Ask a follow-up";
  renderChat();
  runTrain(route);
  busy = true; $("sendBtn").disabled = true;

  const aiEl = $("thread").lastElementChild;
  const paint = (t) => { aiEl.querySelector(".body").innerHTML = formatText(t); scrollToEnd(); };
  const newParts = part ? [{ text: prompt }, { inlineData: { mimeType: part.mimeType, data: part.data } }] : [{ text: prompt }];

  const start = performance.now();
  try {
    // Gemini Nano can take a while to load into memory the first time; tell the person.
    const slowNote = setTimeout(() => { const p = aiEl.querySelector(".pill"); if (p && aiMsg.src === "pending") p.textContent = "Starting the offline AI, this can take up to a minute the first time"; }, 6000);
    let res;
    try {
      res = await streamWithTimeout(set[mode], { contents: buildContents(history, newParts, route === "device") }, paint, route === "device" ? 75000 : 20000);
    } catch (err) {
      // The offline AI couldn't start (for example, not enough free memory). If there's signal, use the cloud.
      if (route !== "device" || !navigator.onLine) throw err;
      console.warn("On-device AI failed, using the cloud:", err);
      aiEl.querySelector(".pill").textContent = "Offline AI busy, using cloud";
      res = await streamWithTimeout(set[InferenceMode.ONLY_IN_CLOUD], { contents: buildContents(history, newParts, false) }, paint, 60000);
      if (!res) throw err;
    }
    clearTimeout(slowNote);
    if (!res) {
      if (!navigator.onLine || mode === "only_on_device") throw new Error("The on-device AI took too long to start.");
      aiEl.querySelector(".pill").textContent = "Switching to cloud";
      res = await streamWithTimeout(set[InferenceMode.ONLY_IN_CLOUD], { contents: buildContents(history, newParts, false) }, paint, 60000);
      if (!res) throw new Error("The cloud AI didn't respond in time.");
    }
    Object.assign(aiMsg, {
      text: res.out,
      src: res.response.inferenceSource === "on_device" ? "device" : "cloud",
      secs: ((performance.now() - start) / 1000).toFixed(1),
      net: net.label,
      at: Date.now(),
    });
    $("trackWrap").dataset.route = aiMsg.src;
  } catch (e) {
    console.error(e);
    Object.assign(aiMsg, { src: "error", text: explainError(e, hasImage) });
  } finally {
    chat.updated = Date.now();
    persistChats();
    aiEl.replaceWith(renderMessage(aiMsg));
    renderSidebar(); renderTop(); scrollToEnd();
    busy = false; $("sendBtn").disabled = false;
  }
}

function explainError(e, hasImage) {
  const msg = String(e?.message || e);
  const status = `Offline AI status: ${DEVICE_TEXT[deviceState] || deviceState}.`;
  if (hasImage && !navigator.onLine && deviceImageState !== "available")
    return `The offline AI on this device can't read photos, and there's no signal for the cloud. Try again when you're online. (${status})`;
  if (!navigator.onLine && deviceState !== "available")
    return `There's no signal and the offline AI isn't ready on this device. ${status} Connect to Wi-Fi, open the app, and check that “On this device” says Gemini Nano is ready.`;
  if (!navigator.onLine)
    return `The offline AI couldn't answer. ${status} Details: ${msg}`;
  if (/app.?check|PERMISSION|403/i.test(msg))
    return "The cloud AI blocked this request because the app couldn't verify itself. Reload the page and try again.";
  return `The answer couldn't be loaded. Check your connection and try again. (${msg})`;
}

/* =========================================================
   Photo cleaner page
   ========================================================= */
let enhSource = null;
function runEnhance() {
  if (!enhSource) return;
  enhance(enhSource, $("enhAfter"), $("enhMode").value, Number($("enhStrength").value));
}
$("enhPick").addEventListener("click", () => $("enhInput").click());
$("enhInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const img = await fileToImage(file);
    enhSource = drawScaled(img, $("enhBefore"), 1600);
    $("enhStage").hidden = false;
    $("enhActions").hidden = false;
    runEnhance();
  } catch (err) {
    alertLead(err.message);
  }
});
$("enhMode").addEventListener("change", runEnhance);
$("enhStrength").addEventListener("input", runEnhance);
$("enhSave").addEventListener("click", () => {
  const a = document.createElement("a");
  a.download = "universal-ai-clean-photo.jpg";
  a.href = $("enhAfter").toDataURL("image/jpeg", 0.92);
  a.click();
});
$("enhAsk").addEventListener("click", () => {
  const c = document.createElement("canvas");
  c.width = $("enhAfter").width; c.height = $("enhAfter").height;
  c.getContext("2d").drawImage($("enhAfter"), 0, 0);
  attached = { canvas: c, enhanced: true };
  currentId = null;
  setView("chat"); renderChat(); showAttachment();
  input.placeholder = "What should I do with this photo? e.g. Explain this page";
  input.focus();
});
function alertLead(msg) { document.querySelector("#view-photo .lead").textContent = msg; }

/* =========================================================
   Other tools
   ========================================================= */
initWayback();
$("safetyBtn").addEventListener("click", () => {
  currentId = null; setView("chat"); renderChat();
  input.value = "I'm lost and my phone has little or no signal. Give me short, practical safety steps to get back home in India.";
  autosize(); send();
});

const schedule = initSchedule({
  getProjects: () => projects,
  onPlanRequest: (text) => {
    currentId = null; setView("chat"); renderChat();
    input.value = text; autosize(); input.focus();
    input.setSelectionRange(text.length, text.length);
  },
});

/* =========================================================
   Install as an app + offline support
   ========================================================= */
let installEvent = null;
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; $("installBtn").hidden = false; });
$("installBtn").addEventListener("click", async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => {});
  installEvent = null; $("installBtn").hidden = true;
});
addEventListener("appinstalled", () => { $("installBtn").hidden = true; });
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("/sw.js").catch((e) => console.warn("Offline support unavailable:", e));
  // When the connection comes back, top up anything that isn't saved for offline use yet.
  // Save the background-remover model for offline use, quietly, when the connection is good.
  const warmMatting = () => {
    const c = navigator.connection;
    if (!navigator.onLine || c?.saveData || /2g/.test(c?.effectiveType || "")) return;
    (self.requestIdleCallback || setTimeout)(() => Promise.all([import("./matting.js").then((m) => m.prepareOffline()), import("./superres.js").then((m) => m.prepareUpscaler())]).catch(() => {}));
  };
  setTimeout(warmMatting, 20000);
  addEventListener("online", warmMatting);
  addEventListener("online", () => navigator.serviceWorker.controller?.postMessage("cache-heavy"));
  navigator.serviceWorker.ready.then(() => { if (navigator.onLine) navigator.serviceWorker.controller?.postMessage("cache-heavy"); });
}

/* =========================================================
   Start
   ========================================================= */
setView("chat");
renderChat();
renderRouting();
checkDevice();
setInterval(() => { if (deviceState === "downloadable" || deviceState === "downloading") checkDevice(); }, 30000);

/* =========================================================
   Top bar menus, dashboard, recent chats
   ========================================================= */
$("themeBtn").addEventListener("click", (e) => {
  const cur = getTheme();
  showMenu(e.currentTarget, [
    { label: "Day mode", icon: ICONS.sun, active: cur === "light", action: () => { setTheme("light"); toast("Day mode on"); } },
    { label: "Night mode", icon: ICONS.moon, active: cur === "dark", action: () => { setTheme("dark"); toast("Night mode on"); } },
    { label: "System default", hint: "Follows your device", icon: ICONS.system, active: cur === "system", action: () => { setTheme("system"); toast("Theme follows your device"); } },
  ], { title: "Theme" });
});

$("toolsBtn").addEventListener("click", (e) => {
  showMenu(e.currentTarget, [
    { label: "AI chat", hint: "New conversation", icon: ICONS.chat, action: () => { currentId = null; setView("chat"); renderChat(); input.focus(); } },
    { label: "Document AI", hint: "PDF, Word, Excel, PowerPoint", icon: ICONS.doc, action: () => setView("docs") },
    { label: "Photo cleaner", hint: "Works offline", icon: ICONS.photo, action: () => setView("photo") },
    { label: "Voice", hint: "Speak and listen", icon: ICONS.voice, action: () => setView("voice") },
    { label: "Find my way back", hint: "Map or compass", icon: ICONS.map, action: () => setView("way") },
    { label: "Study schedule", hint: "Plan and get reminders", icon: ICONS.cal, action: () => setView("schedule") },
  ], { title: "AI tools" });
});

document.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.go)));

function renderRecent() {
  const list = [...chats].sort((a, b) => b.updated - a.updated).slice(0, 4);
  $("recentWrap").hidden = list.length === 0;
  $("recentList").innerHTML = list.map((c) => {
    const last = [...c.messages].reverse().find((m) => m.role === "model" && m.text);
    return `<button class="recent-card" type="button" data-open="${c.id}"><strong>${escapeHtml(c.title)}</strong><span>${escapeHtml((last?.text || "").replace(/\*\*/g, "").slice(0, 90))}</span></button>`;
  }).join("");
}
$("recentList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (b) { currentId = b.dataset.open; renderChat(); }
});

/* =========================================================
   Shared helper: ask the AI one question (used by documents and voice)
   ========================================================= */
async function askOnce(prompt, onText, { forceDevice = false } = {}) {
  if (deviceState !== "available") await checkDevice();
  let mode = forceDevice ? InferenceMode.ONLY_ON_DEVICE : chooseMode(false);
  if (!navigator.onLine && mode !== InferenceMode.ONLY_IN_CLOUD) mode = InferenceMode.ONLY_ON_DEVICE;
  const start = performance.now();
  const onDevice = mode === InferenceMode.ONLY_ON_DEVICE || (mode === InferenceMode.PREFER_ON_DEVICE && deviceState === "available");
  let res = await streamWithTimeout(models[mode], prompt, onText, onDevice ? 75000 : 20000);
  if (!res) {
    if (!navigator.onLine) throw new Error("The on-device AI took too long to start.");
    res = await streamWithTimeout(models[InferenceMode.ONLY_IN_CLOUD], prompt, onText, 60000);
    if (!res) throw new Error("The AI didn't respond in time.");
  }
  return { out: res.out, src: res.response.inferenceSource === "on_device" ? "device" : "cloud", secs: ((performance.now() - start) / 1000).toFixed(1) };
}

// Will the next question run on the device? (Decides how much of a document we can send.)
function willUseDevice() {
  if (!navigator.onLine) return true;
  return expectedRoute(chooseMode(false), false) === "device";
}

/* =========================================================
   Document AI
   ========================================================= */
let doc = null; // { name, text, chunks }
const DOC_TASKS = {
  summary: { label: "Summary", prompt: "Summarize this document for a student in 6 to 8 short bullet points, then one line on what it is about overall." },
  keypoints: { label: "Key points", prompt: "List the most important facts, definitions and formulas from this document that are likely to come up in an exam, as short bullet points." },
  quiz: { label: "Quiz", prompt: "Write 5 multiple-choice questions (A-D) that test understanding of this document, then list the answers at the end." },
  translate: { label: "Hindi translation", prompt: "Translate this document into simple Hindi (Devanagari script). Keep the structure." },
  grammar: { label: "Grammar fixed", prompt: "Correct the grammar and spelling of this text. Return the corrected text, then a short list of the main changes." },
  tables: { label: "Tables", prompt: "Find any tables or table-like data in this document and rewrite each one as a clean table with | between columns and a header row. If there are none, say so." },
};

function openDocPicker() { $("docInput").click(); }
$("docDrop").addEventListener("click", openDocPicker);
$("docDrop").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDocPicker(); } });
$("docDrop").addEventListener("dragover", (e) => { e.preventDefault(); $("docDrop").classList.add("over"); });
$("docDrop").addEventListener("dragleave", () => $("docDrop").classList.remove("over"));
$("docDrop").addEventListener("drop", (e) => { e.preventDefault(); $("docDrop").classList.remove("over"); if (e.dataTransfer.files[0]) loadDoc(e.dataTransfer.files[0]); });
$("docInput").addEventListener("change", (e) => { if (e.target.files[0]) loadDoc(e.target.files[0]); e.target.value = ""; });
$("docClose").addEventListener("click", () => { doc = null; $("docCard").hidden = true; $("docDrop").hidden = false; });

async function loadDoc(file) {
  $("docDrop").classList.add("busy");
  $("docDrop").querySelector("strong").textContent = `Reading ${file.name}…`;
  try {
    const r = await readDocument(file, (p) => { $("docDrop").querySelector("strong").textContent = `Reading ${file.name}… ${Math.round(p * 100)}%`; });
    if (!r.text.trim() || r.scanned) throw new Error("I couldn't find any text in this file. If it's a scanned PDF, take a photo of the page and ask about it in the chat instead.");
    doc = { name: file.name, text: r.text };
    $("docName").textContent = file.name;
    const words = r.text.split(/\s+/).filter(Boolean).length;
    $("docMeta").textContent = `${r.meta}, about ${words.toLocaleString()} words`;
    $("docText").textContent = r.text.slice(0, 20000) + (r.text.length > 20000 ? "\n\n… (preview cut short)" : "");
    $("docCard").hidden = false;
    $("docDrop").hidden = true;
    $("docResult").hidden = true;
    toast(`Read ${file.name} on this device`, "success");
  } catch (e) {
    toast(e.message, "error", 6000);
  } finally {
    $("docDrop").classList.remove("busy");
    $("docDrop").querySelector("strong").textContent = "Choose a file or drop it here";
  }
}

let docBusy = false;
async function runDoc(task, question) {
  if (!doc || docBusy) return;
  docBusy = true;
  document.querySelectorAll("[data-doc], #docAsk button").forEach((b) => (b.disabled = true));
  const out = $("docOut"), badge = $("docBadge"), info = $("docInfo"), box = $("docResult");
  box.hidden = false; box.dataset.src = "pending";
  badge.textContent = "Working"; info.textContent = ""; out.innerHTML = "";
  const paint = (t) => { out.innerHTML = formatText(t); };
  const device = willUseDevice();
  try {
    let result;
    if (!device) {
      // Cloud: send the whole document (up to a generous limit).
      const body = doc.text.slice(0, 120000);
      const cut = doc.text.length > body.length ? "\n\n(The document was cut short because it is very long.)" : "";
      const ask = question ? `Answer this question using only the document below. If the answer isn't in it, say so.\nQuestion: ${question}` : DOC_TASKS[task].prompt;
      result = await askOnce(`${ask}\n\nDocument "${doc.name}":\n${body}${cut}`, paint);
    } else if (question) {
      // On-device model has a small memory: send only the most relevant parts.
      const parts = relevantChunks(chunkText(doc.text, 1100), question, 3);
      info.textContent = "Searched the file for the most relevant parts";
      result = await askOnce(`Answer using only these parts of "${doc.name}". If the answer isn't there, say so.\nQuestion: ${question}\n\n${parts.join("\n\n")}`, paint);
    } else {
      // Summarise piece by piece, then combine.
      const chunks = chunkText(doc.text, 2400);
      const used = chunks.slice(0, 8);
      const notes = [];
      const start = performance.now();
      for (const [i, c] of used.entries()) {
        info.textContent = `Reading part ${i + 1} of ${used.length} on this device`;
        const r = await askOnce(`Write the main points of this part of a document as 3 to 5 short bullet points.\n\n${c}`, () => {}, { forceDevice: true });
        notes.push(r.out);
      }
      info.textContent = "Putting it together";
      const final = await askOnce(`${DOC_TASKS[task].prompt}\n\nUse these notes taken from "${doc.name}":\n${notes.join("\n")}`, paint, { forceDevice: true });
      result = { ...final, secs: ((performance.now() - start) / 1000).toFixed(1) };
      if (chunks.length > used.length) info.textContent = `Used the first ${used.length} of ${chunks.length} parts. Connect to the internet to process the whole file.`;
      else info.textContent = "";
    }
    box.dataset.src = result.src;
    badge.textContent = `${result.src === "device" ? "On this device" : "Cloud"}, ${result.secs} s`;
    paint(result.out);
  } catch (e) {
    box.dataset.src = "error";
    badge.textContent = "Didn't go through";
    out.textContent = !navigator.onLine && deviceState !== "available"
      ? "There's no signal and the offline AI isn't ready on this device, so I can't read the file for you right now. You can still open it and read the text above."
      : `Something went wrong: ${e.message}`;
  } finally {
    docBusy = false;
    document.querySelectorAll("[data-doc], #docAsk button").forEach((b) => (b.disabled = false));
  }
}
document.querySelectorAll("[data-doc]").forEach((b) => b.addEventListener("click", () => runDoc(b.dataset.doc)));
$("docAsk").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("docQuestion").value.trim();
  if (q) runDoc("ask", q);
});

/* =========================================================
   Voice page
   ========================================================= */
const orb = $("orb");
orb.addEventListener("click", async () => {
  if (orb.getAttribute("aria-pressed") === "true") { stopListening(); return; }
  stopSpeaking();
  let heard = "";
  try {
    orb.setAttribute("aria-pressed", "true");
    $("orbState").textContent = "Listening…";
    $("orbHeard").textContent = "";
    await listen({
      onText: (t) => { heard = t; $("orbHeard").textContent = `“${t}”`; },
      onError: (msg) => { orb.setAttribute("aria-pressed", "false"); $("orbState").textContent = msg; },
      onEnd: async () => {
        orb.setAttribute("aria-pressed", "false");
        if (!heard.trim()) { $("orbState").textContent = "Tap to speak"; return; }
        $("orbState").textContent = "Thinking…";
        const box = $("voiceResult"); box.hidden = false; box.dataset.src = "pending";
        $("voiceBadge").textContent = "Thinking";
        try {
          const r = await askOnce(`${heard}\n\n(Answer in 3 to 5 short sentences that sound natural when read aloud. No bullet points.)`, (t) => { $("voiceOut").innerHTML = formatText(t); });
          box.dataset.src = r.src;
          $("voiceBadge").textContent = `${r.src === "device" ? "On this device" : "Cloud"}, ${r.secs} s`;
          $("orbState").textContent = "Speaking… tap the orb to ask again";
          speak(r.out, () => ($("orbState").textContent = "Tap to speak"));
        } catch (e) {
          box.dataset.src = "error"; $("voiceBadge").textContent = "Didn't go through";
          $("voiceOut").textContent = e.message;
          $("orbState").textContent = "Tap to speak";
        }
      },
    });
  } catch (e) {
    orb.setAttribute("aria-pressed", "false");
    $("orbState").textContent = e.message;
  }
});
if (!canListen) $("orbState").textContent = "Voice input isn't supported in this browser. Try Chrome.";
