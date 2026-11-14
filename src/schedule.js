// Study schedule with reminders while the app is open.
import { load, save, uid, escapeHtml } from "./store.js";

const KEY = "universal-ai-schedule";
const $ = (id) => document.getElementById(id);

export function initSchedule({ getProjects, onPlanRequest }) {
  let items = load(KEY, []);
  const persist = () => save(KEY, items);

  // Defaults: today, next full hour.
  const now = new Date();
  const next = new Date(now.getTime() + 60 * 60 * 1000);
  $("schedDate").value = now.toLocaleDateString("en-CA");
  $("schedTime").value = `${String(next.getHours()).padStart(2, "0")}:00`;

  function fillProjects() {
    const sel = $("schedProject");
    const keep = sel.value;
    sel.innerHTML = `<option value="">No project</option>` +
      getProjects().map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
    sel.value = keep;
  }

  function render() {
    fillProjects();
    const projects = Object.fromEntries(getProjects().map((p) => [p.id, p.name]));
    const upcoming = items.filter((i) => !i.done).sort((a, b) => a.when - b.when);
    const done = items.filter((i) => i.done).sort((a, b) => b.when - a.when).slice(0, 20);
    const row = (i) => {
      const d = new Date(i.when);
      const isNow = !i.done && i.when <= Date.now();
      return `<li class="${isNow ? "now" : ""}" data-id="${i.id}">
        <div class="when">${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}<small>${d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" })}</small></div>
        <div class="what"><strong>${escapeHtml(i.title)}</strong>${i.projectId && projects[i.projectId] ? `<span>${escapeHtml(projects[i.projectId])}</span>` : ""}${isNow ? `<span>Time to start</span>` : ""}</div>
        <div class="acts">${i.done ? "" : `<button class="link-btn" data-act="done" type="button">Mark done</button>`}<button class="link-btn" data-act="del" type="button">Delete</button></div>
      </li>`;
    };
    $("schedUpcoming").innerHTML = upcoming.map(row).join("");
    $("schedDone").innerHTML = done.map(row).join("");
    $("schedEmpty").hidden = upcoming.length > 0;
    $("schedDoneHead").hidden = done.length === 0;
    const today = upcoming.filter((i) => new Date(i.when).toDateString() === new Date().toDateString()).length;
    $("schedCount").hidden = today === 0;
    $("schedCount").textContent = today;
  }

  $("schedForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const when = new Date(`${$("schedDate").value}T${$("schedTime").value}`).getTime();
    if (Number.isNaN(when)) return;
    items.push({ id: uid(), title: $("schedTitle").value.trim(), when, projectId: $("schedProject").value || null, done: false, notified: when <= Date.now() });
    persist();
    $("schedTitle").value = "";
    render();
    // Ask for notification permission the first time someone schedules something.
    if ("Notification" in self && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  });

  const onListClick = (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = btn.closest("li").dataset.id;
    if (btn.dataset.act === "del") items = items.filter((i) => i.id !== id);
    if (btn.dataset.act === "done") items = items.map((i) => (i.id === id ? { ...i, done: true } : i));
    persist();
    render();
  };
  $("schedUpcoming").addEventListener("click", onListClick);
  $("schedDone").addEventListener("click", onListClick);

  $("planBtn").addEventListener("click", () => {
    const upcoming = items.filter((i) => !i.done).map((i) => `- ${i.title} (${new Date(i.when).toLocaleString()})`).join("\n");
    onPlanRequest(
      `Make me a simple 7-day study plan with short daily sessions and breaks.` +
      (upcoming ? `\nI have already planned:\n${upcoming}` : `\nMy subjects and exam dates are: `)
    );
  });

  // Reminders.
  async function remind(item) {
    const body = `Time to study: ${item.title}`;
    try {
      if ("Notification" in self && Notification.permission === "granted") {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (reg) reg.showNotification("Universal AI", { body, icon: "/icons/icon-192.png", tag: item.id });
        else new Notification("Universal AI", { body, icon: "/icons/icon-192.png" });
      }
    } catch {}
  }
  setInterval(() => {
    let changed = false;
    for (const i of items) {
      if (!i.done && !i.notified && i.when <= Date.now()) {
        i.notified = true;
        changed = true;
        remind(i);
      }
    }
    if (changed) persist();
    render();
  }, 20000);

  render();
  return { render };
}
