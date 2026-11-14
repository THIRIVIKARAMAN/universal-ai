import { models, imageModels, InferenceMode } from "./firebase.js";
import { load, save, uid, escapeHtml } from "./store.js";
import { fileToImage, drawScaled, canvasToPart, thumbnail, enhance } from "./photo.js";
import { listen, stopListening, speak, stopSpeaking, canListen, canSpeak } from "./voice.js";
import { initWayback } from "./wayback.js";
import { initSchedule } from "./schedule.js";

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

const persistChats = () => save(CHATS_KEY, chats.slice(0, 60));
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
    : "<b>No signal</b>, and the offline AI isn't downloaded yet. Download it next time you have Wi-Fi.";
  if (n.quality === "slow") return ready
    ? `<b>Weak signal (${n.label}).</b> Questions go to this device first, so you don't wait for the network.`
    : `<b>Weak signal (${n.label}).</b> The offline AI isn't ready on this device, so the cloud will answer. It may be slow.`;
  return `<b>Good signal (${n.label}).</b> Questions go to the cloud for the most detailed answers.`;
}

function renderRouting() {
  const n = getNetwork();
  $("netChip").textContent = n.label;
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

async function checkDevice() {
  deviceState = await availability(false);
  deviceImageState = deviceState === "available" ? await availability(true) : "unavailable";
  $("deviceChip").textContent = DEVICE_TEXT[deviceState] || `Gemini Nano: ${deviceState}`;
  $("downloadBtn").hidden = !(deviceState === "downloadable" || deviceState === "downloading");
  $("downloadBtn").textContent = deviceState === "downloading" ? "Show download progress" : "Download offline AI";
  renderRouting();
}

$("downloadBtn").addEventListener("click", async () => {
  $("downloadBtn").hidden = true;
  $("progressWrap").hidden = false;
  $("deviceChip").textContent = "Downloading Gemini Nano. Keep this tab open.";
  try {
    await models[InferenceMode.PREFER_ON_DEVICE].initializeDeviceModel((p) => {
      const pct = Math.round(p * 100);
      $("progressBar").style.width = `${pct}%`;
      $("deviceChip").textContent = `Downloading Gemini Nano: ${pct}%`;
    });
  } catch (e) {
    $("deviceChip").textContent = `Download stopped: ${e.message}`;
  }
  checkDevice();
});

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
  for (const id of ["chat", "schedule", "photo", "way"]) $(`view-${id}`).hidden = id !== v;
  document.querySelectorAll(".nav-item").forEach((b) => b.toggleAttribute("aria-current", b.dataset.view === v));
  document.querySelectorAll(".nav-item[aria-current]").forEach((b) => b.setAttribute("aria-current", "page"));
  renderTop();
  renderSidebar();
  closeSide();
}
document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));

function renderTop() {
  const titles = { schedule: "Study schedule", photo: "Photo cleaner", way: "Find my way back" };
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
  renderTop();
  renderSidebar();
  scrollToEnd();
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

let busy = false;
async function send() {
  if (busy) return;
  const text = input.value.trim();
  if (!text && !attached) return input.focus();
  const task = $("task").value;
  const hasImage = Boolean(attached);
  const mode = chooseMode(hasImage);
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
    let res = await streamWithTimeout(set[mode], { contents: buildContents(history, newParts, route === "device") }, paint);
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
  if (hasImage && !navigator.onLine && deviceImageState !== "available")
    return "The offline AI on this device can't read photos, and there's no signal for the cloud. Try again when you're online.";
  if (!navigator.onLine)
    return "There's no signal and the offline AI isn't ready on this device. Download it the next time you're on Wi-Fi, then try again.";
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
}

/* =========================================================
   Start
   ========================================================= */
setView("chat");
renderChat();
renderRouting();
checkDevice();
setInterval(() => { if (deviceState === "downloadable" || deviceState === "downloading") checkDevice(); }, 30000);
