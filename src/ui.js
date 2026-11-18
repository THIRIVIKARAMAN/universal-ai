// Reusable interface pieces: floating menus, toasts, ripples, theme switching.
import { load, save } from "./store.js";

const THEME_KEY = "universal-ai-theme";

/* ---------------- Theme ---------------- */
export function getTheme() {
  return load(THEME_KEY, "system");
}

export function setTheme(theme) {
  save(THEME_KEY, theme);
  const apply = () => { document.documentElement.dataset.theme = theme; };
  // Animated cross-fade where the browser supports it.
  if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
  updateThemeColor();
}

export function isDark() {
  const t = document.documentElement.dataset.theme;
  return t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}

function updateThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = isDark() ? "#07090f" : "#f3f5fa";
}
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", updateThemeColor);
updateThemeColor();

/* ---------------- Floating menu ---------------- */
let openMenu = null;

export function closeMenu() {
  if (!openMenu) return;
  const { el, anchor } = openMenu;
  anchor.setAttribute("aria-expanded", "false");
  el.classList.remove("show");
  setTimeout(() => el.remove(), 180);
  openMenu = null;
}

/**
 * Show a floating menu above (or below, if there's no room) an anchor element.
 * items: [{ label, hint?, icon? (svg string), active?, action() }]
 */
export function showMenu(anchor, items, { title } = {}) {
  if (openMenu && openMenu.anchor === anchor) return closeMenu();
  closeMenu();
  const el = document.createElement("div");
  el.className = "float-menu";
  el.setAttribute("role", "menu");
  if (title) {
    const h = document.createElement("p");
    h.className = "fm-title";
    h.textContent = title;
    el.append(h);
  }
  items.forEach((item) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("role", "menuitemradio" in item ? "menuitemradio" : "menuitem");
    if (item.active) b.setAttribute("aria-checked", "true");
    b.innerHTML = `${item.icon ? `<span class="fm-icon">${item.icon}</span>` : ""}<span class="fm-text"><span></span>${item.hint ? "<small></small>" : ""}</span>`;
    b.querySelector(".fm-text span").textContent = item.label;
    if (item.hint) b.querySelector("small").textContent = item.hint;
    if (item.active) b.classList.add("active");
    b.addEventListener("click", () => { closeMenu(); item.action(); });
    el.append(b);
  });
  document.body.append(el);
  position(el, anchor);
  anchor.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => el.classList.add("show"));
  openMenu = { el, anchor };
  el.querySelector("button")?.focus({ preventScroll: true });

  el.addEventListener("keydown", (e) => {
    const btns = [...el.querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
    if (e.key === "ArrowUp") { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    if (e.key === "Escape") { closeMenu(); anchor.focus(); }
    if (e.key === "Tab") closeMenu();
  });
}

// Keep the menu fully on screen: prefer above the anchor, flip below if needed.
function position(el, anchor) {
  const r = anchor.getBoundingClientRect();
  // offsetWidth/Height ignore the opening animation's scale.
  const m = { width: el.offsetWidth, height: el.offsetHeight };
  const gap = 10, pad = 8;
  let top = r.top - m.height - gap;
  let placement = "above";
  if (top < pad) { top = r.bottom + gap; placement = "below"; }
  if (top + m.height > innerHeight - pad) top = Math.max(pad, innerHeight - pad - m.height);
  let left = r.left + r.width / 2 - m.width / 2;
  left = Math.min(Math.max(pad, left), innerWidth - pad - m.width);
  el.style.top = `${top}px`;
  el.style.left = `${left}px`;
  el.dataset.placement = placement;
  el.style.setProperty("--arrow-x", `${r.left + r.width / 2 - left}px`);
}

addEventListener("pointerdown", (e) => {
  if (openMenu && !openMenu.el.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
});
addEventListener("resize", closeMenu);
addEventListener("scroll", closeMenu, true);

/* ---------------- Toasts ---------------- */
export function toast(message, type = "info", ms = 3800) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.textContent = message;
  box.append(t);
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => { t.classList.remove("show"); setTimeout(() => t.remove(), 300); }, ms);
}

/* ---------------- Ripple on press ---------------- */
const RIPPLE = "button, .tool-card, .nav-item";
addEventListener("pointerdown", (e) => {
  const el = e.target.closest(RIPPLE);
  if (!el || el.disabled || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 1.6;
  const dot = document.createElement("span");
  dot.className = "ripple";
  dot.style.width = dot.style.height = `${size}px`;
  dot.style.left = `${e.clientX - r.left - size / 2}px`;
  dot.style.top = `${e.clientY - r.top - size / 2}px`;
  el.append(dot);
  setTimeout(() => dot.remove(), 600);
});

/* ---------------- Tooltips ---------------- */
let tip = null;
function showTip(el) {
  const text = el.dataset.tip;
  if (!text) return;
  hideTip();
  tip = document.createElement("div");
  tip.className = "tooltip";
  tip.textContent = text;
  document.body.append(tip);
  const r = el.getBoundingClientRect(), m = tip.getBoundingClientRect();
  let left = Math.min(Math.max(6, r.left + r.width / 2 - m.width / 2), innerWidth - 6 - m.width);
  let top = r.bottom + 8;
  if (top + m.height > innerHeight - 6) top = r.top - m.height - 8;
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
  requestAnimationFrame(() => tip?.classList.add("show"));
}
function hideTip() { tip?.remove(); tip = null; }
addEventListener("pointerover", (e) => { const el = e.target.closest("[data-tip]"); if (el && e.pointerType === "mouse") showTip(el); });
addEventListener("pointerout", (e) => { if (e.target.closest("[data-tip]")) hideTip(); });
addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el); });
addEventListener("focusout", hideTip);
addEventListener("pointerdown", hideTip);

/* ---------------- Icons used in menus ---------------- */
export const ICONS = {
  sun: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/></svg>',
  moon: '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
  system: '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  doc: '<svg viewBox="0 0 24 24"><path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5M10 13h6M10 17h6"/></svg>',
  photo: '<svg viewBox="0 0 24 24"><path d="M4 7h3l2-2.5h6L17 7h3v12H4z"/><circle cx="12" cy="13" r="3.6"/></svg>',
  voice: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>',
  map: '<svg viewBox="0 0 24 24"><path d="M12 21s-6.5-6.2-6.5-11A6.5 6.5 0 0 1 18.5 10c0 4.8-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
};
