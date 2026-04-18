// @ts-nocheck
/**
 * Babylog — application UI (ported from classic `js/app.js`).
 */
import {
  STORAGE_KEY,
  STORAGE_PROFILE_KEY,
  STORAGE_THEME_KEY,
  STORAGE_SIDEBAR_COLLAPSED_KEY,
  STORAGE_AI_INSTRUCTION_KEY,
  STORAGE_AI_PROJECT_KEY,
  STORAGE_AUTH_LOCAL_ONLY_KEY,
  AUTH_CSRF_COOKIE,
  DEFAULT_AI_INSTRUCTION,
  MAX_ENTRY_PHOTOS,
  MAX_PHOTO_BYTES,
  VACCINE_TEMPLATES,
  DEFAULT_VACCINE_TEMPLATE_LABELS,
  CATEGORIES,
} from "../config/constants";
import { API_BASE, API_ORIGIN } from "../config/api-base";
import { mapEntryToApi } from "../api/mappers";
import {
  TREND_LINE_COLOR,
  CHART_METRIC_BUCKETS,
  CHART_METRIC_SHEET_MAX_W,
} from "../chart/chart-config";
import { initCustomDropdowns } from "../ui/custom-dropdown";
import { fetchAllEntriesPaged } from "../api/entries-pagination";
import { renderMarkdownToHtml, throttledStreamingMarkdownUpdate, flushStreamingMarkdownThrottle } from "../markdown/render";
import { accumulateRangeStats } from "../stats/accumulate-range-stats";
import { toLocalDateKey } from "../lib/dates";
import { collectGalleryPhotosFromEntries } from "../gallery/collect-photos";

/** @type {Array<{id: string, categoryId: string, at: string, fields: Record<string, string|number>, note: string, photos?: string[]}>} */
let entries = [];
/** @type {{name: string, birthDate: string, gender: string, blood: string, avatar: string}} */
let profile = { name: "", birthDate: "", gender: "", blood: "", avatar: "" };
/** @type {Array<{id: string, name: string, dose: string, dueDate: string, status: "todo"|"done", doneAt: string}>} */
let vaccines = [];
let vaccineSettings = { region: "cn", reminderDays: 3, notificationsEnabled: false, notifiedMap: {} };
let customVaccineTemplates = {};
/** @type {{start: string, end: string, preset: string}} */
let statsRange = { start: "", end: "", preset: "7d" };
let statsMode = "cards";
let timelineVisibleCount = 20;
let chartResolution = "day";
let chartMetricId = "feeding.amountMl";
let chartHitPoints = [];
/** @type {object|null} */
let chartLastTrend = null;
let chartScrubIndex = null;
/** @type {{ xs: number[], left: number, plotW: number, len: number }|null} */
let chartPlotLayout = null;
let statsRangeApplyTimer = null;
/** Coalesces chart redraws during window resize (at most once per frame). */
let chartResizeRafId = 0;
let apiReady = false;
/** @type {{token: string, user: {id: string, username: string} | null, localOnly: boolean, csrf: string}} */
let authState = { token: "", user: null, localOnly: false, csrf: "" };
let authMode = "login";
let authBusy = false;
let themeMode = "system";
let activeModuleId = "profile";
let sidebarOpen = false;
/** Desktop-only: narrow icon rail when true. */
let sidebarCollapsedDesktop = false;
let profileEditorOpen = true;
let aiInstruction = DEFAULT_AI_INSTRUCTION;
let _toastTimer = 0;
function showToast(msg, duration = 2200) {
  const el = document.getElementById("app-toast");
  if (!el) return;
  clearTimeout(_toastTimer);
  el.textContent = msg;
  el.classList.add("app-toast--visible");
  _toastTimer = setTimeout(() => el.classList.remove("app-toast--visible"), duration);
}

function setImportProgress(done, total, show) {
  const wrap = document.getElementById("import-progress");
  const text = document.getElementById("import-progress-text");
  const bar = document.getElementById("import-progress-bar");
  const track = wrap?.querySelector(".import-progress-track");
  if (!wrap || !text || !bar || !track) return;
  wrap.classList.toggle("hidden", !show);
  const safeTotal = Math.max(0, total);
  const safeDone = Math.max(0, Math.min(done, safeTotal));
  const pct = safeTotal <= 0 ? 0 : Math.round((safeDone / safeTotal) * 100);
  text.textContent = `正在导入 ${safeDone}/${safeTotal}`;
  bar.style.width = `${pct}%`;
  track.setAttribute("aria-valuenow", String(pct));
}
/** @type {AiProject} */
let aiProject = {
  instruction: DEFAULT_AI_INSTRUCTION,
  activeSessionId: "",
  contextPolicy: "full_recent",
  aiContextConsent: {},
  syncSessionsDisclaimerAck: false,
  sessions: [],
};
let aiStreamRenderScheduled = false;
let aiBusy = false;
let aiSessionSearchKeyword = "";
/** @type {string|null} 列表内删除确认：当前待确认的会话 id */
let aiSessionDeletePendingId = null;
/** @type {import("../types/models").LogEntry|null} 服务端草稿，确认后写入时间轴 */
let pendingAiEntryDraft = null;
let commandPaletteOpen = false;
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    entries = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
}

function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

function loadProfile() {
  try {
    const raw = localStorage.getItem(STORAGE_PROFILE_KEY);
    const data = raw ? JSON.parse(raw) : {};
    profile = {
      name: data?.name || "",
      birthDate: data?.birthDate || "",
      gender: data?.gender || "",
      blood: data?.blood || "",
      avatar: data?.avatar || "",
    };
  } catch {
    profile = { name: "", birthDate: "", gender: "", blood: "", avatar: "" };
  }
}

function saveProfile() {
  localStorage.setItem(STORAGE_PROFILE_KEY, JSON.stringify(profile));
}

function loadVaccines() {
  vaccines = [];
}

function saveVaccines() {
  if (!apiReady) return;
  apiRequest("/vaccines", {
    method: "PUT",
    body: JSON.stringify(vaccines.map((v) => ({
      id: String(v.id || ""),
      name: String(v.name || ""),
      dose: String(v.dose || ""),
      due_date: String(v.dueDate || ""),
      status: String(v.status || "todo"),
      done_at: String(v.doneAt || ""),
    }))),
  }).catch(() => {
    apiReady = false;
  });
}

function loadVaccineSettings() {
  vaccineSettings = { region: "cn", reminderDays: 3, notificationsEnabled: false, notifiedMap: {} };
}

function saveVaccineSettings() {
  if (!apiReady) return;
  apiRequest("/vaccine-settings", {
    method: "PUT",
    body: JSON.stringify({
      region: String(vaccineSettings.region || "cn"),
      reminder_days: Number(vaccineSettings.reminderDays ?? 3),
      notifications_enabled: Boolean(vaccineSettings.notificationsEnabled),
      notified_map: vaccineSettings.notifiedMap || {},
    }),
  }).catch(() => {
    apiReady = false;
  });
}

function loadCustomVaccineTemplates() {
  customVaccineTemplates = {};
}

function saveCustomVaccineTemplates() {
  if (!apiReady) return;
  apiRequest("/vaccine-templates", {
    method: "PUT",
    body: JSON.stringify(customVaccineTemplates),
  }).catch(() => {
    apiReady = false;
  });
}

function readCookie(name) {
  const raw = typeof document !== "undefined" ? document.cookie : "";
  if (!raw) return "";
  const needle = `${name}=`;
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (p.startsWith(needle)) return decodeURIComponent(p.slice(needle.length));
  }
  return "";
}


function loadAuth() {
  let localOnly = false;
  try {
    localOnly = localStorage.getItem(STORAGE_AUTH_LOCAL_ONLY_KEY) === "1";
  } catch {
    localOnly = false;
  }
  authState = {
    token: "",
    user: null,
    localOnly,
    csrf: readCookie(AUTH_CSRF_COOKIE),
  };
}

function persistAuth() {
  try {
    if (authState.localOnly) localStorage.setItem(STORAGE_AUTH_LOCAL_ONLY_KEY, "1");
    else localStorage.removeItem(STORAGE_AUTH_LOCAL_ONLY_KEY);
  } catch {
    /* ignore quota/private-mode errors */
  }
}

function clearAuth() {
  authState = { token: "", user: null, localOnly: false, csrf: "" };
  persistAuth();
  syncSidebarAccount();
}

/**
 * Returns extra headers for authenticated requests. The session cookie is
 * HttpOnly and sent automatically via `credentials: "include"`; we only need
 * to echo the CSRF token (read fresh from the readable cookie) on every
 * state-changing request.
 */
function authHeaders(extra) {
  const out = { ...(extra || {}) };
  const csrf = readCookie(AUTH_CSRF_COOKIE) || authState.csrf;
  if (csrf) {
    out["X-CSRF-Token"] = csrf;
    authState.csrf = csrf;
  }
  return out;
}

function showAuthOverlay(mode, message) {
  const overlay = document.getElementById("auth-overlay");
  if (!overlay) return;
  authMode = mode === "register" ? "register" : "login";
  overlay.classList.remove("hidden");
  const title = document.getElementById("auth-title");
  const submit = document.getElementById("btn-auth-submit");
  const hint = document.getElementById("auth-switch-hint");
  const swBtn = document.getElementById("btn-auth-switch");
  const pwd = /** @type {HTMLInputElement|null} */ (document.getElementById("auth-password"));
  if (title) title.textContent = authMode === "register" ? "注册" : "登录";
  if (submit) submit.textContent = authMode === "register" ? "注册" : "登录";
  if (hint) hint.textContent = authMode === "register" ? "已有账号？" : "还没有账号？";
  if (swBtn) swBtn.textContent = authMode === "register" ? "去登录" : "去注册";
  if (pwd) pwd.setAttribute("autocomplete", authMode === "register" ? "new-password" : "current-password");
  setAuthError(message || "");
  const usernameEl = /** @type {HTMLInputElement|null} */ (document.getElementById("auth-username"));
  if (usernameEl && !message) setTimeout(() => usernameEl.focus(), 30);
}

function hideAuthOverlay() {
  const overlay = document.getElementById("auth-overlay");
  if (overlay) overlay.classList.add("hidden");
}

function setAuthError(msg) {
  const el = document.getElementById("auth-error");
  if (el) el.textContent = msg || "";
}

function setAuthBusy(busy) {
  authBusy = busy;
  const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-auth-submit"));
  if (btn) {
    btn.disabled = busy;
    btn.textContent = busy
      ? (authMode === "register" ? "注册中…" : "登录中…")
      : (authMode === "register" ? "注册" : "登录");
  }
}

function avatarInitial(username) {
  const s = String(username || "").trim();
  if (!s) return "U";
  const ch = s.charAt(0);
  return ch.toUpperCase();
}

function renderAvatarInto(el, user) {
  if (!el) return;
  el.textContent = "";
  const url = user?.avatar || "";
  if (url) {
    const img = document.createElement("img");
    img.src = url;
    img.alt = "";
    el.appendChild(img);
  } else {
    el.textContent = avatarInitial(user?.username);
  }
}

function syncSidebarAccount() {
  const box = document.getElementById("sidebar-account");
  const name = document.getElementById("user-avatar-name");
  const avatar = document.getElementById("user-avatar");
  const btn = document.getElementById("btn-user-menu");
  if (!box) return;
  const loggedIn = Boolean(authState.user && !authState.localOnly);
  if (loggedIn) {
    box.classList.remove("hidden");
    if (name) name.textContent = authState.user.username;
    renderAvatarInto(avatar, authState.user);
    if (btn) btn.title = authState.user.username;
  } else {
    box.classList.add("hidden");
    if (name) name.textContent = "";
    if (avatar) avatar.textContent = "U";
  }
  // Keep settings dialog in sync if it's open.
  const settingsOverlay = document.getElementById("settings-overlay");
  if (settingsOverlay && !settingsOverlay.classList.contains("hidden")) {
    syncSettingsDialog();
  }
}

/**
 * Maps backend error responses to a user-facing message that doesn't leak
 * implementation details, while still surfacing rate-limit hints.
 */
function authErrorMessage(status, body) {
  if (status === 429) {
    const retry = body?.retry_after;
    return retry ? `请求过于频繁，请稍后再试（约 ${retry} 秒）` : "请求过于频繁，请稍后再试";
  }
  if (status === 400) {
    const raw = String(body?.error || "");
    if (raw.startsWith("weak password")) return "密码强度不足，请使用更复杂的密码（建议包含大小写字母、数字和符号）";
    return "请检查用户名和密码格式";
  }
  if (status === 401) return "用户名或密码错误";
  if (status === 403) return "请刷新页面后重试";
  if (status === 409) return "注册失败";
  return "请求失败，请稍后重试";
}

/**
 * Calls an auth API without touching the shared apiRequest helper (so 401 flows
 * don't recursively clear state while we're still trying to authenticate).
 */
async function authApi(path, payload) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(authErrorMessage(res.status, data));
    err.status = res.status;
    throw err;
  }
  return data;
}

function validateAuthInputs(username, password) {
  if (!username || !password) return "请填写用户名和密码";
  if (username.length > 48) return "用户名过长";
  if (!/^[A-Za-z0-9_.\-]+$/.test(username)) return "用户名只能包含字母、数字、_ - .";
  if (password.length < 6) return "密码至少 6 位";
  if (password.length > 128) return "密码过长";
  return "";
}

async function submitAuthForm() {
  if (authBusy) return;
  const u = /** @type {HTMLInputElement} */ (document.getElementById("auth-username"));
  const p = /** @type {HTMLInputElement} */ (document.getElementById("auth-password"));
  const username = (u?.value || "").trim();
  const password = p?.value || "";
  const validationMsg = validateAuthInputs(username, password);
  if (validationMsg) {
    setAuthError(validationMsg);
    return;
  }
  setAuthBusy(true);
  setAuthError("");
  try {
    const path = authMode === "register" ? "/auth/register" : "/auth/login";
    const data = await authApi(path, { username, password });
    authState = {
      token: "",
      user: data?.user
        ? {
            id: String(data.user.id),
            username: String(data.user.username),
            avatar: typeof data.user.avatar === "string" ? data.user.avatar : "",
          }
        : null,
      localOnly: false,
      csrf: readCookie(AUTH_CSRF_COOKIE) || String(data?.csrf_token || ""),
    };
    persistAuth();
    hideAuthOverlay();
    if (p) p.value = "";
    showToast(authMode === "register" ? "注册成功" : "登录成功");
    if (data?.new_device) {
      setTimeout(() => showToast("检测到新设备登录，如非本人请立即修改密码", 4200), 600);
    }
    syncSidebarAccount();
    resetInMemoryUserData();
    await initDataSource();
    render();
  } catch (err) {
    setAuthError(err?.message || "请求失败");
  } finally {
    setAuthBusy(false);
  }
}

function resetInMemoryUserData() {
  entries = [];
  profile = { name: "", birthDate: "", gender: "", blood: "", avatar: "" };
  vaccines = [];
  vaccineSettings = { region: "cn", reminderDays: 3, notificationsEnabled: false, notifiedMap: {} };
  customVaccineTemplates = {};
  timelineVisibleCount = 20;
  try { render(); } catch { /* render may not be ready yet */ }
}

async function logout() {
  try {
    await fetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: authHeaders(),
      credentials: "include",
    });
  } catch {
    // best-effort; the server clears cookies on success, but we clear local
    // state either way below
  }
  clearAuth();
  apiReady = false;
  resetInMemoryUserData();
  showToast("已退出登录");
  showAuthOverlay("login");
}

/**
 * Restores the current session by asking the backend who we are.
 * The session cookie (if any) is sent automatically via credentials: "include".
 * Returns true when /auth/me returns a valid user.
 */
async function restoreSessionFromCookie() {
  try {
    const res = await fetch(`${API_BASE}/auth/me`, {
      headers: authHeaders(),
      credentials: "include",
    });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    if (!data?.user) return false;
    authState.user = {
      id: String(data.user.id),
      username: String(data.user.username),
      avatar: typeof data.user.avatar === "string" ? data.user.avatar : "",
    };
    authState.csrf = readCookie(AUTH_CSRF_COOKIE) || authState.csrf;
    return true;
  } catch {
    return false;
  }
}

async function apiRequest(path, options = {}) {
  const headers = authHeaders({ "Content-Type": "application/json", ...(options.headers || {}) });
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });
  if (res.status === 401 && authState.user && !authState.localOnly) {
    clearAuth();
    showAuthOverlay("login", "登录状态已过期，请重新登录");
  }
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return null;
}

function syncThemeToggleUi() {
  document.querySelectorAll(".theme-icon-btn").forEach((el) => {
    const btn = /** @type {HTMLButtonElement} */ (el);
    const mode = btn.getAttribute("data-theme");
    const pressed = mode === themeMode;
    btn.setAttribute("aria-pressed", String(pressed));
    btn.classList.toggle("is-active", pressed);
  });
}

function applyTheme(mode) {
  const root = document.documentElement;
  themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  if (themeMode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", themeMode);
  localStorage.setItem(STORAGE_THEME_KEY, themeMode);
  syncThemeToggleUi();
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_THEME_KEY) || "system";
  applyTheme(saved);
  document.querySelectorAll(".theme-icon-btn").forEach((el) => {
    el.addEventListener("click", () => {
      const m = el.getAttribute("data-theme");
      applyTheme(m || "system");
    });
  });
}

function readSidebarCollapsedPreference() {
  try {
    return localStorage.getItem(STORAGE_SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function applySidebarCollapsed(collapsed) {
  const shell = document.getElementById("app-shell");
  const sidebar = document.getElementById("app-sidebar");
  const btn = document.getElementById("btn-toggle-sidebar-collapse");
  if (!shell || !sidebar) return;
  sidebarCollapsedDesktop = Boolean(collapsed);
  shell.classList.toggle("app-shell--sidebar-collapsed", sidebarCollapsedDesktop);
  sidebar.classList.toggle("app-sidebar--collapsed", sidebarCollapsedDesktop);
  try {
    localStorage.setItem(STORAGE_SIDEBAR_COLLAPSED_KEY, sidebarCollapsedDesktop ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  if (btn) {
    btn.setAttribute("aria-expanded", String(!sidebarCollapsedDesktop));
    btn.setAttribute("aria-label", sidebarCollapsedDesktop ? "展开侧栏" : "收起侧栏");
    btn.setAttribute("title", sidebarCollapsedDesktop ? "展开侧栏" : "收起侧栏");
  }
}

function initSidebarCollapse() {
  applySidebarCollapsed(readSidebarCollapsedPreference());
  const btn = document.getElementById("btn-toggle-sidebar-collapse");
  if (btn) {
    btn.addEventListener("click", () => {
      if (window.innerWidth <= 760) return;
      applySidebarCollapsed(!sidebarCollapsedDesktop);
    });
  }
}

function setSidebarOpen(open) {
  sidebarOpen = Boolean(open);
  const sidebar = document.getElementById("app-sidebar");
  const backdrop = document.getElementById("app-backdrop");
  if (!sidebar || !backdrop) return;
  if (sidebarOpen) {
    sidebar.classList.add("open");
    backdrop.classList.remove("hidden");
  } else {
    sidebar.classList.remove("open");
    backdrop.classList.add("hidden");
  }
}

function setActiveModule(moduleId) {
  activeModuleId = moduleId;
  document.querySelectorAll(".module-nav-item").forEach((el) => {
    const isActive = el.getAttribute("data-module") === moduleId;
    el.classList.toggle("active", isActive);
  });
  document.querySelectorAll(".module-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `module-${moduleId}`);
  });
  const titleEl = document.getElementById("mobile-topbar-title");
  const activeNavText = document.querySelector(`#module-nav .module-nav-item[data-module="${moduleId}"] .module-nav-text`);
  if (titleEl && activeNavText) {
    titleEl.textContent = activeNavText.textContent || "Babylog";
  }
  const container = document.querySelector(".app-content .container");
  if (container) {
    container.classList.toggle("container-wide", moduleId === "ai");
  }
  const appContent = document.querySelector(".app-content");
  if (appContent) {
    appContent.classList.toggle("app-content--ai-full", moduleId === "ai");
  }
}

function initModuleNavigation() {
  const nav = document.getElementById("module-nav");
  if (!nav) return;
  nav.addEventListener("click", (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof Element ? ev.target.closest(".module-nav-item") : null);
    if (!target) return;
    const moduleId = target.getAttribute("data-module");
    if (!moduleId) return;
    setActiveModule(moduleId);
    setSidebarOpen(false);
  });

  const openBtn = document.getElementById("btn-open-sidebar");
  if (openBtn) {
    openBtn.addEventListener("click", () => setSidebarOpen(!sidebarOpen));
  }
  const backdrop = document.getElementById("app-backdrop");
  if (backdrop) {
    backdrop.addEventListener("click", () => setSidebarOpen(false));
  }
  window.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") setSidebarOpen(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 760) setSidebarOpen(false);
  });
  setActiveModule(activeModuleId);
}

async function initDataSource() {
  try {
    const [apiProfile, apiVaccines, apiVaccineSettings, apiVaccineTemplates, entryList] = await Promise.all([
      apiRequest("/profile"),
      apiRequest("/vaccines"),
      apiRequest("/vaccine-settings"),
      apiRequest("/vaccine-templates"),
      fetchAllEntriesPaged(apiRequest, { pageSize: 500, maxEntries: 25000 }),
    ]);
    profile = {
      name: apiProfile?.name || "",
      birthDate: apiProfile?.birth_date || "",
      gender: apiProfile?.gender || "",
      blood: apiProfile?.blood || "",
      avatar: apiProfile?.avatar || apiProfile?.avatar_url || profile.avatar || "",
    };
    entries = entryList;
    vaccines = Array.isArray(apiVaccines)
      ? apiVaccines.map((v) => ({
        id: String(v.id || ""),
        name: String(v.name || ""),
        dose: String(v.dose || ""),
        dueDate: String(v.due_date || ""),
        status: v.status === "done" ? "done" : "todo",
        doneAt: String(v.done_at || ""),
      }))
      : [];
    vaccineSettings = {
      region: apiVaccineSettings?.region || "cn",
      reminderDays: Number(apiVaccineSettings?.reminder_days ?? 3),
      notificationsEnabled: Boolean(apiVaccineSettings?.notifications_enabled),
      notifiedMap: apiVaccineSettings?.notified_map && typeof apiVaccineSettings.notified_map === "object"
        ? apiVaccineSettings.notified_map
        : {},
    };
    customVaccineTemplates = apiVaccineTemplates && typeof apiVaccineTemplates === "object"
      ? apiVaccineTemplates
      : {};
    apiReady = true;
  } catch {
    apiReady = false;
    load();
    loadProfile();
    loadVaccines();
    loadVaccineSettings();
    loadCustomVaccineTemplates();
  }
}

function getAllVaccineTemplates() {
  const merged = {};
  for (const key of Object.keys(VACCINE_TEMPLATES)) merged[key] = VACCINE_TEMPLATES[key];
  for (const key of Object.keys(customVaccineTemplates)) {
    const tpl = customVaccineTemplates[key];
    if (tpl && Array.isArray(tpl.items)) merged[key] = tpl.items;
  }
  return merged;
}

function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES[CATEGORIES.length - 1];
}

function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function formatDateHeader(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yest = new Date(today);
  yest.setDate(yest.getDate() - 1);
  const sameDay = (a, b) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "今天";
  if (sameDay(d, yest)) return "昨天";
  return d.toLocaleDateString("zh-CN", { month: "short", day: "numeric", weekday: "short" });
}

function daysBetween(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  a.setHours(0, 0, 0, 0);
  b.setHours(0, 0, 0, 0);
  return Math.floor((b - a) / (24 * 60 * 60 * 1000));
}

function getAgeText() {
  if (!profile.birthDate) return "未设置生日";
  const d = daysBetween(profile.birthDate, new Date().toISOString());
  if (d < 30) return `${d} 天`;
  const m = Math.floor(d / 30);
  const dd = d % 30;
  return `${m} 月 ${dd} 天`;
}

function summarizeFields(cat, fields) {
  const parts = [];
  for (const f of cat.fields) {
    const v = fields[f.key];
    if (v === undefined || v === null || v === "") continue;
    if (f.type === "select" && f.options) {
      const opt = f.options.find((o) => o.v === String(v));
      parts.push(opt ? opt.t : v);
    } else if (f.key === "amountMl") parts.push(`${v} ml`);
    else if (f.key === "durationMin") parts.push(formatDurationMinutes(Number(v)));
    else if (f.key === "celsius") parts.push(`${v}°C`);
    else if (f.key === "weightKg") parts.push(`体重 ${v} kg`);
    else if (f.key === "heightCm") parts.push(`身长 ${v} cm`);
    else if (f.key === "headCm") parts.push(`头围 ${v} cm`);
    else if (f.key === "name" || f.key === "food") parts.push(String(v));
    else if (f.key === "dose" || f.key === "amount" || f.key === "place" || f.key === "soothe") parts.push(String(v));
    else parts.push(`${f.label}: ${v}`);
  }
  return parts.join(" · ");
}

function getNumericMetricOptions() {
  /** @type {Array<{id: string, label: string, categoryId: string, fieldKey: string}>} */
  const opts = [];
  for (const c of CATEGORIES) {
    for (const f of c.fields) {
      if (f.type !== "number") continue;
      const metricName = stripFieldUnit(String(f.label || f.key || "数值"));
      opts.push({
        id: `${c.id}.${f.key}`,
        label: `${c.emoji} ${c.label} · ${metricName}`,
        categoryId: c.id,
        fieldKey: f.key,
        unit: inferMetricUnit(f),
      });
    }
  }
  return opts;
}

function getNumericMetricOptionsGrouped() {
  /** @type {Array<{ key: string, title: string, emoji: string, items: Array<{ id: string, label: string, categoryId: string, fieldKey: string, unit: string }> }>} */
  const groups = [];
  for (const bucket of CHART_METRIC_BUCKETS) {
    /** @type {Array<{ id: string, label: string, categoryId: string, fieldKey: string, unit: string }>} */
    const items = [];
    for (const catId of bucket.categoryIds) {
      const c = CATEGORIES.find((x) => x.id === catId);
      if (!c) continue;
      for (const f of c.fields) {
        if (f.type !== "number") continue;
        const metricName = stripFieldUnit(String(f.label || f.key || "数值"));
        items.push({
          id: `${c.id}.${f.key}`,
          label: `${c.emoji} ${c.label} · ${metricName}`,
          categoryId: c.id,
          fieldKey: f.key,
          unit: inferMetricUnit(f),
        });
      }
    }
    if (items.length) groups.push({ key: bucket.key, title: bucket.title, emoji: bucket.emoji, items });
  }
  return groups;
}

/**
 * 将总分钟数格式化为「天 / 小时 / 分钟」可读文案（用于统计、图表、摘要等）。
 * @param {number|string} totalMin
 */
function formatDurationMinutes(totalMin) {
  let n = Math.round(Number(totalMin) || 0);
  if (n < 0) n = 0;
  if (n === 0) return "0 分钟";
  const days = Math.floor(n / 1440);
  const remD = n % 1440;
  const hours = Math.floor(remD / 60);
  const mins = remD % 60;
  /** @type {string[]} */
  const parts = [];
  if (days) parts.push(`${days} 天`);
  if (hours) parts.push(`${hours} 小时`);
  if (mins > 0 || parts.length === 0) parts.push(`${mins} 分钟`);
  return parts.join(" ");
}

/**
 * 图表 Y 轴刻度用较短文案，避免挤占画布。
 * @param {number} minutes
 */
function formatDurationAxisTick(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m < 60) return `${m} 分`;
  if (m < 1440) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return mm ? `${h} 时${mm} 分` : `${h} 时`;
  }
  const d = Math.floor(m / 1440);
  const r = m % 1440;
  const h = Math.floor(r / 60);
  const mm = r % 60;
  if (h && mm) return `${d} 天${h} 时`;
  if (h) return `${d} 天${h} 时`;
  if (mm) return `${d} 天${mm} 分`;
  return `${d} 天`;
}

function formatChartValueForUnit(unit, n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  if (unit === "°C") return x.toFixed(1);
  if (unit === "kg") return x.toFixed(2);
  if (unit === "cm") return x.toFixed(1);
  if (unit === "ml") return String(Math.round(x));
  if (unit === "分钟") return formatDurationMinutes(x);
  return Number.isInteger(x) ? String(x) : x.toFixed(1);
}

function withChartUnit(unit, n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  if (unit === "分钟") return formatDurationMinutes(Number(n));
  const v = formatChartValueForUnit(unit, n);
  if (v === "—") return "—";
  return unit ? `${v} ${unit}` : v;
}

function isChartBodyMetric(metric) {
  if (!metric) return false;
  if (metric.categoryId === "temperature") return true;
  if (metric.categoryId === "growth") return true;
  return false;
}

/**
 * @param {{ unit?: string, categoryId?: string, fieldKey?: string }} metric
 * @param {Array<{ label: string, value: number }>} points
 */
function computeTrendSummary(metric, points) {
  const vals = points.map((p) => Number(p.value) || 0);
  const count = vals.length;
  if (count === 0) {
    return { primary: "—", secondary: "本范围内没有可用的数值点", sum: 0, mean: 0, min: 0, max: 0, count: 0 };
  }
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / count;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const u = metric.unit || "";
  const body = isChartBodyMetric(metric);
  const primary = body ? `平均 ${withChartUnit(u, mean)}` : `合计 ${withChartUnit(u, sum)}`;
  const secondary = [
    body ? `合计 ${withChartUnit(u, sum)}` : `日均 ${withChartUnit(u, mean)}`,
    `高 ${withChartUnit(u, max)}`,
    `低 ${withChartUnit(u, min)}`,
    `${count} 个数据点`,
  ].join(" · ");
  return { primary, secondary, sum, mean, min, max, count };
}

/**
 * @param {{ categoryId?: string, fieldKey?: string }} metric
 * @param {number[]} vals
 */
function getSmartYRange(metric, vals) {
  if (!vals.length) return { minY: 0, maxY: 10 };
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals);
  const key = String(metric.fieldKey || "");
  const cat = metric.categoryId || "";
  const natural =
    key === "celsius" ||
    (cat === "growth" && ["weightKg", "heightCm", "headCm"].includes(key));
  if (natural) {
    const span = Math.max(maxV - minV, 1e-9);
    let pad = span * 0.12;
    if (key === "celsius") pad = Math.max(pad, 0.15);
    if (cat === "growth") pad = Math.max(pad, span * 0.08);
    let yMin = minV - pad;
    let yMax = maxV + pad;
    if (maxV === minV) {
      const bump = key === "celsius" ? 0.5 : Math.max(Math.abs(maxV) * 0.04, 0.4);
      yMin = minV - bump;
      yMax = maxV + bump;
    }
    return { minY: yMin, maxY: yMax };
  }
  const maxY = Math.max(10, maxV);
  return { minY: 0, maxY };
}

function readCssColorVar(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) return v;
  } catch {
    /* ignore */
  }
  return fallback;
}

/**
 * @param {{ id?: string, categoryId?: string, fieldKey?: string }|null} metric
 */
function getChartLineCssColor(metric) {
  if (!metric) return TREND_LINE_COLOR;
  const id = String(metric.id || "");
  if (id.startsWith("cry.")) return readCssColorVar("--chart-line-care", TREND_LINE_COLOR);
  if (id.includes("celsius")) return readCssColorVar("--chart-line-accent", TREND_LINE_COLOR);
  if (id.startsWith("sleep.") || id.startsWith("outdoor.") || id.startsWith("tummy_time.")) {
    return readCssColorVar("--chart-line-good", TREND_LINE_COLOR);
  }
  if (id.startsWith("medicine")) return readCssColorVar("--chart-line-care", TREND_LINE_COLOR);
  return readCssColorVar("--chart-line", TREND_LINE_COLOR);
}

function hexToRgba(hex, alpha) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(String(hex || "").trim());
  if (!m) return `rgba(107, 114, 128, ${alpha})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
}

function cssColorToRgba(color, alpha) {
  const c = String(color || "").trim();
  if (c.startsWith("#")) return hexToRgba(c, alpha);
  const m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(c);
  if (m) return `rgba(${m[1]},${m[2]},${m[3]},${alpha})`;
  return `rgba(107, 114, 128, ${alpha})`;
}

function stripFieldUnit(label) {
  // Remove trailing unit hints like "(ml)" / "（分钟）" for display labels.
  return String(label).replace(/\s*[（(][^()（）]{1,10}[)）]\s*$/u, "").trim();
}

function inferMetricUnit(field) {
  const key = String(field.key || "");
  const label = String(field.label || "");
  if (key.includes("amountMl") || label.includes("ml")) return "ml";
  if (key.includes("durationMin") || label.includes("分钟")) return "分钟";
  if (key.includes("celsius") || label.includes("°C")) return "°C";
  if (key.includes("weightKg") || label.includes("kg")) return "kg";
  if (key.includes("heightCm") || key.includes("headCm") || label.includes("cm")) return "cm";
  return "数值";
}

let editingId = null;
let pendingCategoryId = null;
/** @type {string[]} */
let modalPhotos = [];

/**
 * Upload image files to backend object storage; returns public URLs (/media/...).
 * @param {File[]} files
 * @returns {Promise<string[]>}
 */
async function uploadPhotosToServer(files) {
  const form = new FormData();
  for (const f of files) {
    form.append("file", f);
  }
  const res = await fetch(`${API_ORIGIN}/api/uploads`, {
    method: "POST",
    headers: authHeaders(),
    credentials: "include",
    body: form,
  });
  if (res.status === 401 && authState.user && !authState.localOnly) {
    clearAuth();
    showAuthOverlay("login", "登录状态已过期，请重新登录");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `upload ${res.status}`);
  }
  const urls = data.urls;
  if (!Array.isArray(urls)) throw new Error("invalid upload response");
  return urls;
}

function renderPhotoPreviews(form) {
  const wrap = form.querySelector("#photo-previews");
  if (!wrap) return;
  wrap.innerHTML = "";
  modalPhotos.forEach((url, idx) => {
    const item = document.createElement("div");
    item.className = "photo-preview-item";
    const img = document.createElement("img");
    img.src = url;
    img.alt = `照片 ${idx + 1}`;
    img.className = "photo-preview-thumb";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "photo-preview-remove";
    btn.textContent = "×";
    btn.title = "移除";
    btn.addEventListener("click", () => {
      modalPhotos.splice(idx, 1);
      renderPhotoPreviews(form);
    });
    item.appendChild(img);
    item.appendChild(btn);
    wrap.appendChild(item);
  });
}

async function onModalPhotosSelected(input) {
  const files = [...(input.files || [])];
  input.value = "";
  const form = document.getElementById("modal-form");
  if (!apiReady) {
    alert("上传照片需要先启动后端：图片会保存到服务端对象存储，数据库只存 URL。");
    return;
  }
  const room = MAX_ENTRY_PHOTOS - modalPhotos.length;
  if (room <= 0) {
    alert(`最多添加 ${MAX_ENTRY_PHOTOS} 张照片`);
    return;
  }
  /** @type {File[]} */
  const candidates = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      alert(`已跳过非图片文件: ${file.name}`);
      continue;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      alert(`图片过大（>${MAX_PHOTO_BYTES / 1024 / 1024}MB），已跳过: ${file.name}`);
      continue;
    }
    if (candidates.length >= room) {
      alert(`最多再添加 ${room} 张（合计 ${MAX_ENTRY_PHOTOS} 张上限）`);
      break;
    }
    candidates.push(file);
  }
  if (!candidates.length) return;
  try {
    const urls = await uploadPhotosToServer(candidates);
    modalPhotos.push(...urls);
  } catch (e) {
    alert(`照片上传失败：${e instanceof Error ? e.message : String(e)}`);
  }
  renderPhotoPreviews(form);
}

function openModal(categoryId, existing) {
  pendingCategoryId = categoryId;
  editingId = existing ? existing.id : null;
  modalPhotos = existing && Array.isArray(existing.photos) ? [...existing.photos] : [];
  const cat = getCategory(categoryId);
  const overlay = document.getElementById("modal-overlay");
  const title = document.getElementById("modal-title");
  const form = document.getElementById("modal-form");
  title.textContent = existing ? `编辑 · ${cat.label}` : `记录 · ${cat.label}`;

  form.innerHTML = "";

  const atRow = document.createElement("div");
  atRow.className = "form-row";
  atRow.innerHTML = `
    <label for="field-at">时间</label>
    <input type="datetime-local" id="field-at" name="at" step="60" />
  `;
  form.appendChild(atRow);

  const atInput = /** @type {HTMLInputElement} */ (atRow.querySelector("#field-at"));
  const d = existing ? new Date(existing.at) : new Date();
  const pad = (n) => String(n).padStart(2, "0");
  atInput.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  for (const f of cat.fields) {
    const row = document.createElement("div");
    row.className = "form-row";
    if (f.type === "select") {
      const opts = f.options.map((o) => `<option value="${o.v}">${o.t}</option>`).join("");
      row.innerHTML = `
        <label for="field-${f.key}">${f.label}</label>
        <select id="field-${f.key}" name="${f.key}">${opts}</select>
      `;
    } else if (f.type === "number") {
      row.innerHTML = `
        <label for="field-${f.key}">${f.label}</label>
        <input type="number" id="field-${f.key}" name="${f.key}" step="${f.step || "1"}" placeholder="${f.placeholder || ""}" />
      `;
    } else {
      row.innerHTML = `
        <label for="field-${f.key}">${f.label}</label>
        <input type="text" id="field-${f.key}" name="${f.key}" placeholder="${f.placeholder || ""}" />
      `;
    }
    form.appendChild(row);
  }

  const noteRow = document.createElement("div");
  noteRow.className = "form-row";
  noteRow.innerHTML = `
    <label for="field-note">备注</label>
    <textarea id="field-note" name="note" placeholder="可选"></textarea>
  `;
  form.appendChild(noteRow);

  const photoRow = document.createElement("div");
  photoRow.className = "form-row";
  photoRow.innerHTML = `
    <label for="field-photos">照片（可选，最多 ${MAX_ENTRY_PHOTOS} 张）</label>
    <input type="file" id="field-photos" accept="image/*" multiple />
    <div id="photo-previews" class="photo-previews" aria-live="polite"></div>
  `;
  form.appendChild(photoRow);
  renderPhotoPreviews(form);
  const photoInput = /** @type {HTMLInputElement} */ (photoRow.querySelector("#field-photos"));
  photoInput.addEventListener("change", () => onModalPhotosSelected(photoInput));

  if (existing) {
    const flds = existing.fields || {};
    for (const f of cat.fields) {
      const el = form.querySelector(`[name="${f.key}"]`);
      if (el && flds[f.key] != null) el.value = String(flds[f.key]);
    }
    const noteEl = form.querySelector("#field-note");
    if (noteEl) noteEl.value = existing.note || "";
  }

  initCustomDropdowns();
  overlay.classList.add("open");
}

function closeModal() {
  document.getElementById("modal-overlay").classList.remove("open");
  pendingCategoryId = null;
  editingId = null;
  modalPhotos = [];
}

function collectForm() {
  const form = document.getElementById("modal-form");
  const cat = getCategory(pendingCategoryId);
  const atEl = /** @type {HTMLInputElement} */ (form.querySelector("#field-at"));
  const at = atEl.value ? new Date(atEl.value).toISOString() : new Date().toISOString();
  /** @type {Record<string, string|number>} */
  const fields = {};
  for (const f of cat.fields) {
    const el = form.querySelector(`[name="${f.key}"]`);
    if (!el) continue;
    const val = /** @type {HTMLInputElement|HTMLSelectElement} */ (el).value.trim();
    if (val === "") continue;
    if (f.type === "number") {
      const n = parseFloat(val);
      if (!Number.isNaN(n)) fields[f.key] = n;
    } else {
      fields[f.key] = val;
    }
  }
  const noteEl = /** @type {HTMLTextAreaElement} */ (form.querySelector("#field-note"));
  const note = noteEl ? noteEl.value.trim() : "";
  return { at, fields, note, photos: [...modalPhotos] };
}

async function submitModal() {
  if (!pendingCategoryId) return;
  const { at, fields, note, photos } = collectForm();
  let changedEntry = null;
  if (editingId) {
    const idx = entries.findIndex((e) => e.id === editingId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], categoryId: pendingCategoryId, at, fields, note, photos };
      changedEntry = entries[idx];
    }
  } else {
    changedEntry = {
      id: crypto.randomUUID(),
      categoryId: pendingCategoryId,
      at,
      fields,
      note,
      photos,
    };
    entries.push(changedEntry);
  }
  entries.sort((a, b) => new Date(b.at) - new Date(a.at));
  if (apiReady && changedEntry) {
    try {
      if (editingId) {
        await apiRequest(`/entries/${changedEntry.id}`, {
          method: "PUT",
          body: JSON.stringify(mapEntryToApi(changedEntry)),
        });
      } else {
        const created = await apiRequest("/entries", {
          method: "POST",
          body: JSON.stringify(mapEntryToApi(changedEntry)),
        });
        if (created?.id) changedEntry.id = created.id;
      }
    } catch {
      apiReady = false;
      save();
      alert("后端暂不可用，已回退到本地存储。");
    }
  } else {
    save();
  }
  closeModal();
  renderAfterEntriesMutated();
}

async function deleteEntry(id) {
  entries = entries.filter((e) => e.id !== id);
  if (apiReady) {
    try {
      await apiRequest(`/entries/${id}`, { method: "DELETE" });
    } catch {
      apiReady = false;
      save();
    }
  } else {
    save();
  }
  renderAfterEntriesMutated();
  showToast("已删除");
}

function renderCategories() {
  const grid = document.getElementById("category-grid");
  grid.innerHTML = "";
  for (const c of CATEGORIES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cat-btn";
    btn.innerHTML = `<span class="emoji">${c.emoji}</span><span>${c.label}</span>`;
    btn.addEventListener("click", () => openModal(c.id, null));
    grid.appendChild(btn);
  }
}

const GENDER_MAP = { boy: "\u7537", girl: "\u5973" };

function renderProfile() {
  const nameEl = /** @type {HTMLInputElement} */ (document.getElementById("baby-name"));
  const birthEl = /** @type {HTMLInputElement} */ (document.getElementById("baby-birth"));
  const genderEl = /** @type {HTMLSelectElement} */ (document.getElementById("baby-gender"));
  const bloodEl = /** @type {HTMLInputElement} */ (document.getElementById("baby-blood"));

  nameEl.value = profile.name || "";
  birthEl.value = profile.birthDate || "";
  genderEl.value = profile.gender || "";
  bloodEl.value = profile.blood || "";

  const nameText = profile.name || "\u5b9d\u5b9d\u6863\u6848";
  const ageText = getAgeText();
  const initial = profile.name ? profile.name.trim().slice(0, 1).toUpperCase() : "\u5b9d";

  const avatarEl = document.getElementById("profile-avatar-display");
  if (avatarEl) {
    avatarEl.textContent = "";
    if (profile.avatar) {
      const img = document.createElement("img");
      img.src = profile.avatar;
      img.alt = nameText;
      avatarEl.appendChild(img);
    } else {
      avatarEl.textContent = initial;
    }
  }

  const summaryEl = document.getElementById("profile-summary");
  if (summaryEl) {
    const nameDisplay = summaryEl.querySelector(".profile-name-display");
    const ageDisplay = summaryEl.querySelector(".profile-age-display");
    if (nameDisplay) nameDisplay.textContent = nameText;
    if (ageDisplay) ageDisplay.textContent = profile.birthDate ? ageText : "\u8bbe\u7f6e\u751f\u65e5\u540e\u663e\u793a\u6708\u9f84";
  }

  const dn = document.getElementById("profile-d-name");
  const db = document.getElementById("profile-d-birth");
  const dg = document.getElementById("profile-d-gender");
  const dbl = document.getElementById("profile-d-blood");
  if (dn) dn.textContent = profile.name || "\u2014";
  if (db) db.textContent = profile.birthDate || "\u2014";
  if (dg) dg.textContent = GENDER_MAP[profile.gender] || "\u2014";
  if (dbl) dbl.textContent = profile.blood || "\u2014";

  syncProfileEditState();
}

function setProfileEditing(editing) {
  profileEditorOpen = editing;
  syncProfileEditState();
}

function syncProfileEditState() {
  const mod = document.getElementById("module-profile");
  if (!mod) return;
  mod.classList.toggle("is-editing", profileEditorOpen);
}

async function saveProfileFromForm() {
  profile = {
    name: /** @type {HTMLInputElement} */ (document.getElementById("baby-name")).value.trim(),
    birthDate: /** @type {HTMLInputElement} */ (document.getElementById("baby-birth")).value,
    gender: /** @type {HTMLSelectElement} */ (document.getElementById("baby-gender")).value,
    blood: /** @type {HTMLInputElement} */ (document.getElementById("baby-blood")).value.trim(),
    avatar: profile.avatar || "",
  };
  if (apiReady) {
    try {
      await apiRequest("/profile", {
        method: "PUT",
        body: JSON.stringify({
          name: profile.name,
          birth_date: profile.birthDate,
          gender: profile.gender,
          blood: profile.blood,
        }),
      });
    } catch {
      apiReady = false;
      saveProfile();
      showToast("后端不可用，已存到本地");
    }
  }
  saveProfile();
  setProfileEditing(false);
  renderProfile();
  renderVaccines();
  showToast("已保存");
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

async function handleAvatarChange(ev) {
  const input = /** @type {HTMLInputElement} */ (ev.target);
  const file = input.files && input.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    alert("请选择图片文件");
    input.value = "";
    return;
  }
  if (file.size > 2 * 1024 * 1024) {
    alert("头像文件请控制在 2MB 以内");
    input.value = "";
    return;
  }
  try {
    const dataUrl = await readFileAsDataURL(file);
    profile.avatar = dataUrl;
    saveProfile();
    renderProfile();
  } catch {
    alert("头像读取失败，请重试");
  } finally {
    input.value = "";
  }
}

function clearAvatar() {
  profile.avatar = "";
  saveProfile();
  renderProfile();
}

function toggleProfileEditor() {
  profileEditorOpen = !profileEditorOpen;
  renderProfile();
}

function renderModuleSummaries() {
  const vaccineSummary = document.getElementById("vaccine-module-summary");
  const quickSummary = document.getElementById("quick-module-summary");
  const timelineSummary = document.getElementById("timeline-module-summary");
  const gallerySummary = document.getElementById("gallery-module-summary");

  if (vaccineSummary) {
    const doneCount = vaccines.filter((v) => v.status === "done").length;
    const todoCount = vaccines.length - doneCount;
    const nextTodo = vaccines
      .filter((v) => v.status !== "done")
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];
    vaccineSummary.innerHTML = `
      <span class="module-summary-item">计划总数 <strong>${vaccines.length}</strong></span>
      <span class="module-summary-item">已完成 <strong>${doneCount}</strong></span>
      <span class="module-summary-item">待完成 <strong>${Math.max(0, todoCount)}</strong></span>
      <span class="module-summary-item">下一针 <strong>${nextTodo ? nextTodo.dueDate : "暂无"}</strong></span>
    `;
  }

  if (quickSummary) {
    const todayKey = toLocalDateKey(new Date());
    const todayCount = entries.filter((e) => toLocalDateKey(e.at) === todayKey).length;
    quickSummary.innerHTML = `
      <span class="module-summary-item">记录分类 <strong>${CATEGORIES.length}</strong></span>
      <span class="module-summary-item">今日新增 <strong>${todayCount}</strong></span>
      <span class="module-summary-item">累计记录 <strong>${entries.length}</strong></span>
    `;
  }

  if (timelineSummary) {
    const latest = entries[0];
    timelineSummary.innerHTML = `
      <span class="module-summary-item">总记录 <strong>${entries.length}</strong></span>
      <span class="module-summary-item">最近记录 <strong>${latest ? `${formatDateHeader(latest.at)} ${formatTime(latest.at)}` : "暂无"}</strong></span>
    `;
  }

  if (gallerySummary) {
    const photos = collectGalleryPhotosFromEntries(entries, getCategory);
    const daySet = new Set(photos.map((p) => toLocalDateKey(p.at)));
    const latestPhoto = photos[0];
    gallerySummary.innerHTML = `
      <span class="module-summary-item">${photos.length} <strong>张</strong></span>
      <span class="module-summary-item">${daySet.size} <strong>天</strong></span>
      <span class="module-summary-item">最近 <strong>${latestPhoto ? formatDateHeader(latestPhoto.at) : "\u2014"}</strong></span>
    `;
  }

  const aiSummary = document.getElementById("ai-module-summary");
  if (aiSummary) {
    const active = getActiveAiSession();
    const userTurns = active ? active.messages.filter((m) => m.role === "user").length : 0;
    const policy = aiProject.contextPolicy || "full_recent";
    const policyShort =
      policy === "recent_7d"
        ? "最近 7 天"
        : policy === "timeline_filter"
          ? "与筛选一致"
          : policy === "stats_only"
            ? "仅统计"
            : "最近记录";
    aiSummary.innerHTML = `
      <span class="module-summary-item">会话数 <strong>${aiProject.sessions.length}</strong></span>
      <span class="module-summary-item">用户消息 <strong>${userTurns}</strong></span>
      <span class="module-summary-item">上下文 <strong>${policyShort}</strong></span>
    `;
  }
}

function getPreviousRange(start, end) {
  if (!start || !end) return null;
  const startDate = new Date(`${start}T00:00:00`);
  const endDate = new Date(`${end}T00:00:00`);
  const spanDays = Math.max(1, Math.floor((endDate - startDate) / 86400000) + 1);
  const prevEnd = new Date(startDate);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - (spanDays - 1));
  return { start: toLocalDateKey(prevStart), end: toLocalDateKey(prevEnd), spanDays };
}

function formatDelta(current, prev) {
  if (prev <= 0) {
    if (current > 0) return { text: "新增", tone: "new", arrow: "◆" };
    return { text: "持平", tone: "flat", arrow: "→" };
  }
  const pct = Math.round(((current - prev) / prev) * 100);
  if (Math.abs(pct) <= 2) return { text: "持平", tone: "flat", arrow: "→" };
  if (pct > 0) return { text: `+${pct}%`, tone: "up", arrow: "↗" };
  return { text: `${pct}%`, tone: "down", arrow: "↘" };
}

function summarizeAttention(inRangeEntries, dayCount) {
  const notes = [];
  const medicineCount = inRangeEntries.filter((e) => e.categoryId === "medicine").length;
  const sleepMin = inRangeEntries
    .filter((e) => e.categoryId === "sleep")
    .reduce((sum, e) => sum + (Number(e.fields?.durationMin) || 0), 0);
  const avgSleep = dayCount > 0 ? sleepMin / dayCount : 0;
  if (medicineCount >= Math.max(2, Math.ceil(dayCount / 2))) notes.push("用药记录较频繁");
  if (dayCount >= 3 && avgSleep > 0 && avgSleep < 180) notes.push("日均睡眠偏低");
  const coveredDays = new Set(inRangeEntries.map((e) => toLocalDateKey(e.at))).size;
  const missingDays = Math.max(0, dayCount - coveredDays);
  if (dayCount >= 3 && missingDays >= 2) notes.push(`缺少 ${missingDays} 天记录`);
  return notes.length ? notes.join(" · ") : "暂无明显异常";
}

function openStatsMetric(metricId) {
  if (!metricId) return;
  statsMode = "chart";
  chartMetricId = metricId;
  renderStats();
}

function syncStatsModeButtons() {
  document.querySelectorAll(".stats-mode-btn").forEach((btn) => {
    const mode = btn.getAttribute("data-mode") || "cards";
    const active = mode === statsMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function renderStats() {
  const grid = document.getElementById("stats-grid");
  const chartWrap = document.getElementById("stats-chart-wrap");
  const rangeHint = document.getElementById("stats-range-hint");
  if (!grid || !chartWrap) return;

  const inRangeEntries = getEntriesByRange(statsRange.start, statsRange.end);
  const prevRange = getPreviousRange(statsRange.start, statsRange.end);
  const prevEntries = prevRange ? getEntriesByRange(prevRange.start, prevRange.end) : [];
  const cur = accumulateRangeStats(inRangeEntries);
  const prev = accumulateRangeStats(prevEntries);
  const rangeStartDate = statsRange.start ? new Date(`${statsRange.start}T00:00:00`) : null;
  const rangeEndDate = statsRange.end ? new Date(`${statsRange.end}T00:00:00`) : null;
  const dayCount = rangeStartDate && rangeEndDate
    ? Math.max(1, Math.floor((rangeEndDate - rangeStartDate) / 86400000) + 1)
    : cur.dayKeys.size || 1;
  const feedMl = cur.feedMl;
  const prevFeedMl = prev.feedMl;
  const sleepMin = cur.sleepMin;
  const prevSleepMin = prev.sleepMin;
  const wetCount = cur.wetCount;
  const dirtyCount = cur.dirtyCount;
  const diaperCount = cur.diaperCount;
  const prevDiaperCount = prev.diaperCount;
  const bathCount = cur.bathCount;
  const medicineCount = cur.medicineCount;
  const prevMedicineCount = prev.medicineCount;
  const solidCount = cur.solidCount;
  const prevSolidCount = prev.solidCount;
  const spitupCount = cur.spitupCount;
  const supplementCount = cur.supplementCount;
  const prevSupplementCount = prev.supplementCount;
  const pumpCount = cur.pumpCount;
  const prevPumpCount = prev.pumpCount;
  const pumpMl = cur.pumpMl;
  const prevPumpMl = prev.pumpMl;
  const customCount = cur.customCount;
  const tummyMin = cur.tummyMin;
  const prevTummyMin = prev.tummyMin;
  const outdoorMin = cur.outdoorMin;
  const prevOutdoorMin = prev.outdoorMin;
  const cryMin = cur.cryMin;
  const prevCryMin = prev.cryMin;
  const tempEntries = cur.latestTempEntry ? [cur.latestTempEntry] : [];
  const prevTempCount = prev.tempCount;
  const latestTemp = tempEntries.length ? Number(tempEntries[0].fields?.celsius) || null : null;
  const growthCount = cur.growthCount;
  const prevGrowthCount = prev.growthCount;
  const lg = cur.latestGrowthEntry;
  let growthMain = "暂无";
  let growthSub = "本范围内无生长测量";
  /** @type {string} */
  let growthMetricId = "";
  if (lg) {
    const gf = lg.fields || {};
    const wRaw = gf.weightKg;
    const hRaw = gf.heightCm;
    const headRaw = gf.headCm;
    const w = wRaw !== "" && wRaw != null && !Number.isNaN(Number(wRaw)) ? Number(wRaw) : null;
    const h = hRaw !== "" && hRaw != null && !Number.isNaN(Number(hRaw)) ? Number(hRaw) : null;
    const head = headRaw !== "" && headRaw != null && !Number.isNaN(Number(headRaw)) ? Number(headRaw) : null;
    const parts = [];
    if (w != null) {
      parts.push(`体重 ${w} kg`);
      growthMetricId = "growth.weightKg";
    }
    if (h != null) {
      parts.push(`身长 ${h} cm`);
      if (!growthMetricId) growthMetricId = "growth.heightCm";
    }
    if (head != null) {
      parts.push(`头围 ${head} cm`);
      if (!growthMetricId) growthMetricId = "growth.headCm";
    }
    growthMain = w != null ? `${w} kg` : h != null ? `${h} cm` : head != null ? `${head} cm` : "已记录";
    growthSub = parts.length ? parts.join(" · ") : `共 ${growthCount} 次`;
  }
  const doneVaccines = vaccines.filter((v) => v.status === "done").length;
  const rangeLabel = statsRange.start && statsRange.end ? `${statsRange.start} 至 ${statsRange.end}` : "全部时间";

  if (rangeHint) {
    rangeHint.textContent = `当前范围：${rangeLabel}`;
    rangeHint.classList.remove("is-error");
  }

  const insightText = summarizeAttention(inRangeEntries, dayCount);

  const iconMap = {
    records: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="4" width="14" height="16" rx="2"></rect><path d="M9 9h6M9 13h6"></path></svg>',
    feeding: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3v7a4 4 0 1 0 8 0V3"></path><path d="M10 7h8"></path><path d="M14 14v7"></path></svg>',
    sleep: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 14a6 6 0 1 1-8-8 5 5 0 1 0 8 8z"></path></svg>',
    diaper: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9a8 8 0 0 1 16 0v6H4z"></path><path d="M8 15v3M16 15v3"></path></svg>',
    attention: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4"></path><path d="M12 17h.01"></path><circle cx="12" cy="12" r="9"></circle></svg>',
    medicine: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="10" width="18" height="4" rx="2"></rect><path d="M9 10V6M15 14v4"></path></svg>',
    temperature: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a2 2 0 0 0-2 2v7.5a4 4 0 1 0 4 0V6a2 2 0 0 0-2-2z"></path><path d="M12 12v4"></path></svg>',
    solid: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"></path><path d="M7 8h10"></path><path d="M9 16h6"></path></svg>',
    cry: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 15c1 1 2 1.5 4 1.5s3-.5 4-1.5"></path><circle cx="9" cy="10" r="1"></circle><circle cx="15" cy="10" r="1"></circle><circle cx="12" cy="12" r="8"></circle></svg>',
    outdoor: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2"></path></svg>',
    tummy: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14c2.5-2 5.5-3 8-3s5.5 1 8 3"></path><path d="M7 10l2-2M17 10l-2-2"></path></svg>',
    bath: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11h16"></path><path d="M6 11v3a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-3"></path><path d="M8 8V6a2 2 0 0 1 4 0"></path></svg>',
    growth: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16"></path><path d="M7 20V10l3-3 3 3v10M14 20V6l3-2 3 2v14"></path></svg>',
    supplement: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="2.5"></circle><path d="M12 4v3M12 17v3M5 12h3M16 12h3"></path></svg>',
    pump: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5h6a2 2 0 0 1 2 2v9H7V7a2 2 0 0 1 2-2z"></path><path d="M12 16v4"></path></svg>',
    custom: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12M6 12h8M6 17h10"></path></svg>',
    spitup: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor" stroke="none"><path d="M12 3c-3 4-5 7-5 10a5 5 0 0 0 10 0c0-3-2-6-5-10z"></path></svg>',
  };

  const renderCard = (c) => {
    const clickable = c.metricId ? " stat-card--clickable" : "";
    const heroClass = c.hero ? " stat-card--hero" : "";
    const extraClass = c.cardClass ? ` ${c.cardClass}` : "";
    const attrs = c.metricId ? ` data-metric-id="${c.metricId}"` : "";
    const keyHeader = c.icon
      ? `<div class="stat-k-row"><span class="stat-k-icon">${iconMap[c.icon] || ""}</span><span class="k">${c.k}</span></div>`
      : `<div class="k">${c.k}</div>`;
    const deltaHtml = c.delta
      ? `<div class="stat-delta stat-delta--${c.delta.tone || "flat"}"><span class="stat-delta-arrow">${c.delta.arrow || "→"}</span>${c.delta.text} vs 上周期</div>`
      : "";
    return `<div class="stat-card ${c.tone || ""}${clickable}${heroClass}${extraClass}"${attrs}>${keyHeader}<div class="v">${c.v}</div>${c.sub ? `<div class="stat-sub">${c.sub}</div>` : ""}${deltaHtml}</div>`;
  };

  const summaryCards = [
    {
      k: "喂奶总量",
      v: `${feedMl} ml`,
      sub: `日均 ${Math.round(feedMl / dayCount)} ml`,
      delta: formatDelta(feedMl, prevFeedMl),
      tone: "priority",
      metricId: "feeding.amountMl",
      icon: "feeding",
      hero: true,
    },
    {
      k: "睡眠时长",
      v: formatDurationMinutes(sleepMin),
      sub: `日均 ${formatDurationMinutes(Math.round(sleepMin / dayCount))}`,
      delta: formatDelta(sleepMin, prevSleepMin),
      tone: "priority",
      metricId: "sleep.durationMin",
      icon: "sleep",
      hero: true,
    },
    {
      k: "尿布",
      v: `小便 ${wetCount} / 大便 ${dirtyCount}`,
      sub: `换片共 ${diaperCount} 次`,
      delta: formatDelta(diaperCount, prevDiaperCount),
      tone: "priority",
      icon: "diaper",
      hero: true,
    },
    {
      k: "最近体温",
      v: latestTemp != null ? `${latestTemp.toFixed(1)} °C` : tempEntries.length ? "—" : "暂无",
      sub: tempEntries.length ? `记录 ${tempEntries.length} 次` : "本范围内无体温记录",
      delta: formatDelta(tempEntries.length, prevTempCount),
      tone: "priority",
      metricId: cur.tempCount ? "temperature.celsius" : "",
      icon: "temperature",
      hero: true,
    },
    {
      k: "生长测量",
      v: growthMain,
      sub: growthSub,
      delta: formatDelta(growthCount, prevGrowthCount),
      tone: "priority",
      metricId: growthMetricId,
      icon: "growth",
      hero: true,
    },
  ];

  const nutritionCards = [
    {
      k: "辅食次数",
      v: `${solidCount} 次`,
      delta: formatDelta(solidCount, prevSolidCount),
      icon: "solid",
    },
  ];

  const medicalCards = [
    {
      k: "用药次数",
      v: `${medicineCount} 次`,
      delta: formatDelta(medicineCount, prevMedicineCount),
      icon: "medicine",
    },
    {
      k: "补剂次数",
      v: `${supplementCount} 次`,
      delta: formatDelta(supplementCount, prevSupplementCount),
      icon: "supplement",
    },
  ];

  const activityCards = [
    { k: "洗澡次数", v: `${bathCount} 次`, icon: "bath" },
    {
      k: "趴玩时长",
      v: formatDurationMinutes(tummyMin),
      sub: `日均 ${formatDurationMinutes(Math.round(tummyMin / dayCount))}`,
      delta: formatDelta(tummyMin, prevTummyMin),
      metricId: "tummy_time.durationMin",
      icon: "tummy",
    },
    {
      k: "外出时长",
      v: formatDurationMinutes(outdoorMin),
      sub: `日均 ${formatDurationMinutes(Math.round(outdoorMin / dayCount))}`,
      delta: formatDelta(outdoorMin, prevOutdoorMin),
      metricId: "outdoor.durationMin",
      icon: "outdoor",
    },
    {
      k: "哭闹时长",
      v: formatDurationMinutes(cryMin),
      sub: `日均 ${formatDurationMinutes(Math.round(cryMin / dayCount))}`,
      delta: formatDelta(cryMin, prevCryMin),
      metricId: "cry.durationMin",
      icon: "cry",
    },
    { k: "吐奶/溢奶", v: `${spitupCount} 次`, icon: "spitup" },
  ];

  const caregiverCards = [
    {
      k: "吸奶",
      v: pumpCount ? `${pumpMl} ml` : "暂无",
      sub: pumpCount ? `共 ${pumpCount} 次` : "",
      delta: formatDelta(pumpMl, prevPumpMl),
      metricId: pumpCount ? "pump.amountMl" : "",
      icon: "pump",
    },
  ];

  const otherCards = [
    { k: "自由记录（其他）", v: `${customCount} 条`, icon: "custom" },
  ];

  const qualityCards = [
    { k: "疫苗完成进度", v: vaccines.length ? `${doneVaccines}/${vaccines.length}` : "未生成", tone: "muted", icon: "records" },
    {
      k: "本范围记录数",
      v: `${inRangeEntries.length} 条`,
      sub: `日均 ${(inRangeEntries.length / dayCount).toFixed(1)} 条`,
      delta: formatDelta(inRangeEntries.length, prevEntries.length),
      icon: "records",
    },
    { k: "累计总记录", v: `${entries.length} 条`, tone: "muted", icon: "records" },
  ];

  const browseGrid = "stats-section-grid stats-section-grid--compact";

  const insightHtml = `
    <div class="stats-insight" role="status">
      <span class="stats-insight-icon" aria-hidden="true">${iconMap.attention}</span>
      <p class="stats-insight-text">${escapeHtml(insightText)}</p>
    </div>`;

  const summarySection = `
    <section class="stats-section stats-section--summary">
      <header class="stats-section-head">
        <h3 class="stats-section-title">本周期摘要</h3>
        <span class="stats-section-count">${summaryCards.length} 项</span>
      </header>
      <p class="stats-section-subtitle">节律与身体测量优先；点按带趋势的数据可查看图表。</p>
      <div class="stats-summary-grid">${summaryCards.map(renderCard).join("")}</div>
    </section>`;

  const browseSection = (title, subtitle, cardList) => {
    if (!cardList.length) return "";
    return `
      <section class="stats-section">
        <header class="stats-section-head">
          <h3 class="stats-section-title">${title}</h3>
          <span class="stats-section-count">${cardList.length} 项</span>
        </header>
        ${subtitle ? `<p class="stats-section-subtitle">${subtitle}</p>` : ""}
        <div class="${browseGrid}">${cardList.map(renderCard).join("")}</div>
      </section>`;
  };

  const collapsibleBrowse = (title, subtitle, cardList) => {
    if (!cardList.length) return "";
    return `
      <details class="stats-browse-details">
        <summary class="stats-browse-summary">
          <span class="stats-browse-summary-title">${title}</span>
          <span class="stats-browse-summary-meta">${cardList.length} 项</span>
        </summary>
        <div class="stats-browse-body">
          ${subtitle ? `<p class="stats-section-subtitle">${subtitle}</p>` : ""}
          <div class="${browseGrid}">${cardList.map(renderCard).join("")}</div>
        </div>
      </details>`;
  };

  grid.innerHTML = [
    insightHtml,
    summarySection,
    browseSection("营养", "辅食与进食过渡", nutritionCards),
    browseSection("用药与补剂", "医疗相关与例行补充", medicalCards),
    collapsibleBrowse("活动与情境", "洗澡、大运动、外出、哭闹与溢奶", activityCards),
    browseSection("照护者", "与喂养支持相关的记录", caregiverCards),
    browseSection("其他", "未归类模板", otherCards),
    collapsibleBrowse("长期与完整度", "疫苗计划与记录覆盖", qualityCards),
  ].join("");

  grid.querySelectorAll(".stat-card--clickable").forEach((card) => {
    card.addEventListener("click", () => {
      const metricId = card.getAttribute("data-metric-id") || "";
      openStatsMetric(metricId);
    });
  });

  const chartMode = statsMode === "chart";
  syncStatsModeButtons();
  if (!chartMode) hideChartMetricMenu();
  if (statsMode === "chart") {
    grid.classList.add("hidden");
    chartWrap.classList.remove("hidden");
    renderTrendChart();
  } else {
    chartWrap.classList.add("hidden");
    grid.classList.remove("hidden");
  }
}

function getChartResolutionByRange() {
  return chartResolution;
}

function getWeekStartDate(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function getAggregationLabel(mode) {
  if (mode === "day") return "按天";
  if (mode === "week") return "按周";
  if (mode === "month") return "按月";
  return "按天";
}

function syncChartResolutionButtons() {
  document.querySelectorAll(".chart-res-btn").forEach((btn) => {
    const active = btn.getAttribute("data-resolution") === chartResolution;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

/** @param {Record<string, unknown>} trend */
function updateChartPanelFromTrend(trend) {
  const titleEl = document.getElementById("chart-panel-metric-title");
  const rangeEl = document.getElementById("chart-panel-range-line");
  const aggEl = document.getElementById("chart-aggregation-subtitle");
  const pri = document.getElementById("chart-summary-primary");
  const sec = document.getElementById("chart-summary-secondary");
  const empty = document.getElementById("chart-empty-state");
  const legendText = document.getElementById("chart-legend-text");
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-chart"));
  const ml = trend.metric ? trend.metric.label : String(trend.metricLabel || "趋势");
  if (titleEl) titleEl.textContent = ml;
  if (legendText) legendText.textContent = ml;
  if (rangeEl) {
    rangeEl.textContent =
      statsRange.start && statsRange.end
        ? `日期 ${statsRange.start} — ${statsRange.end}`
        : "尚未选择具体日期范围";
  }
  if (aggEl) {
    aggEl.textContent = trend.resolutionLabel
      ? `当前为「${trend.resolutionLabel}」汇总，可与时间范围配合理解。`
      : "";
  }
  const sum = /** @type {{ primary?: string, secondary?: string }} */ (trend.summary || {});
  if (pri) pri.textContent = sum.primary || "—";
  if (sec) sec.textContent = sum.secondary || "";
  const pts = /** @type {unknown[]} */ (trend.points || []);
  const hasPoints = pts.length > 0;
  if (empty) empty.classList.toggle("hidden", hasPoints);
  if (canvas) canvas.classList.toggle("hidden", !hasPoints);
  const et = document.getElementById("chart-empty-title");
  const ed = document.getElementById("chart-empty-desc");
  if (!hasPoints && et && ed) {
    et.textContent = "暂无趋势数据";
    ed.textContent =
      !statsRange.start || !statsRange.end
        ? "请选择统计的开始与结束日期，或使用下方按钮切换到常用范围。"
        : "本范围内没有该指标的数值。可拉长时间段或选择其他指标。";
  }
  const dot = document.querySelector("#chart-legend-trigger .chart-legend-dot");
  if (dot && trend.metric) dot.style.background = getChartLineCssColor(trend.metric);
  if (canvas) {
    canvas.setAttribute("aria-label", `${ml}，共 ${pts.length} 个数据点`);
  }
}

function syncChartCrosshairForIndex(index) {
  const cross = document.getElementById("chart-crosshair");
  const canvas = document.getElementById("stats-chart");
  if (!cross || !canvas || !chartPlotLayout || index == null || index < 0 || index >= chartPlotLayout.len) {
    if (cross) cross.classList.add("hidden");
    return;
  }
  cross.style.left = `${canvas.offsetLeft + chartPlotLayout.xs[index]}px`;
  cross.style.top = `${canvas.offsetTop}px`;
  cross.style.height = `${canvas.clientHeight}px`;
  cross.classList.remove("hidden");
}

function hideChartCrosshairAndTip() {
  chartScrubIndex = null;
  document.getElementById("chart-crosshair")?.classList.add("hidden");
  hideChartTooltip();
}

/** @param {Record<string, unknown>} trend */
function showChartTooltipForIndex(index, trend) {
  const tip = document.getElementById("chart-tooltip");
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-chart"));
  const points = /** @type {Array<{ label: string, value: number }>} */ (trend.points || []);
  if (!tip || !canvas || !chartPlotLayout || !points[index]) return;
  const p = points[index];
  const u = String(trend.unit || "");
  const valStr = withChartUnit(u, p.value);
  tip.innerHTML = `<div class="chart-tip-label">${escapeHtml(p.label)}</div><div class="chart-tip-value">${escapeHtml(valStr)}</div>`;
  const x = chartPlotLayout.xs[index];
  const y = chartPlotLayout.ys[index];
  const offsetX = Math.min(canvas.clientWidth - 130, Math.max(6, x + 8));
  const offsetY = Math.max(6, y - 40);
  tip.style.left = `${offsetX}px`;
  tip.style.top = `${offsetY}px`;
  tip.classList.remove("hidden");
}

/** @type {number|null} */
let chartPointerCaptureId = null;

function onChartPointerMove(ev) {
  if (statsMode !== "chart") return;
  const trend = chartLastTrend;
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-chart"));
  if (!canvas || !trend || !chartPlotLayout || !trend.points?.length) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const { left, plotW, len, xs } = chartPlotLayout;
  if (mx < left - 8 || mx > left + plotW + 8) {
    if (chartPointerCaptureId == null) hideChartCrosshairAndTip();
    return;
  }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < len; i += 1) {
    const d = Math.abs(xs[i] - mx);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  chartScrubIndex = best;
  syncChartCrosshairForIndex(best);
  showChartTooltipForIndex(best, trend);
}

function onChartPointerDown(ev) {
  if (statsMode !== "chart") return;
  if (ev.pointerType === "mouse" && ev.button !== 0) return;
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-chart"));
  if (!canvas) return;
  chartPointerCaptureId = ev.pointerId;
  try {
    canvas.setPointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  onChartPointerMove(ev);
}

function onChartPointerUp(ev) {
  if (chartPointerCaptureId == null || ev.pointerId !== chartPointerCaptureId) return;
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-chart"));
  try {
    canvas?.releasePointerCapture(ev.pointerId);
  } catch {
    /* ignore */
  }
  chartPointerCaptureId = null;
  hideChartCrosshairAndTip();
}

function onChartPointerLeave() {
  if (chartPointerCaptureId != null) return;
  hideChartCrosshairAndTip();
}

function renderTrendChart() {
  syncChartResolutionButtons();
  const canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById("stats-chart"));
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  chartScrubIndex = null;
  chartPlotLayout = null;
  chartHitPoints = [];
  chartLastTrend = null;
  hideChartCrosshairAndTip();

  const loading = document.getElementById("chart-loading");

  const runDraw = () => {
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 900;
    const cssHeight = 320;
    canvas.width = Math.floor(cssWidth * dpr);
    canvas.height = Math.floor(cssHeight * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, cssHeight);

    const trend = buildTrendData();
    chartLastTrend = trend;
    updateChartPanelFromTrend(trend);

    const points = trend.points || [];
    const vals = points.map((p) => Number(p.value) || 0);
    if (!points.length) return;

    const yRange = trend.yRange || { minY: 0, maxY: 10 };
    const yMin = yRange.minY;
    const yMax = yRange.maxY;
    const spanY = Math.max(yMax - yMin, 1e-9);
    const lineColor = getChartLineCssColor(trend.metric);

    const unit = trend.unit || "数值";
    const left = unit === "分钟" ? 78 : 56;
    const right = 12;
    const top = 22;
    const bottom = 30;
    const pw = cssWidth - left - right;
    const ph = cssHeight - top - bottom;

    ctx.strokeStyle = "rgba(128, 128, 128, 0.15)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(128, 128, 128, 0.6)";
    ctx.font = '11px "SF Pro Text", "Helvetica Neue", Arial';
    for (let i = 0; i <= 4; i += 1) {
      const y = top + (ph / 4) * i;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(left + pw, y);
      ctx.stroke();
      const raw = yMax - (spanY / 4) * i;
      const tickLabel =
        unit === "分钟"
          ? formatDurationAxisTick(raw)
          : String(spanY < 6 ? Math.round(raw * 100) / 100 : Math.round(raw));
      ctx.fillText(tickLabel, 8, y + 4);
    }
    ctx.fillText(unit === "分钟" ? "分钟 (累计)" : unit, 8, 14);

    const mapX = (i) => left + (pw * i) / Math.max(1, points.length - 1);
    const mapY = (v) => top + ph - ((Number(v) - yMin) / spanY) * ph;
    const xs = points.map((_, i) => mapX(i));
    const ys = points.map((p) => mapY(p.value));
    chartPlotLayout = { xs, ys, left, plotW: pw, len: points.length };

    chartHitPoints = points.map((p, i) => ({
      x: xs[i],
      y: ys[i],
      label: p.label,
      value: p.value,
      unit,
    }));

    const drawSeries = (seriesVals, color) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      seriesVals.forEach((v, i) => {
        const x = mapX(i);
        const y = mapY(v);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    const gradient = ctx.createLinearGradient(0, top, 0, top + ph);
    gradient.addColorStop(0, cssColorToRgba(lineColor, 0.2));
    gradient.addColorStop(1, cssColorToRgba(lineColor, 0.02));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    points.forEach((p, i) => {
      const x = mapX(i);
      const y = mapY(p.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(mapX(points.length - 1), top + ph);
    ctx.lineTo(mapX(0), top + ph);
    ctx.closePath();
    ctx.fill();

    drawSeries(vals, lineColor);
    ctx.fillStyle = lineColor;
    points.forEach((p, i) => {
      const x = mapX(i);
      const y = mapY(p.value);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = lineColor;
      ctx.fill();
    });

    ctx.fillStyle = "rgba(128, 128, 128, 0.6)";
    ctx.font = '11px "SF Pro Text", "Helvetica Neue", Arial';
    points.forEach((p, i) => {
      if (i % Math.ceil(points.length / 6) !== 0 && i !== points.length - 1) return;
      const x = mapX(i) - 12;
      const y = cssHeight - 8;
      ctx.fillText(p.label, x, y);
    });
  };

  if (loading) loading.classList.add("is-visible");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const doneLoading = () => {
    if (loading) loading.classList.remove("is-visible");
  };
  if (reduceMotion) {
    try {
      runDraw();
    } finally {
      doneLoading();
    }
    return;
  }
  requestAnimationFrame(() => {
    try {
      runDraw();
    } finally {
      requestAnimationFrame(doneLoading);
    }
  });
}

function hideChartTooltip() {
  const tip = document.getElementById("chart-tooltip");
  if (!tip) return;
  tip.classList.add("hidden");
}

function renderChartMetricMenuItems() {
  const menu = document.getElementById("chart-metric-menu");
  if (!menu) return;
  const groups = getNumericMetricOptionsGrouped();
  menu.innerHTML = groups
    .map((g) => {
      const items = g.items
        .map(
          (o) =>
            `<button type="button" class="chart-metric-menu-item${o.id === chartMetricId ? " is-active" : ""}" data-metric-id="${o.id}" role="menuitem">${escapeHtml(o.label)}</button>`,
        )
        .join("");
      const head = `${escapeHtml(g.emoji)} ${escapeHtml(g.title)}`;
      return `<div class="chart-metric-group" role="group" aria-label="${escapeHtml(g.title)}"><div class="chart-metric-group-title">${head}</div>${items}</div>`;
    })
    .join("");
}

function hideChartMetricMenu() {
  const menu = document.getElementById("chart-metric-menu");
  const backdrop = document.getElementById("chart-metric-menu-backdrop");
  const legend = document.getElementById("chart-legend-trigger");
  if (menu) {
    menu.classList.add("hidden");
    menu.classList.remove("chart-metric-menu--sheet", "chart-metric-menu--popover");
    menu.style.left = "";
    menu.style.top = "";
    menu.style.right = "";
    menu.style.bottom = "";
  }
  if (backdrop) backdrop.classList.add("hidden");
  if (legend) legend.setAttribute("aria-expanded", "false");
}

/**
 * @param {number} clientX viewport X
 * @param {number} clientY viewport Y
 */
function openChartMetricMenu(clientX, clientY) {
  const wrap = document.getElementById("stats-chart-wrap");
  const menu = document.getElementById("chart-metric-menu");
  const backdrop = document.getElementById("chart-metric-menu-backdrop");
  if (!wrap || !menu) return;
  renderChartMetricMenuItems();
  const sheet = window.innerWidth <= CHART_METRIC_SHEET_MAX_W;
  menu.classList.remove("hidden");
  if (sheet) {
    menu.classList.add("chart-metric-menu--sheet");
    menu.classList.remove("chart-metric-menu--popover");
    if (backdrop) backdrop.classList.remove("hidden");
    menu.style.left = "";
    menu.style.top = "";
  } else {
    menu.classList.add("chart-metric-menu--popover");
    menu.classList.remove("chart-metric-menu--sheet");
    if (backdrop) backdrop.classList.add("hidden");
    const wrapRect = wrap.getBoundingClientRect();
    const localX = clientX - wrapRect.left;
    const localY = clientY - wrapRect.top;
    const menuW = menu.offsetWidth || 240;
    const menuH = menu.offsetHeight || 200;
    const left = Math.min(
      wrapRect.width - menuW - 8,
      Math.max(8, localX - menuW / 2),
    );
    const top = Math.min(
      wrapRect.height - menuH - 8,
      Math.max(8, localY - menuH - 8),
    );
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
  }
  const legend = document.getElementById("chart-legend-trigger");
  if (legend) legend.setAttribute("aria-expanded", "true");
}

function openChartMetricMenuByLegend() {
  if (statsMode !== "chart") return;
  const trigger = document.getElementById("chart-legend-trigger");
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  openChartMetricMenu(rect.left + rect.width / 2, rect.top);
}

function buildTrendData() {
  const metrics = getNumericMetricOptions();
  const metric = metrics.find((m) => m.id === chartMetricId) || metrics[0];
  const emptySummary = () => ({
    primary: "—",
    secondary: !statsRange.start || !statsRange.end ? "请选择开始与结束日期以查看趋势" : "当前范围内没有数据",
    sum: 0,
    mean: 0,
    min: 0,
    max: 0,
    count: 0,
  });
  const empty = (extra = {}) => ({
    mode: /** @type {"range-line"|"day-points"} */ ("range-line"),
    points: /** @type {Array<{ label: string, value: number, t?: number }>} */ ([]),
    unit: metric?.unit || "数值",
    metricLabel: metric?.label || "当前指标",
    metric,
    resolution: "day",
    resolutionLabel: "",
    summary: emptySummary(),
    yRange: { minY: 0, maxY: 10 },
    ...extra,
  });
  if (!metric) return empty({ metric: null, unit: "数值", metricLabel: "当前指标" });

  const range = { start: statsRange.start, end: statsRange.end };
  const source = getEntriesByRange(range.start, range.end);
  const hint = document.getElementById("stats-range-hint");
  const rangeLabel = range.start && range.end ? `${range.start} 至 ${range.end}` : "全部时间";

  const pack = (mode, points, resolution, resLabelOverride) => {
    const summary = computeTrendSummary(metric, points);
    const vals = points.map((p) => Number(p.value) || 0);
    const yRange = getSmartYRange(metric, vals);
    const resLabel = resLabelOverride || getAggregationLabel(resolution);
    if (hint) hint.textContent = `当前范围：${rangeLabel} · 图表聚合：${resLabel}`;
    return {
      mode,
      points,
      unit: metric.unit,
      metricLabel: metric.label,
      metric,
      resolution,
      resolutionLabel: resLabel,
      summary,
      yRange,
    };
  };

  if (!range.start || !range.end) {
    if (hint) hint.textContent = "当前范围：全部时间 · 图表需选择具体日期范围";
    return empty();
  }

  const start = new Date(`${range.start}T00:00:00`);
  const end = new Date(`${range.end}T00:00:00`);
  const resolution = getChartResolutionByRange();
  const isSingleDay = range.start === range.end;
  if (isSingleDay && resolution === "day") {
    const dayPoints = source
      .filter((e) => toLocalDateKey(e.at) === range.start && e.categoryId === metric.categoryId)
      .map((e) => {
        const d = new Date(e.at);
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        return {
          t: d.getTime(),
          label: `${hh}:${mm}`,
          value: Number(e.fields?.[metric.fieldKey]) || 0,
        };
      })
      .sort((a, b) => a.t - b.t);
    return pack("day-points", dayPoints, "day", "按记录时间");
  }

  const metricEntries = source.filter((e) => e.categoryId === metric.categoryId);
  const data = [];
  if (resolution === "day") {
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = toLocalDateKey(d);
      const label = `${d.getMonth() + 1}/${d.getDate()}`;
      const dayEntries = metricEntries.filter((e) => toLocalDateKey(e.at) === key);
      const value = dayEntries.reduce((sum, e) => sum + (Number(e.fields?.[metric.fieldKey]) || 0), 0);
      data.push({ label, value });
    }
  } else if (resolution === "week") {
    const buckets = new Map();
    for (const e of metricEntries) {
      const at = new Date(e.at);
      const weekStart = getWeekStartDate(at);
      const key = toLocalDateKey(weekStart);
      const prev = buckets.get(key) || 0;
      buckets.set(key, prev + (Number(e.fields?.[metric.fieldKey]) || 0));
    }
    let cursor = getWeekStartDate(start);
    const endWeek = getWeekStartDate(end);
    while (cursor <= endWeek) {
      const key = toLocalDateKey(cursor);
      const label = `${cursor.getMonth() + 1}/${cursor.getDate()}周`;
      data.push({ label, value: buckets.get(key) || 0 });
      cursor.setDate(cursor.getDate() + 7);
    }
  } else {
    const buckets = new Map();
    for (const e of metricEntries) {
      const at = new Date(e.at);
      const key = getMonthKey(at);
      const prev = buckets.get(key) || 0;
      buckets.set(key, prev + (Number(e.fields?.[metric.fieldKey]) || 0));
    }
    let cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    const endMonth = new Date(end.getFullYear(), end.getMonth(), 1);
    while (cursor <= endMonth) {
      const key = getMonthKey(cursor);
      const label = `${cursor.getFullYear()}/${cursor.getMonth() + 1}`;
      data.push({ label, value: buckets.get(key) || 0 });
      cursor.setMonth(cursor.getMonth() + 1);
    }
  }
  return pack("range-line", data, resolution, "");
}

function getEntriesByRange(start, end) {
  if (!start && !end) return [...entries];
  const s = start || "0000-01-01";
  const e = end || "9999-12-31";
  if (s > e) return [];
  return entries.filter((x) => {
    const key = toLocalDateKey(x.at);
    return key >= s && key <= e;
  });
}

function applyPresetRange(preset) {
  const end = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);
  let start = new Date(end);
  if (preset === "today") {
    start = new Date(end);
  } else if (preset === "7d") {
    start.setDate(end.getDate() - 6);
  } else if (preset === "30d") {
    start.setDate(end.getDate() - 29);
  } else if (preset === "all") {
    const oldest = entries.length ? new Date(entries[entries.length - 1].at) : new Date(end);
    statsRange = { start: fmt(oldest), end: fmt(end), preset };
    syncStatsRangeInputs();
    renderStats();
    return;
  }
  statsRange = { start: fmt(start), end: fmt(end), preset };
  syncStatsRangeInputs();
  renderStats();
}

function syncStatsRangeInputs() {
  const startEl = /** @type {HTMLInputElement} */ (document.getElementById("stats-start"));
  const endEl = /** @type {HTMLInputElement} */ (document.getElementById("stats-end"));
  const presetEl = /** @type {HTMLSelectElement} */ (document.getElementById("stats-preset"));
  startEl.value = statsRange.start || "";
  endEl.value = statsRange.end || "";
  presetEl.value = statsRange.preset || "custom";
}

function setStatsRangeHintMessage(message, tone = "default") {
  const hint = document.getElementById("stats-range-hint");
  if (!hint) return;
  hint.textContent = message;
  hint.classList.toggle("is-error", tone === "error");
}

function applyCustomStatsRange() {
  const start = /** @type {HTMLInputElement} */ (document.getElementById("stats-start")).value;
  const end = /** @type {HTMLInputElement} */ (document.getElementById("stats-end")).value;
  if ((start && !end) || (!start && end)) {
    setStatsRangeHintMessage("请选择完整的开始和结束日期", "error");
    return;
  }
  if (start && end && start > end) {
    setStatsRangeHintMessage("开始日期不能晚于结束日期", "error");
    return;
  }
  statsRange = { start, end, preset: "custom" };
  syncStatsRangeInputs();
  renderStats();
}

function scheduleAutoApplyCustomStatsRange() {
  if (statsRangeApplyTimer) clearTimeout(statsRangeApplyTimer);
  statsRangeApplyTimer = setTimeout(() => {
    applyCustomStatsRange();
  }, 180);
}

function buildVaccinePlan() {
  if (!profile.birthDate) {
    showToast("请先填写生日");
    return;
  }
  if (vaccines.length > 0 && !confirm("将按生日重建疫苗计划，是否继续？")) return;

  const base = new Date(profile.birthDate);
  const allTemplates = getAllVaccineTemplates();
  const template = allTemplates[vaccineSettings.region] || allTemplates.cn;
  vaccines = template.map((v) => {
    const due = new Date(base);
    due.setDate(base.getDate() + v.day);
    return {
      id: crypto.randomUUID(),
      name: v.name,
      dose: v.dose,
      dueDate: due.toISOString().slice(0, 10),
      status: "todo",
      doneAt: "",
    };
  }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  saveVaccines();
  renderAfterVaccinesMutated();
}

function getVaccineReminderState(v) {
  if (v.status === "done") return { cls: "", text: "已完成", daysLeft: null };
  const todayKey = toLocalDateKey(new Date());
  const daysLeft = daysBetween(todayKey, v.dueDate);
  if (daysLeft < 0) return { cls: "danger", text: `逾期 ${Math.abs(daysLeft)} 天`, daysLeft };
  if (daysLeft <= vaccineSettings.reminderDays) return { cls: "warn", text: `${daysLeft} 天后到期`, daysLeft };
  return { cls: "", text: `${daysLeft} 天后`, daysLeft };
}

function checkVaccineReminders(notify) {
  const summary = document.getElementById("vaccine-reminder-summary");
  const dueItems = vaccines.filter((v) => v.status !== "done").filter((v) => {
    const state = getVaccineReminderState(v);
    return typeof state.daysLeft === "number" && state.daysLeft <= vaccineSettings.reminderDays;
  });
  if (summary) {
    summary.textContent = dueItems.length
      ? `${dueItems.length} 项接种在提醒范围内`
      : "";
  }

  if (vaccineSettings.notificationsEnabled && "Notification" in window && Notification.permission === "granted") {
    const today = toLocalDateKey(new Date());
    for (const item of dueItems) {
      const key = `${item.id}_${today}`;
      if (vaccineSettings.notifiedMap[key]) continue;
      const state = getVaccineReminderState(item);
      new Notification("Babylog 疫苗提醒", {
        body: `${item.name} ${item.dose} · ${state.text}`,
      });
      vaccineSettings.notifiedMap[key] = true;
    }
    saveVaccineSettings();
  }

  if (notify) showToast(dueItems.length ? `${dueItems.length} 项疫苗待接种` : "暂无提醒");
}

function syncVaccineSettingControls() {
  const regionEl = /** @type {HTMLSelectElement} */ (document.getElementById("vaccine-region"));
  const reminderEl = /** @type {HTMLSelectElement} */ (document.getElementById("vaccine-reminder-days"));
  if (regionEl) regionEl.value = vaccineSettings.region;
  if (reminderEl) reminderEl.value = String(vaccineSettings.reminderDays);
}

function populateVaccineRegionOptions() {
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById("vaccine-region"));
  if (!sel) return;
  sel.innerHTML = "";
  for (const id of Object.keys(VACCINE_TEMPLATES)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = DEFAULT_VACCINE_TEMPLATE_LABELS[id] || id;
    sel.appendChild(opt);
  }
  for (const id of Object.keys(customVaccineTemplates)) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = `自定义 · ${customVaccineTemplates[id].name || id}`;
    sel.appendChild(opt);
  }
  if (!sel.querySelector(`option[value="${vaccineSettings.region}"]`)) {
    vaccineSettings.region = "cn";
    saveVaccineSettings();
  }
  sel.value = vaccineSettings.region;
}

function serializeTemplateItems(items) {
  return items.map((x) => `${x.name}|${x.dose}|${x.day}`).join("\n");
}

function parseTemplateLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, dose, dayRaw] = line.split("|").map((x) => (x || "").trim());
      const day = Number(dayRaw);
      return { name, dose, day: Number.isFinite(day) ? day : NaN };
    })
    .filter((x) => x.name && x.dose && Number.isFinite(x.day));
}

function getTemplateRowsFromTable() {
  const tbody = document.getElementById("vaccine-template-tbody");
  const rows = Array.from(tbody.querySelectorAll("tr"));
  return rows
    .map((tr) => {
      const name = tr.querySelector('[data-k="name"]')?.value?.trim() || "";
      const dose = tr.querySelector('[data-k="dose"]')?.value?.trim() || "";
      const dayRaw = tr.querySelector('[data-k="day"]')?.value?.trim() || "";
      const day = Number(dayRaw);
      return { name, dose, day };
    })
    .filter((x) => x.name && x.dose && Number.isFinite(x.day));
}

function appendTemplateRow(item = { name: "", dose: "", day: 0 }) {
  const tbody = document.getElementById("vaccine-template-tbody");
  const tr = document.createElement("tr");
  const tdName = document.createElement("td");
  const inName = document.createElement("input");
  inName.setAttribute("data-k", "name");
  inName.type = "text";
  inName.placeholder = "如 乙肝疫苗";
  inName.value = String(item.name ?? "");
  tdName.appendChild(inName);

  const tdDose = document.createElement("td");
  const inDose = document.createElement("input");
  inDose.setAttribute("data-k", "dose");
  inDose.type = "text";
  inDose.placeholder = "如 第1针";
  inDose.value = String(item.dose ?? "");
  tdDose.appendChild(inDose);

  const tdDay = document.createElement("td");
  const inDay = document.createElement("input");
  inDay.setAttribute("data-k", "day");
  inDay.type = "number";
  inDay.placeholder = "0";
  inDay.value = String(item.day ?? 0);
  tdDay.appendChild(inDay);

  const tdOp = document.createElement("td");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "text-btn";
  btn.setAttribute("data-del-row", "1");
  btn.textContent = "删除";
  tdOp.appendChild(btn);

  tr.appendChild(tdName);
  tr.appendChild(tdDose);
  tr.appendChild(tdDay);
  tr.appendChild(tdOp);
  btn.addEventListener("click", () => {
    const ok = confirm("确定删除这一行模板条目？");
    if (!ok) return;
    tr.remove();
    if (!tbody.querySelector("tr")) appendTemplateRow();
  });
  tbody.appendChild(tr);
}

function renderTemplateTable(items) {
  const tbody = document.getElementById("vaccine-template-tbody");
  tbody.innerHTML = "";
  if (!items || items.length === 0) {
    appendTemplateRow();
    return;
  }
  for (const item of items) appendTemplateRow(item);
}

function getCurrentTemplateMeta() {
  const region = vaccineSettings.region;
  if (customVaccineTemplates[region]) {
    return { id: region, name: customVaccineTemplates[region].name, items: customVaccineTemplates[region].items, isCustom: true };
  }
  return {
    id: region,
    name: DEFAULT_VACCINE_TEMPLATE_LABELS[region] || region,
    items: VACCINE_TEMPLATES[region] || [],
    isCustom: false,
  };
}

function loadCurrentTemplateToEditor() {
  const meta = getCurrentTemplateMeta();
  const nameEl = /** @type {HTMLInputElement} */ (document.getElementById("vaccine-template-name"));
  nameEl.value = meta.name || "";
  renderTemplateTable(meta.items || []);
}

function toggleVaccineTemplateEditor() {
  const box = document.getElementById("vaccine-template-editor");
  box.classList.toggle("hidden");
  if (!box.classList.contains("hidden")) loadCurrentTemplateToEditor();
}

function saveCustomTemplateFromEditor() {
  const name = /** @type {HTMLInputElement} */ (document.getElementById("vaccine-template-name")).value.trim();
  const items = getTemplateRowsFromTable();
  if (!name) {
    alert("请填写模板名称");
    return;
  }
  if (items.length === 0) {
    alert("请至少填写一条有效条目（疫苗名、剂次、天数）");
    return;
  }
  const current = getCurrentTemplateMeta();
  const key = current.isCustom ? current.id : `custom_${Date.now()}`;
  customVaccineTemplates[key] = { name, items };
  vaccineSettings.region = key;
  saveCustomVaccineTemplates();
  saveVaccineSettings();
  populateVaccineRegionOptions();
  syncVaccineSettingControls();
  alert("模板已保存");
}

function deleteCurrentCustomTemplate() {
  const current = getCurrentTemplateMeta();
  const ok = window.confirm(`将尝试删除模板“${current.name}”。是否继续？`);
  if (!ok) return;
  if (!current.isCustom) {
    alert("当前是系统模板，不能删除。请先切换到“自定义 · ...”模板后再删除。");
    return;
  }
  delete customVaccineTemplates[current.id];
  vaccineSettings.region = "cn";
  saveCustomVaccineTemplates();
  saveVaccineSettings();
  populateVaccineRegionOptions();
  syncVaccineSettingControls();
  loadCurrentTemplateToEditor();
}

async function enableVaccineNotification() {
  if (!("Notification" in window)) {
    alert("当前浏览器不支持通知");
    return;
  }
  const permission = await Notification.requestPermission();
  if (permission === "granted") {
    vaccineSettings.notificationsEnabled = true;
    saveVaccineSettings();
    alert("通知已启用");
    checkVaccineReminders(false);
  } else {
    alert("通知权限未授予");
  }
}

function toggleVaccineDone(id) {
  vaccines = vaccines.map((v) => {
    if (v.id !== id) return v;
    if (v.status === "done") return { ...v, status: "todo", doneAt: "" };
    return { ...v, status: "done", doneAt: new Date().toISOString().slice(0, 10) };
  });
  saveVaccines();
  renderAfterVaccinesMutated();
}

function renderVaccines() {
  const list = document.getElementById("vaccine-list");
  if (!vaccines.length) {
    list.innerHTML = `<li class="empty-state">暂无计划</li>`;
    return;
  }
  list.innerHTML = "";
  for (const v of vaccines) {
    const li = document.createElement("li");
    const state = getVaccineReminderState(v);
    const isDone = v.status === "done";
    const statusCls = isDone ? "done" : (state.cls || "upcoming");
    const metaText = v.dueDate + (v.doneAt ? ` · 已接种 ${v.doneAt}` : "");
    li.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="vac-name">${v.name} · ${v.dose}</div>
        <div class="vac-meta">${metaText}</div>
      </div>
      <span class="vac-status ${statusCls}">${state.text}</span>
      <button type="button" class="vac-toggle-btn${isDone ? " is-done" : ""}" data-vdone title="${isDone ? "撤销" : "完成"}">${isDone ? "✓" : "○"}</button>
    `;
    li.querySelector("[data-vdone]").addEventListener("click", () => toggleVaccineDone(v.id));
    list.appendChild(li);
  }
  checkVaccineReminders(false);
}

let galleryPhotos = [];

function renderPhotoGallery() {
  const summaryEl = document.getElementById("photo-gallery-summary");
  const galleryEl = document.getElementById("photo-gallery");
  if (!summaryEl || !galleryEl) return;
  galleryPhotos = collectGalleryPhotosFromEntries(entries, getCategory);
  if (!galleryPhotos.length) {
    summaryEl.textContent = "";
    galleryEl.innerHTML = `<div class="empty-state">暂无照片</div>`;
    return;
  }
  const daySet = new Set(galleryPhotos.map((p) => toLocalDateKey(p.at)));
  summaryEl.textContent = `${galleryPhotos.length} 张照片，${daySet.size} 天`;
  galleryEl.innerHTML = "";
  const frag = document.createDocumentFragment();
  galleryPhotos.forEach((photo, idx) => {
    const item = document.createElement("article");
    item.className = "gallery-item";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "gallery-link";
    btn.addEventListener("click", () => openLightbox(idx, galleryPhotos.map((p) => ({
      url: p.url, caption: `${formatDateHeader(p.at)} \u00b7 ${p.categoryLabel}`
    }))));
    const img = document.createElement("img");
    img.src = photo.url;
    img.alt = `${photo.categoryLabel}`;
    img.className = "gallery-thumb";
    img.loading = "lazy";
    const meta = document.createElement("div");
    meta.className = "gallery-meta";
    meta.textContent = `${formatDateHeader(photo.at)} · ${photo.categoryLabel}`;
    btn.appendChild(img);
    item.appendChild(btn);
    item.appendChild(meta);
    frag.appendChild(item);
  });
  galleryEl.appendChild(frag);
}

/* ── Lightbox ── */
let lightboxItems = [];
let lightboxIndex = 0;

function openLightbox(idx, items) {
  lightboxItems = items || galleryPhotos;
  lightboxIndex = idx;
  updateLightboxContent();
  document.getElementById("lightbox").classList.add("is-open");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  document.getElementById("lightbox").classList.remove("is-open");
  document.body.style.overflow = "";
}

function updateLightboxContent() {
  const item = lightboxItems[lightboxIndex];
  if (!item) return;
  document.getElementById("lightbox-img").src = item.url;
  document.getElementById("lightbox-caption").textContent = item.caption || "";
  document.getElementById("lightbox-prev").style.display = lightboxIndex > 0 ? "" : "none";
  document.getElementById("lightbox-next").style.display = lightboxIndex < lightboxItems.length - 1 ? "" : "none";
}

function initLightbox() {
  document.getElementById("lightbox-close").addEventListener("click", closeLightbox);
  document.getElementById("lightbox-prev").addEventListener("click", () => {
    if (lightboxIndex > 0) { lightboxIndex--; updateLightboxContent(); }
  });
  document.getElementById("lightbox-next").addEventListener("click", () => {
    if (lightboxIndex < lightboxItems.length - 1) { lightboxIndex++; updateLightboxContent(); }
  });
  document.getElementById("lightbox").addEventListener("click", (e) => {
    if (e.target === e.currentTarget) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    const lb = document.getElementById("lightbox");
    if (!lb.classList.contains("is-open")) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft" && lightboxIndex > 0) { lightboxIndex--; updateLightboxContent(); }
    else if (e.key === "ArrowRight" && lightboxIndex < lightboxItems.length - 1) { lightboxIndex++; updateLightboxContent(); }
  });
}

function renderTimeline() {
  const filter = /** @type {HTMLSelectElement} */ (document.getElementById("filter-category")).value;
  const day = /** @type {HTMLInputElement} */ (document.getElementById("filter-day")).value;
  const list = document.getElementById("timeline");
  const moreWrap = document.getElementById("timeline-more-wrap");
  let data = filter ? entries.filter((e) => e.categoryId === filter) : [...entries];
  if (day) data = data.filter((e) => toLocalDateKey(e.at) === day);

  if (data.length === 0) {
    list.innerHTML = `<li class="empty-state">暂无记录</li>`;
    moreWrap.classList.add("hidden");
    return;
  }

  const visible = data.slice(0, timelineVisibleCount);
  /** @type {string|null} */
  let lastHeader = null;
  const frag = document.createDocumentFragment();
  for (const e of visible) {
    const header = formatDateHeader(e.at);
    if (header !== lastHeader) {
      lastHeader = header;
      const h = document.createElement("li");
      h.className = "tl-day";
      const inner = document.createElement("div");
      inner.className = "section-title";
      inner.textContent = header;
      h.appendChild(inner);
      frag.appendChild(h);
    }
    const cat = getCategory(e.categoryId);
    const li = document.createElement("li");
    const detail = summarizeFields(cat, e.fields || {});
    const metaLine =
      detail && e.note ? `${detail} · ${e.note}` : detail || e.note || "—";
    li.innerHTML = `
      <span class="tl-time">${formatTime(e.at)}</span>
      <div class="tl-body">
        <span class="tl-label">${cat.emoji} ${cat.label}</span>
        <div class="tl-meta"></div>
      </div>
      <div class="tl-actions">
        <button type="button" class="icon-btn" data-edit title="编辑">✎</button>
        <button type="button" class="icon-btn" data-del title="删除">✕</button>
      </div>
    `;
    const bodyEl = li.querySelector(".tl-body");
    const metaEl = li.querySelector(".tl-meta");
    if (metaEl) metaEl.textContent = metaLine;
    const photos = Array.isArray(e.photos) ? e.photos : [];
    if (photos.length && bodyEl) {
      const wrap = document.createElement("div");
      wrap.className = "tl-photos";
      const tlLightboxItems = photos.map((u) => ({ url: u, caption: `${formatDateHeader(e.at)} \u00b7 ${cat.label}` }));
      photos.slice(0, 4).forEach((url, pi) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tl-photo-link";
        btn.addEventListener("click", () => openLightbox(pi, tlLightboxItems));
        const img = document.createElement("img");
        img.src = url;
        img.alt = "附图";
        img.className = "tl-photo-thumb";
        img.loading = "lazy";
        btn.appendChild(img);
        wrap.appendChild(btn);
      });
      if (photos.length > 4) {
        const more = document.createElement("span");
        more.className = "tl-photo-more";
        more.textContent = `+${photos.length - 4}`;
        wrap.appendChild(more);
      }
      bodyEl.appendChild(wrap);
    }
    li.querySelector("[data-edit]").addEventListener("click", () => openModal(e.categoryId, e));
    li.querySelector("[data-del]").addEventListener("click", () => {
      if (li.classList.contains("tl-delete-pending")) return;
      li.classList.add("tl-delete-pending");
      const actions = li.querySelector(".tl-actions");
      if (actions) actions.classList.add("hidden");
      const row = document.createElement("div");
      row.className = "tl-confirm-row";
      row.innerHTML = `
        <span class="tl-confirm-label">删除？</span>
        <div class="tl-confirm-btns">
          <button type="button" class="tl-confirm-btn tl-confirm-cancel" title="取消">
            <svg viewBox="0 0 24 24"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>
          </button>
          <button type="button" class="tl-confirm-btn tl-confirm-ok" title="确认删除">
            <svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"></path></svg>
          </button>
        </div>`;
      row.querySelector(".tl-confirm-cancel").addEventListener("click", () => {
        li.classList.remove("tl-delete-pending");
        row.remove();
        if (actions) actions.classList.remove("hidden");
      });
      row.querySelector(".tl-confirm-ok").addEventListener("click", () => deleteEntry(e.id));
      li.appendChild(row);
    });
    frag.appendChild(li);
  }
  list.innerHTML = "";
  list.appendChild(frag);
  if (visible.length < data.length) moreWrap.classList.remove("hidden");
  else moreWrap.classList.add("hidden");
}

function render() {
  renderProfile();
  renderModuleSummaries();
  renderStats();
  renderVaccines();
  renderPhotoGallery();
  renderTimeline();
  renderAiChat();
}

/** After entries changed: skip profile, vaccines, and full AI chat rebuild. */
function renderAfterEntriesMutated() {
  renderTimeline();
  renderModuleSummaries();
  renderStats();
  renderPhotoGallery();
}

/** After vaccine list or status changed. */
function renderAfterVaccinesMutated() {
  renderVaccines();
  renderStats();
  renderModuleSummaries();
}

function nowIso() {
  return new Date().toISOString();
}

function makeAiSession(title = "新会话") {
  const now = nowIso();
  return { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now, messages: [] };
}

function getActiveAiSession() {
  return aiProject.sessions.find((s) => s.id === aiProject.activeSessionId) || null;
}

function ensureAiProjectConsistency() {
  if (!Array.isArray(aiProject.sessions)) aiProject.sessions = [];
  const policies = ["full_recent", "stats_only", "recent_7d", "timeline_filter"];
  if (!policies.includes(aiProject.contextPolicy)) aiProject.contextPolicy = "full_recent";
  if (!aiProject.aiContextConsent || typeof aiProject.aiContextConsent !== "object") aiProject.aiContextConsent = {};
  if (!aiProject.instruction || !String(aiProject.instruction).trim()) aiProject.instruction = DEFAULT_AI_INSTRUCTION;
  if (!aiProject.sessions.length) {
    const first = makeAiSession("默认会话");
    aiProject.sessions = [first];
    aiProject.activeSessionId = first.id;
    return;
  }
  if (!aiProject.sessions.some((s) => s.id === aiProject.activeSessionId)) {
    aiProject.sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    aiProject.activeSessionId = aiProject.sessions[0].id;
  }
}

function saveAiProject() {
  try {
    localStorage.setItem(STORAGE_AI_PROJECT_KEY, JSON.stringify(aiProject));
    localStorage.setItem(STORAGE_AI_INSTRUCTION_KEY, aiProject.instruction || DEFAULT_AI_INSTRUCTION);
  } catch {
    // ignore quota errors
  }
}

function loadAiInstruction() {
  try {
    const rawProject = localStorage.getItem(STORAGE_AI_PROJECT_KEY);
    if (rawProject) {
      const data = JSON.parse(rawProject);
      const policies = ["full_recent", "stats_only", "recent_7d", "timeline_filter"];
      const rawPolicy = String(data?.contextPolicy || "full_recent");
      aiProject = {
        instruction: String(data?.instruction || DEFAULT_AI_INSTRUCTION),
        activeSessionId: String(data?.activeSessionId || ""),
        contextPolicy: policies.includes(rawPolicy) ? rawPolicy : "full_recent",
        aiContextConsent:
          data?.aiContextConsent && typeof data.aiContextConsent === "object" ? data.aiContextConsent : {},
        syncSessionsDisclaimerAck: Boolean(data?.syncSessionsDisclaimerAck),
        sessions: Array.isArray(data?.sessions)
          ? data.sessions.map((s) => ({
            id: String(s?.id || crypto.randomUUID()),
            title: String(s?.title || "新会话"),
            createdAt: String(s?.createdAt || nowIso()),
            updatedAt: String(s?.updatedAt || nowIso()),
            messages: Array.isArray(s?.messages)
              ? s.messages
                .filter((m) => m && (m.role === "user" || m.role === "assistant"))
                .map((m) => ({
                  role: m.role,
                  content: String(m.content || ""),
                  ts: String(m.ts || s?.updatedAt || nowIso()),
                }))
              : [],
          }))
          : [],
      };
    } else {
      aiProject = {
        instruction: DEFAULT_AI_INSTRUCTION,
        activeSessionId: "",
        contextPolicy: "full_recent",
        aiContextConsent: {},
        syncSessionsDisclaimerAck: false,
        sessions: [],
      };
    }
  } catch {
    aiProject = {
      instruction: DEFAULT_AI_INSTRUCTION,
      activeSessionId: "",
      contextPolicy: "full_recent",
      aiContextConsent: {},
      syncSessionsDisclaimerAck: false,
      sessions: [],
    };
  }
  ensureAiProjectConsistency();
  aiInstruction = aiProject.instruction;
  saveAiProject();
}

function syncAiInstructionField() {
  const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-instruction"));
  const compact = /** @type {HTMLElement|null} */ (document.getElementById("ai-instruction-compact"));
  const preview = /** @type {HTMLElement|null} */ (document.getElementById("ai-instruction-preview"));
  if (!ta) return;
  const value = aiProject.instruction || DEFAULT_AI_INSTRUCTION;
  ta.value = value;
  if (preview) {
    const text = value.replace(/\s+/g, " ").trim() || "未设置项目指令";
    preview.textContent = text;
  }
  if (compact) {
    compact.setAttribute("title", value);
  }
}

function syncAiInstructionSaveBtn() {
  const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-instruction"));
  const btn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-save-ai-instruction"));
  if (!ta || !btn) return;
  const current = ta.value;
  const saved = aiProject.instruction || DEFAULT_AI_INSTRUCTION;
  btn.disabled = current === saved;
}

function saveAiInstructionFromForm() {
  const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-instruction"));
  if (!ta) return;
  const newVal = ta.value.trim() ? ta.value : DEFAULT_AI_INSTRUCTION;
  const saved = aiProject.instruction || DEFAULT_AI_INSTRUCTION;
  if (newVal === saved) return;
  aiProject.instruction = newVal;
  aiInstruction = aiProject.instruction;
  saveAiProject();
  syncAiInstructionField();
  closeAiInstructionEditor();
  showToast("\u6307\u4ee4\u5df2\u4fdd\u5b58");
}

function openAiInstructionEditor() {
  const modal = document.getElementById("ai-instruction-modal");
  const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-instruction"));
  if (!modal) return;
  modal.classList.remove("hidden");
  syncAiInstructionSaveBtn();
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

function discardAiInstruction() {
  syncAiInstructionField();
  closeAiInstructionEditor();
}


function closeAiInstructionEditor() {
  const modal = document.getElementById("ai-instruction-modal");
  if (!modal) return;
  modal.classList.add("hidden");
}

function summarizeAsTitle(text) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  return (s || "新会话").slice(0, 20);
}

function renderAiSessionList() {
  const root = document.getElementById("ai-session-list");
  if (!root) return;
  root.innerHTML = "";
  const keyword = String(aiSessionSearchKeyword || "").trim().toLowerCase();
  const sessions = [...aiProject.sessions].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const filtered = sessions.filter((s) => {
    if (!keyword) return true;
    const body = s.messages.slice(-6).map((m) => String(m.content || "")).join("\n");
    return `${s.title}\n${body}`.toLowerCase().includes(keyword);
  });
  if (aiSessionDeletePendingId && !filtered.some((s) => s.id === aiSessionDeletePendingId)) {
    aiSessionDeletePendingId = null;
  }
  if (filtered.length === 0) {
    root.innerHTML = `<div class="empty-state">没有匹配的会话</div>`;
    return;
  }
  for (const s of filtered) {
    const item = document.createElement("div");
    const isPending = aiSessionDeletePendingId === s.id;
    item.className = `ai-session-item ${s.id === aiProject.activeSessionId ? "active" : ""}${isPending ? " ai-session-item--delete-pending" : ""}`;
    item.dataset.sid = s.id;
    const lastMsg = s.messages[s.messages.length - 1];
    const lastText = lastMsg?.content ? String(lastMsg.content).replace(/\s+/g, " ").trim() : "暂无消息";
    const updatedText = new Date(s.updatedAt).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const actionsHtml = isPending
      ? `<div class="ai-session-confirm-row" role="group" aria-label="确认删除会话">
          <span class="ai-session-confirm-label">删除此会话？</span>
          <div class="ai-session-actions ai-session-actions--visible">
            <button type="button" class="ai-session-action-btn ai-session-action-btn--cancel" data-ai-delete-cancel aria-label="取消删除" title="取消">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6L6 18"></path><path d="M6 6l12 12"></path></svg>
            </button>
            <button type="button" class="ai-session-action-btn ai-session-action-btn--confirm" data-ai-delete-confirm aria-label="确认删除" title="确认删除">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6L9 17l-5-5"></path></svg>
            </button>
          </div>
        </div>`
      : `<div class="ai-session-actions">
        <button type="button" class="ai-session-action-btn" data-ai-rename aria-label="重命名会话" title="重命名">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L19.81 7.94l-3.75-3.75L3 17.25z"></path><path d="M14.06 4.19l3.75 3.75"></path></svg>
        </button>
        <button type="button" class="ai-session-action-btn" data-ai-delete aria-label="删除会话" title="删除">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M6 7l1 12h10l1-12"></path><path d="M9 7V5h6v2"></path></svg>
        </button>
      </div>`;
    item.innerHTML = `
      <div class="ai-session-title">${escapeHtml(s.title || "新会话")}</div>
      <div class="ai-session-meta">
        <span>${s.messages.length} 条消息</span>
        <span>${updatedText}</span>
      </div>
      <div class="ai-session-last">${escapeHtml(lastText.slice(0, 36) || "暂无消息")}</div>
      ${actionsHtml}
    `;
    item.addEventListener("click", () => {
      if (isPending) return;
      switchAiSession(s.id);
    });
    const btnRename = item.querySelector("[data-ai-rename]");
    if (btnRename) {
      btnRename.addEventListener("click", (ev) => {
        ev.stopPropagation();
        renameAiSession(s.id);
      });
    }
    const btnDelete = item.querySelector("[data-ai-delete]");
    if (btnDelete) {
      btnDelete.addEventListener("click", (ev) => {
        ev.stopPropagation();
        requestAiSessionDelete(s.id);
      });
    }
    const btnCancelDel = item.querySelector("[data-ai-delete-cancel]");
    if (btnCancelDel) {
      btnCancelDel.addEventListener("click", (ev) => {
        ev.stopPropagation();
        cancelPendingAiSessionDelete();
      });
    }
    const btnConfirmDel = item.querySelector("[data-ai-delete-confirm]");
    if (btnConfirmDel) {
      btnConfirmDel.addEventListener("click", (ev) => {
        ev.stopPropagation();
        confirmPendingAiSessionDelete(s.id);
      });
    }
    root.appendChild(item);
  }
}

function switchAiSession(sessionId) {
  if (aiBusy) {
    alert("请等待当前回答完成后再切换会话");
    return;
  }
  aiSessionDeletePendingId = null;
  if (!aiProject.sessions.some((s) => s.id === sessionId)) return;
  aiProject.activeSessionId = sessionId;
  saveAiProject();
  renderAiChat();
  renderAiSessionList();
  renderModuleSummaries();
}

function createAiSession() {
  if (aiBusy) {
    alert("请等待当前回答完成后再新建会话");
    return;
  }
  aiSessionDeletePendingId = null;
  const s = makeAiSession("新会话");
  aiProject.sessions.unshift(s);
  aiProject.activeSessionId = s.id;
  saveAiProject();
  renderAiChat();
  renderAiSessionList();
  renderModuleSummaries();
}

function handleAiGlobalShortcuts(ev) {
  const isNewSessionShortcut = (ev.ctrlKey || ev.metaKey) && ev.shiftKey && String(ev.key).toLowerCase() === "n";
  if (!isNewSessionShortcut) return;
  if (activeModuleId !== "ai") return;
  const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target : null);
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
  ev.preventDefault();
  createAiSession();
}

function renameAiSession(sessionId) {
  if (aiBusy) {
    alert("请等待当前回答完成后再重命名");
    return;
  }
  aiSessionDeletePendingId = null;
  const target = aiProject.sessions.find((s) => s.id === sessionId);
  if (!target) return;
  const next = window.prompt("请输入新的会话名称", target.title || "新会话");
  if (next == null) return;
  const value = String(next).trim();
  if (!value) return;
  target.title = value.slice(0, 40);
  target.updatedAt = nowIso();
  saveAiProject();
  renderAiSessionList();
}

function requestAiSessionDelete(sessionId) {
  if (aiBusy) {
    alert("请等待当前回答完成后再删除");
    return;
  }
  if (!aiProject.sessions.some((s) => s.id === sessionId)) return;
  aiSessionDeletePendingId = sessionId;
  renderAiSessionList();
}

function cancelPendingAiSessionDelete() {
  aiSessionDeletePendingId = null;
  renderAiSessionList();
}

function confirmPendingAiSessionDelete(sessionId) {
  if (aiBusy) {
    alert("请等待当前回答完成后再删除");
    return;
  }
  if (aiSessionDeletePendingId !== sessionId) return;
  performAiSessionDelete(sessionId);
}

function performAiSessionDelete(sessionId) {
  const target = aiProject.sessions.find((s) => s.id === sessionId);
  if (!target) return;
  aiSessionDeletePendingId = null;
  aiProject.sessions = aiProject.sessions.filter((s) => s.id !== sessionId);
  if (aiProject.sessions.length === 0) {
    const created = makeAiSession("新会话");
    aiProject.sessions = [created];
    aiProject.activeSessionId = created.id;
  } else if (aiProject.activeSessionId === sessionId) {
    aiProject.sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    aiProject.activeSessionId = aiProject.sessions[0].id;
  }
  saveAiProject();
  renderAiSessionList();
  renderAiChat();
  renderModuleSummaries();
}

function clearAiChat() {
  if (aiBusy) return;
  const active = getActiveAiSession();
  if (!active) return;
  if (active.messages.length && !confirm("确定清空当前会话消息？")) return;
  active.messages = [];
  active.updatedAt = nowIso();
  saveAiProject();
  renderAiChat();
  renderAiSessionList();
  renderModuleSummaries();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getAiContextConsent() {
  const c = aiProject.aiContextConsent || {};
  return {
    profile: c.profile !== false,
    vaccinesSummary: c.vaccinesSummary !== false,
    entriesSummary: c.entriesSummary !== false,
    includeNotesInEntries: c.includeNotesInEntries !== false,
    includePhotosInEntries: c.includePhotosInEntries !== false,
    allowServerTools: c.allowServerTools !== false,
  };
}

function getTimelineFilterForAi() {
  const catEl = /** @type {HTMLSelectElement|null} */ (document.getElementById("filter-category"));
  const dayEl = /** @type {HTMLInputElement|null} */ (document.getElementById("filter-day"));
  return {
    category: catEl?.value?.trim() || "",
    day: dayEl?.value?.trim() || "",
  };
}

function buildStatsOnlyContextLines() {
  const lines = [];
  lines.push("## 记录统计（全量汇总，不含逐条明细）");
  if (!entries.length) {
    lines.push("暂无记录。");
    return lines;
  }
  const byCat = {};
  for (const e of entries) {
    byCat[e.categoryId] = (byCat[e.categoryId] || 0) + 1;
  }
  lines.push(`总条数: ${entries.length}`);
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  for (const [cid, n] of top) {
    const c = getCategory(cid);
    lines.push(`${c.emoji} ${c.label}: ${n}`);
  }
  return lines;
}

function buildEntryContextLines(slice, consent) {
  const lines = [];
  for (const e of slice) {
    const cat = getCategory(e.categoryId);
    const detail = summarizeFields(cat, e.fields || {});
    const parts = [formatDateHeader(e.at), formatTime(e.at), `${cat.emoji} ${cat.label}`, detail];
    if (consent.includeNotesInEntries && e.note) parts.push(e.note);
    if (consent.includePhotosInEntries && e.photos?.length) parts.push(`照片 ${e.photos.length} 张`);
    lines.push(parts.filter((x) => x !== undefined && x !== null && String(x).trim() !== "").join(" | "));
  }
  return lines;
}

function buildBabyContextForAi() {
  const consent = getAiContextConsent();
  const policy = aiProject.contextPolicy || "full_recent";
  const lines = [];
  const genderMap = { boy: "男", girl: "女", other: "未设置/其他" };

  if (consent.profile !== false) {
    lines.push("## 宝宝档案");
    lines.push(`昵称: ${profile.name || "未填写"}`);
    lines.push(`出生日期: ${profile.birthDate || "未填写"}`);
    lines.push(`性别: ${profile.gender ? genderMap[profile.gender] || profile.gender : "未填写"}`);
    lines.push(`血型: ${profile.blood || "未填写"}`);
    lines.push(`月龄参考: ${getAgeText()}`);
    lines.push("");
  }

  if (consent.vaccinesSummary !== false) {
    lines.push("## 疫苗计划（摘要）");
    if (!vaccines.length) {
      lines.push("暂无疫苗计划数据。");
    } else {
      for (const v of vaccines.slice(0, 40)) {
        lines.push(`${v.name} · ${v.dose} · 计划 ${v.dueDate} · 状态 ${v.status}${v.doneAt ? ` · 完成 ${v.doneAt}` : ""}`);
      }
      if (vaccines.length > 40) lines.push(`… 其余 ${vaccines.length - 40} 条略`);
    }
    lines.push("");
  }

  if (consent.entriesSummary === false) {
    lines.push("## 照护记录");
    lines.push("（用户未授权在上下文中包含记录明细；可依赖服务端工具查询。）");
    return lines.join("\n");
  }

  if (policy === "stats_only") {
    lines.push(...buildStatsOnlyContextLines());
    return lines.join("\n");
  }

  let slice = [...entries].sort((a, b) => new Date(b.at) - new Date(a.at));
  let capNote = "";
  if (policy === "recent_7d") {
    const cutoff = Date.now() - 7 * 86400000;
    slice = slice.filter((e) => new Date(e.at).getTime() >= cutoff).slice(0, 150);
    capNote = "（策略：最近 7 天，最多 150 条）";
  } else if (policy === "timeline_filter") {
    const { category, day } = getTimelineFilterForAi();
    if (category) slice = slice.filter((e) => e.categoryId === category);
    if (day) slice = slice.filter((e) => String(e.at || "").slice(0, 10) === day);
    slice = slice.slice(0, 200);
    capNote = `（策略：与活动筛选一致${category ? ` · 类型已筛选` : ""}${day ? ` · 日期 ${day}` : ""}，最多 200 条）`;
  } else {
    slice = slice.slice(0, 300);
    capNote = "（策略：最近记录，最多 300 条）";
  }

  lines.push("## 照护记录（时间倒序；文本由应用汇总）");
  if (!slice.length) {
    lines.push("当前策略下没有匹配的记录。");
  } else {
    lines.push(...buildEntryContextLines(slice, consent));
    if (entries.length > slice.length || policy === "full_recent") {
      if (policy === "full_recent" && entries.length > 300) {
        lines.push(`… 共 ${entries.length} 条记录，仅附最近 300 条`);
      } else if (capNote) {
        lines.push(`… ${capNote}，当前附 ${slice.length} 条`);
      }
    }
  }
  return lines.join("\n");
}

function scheduleAiChatRender() {
  if (aiStreamRenderScheduled) return;
  aiStreamRenderScheduled = true;
  requestAnimationFrame(() => {
    aiStreamRenderScheduled = false;
    renderAiChat();
  });
}

function setAiStatus(text) {
  const el = document.getElementById("ai-status");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("ai-status-busy", Boolean(text));
}

function refreshAiUiState() {
  const moduleEl = document.getElementById("module-ai");
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-user-input"));
  const sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-ai-send"));
  const newSessionBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("btn-ai-new-session"));
  const searchInput = /** @type {HTMLInputElement|null} */ (document.getElementById("ai-session-search"));
  const canSend = Boolean(input && input.value.trim()) && !aiBusy;
  if (moduleEl) {
    moduleEl.classList.toggle("ai-busy", aiBusy);
    moduleEl.setAttribute("aria-busy", aiBusy ? "true" : "false");
  }
  if (input) input.disabled = aiBusy;
  if (searchInput) searchInput.disabled = aiBusy;
  if (newSessionBtn) newSessionBtn.disabled = aiBusy;
  if (sendBtn) {
    sendBtn.disabled = !canSend;
    sendBtn.setAttribute("aria-disabled", String(!canSend));
  }
}

function renderAiChat() {
  const root = document.getElementById("ai-chat-log");
  const titleEl = document.getElementById("ai-active-session-title");
  if (!root) return;
  root.classList.remove("ai-chat-log-empty");
  root.innerHTML = "";
  const active = getActiveAiSession();
  if (titleEl) {
    titleEl.textContent = active?.title ? String(active.title) : "当前会话";
  }
  if (!active || active.messages.length === 0) {
    root.classList.add("ai-chat-log-empty");
    root.innerHTML = `<div class="empty-state"><div class="ai-empty-greeting">想问什么？</div><div class="ai-empty-hint">基于你家的记录与设置作答；不确定的会直说。</div></div>`;
    refreshAiUiState();
    return;
  }
  for (let i = 0; i < active.messages.length; i += 1) {
    const m = active.messages[i];
    const isLastAssistantStreaming = aiBusy && m.role === "assistant" && i === active.messages.length - 1;
    const row = document.createElement("div");
    row.className = `ai-msg ai-msg-${m.role}`;
    const bubble = document.createElement("div");
    bubble.className = "ai-bubble";
    if (m.role === "assistant") {
      bubble.classList.add("ai-md");
      const raw = m.content || "";
      if (isLastAssistantStreaming) {
        const streamMd = raw || (aiBusy ? "…" : "");
        bubble.innerHTML = streamMd ? renderMarkdownToHtml(streamMd) : "";
        bubble.classList.add("ai-streaming");
      } else {
        const content = raw || "";
        bubble.innerHTML = content ? renderMarkdownToHtml(content) : "";
      }
    } else {
      bubble.textContent = m.content;
    }
    row.appendChild(bubble);
    root.appendChild(row);
  }
  root.scrollTop = root.scrollHeight;
  renderAiDraftBanner();
  refreshAiUiState();
}

/**
 * Updates only the streaming assistant bubble when DOM matches model; avoids rebuilding the whole log each token.
 * @returns {boolean} true when patched
 */
function updateStreamingAssistantBubbleOnly() {
  const root = document.getElementById("ai-chat-log");
  if (!root || !aiBusy) return false;
  const active = getActiveAiSession();
  if (!active?.messages.length) return false;
  const last = active.messages[active.messages.length - 1];
  if (last.role !== "assistant") return false;
  const lastRow = root.lastElementChild;
  if (!lastRow || !lastRow.classList.contains("ai-msg-assistant")) return false;
  const bubble = lastRow.querySelector(".ai-bubble");
  if (!bubble || !bubble.classList.contains("ai-streaming")) return false;
  const raw = last.content || "";
  const streamMd = raw || (aiBusy ? "…" : "");
  bubble.innerHTML = streamMd ? renderMarkdownToHtml(streamMd) : "";
  root.scrollTop = root.scrollHeight;
  refreshAiUiState();
  return true;
}

/**
 * @param {object} payload
 * @param {(chunk: string) => void} onChunk
 * @param {(draft: object) => void} [onDraft] snake_case draft from server tool
 */
async function consumeSseChatStream(payload, onChunk, onDraft) {
  const chatHeaders = authHeaders({ "Content-Type": "application/json" });
  const res = await fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: chatHeaders,
    credentials: "include",
    body: JSON.stringify(payload),
  });
  if (res.status === 401 && authState.user && !authState.localOnly) {
    clearAuth();
    showAuthOverlay("login", "登录状态已过期，请重新登录");
    throw new Error("登录状态已过期");
  }
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    if (ct.includes("application/json")) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const t = await res.text();
    throw new Error(t || `HTTP ${res.status}`);
  }
  if (!res.body) throw new Error("empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    for (;;) {
      const idx = buf.indexOf("\n\n");
      if (idx < 0) break;
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const lines = block.split("\n");
      for (const line of lines) {
        const trimmed = line.replace(/\r$/, "");
        if (!trimmed) continue;
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(trimmed.indexOf(":") + 1).trim();
        if (data === "[DONE]") return;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (obj && typeof obj.error === "string" && obj.error) throw new Error(obj.error);
        if (obj && typeof obj.c === "string" && obj.c) {
          onChunk(obj.c);
          await new Promise((resolve) => requestAnimationFrame(resolve));
          throttledStreamingMarkdownUpdate(() => {
            if (!updateStreamingAssistantBubbleOnly()) scheduleAiChatRender();
          });
        }
        if (obj && obj.draft && typeof obj.draft === "object" && onDraft) onDraft(obj.draft);
      }
    }
  }
}

function draftApiToLogEntry(d) {
  if (!d || typeof d !== "object") return null;
  const categoryId = String(d.category_id || "").trim();
  const at = String(d.at || "").trim();
  if (!categoryId || !at) return null;
  return {
    id: crypto.randomUUID(),
    categoryId,
    at,
    fields: d.fields && typeof d.fields === "object" ? d.fields : {},
    note: String(d.note || ""),
    photos: Array.isArray(d.photos) ? d.photos : [],
  };
}

function renderAiDraftBanner() {
  const wrap = document.getElementById("ai-draft-banner");
  const summary = document.getElementById("ai-draft-summary");
  if (!wrap || !summary) return;
  if (!pendingAiEntryDraft) {
    wrap.classList.add("hidden");
    summary.textContent = "";
    return;
  }
  wrap.classList.remove("hidden");
  const cat = getCategory(pendingAiEntryDraft.categoryId);
  const detail = summarizeFields(cat, pendingAiEntryDraft.fields || {});
  summary.textContent = `${cat.emoji} ${cat.label} · ${String(pendingAiEntryDraft.at).slice(0, 19)}${detail ? ` · ${detail}` : ""}`;
}

function dismissPendingAiEntryDraft() {
  pendingAiEntryDraft = null;
  renderAiDraftBanner();
}

async function confirmPendingAiEntryDraft() {
  if (!pendingAiEntryDraft || aiBusy) return;
  const changedEntry = { ...pendingAiEntryDraft };
  dismissPendingAiEntryDraft();
  entries.push(changedEntry);
  entries.sort((a, b) => new Date(b.at) - new Date(a.at));
  if (apiReady) {
    try {
      const created = await apiRequest("/entries", {
        method: "POST",
        body: JSON.stringify(mapEntryToApi(changedEntry)),
      });
      if (created?.id) changedEntry.id = created.id;
    } catch {
      apiReady = false;
      save();
      alert("后端暂不可用，已回退到本地存储。");
    }
  } else {
    save();
  }
  showToast("已从 AI 草稿写入一条记录");
  renderAfterEntriesMutated();
  setActiveModule("timeline");
}

async function sendAiMessage() {
  if (aiBusy) return;
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-user-input"));
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!apiReady) {
    alert("问答需要后端：请先启动 babylog-api，并在进程环境中设置 DEEPSEEK_API_KEY。");
    return;
  }
  let active = getActiveAiSession();
  if (!active) {
    createAiSession();
    active = getActiveAiSession();
    if (!active) return;
  }
  input.value = "";
  dismissPendingAiEntryDraft();
  const userMsg = { role: "user", content: text, ts: nowIso() };
  const assistantMsg = { role: "assistant", content: "", ts: nowIso() };
  active.messages.push(userMsg);
  active.messages.push(assistantMsg);
  if (active.messages.length === 2 && (!active.title || active.title === "新会话" || active.title === "默认会话")) {
    active.title = summarizeAsTitle(text);
  }
  active.updatedAt = nowIso();
  saveAiProject();
  renderAiChat();
  renderAiSessionList();
  renderModuleSummaries();
  aiBusy = true;
  refreshAiUiState();
  const assistant = assistantMsg;
  const messageWindow = active.messages.slice(0, -1).slice(-40).map((m) => ({ role: m.role, content: m.content }));
  const consent = getAiContextConsent();
  const payload = {
    instruction: aiProject.instruction || aiInstruction,
    baby_context: buildBabyContextForAi(),
    messages: messageWindow,
    allow_server_tools: consent.allowServerTools,
  };
  try {
    await consumeSseChatStream(
      payload,
      (chunk) => {
        assistant.content += chunk;
        assistant.ts = nowIso();
      },
      (draft) => {
        const mapped = draftApiToLogEntry(draft);
        if (mapped) {
          pendingAiEntryDraft = mapped;
          renderAiDraftBanner();
        }
      },
    );
    active.updatedAt = nowIso();
    saveAiProject();
    scheduleAiChatRender();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    assistant.content = (assistant.content ? `${assistant.content}\n\n` : "") + `**出错：** ${msg}`;
    assistant.ts = nowIso();
    active.updatedAt = nowIso();
    saveAiProject();
    scheduleAiChatRender();
  } finally {
    flushStreamingMarkdownThrottle();
    aiBusy = false;
    setAiStatus("");
    refreshAiUiState();
    scheduleAiChatRender();
    renderAiSessionList();
    renderModuleSummaries();
  }
}

function populateFilter() {
  const sel = document.getElementById("filter-category");
  const cur = sel.value;
  sel.innerHTML = `<option value="">全部类型</option>`;
  for (const c of CATEGORIES) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.emoji} ${c.label}`;
    sel.appendChild(o);
  }
  sel.value = cur;
}

function populateChartMetricOptions() {
  const opts = getNumericMetricOptions();
  if (!opts.some((x) => x.id === chartMetricId) && opts[0]) chartMetricId = opts[0].id;
  renderChartMetricMenuItems();
}

function exportData() {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `babylog-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    const progressThreshold = 20;
    try {
      const arr = JSON.parse(/** @type {string} */ (reader.result));
      if (!Array.isArray(arr)) throw new Error("格式错误");
      const importedEntries = arr
        .filter((x) => x && x.id && x.categoryId && x.at)
        .map((x) => ({ ...x, photos: Array.isArray(x.photos) ? x.photos : [] }));
      const shouldShowProgress = importedEntries.length >= progressThreshold;
      setImportProgress(0, importedEntries.length, shouldShowProgress);
      const existingIds = new Set(entries.map((e) => e.id));
      const merged = new Map(entries.map((e) => [e.id, e]));
      for (const entry of importedEntries) merged.set(entry.id, entry);
      entries = Array.from(merged.values()).sort((a, b) => new Date(b.at) - new Date(a.at));
      if (apiReady) {
        let processed = 0;
        for (const e of importedEntries) {
          if (existingIds.has(e.id)) {
            await apiRequest(`/entries/${e.id}`, {
              method: "PATCH",
              body: JSON.stringify(mapEntryToApi(e)),
            });
          } else {
            await apiRequest("/entries", {
              method: "POST",
              body: JSON.stringify(mapEntryToApi(e)),
            });
          }
          processed += 1;
          if (shouldShowProgress && (processed % 5 === 0 || processed === importedEntries.length)) {
            setImportProgress(processed, importedEntries.length, true);
          }
        }
      } else {
        save();
      }
      renderAfterEntriesMutated();
      if (shouldShowProgress) {
        setImportProgress(importedEntries.length, importedEntries.length, true);
        setTimeout(() => setImportProgress(0, 0, false), 500);
      }
      showToast(`导入完成：新增/更新 ${importedEntries.length} 条，当前共 ${entries.length} 条`, 2800);
    } catch {
      setImportProgress(0, 0, false);
      showToast("导入失败：请确认是 Babylog 导出的 JSON", 3200);
    }
  };
  reader.readAsText(file);
}

function initAuthUi() {
  const form = document.getElementById("auth-form");
  if (form) {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      submitAuthForm();
    });
  }
  const submit = document.getElementById("btn-auth-submit");
  if (submit) {
    submit.addEventListener("click", (ev) => {
      ev.preventDefault();
      submitAuthForm();
    });
  }
  const sw = document.getElementById("btn-auth-switch");
  if (sw) {
    sw.addEventListener("click", () => {
      showAuthOverlay(authMode === "login" ? "register" : "login");
    });
  }
  const local = document.getElementById("btn-auth-local");
  if (local) {
    local.addEventListener("click", () => {
      authState.localOnly = true;
      authState.token = "";
      authState.user = null;
      authState.csrf = "";
      persistAuth();
      hideAuthOverlay();
      syncSidebarAccount();
      showToast("已进入本机模式");
    });
  }
  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      closeUserMenu();
      logout();
    });
  }
  initUserMenu();
  initSettingsDialog();
}

// ---- User menu (anchored popover on avatar button) -------------------------

function openUserMenu() {
  const pop = document.getElementById("user-menu-pop");
  const btn = document.getElementById("btn-user-menu");
  if (!pop || !btn) return;
  pop.classList.remove("hidden");
  btn.setAttribute("aria-expanded", "true");
  // Defer so the click that opened us doesn't immediately close us.
  setTimeout(() => {
    document.addEventListener("click", onUserMenuOutside, true);
    document.addEventListener("keydown", onUserMenuKey, true);
  }, 0);
}

function closeUserMenu() {
  const pop = document.getElementById("user-menu-pop");
  const btn = document.getElementById("btn-user-menu");
  if (!pop || !btn) return;
  pop.classList.add("hidden");
  btn.setAttribute("aria-expanded", "false");
  document.removeEventListener("click", onUserMenuOutside, true);
  document.removeEventListener("keydown", onUserMenuKey, true);
}

function onUserMenuOutside(ev) {
  const pop = document.getElementById("user-menu-pop");
  const btn = document.getElementById("btn-user-menu");
  if (!pop || !btn) return;
  if (pop.contains(ev.target) || btn.contains(ev.target)) return;
  closeUserMenu();
}

function onUserMenuKey(ev) {
  if (ev.key === "Escape") {
    closeUserMenu();
  }
}

function initUserMenu() {
  const btn = document.getElementById("btn-user-menu");
  if (!btn) return;
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const pop = document.getElementById("user-menu-pop");
    if (pop && !pop.classList.contains("hidden")) closeUserMenu();
    else openUserMenu();
  });
  const openSettings = document.getElementById("btn-open-settings");
  if (openSettings) {
    openSettings.addEventListener("click", () => {
      closeUserMenu();
      openSettingsDialog();
    });
  }
}

// ---- Settings dialog ------------------------------------------------------

function syncSettingsDialog() {
  const u = authState.user;
  const nameEl = document.getElementById("settings-username");
  const avatarEl = document.getElementById("settings-user-avatar");
  const clearBtn = document.getElementById("btn-clear-user-avatar");
  if (nameEl) nameEl.textContent = u?.username || "未登录";
  renderAvatarInto(avatarEl, u || { username: "", avatar: "" });
  if (clearBtn) clearBtn.style.display = u?.avatar ? "" : "none";

  const notifToggle = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-notif-toggle"));
  const notifDays = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-notif-days"));
  const notifStatus = document.getElementById("settings-notif-status");
  if (notifToggle) notifToggle.checked = Boolean(vaccineSettings.notificationsEnabled);
  if (notifDays) notifDays.value = String(vaccineSettings.reminderDays ?? 3);
  if (notifStatus) {
    const perm = "Notification" in window ? Notification.permission : "unsupported";
    if (perm === "unsupported") notifStatus.textContent = "当前浏览器不支持通知";
    else if (perm === "denied") notifStatus.textContent = "通知权限已被拒绝，请在浏览器地址栏处调整";
    else if (!vaccineSettings.notificationsEnabled) notifStatus.textContent = "开启后在到期前弹出浏览器通知";
    else notifStatus.textContent = "已开启。到期前会弹出浏览器通知";
  }

  const ac = getAiContextConsent();
  const g = (id) => /** @type {HTMLInputElement|null} */ (document.getElementById(id));
  const p = g("settings-ai-consent-profile");
  if (p) p.checked = ac.profile;
  const v = g("settings-ai-consent-vaccines");
  if (v) v.checked = ac.vaccinesSummary;
  const e = g("settings-ai-consent-entries");
  if (e) e.checked = ac.entriesSummary;
  const n = g("settings-ai-consent-notes");
  if (n) n.checked = ac.includeNotesInEntries;
  const ph = g("settings-ai-consent-photos");
  if (ph) ph.checked = ac.includePhotosInEntries;
  const t = g("settings-ai-consent-tools");
  if (t) t.checked = ac.allowServerTools;
  const ack = g("settings-ai-sync-ack");
  if (ack) ack.checked = Boolean(aiProject.syncSessionsDisclaimerAck);

  syncThemeToggleUi();
}

function openSettingsDialog() {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  syncSettingsDialog();
  document.addEventListener("keydown", onSettingsKey, true);
}

function closeSettingsDialog() {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  overlay.classList.add("hidden");
  document.removeEventListener("keydown", onSettingsKey, true);
}

function syncAiContextPolicyHint() {
  const el = document.getElementById("ai-context-policy-hint");
  if (!el) return;
  const p = aiProject.contextPolicy || "full_recent";
  const hints = {
    full_recent: "发送最近最多 300 条记录摘要（仍受设置 → AI 与隐私中的勾选项影响）。",
    recent_7d: "仅包含最近 7 天内最多 150 条记录。",
    timeline_filter: "与「活动」模块的类型、日期筛选一致，最多 200 条。",
    stats_only: "仅发送各分类条数统计，不包含逐条记录正文。",
  };
  el.textContent = hints[p] || "";
}

function initAiContextPolicySelect() {
  const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById("ai-context-policy"));
  if (!sel) return;
  sel.value = ["full_recent", "stats_only", "recent_7d", "timeline_filter"].includes(aiProject.contextPolicy)
    ? aiProject.contextPolicy
    : "full_recent";
  syncAiContextPolicyHint();
  sel.addEventListener("change", () => {
    aiProject.contextPolicy = sel.value;
    saveAiProject();
    syncAiContextPolicyHint();
  });
}

function openCommandPalette() {
  const el = document.getElementById("command-palette");
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById("command-palette-input"));
  if (!el) return;
  commandPaletteOpen = true;
  el.classList.remove("hidden");
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 10);
  }
  renderCommandPaletteResults("");
  document.addEventListener("keydown", onCommandPaletteKey, true);
}

function closeCommandPalette() {
  const el = document.getElementById("command-palette");
  if (!el) return;
  commandPaletteOpen = false;
  el.classList.add("hidden");
  document.removeEventListener("keydown", onCommandPaletteKey, true);
}

function onCommandPaletteKey(ev) {
  if (ev.key === "Escape") {
    ev.preventDefault();
    closeCommandPalette();
  }
}

function renderCommandPaletteResults(query) {
  const root = document.getElementById("command-palette-results");
  if (!root) return;
  root.innerHTML = "";
  const q = String(query || "").trim().toLowerCase();
  /** @type {{type: string, title: string, sub?: string, run: () => void}[]} */
  const items = [];

  const modules = [
    { id: "profile", label: "档案", kw: "profile 档案 baby" },
    { id: "ai", label: "AI 问答", kw: "ai 问答 助手" },
    { id: "quick-entry", label: "记录", kw: "记录 新建 添加" },
    { id: "timeline", label: "活动 / 时间轴", kw: "活动 时间轴 历史" },
    { id: "stats", label: "统计", kw: "统计 图表" },
    { id: "vaccine", label: "疫苗", kw: "疫苗 接种" },
    { id: "gallery", label: "相册", kw: "相册 照片" },
  ];
  for (const m of modules) {
    if (!q || m.kw.includes(q) || m.label.toLowerCase().includes(q)) {
      items.push({
        type: "模块",
        title: m.label,
        run: () => {
          setActiveModule(m.id);
          setSidebarOpen(false);
          closeCommandPalette();
        },
      });
    }
  }

  let entryCount = 0;
  for (const e of entries) {
    if (entryCount >= 14) break;
    const cat = getCategory(e.categoryId);
    const hay = `${cat.label} ${e.note || ""} ${e.at}`.toLowerCase();
    if (q && !hay.includes(q)) continue;
    const sid = e.id;
    items.push({
      type: "记录",
      title: `${cat.emoji} ${formatTime(e.at)} ${summarizeFields(cat, e.fields || {})}`,
      sub: e.note || String(e.at).slice(0, 10),
      run: () => {
        setActiveModule("timeline");
        setSidebarOpen(false);
        closeCommandPalette();
        const filter = /** @type {HTMLSelectElement} */ (document.getElementById("filter-category")).value;
        const day = /** @type {HTMLInputElement} */ (document.getElementById("filter-day")).value;
        let data = filter ? entries.filter((x) => x.categoryId === filter) : [...entries];
        if (day) data = data.filter((x) => toLocalDateKey(x.at) === day);
        const idx = data.findIndex((x) => x.id === sid);
        if (idx >= 0) timelineVisibleCount = Math.max(timelineVisibleCount, idx + 5, 20);
        renderTimeline();
      },
    });
    entryCount += 1;
  }

  items.push({
    type: "AI",
    title: "用自然语言记一条…",
    sub: "打开问答并聚焦输入框",
    run: () => {
      setActiveModule("ai");
      setSidebarOpen(false);
      closeCommandPalette();
      const inp = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-user-input"));
      if (inp) setTimeout(() => inp.focus(), 50);
    },
  });

  if (!items.length) {
    root.innerHTML = `<div class="muted-line" style="padding:12px">无匹配结果</div>`;
    return;
  }
  for (const it of items.slice(0, 22)) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "command-palette-item";
    const sub = it.sub ? `<div class="muted-line" style="font-size:12px;margin-top:2px">${escapeHtml(it.sub)}</div>` : "";
    btn.innerHTML = `<span class="command-palette-item-type">${escapeHtml(it.type)}</span>${escapeHtml(it.title)}${sub}`;
    btn.addEventListener("click", () => it.run());
    root.appendChild(btn);
  }
}

function initCommandPalette() {
  const overlay = document.getElementById("command-palette");
  const input = /** @type {HTMLInputElement|null} */ (document.getElementById("command-palette-input"));
  if (overlay) {
    overlay.addEventListener("click", (ev) => {
      if (ev.target === overlay) closeCommandPalette();
    });
  }
  if (input) {
    input.addEventListener("input", () => renderCommandPaletteResults(input.value));
  }
  for (const id of ["btn-command-palette-sidebar", "btn-command-palette-mobile"]) {
    const b = document.getElementById(id);
    if (b) b.addEventListener("click", () => openCommandPalette());
  }
  document.addEventListener("keydown", (ev) => {
    const isK = String(ev.key).toLowerCase() === "k";
    if (!(isK && (ev.metaKey || ev.ctrlKey))) return;
    ev.preventDefault();
    if (commandPaletteOpen) closeCommandPalette();
    else openCommandPalette();
  });
}

function onSettingsKey(ev) {
  if (ev.key === "Escape") closeSettingsDialog();
}

function initSettingsDialog() {
  const overlay = document.getElementById("settings-overlay");
  if (!overlay) return;
  const closeBtn = document.getElementById("btn-close-settings");
  if (closeBtn) closeBtn.addEventListener("click", closeSettingsDialog);
  overlay.addEventListener("click", (ev) => {
    if (ev.target === overlay) closeSettingsDialog();
  });

  const notifToggle = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-notif-toggle"));
  if (notifToggle) {
    notifToggle.addEventListener("change", async () => {
      if (notifToggle.checked) {
        if (!("Notification" in window)) {
          showToast("当前浏览器不支持通知");
          notifToggle.checked = false;
          return;
        }
        const perm = await Notification.requestPermission();
        if (perm !== "granted") {
          showToast("通知权限未授予");
          notifToggle.checked = false;
          syncSettingsDialog();
          return;
        }
        vaccineSettings.notificationsEnabled = true;
        saveVaccineSettings();
        showToast("通知已开启");
        try { checkVaccineReminders(false); } catch { /* non-fatal */ }
      } else {
        vaccineSettings.notificationsEnabled = false;
        saveVaccineSettings();
      }
      syncSettingsDialog();
    });
  }

  const notifDays = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-notif-days"));
  if (notifDays) {
    const commit = () => {
      const raw = Number(notifDays.value);
      const next = Number.isFinite(raw) ? Math.max(0, Math.min(30, Math.round(raw))) : 3;
      notifDays.value = String(next);
      if (next !== vaccineSettings.reminderDays) {
        vaccineSettings.reminderDays = next;
        saveVaccineSettings();
      }
    };
    notifDays.addEventListener("change", commit);
    notifDays.addEventListener("blur", commit);
  }

  const avatarInput = /** @type {HTMLInputElement|null} */ (document.getElementById("settings-avatar-input"));
  if (avatarInput) {
    avatarInput.addEventListener("change", onSettingsAvatarChange);
  }
  const clearBtn = document.getElementById("btn-clear-user-avatar");
  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      await saveUserAvatar("");
    });
  }

  const persistAiPrivacy = () => {
    const g = (id) => /** @type {HTMLInputElement|null} */ (document.getElementById(id));
    aiProject.aiContextConsent = {
      profile: g("settings-ai-consent-profile")?.checked !== false,
      vaccinesSummary: g("settings-ai-consent-vaccines")?.checked !== false,
      entriesSummary: g("settings-ai-consent-entries")?.checked !== false,
      includeNotesInEntries: g("settings-ai-consent-notes")?.checked !== false,
      includePhotosInEntries: g("settings-ai-consent-photos")?.checked !== false,
      allowServerTools: g("settings-ai-consent-tools")?.checked !== false,
    };
    aiProject.syncSessionsDisclaimerAck = g("settings-ai-sync-ack")?.checked || false;
    saveAiProject();
  };
  for (const id of [
    "settings-ai-consent-profile",
    "settings-ai-consent-vaccines",
    "settings-ai-consent-entries",
    "settings-ai-consent-notes",
    "settings-ai-consent-photos",
    "settings-ai-consent-tools",
    "settings-ai-sync-ack",
  ]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", persistAiPrivacy);
  }
}

async function onSettingsAvatarChange(ev) {
  const input = /** @type {HTMLInputElement} */ (ev.target);
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (!/^image\//.test(file.type)) {
    showToast("请选择图片文件");
    return;
  }
  try {
    const dataUrl = await compressImageToDataUrl(file, 256);
    await saveUserAvatar(dataUrl);
  } catch (err) {
    console.warn("avatar processing failed", err);
    showToast("头像处理失败");
  }
}

/**
 * Downscales an image to fit inside a square and re-encodes as JPEG. Returns
 * a data URL below ~200 KB suitable for the /api/auth/avatar endpoint (which
 * caps at 256 KB).
 */
function compressImageToDataUrl(file, edge = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("read failed"));
    reader.onload = () => {
      const src = String(reader.result || "");
      const img = new Image();
      img.onerror = () => reject(new Error("image decode failed"));
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          const scale = Math.min(1, edge / Math.max(w, h));
          const tw = Math.max(1, Math.round(w * scale));
          const th = Math.max(1, Math.round(h * scale));
          const canvas = document.createElement("canvas");
          canvas.width = tw;
          canvas.height = th;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("canvas 2d unavailable")); return; }
          ctx.drawImage(img, 0, 0, tw, th);
          let quality = 0.88;
          let out = canvas.toDataURL("image/jpeg", quality);
          while (out.length > 200 * 1024 && quality > 0.4) {
            quality -= 0.1;
            out = canvas.toDataURL("image/jpeg", quality);
          }
          resolve(out);
        } catch (e) {
          reject(e);
        }
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

async function saveUserAvatar(dataUrl) {
  const previous = authState.user?.avatar || "";
  // Optimistic update for snappy UI.
  if (authState.user) {
    authState.user.avatar = dataUrl;
    syncSidebarAccount();
    syncSettingsDialog();
  }
  if (authState.localOnly || !authState.user) {
    // Local-only or not logged in: nothing to push to the backend.
    showToast(dataUrl ? "头像已更新" : "头像已移除");
    return;
  }
  try {
    await apiRequest("/auth/avatar", {
      method: "PUT",
      body: JSON.stringify({ avatar: dataUrl }),
    });
    showToast(dataUrl ? "头像已更新" : "头像已移除");
  } catch (err) {
    // Roll back on failure.
    if (authState.user) {
      authState.user.avatar = previous;
      syncSidebarAccount();
      syncSettingsDialog();
    }
    console.warn("avatar update failed", err);
    showToast("头像保存失败");
  }
}

/**
 * Returns true if the backend /health endpoint is reachable.
 */
async function backendReachable() {
  try {
    const res = await fetch(`${API_ORIGIN}/health`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function init() {
  initTheme();
  initSidebarCollapse();
  loadProfile();
  loadAiInstruction();
  loadAuth();
  initAuthUi();

  const reachable = await backendReachable();
  if (reachable && !authState.localOnly) {
    const valid = await restoreSessionFromCookie();
    if (!valid) {
      authState.token = "";
      authState.user = null;
      authState.csrf = "";
      showAuthOverlay("login");
      // Skip backend data pulls until the user authenticates. initDataSource
      // would just 401 everywhere and briefly show empty state.
    } else {
      hideAuthOverlay();
      await initDataSource();
    }
  } else {
    hideAuthOverlay();
    await initDataSource();
  }
  syncSidebarAccount();
  const completionCount = [profile.name, profile.birthDate, profile.gender, profile.blood, profile.avatar].filter(Boolean).length;
  profileEditorOpen = completionCount < 4;
  initModuleNavigation();
  initLightbox();
  syncAiInstructionField();
  renderCategories();
  populateFilter();
  populateChartMetricOptions();
  populateVaccineRegionOptions();
  syncVaccineSettingControls();
  applyPresetRange("7d");
  syncStatsRangeInputs();
  render();

  document.getElementById("filter-category").addEventListener("change", () => {
    timelineVisibleCount = 20;
    renderTimeline();
  });
  document.getElementById("filter-day").addEventListener("change", () => {
    timelineVisibleCount = 20;
    renderTimeline();
  });
  document.getElementById("btn-more-timeline").addEventListener("click", () => {
    timelineVisibleCount += 20;
    renderTimeline();
  });
  document.getElementById("btn-save-profile").addEventListener("click", saveProfileFromForm);
  document.getElementById("btn-enter-edit").addEventListener("click", () => setProfileEditing(true));
  document.getElementById("btn-cancel-edit").addEventListener("click", () => { setProfileEditing(false); renderProfile(); });
  document.getElementById("btn-toggle-profile-editor").addEventListener("click", toggleProfileEditor);
  document.getElementById("baby-avatar").addEventListener("change", handleAvatarChange);
  document.getElementById("btn-clear-avatar").addEventListener("click", clearAvatar);
  document.getElementById("btn-build-vaccine").addEventListener("click", buildVaccinePlan);
  document.getElementById("vaccine-region").addEventListener("change", (ev) => {
    vaccineSettings.region = /** @type {HTMLSelectElement} */ (ev.target).value;
    saveVaccineSettings();
    const editor = document.getElementById("vaccine-template-editor");
    if (!editor.classList.contains("hidden")) loadCurrentTemplateToEditor();
  });
  document.getElementById("vaccine-reminder-days").addEventListener("change", (ev) => {
    vaccineSettings.reminderDays = Number(/** @type {HTMLSelectElement} */ (ev.target).value) || 0;
    saveVaccineSettings();
    renderVaccines();
  });
  document.getElementById("btn-check-vaccine-reminder").addEventListener("click", () => checkVaccineReminders(true));
  document.getElementById("btn-enable-vaccine-notice").addEventListener("click", enableVaccineNotification);
  document.getElementById("btn-toggle-vaccine-editor").addEventListener("click", toggleVaccineTemplateEditor);
  document.getElementById("btn-load-vaccine-template").addEventListener("click", loadCurrentTemplateToEditor);
  document.getElementById("btn-add-vaccine-row").addEventListener("click", () => appendTemplateRow());
  document.getElementById("btn-save-vaccine-template").addEventListener("click", saveCustomTemplateFromEditor);
  document.getElementById("btn-delete-vaccine-template").addEventListener("click", deleteCurrentCustomTemplate);
  document.getElementById("stats-preset").addEventListener("change", (ev) => {
    const preset = /** @type {HTMLSelectElement} */ (ev.target).value;
    if (preset === "custom") return;
    applyPresetRange(preset);
  });
  const statsStartEl = /** @type {HTMLInputElement|null} */ (document.getElementById("stats-start"));
  const statsEndEl = /** @type {HTMLInputElement|null} */ (document.getElementById("stats-end"));
  if (statsStartEl) statsStartEl.addEventListener("input", scheduleAutoApplyCustomStatsRange);
  if (statsEndEl) statsEndEl.addEventListener("input", scheduleAutoApplyCustomStatsRange);
  document.querySelectorAll(".stats-mode-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextMode = btn.getAttribute("data-mode");
      if (!nextMode || nextMode === statsMode) return;
      statsMode = nextMode;
      renderStats();
    });
  });
  const chartMetricMenu = document.getElementById("chart-metric-menu");
  if (chartMetricMenu) {
    chartMetricMenu.addEventListener("click", (ev) => {
      const target = /** @type {HTMLElement|null} */ (ev.target);
      const item = target ? target.closest("[data-metric-id]") : null;
      if (!item) return;
      const nextMetricId = item.getAttribute("data-metric-id") || "";
      if (!nextMetricId || nextMetricId === chartMetricId) return;
      chartMetricId = nextMetricId;
      hideChartMetricMenu();
      if (statsMode === "chart") renderTrendChart();
    });
  }
  document.querySelectorAll(".chart-res-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-resolution") || "day";
      chartResolution = next;
      if (statsMode === "chart") renderTrendChart();
      else syncChartResolutionButtons();
    });
  });
  window.addEventListener("resize", () => {
    if (statsMode !== "chart") return;
    if (chartResizeRafId) cancelAnimationFrame(chartResizeRafId);
    chartResizeRafId = requestAnimationFrame(() => {
      chartResizeRafId = 0;
      if (statsMode === "chart") renderTrendChart();
    });
  });
  const chartCanvas = document.getElementById("stats-chart");
  if (chartCanvas) {
    chartCanvas.addEventListener("pointermove", onChartPointerMove);
    chartCanvas.addEventListener("pointerdown", onChartPointerDown);
    chartCanvas.addEventListener("pointerup", onChartPointerUp);
    chartCanvas.addEventListener("pointercancel", onChartPointerUp);
    chartCanvas.addEventListener("pointerleave", onChartPointerLeave);
  }
  const chartMenuBackdrop = document.getElementById("chart-metric-menu-backdrop");
  if (chartMenuBackdrop) chartMenuBackdrop.addEventListener("click", hideChartMetricMenu);
  document.getElementById("chart-empty-to-cards")?.addEventListener("click", () => {
    statsMode = "cards";
    renderStats();
  });
  document.getElementById("chart-empty-widen-range")?.addEventListener("click", () => {
    applyPresetRange("30d");
  });
  const chartLegendTrigger = document.getElementById("chart-legend-trigger");
  if (chartLegendTrigger) {
    chartLegendTrigger.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openChartMetricMenuByLegend();
    });
    chartLegendTrigger.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        openChartMetricMenuByLegend();
      }
    });
  }
  document.addEventListener("click", (ev) => {
    const target = /** @type {HTMLElement|null} */ (ev.target);
    if (!target) return;
    if (target.closest("#chart-metric-menu") || target.closest("#stats-chart") || target.closest("#chart-legend-trigger")) return;
    hideChartMetricMenu();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") hideChartMetricMenu();
  });
  document.getElementById("btn-export").addEventListener("click", exportData);
  document.getElementById("import-file").addEventListener("change", (ev) => {
    const f = /** @type {HTMLInputElement} */ (ev.target).files?.[0];
    if (f) importData(f);
    /** @type {HTMLInputElement} */ (ev.target).value = "";
  });
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("modal-save").addEventListener("click", submitModal);
  document.getElementById("modal-overlay").addEventListener("click", (ev) => {
    if (ev.target.id === "modal-overlay") closeModal();
  });

  const btnSaveAiInstr = document.getElementById("btn-save-ai-instruction");
  if (btnSaveAiInstr) btnSaveAiInstr.addEventListener("click", saveAiInstructionFromForm);
  const btnEditAiInstr = document.getElementById("btn-edit-ai-instruction");
  if (btnEditAiInstr) btnEditAiInstr.addEventListener("click", openAiInstructionEditor);
  const btnDiscardAiInstr = document.getElementById("btn-discard-ai-instruction");
  if (btnDiscardAiInstr) btnDiscardAiInstr.addEventListener("click", discardAiInstruction);
  const aiInstrTextarea = document.getElementById("ai-instruction");
  if (aiInstrTextarea) aiInstrTextarea.addEventListener("input", syncAiInstructionSaveBtn);
  const aiInstrModal = document.getElementById("ai-instruction-modal");
  if (aiInstrModal) {
    aiInstrModal.addEventListener("click", (ev) => {
      if (ev.target === aiInstrModal) discardAiInstruction();
    });
    aiInstrModal.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") discardAiInstruction();
    });
  }
  const btnAiNewSession = document.getElementById("btn-ai-new-session");
  if (btnAiNewSession) btnAiNewSession.addEventListener("click", createAiSession);
  const inputAiSearch = document.getElementById("ai-session-search");
  if (inputAiSearch) {
    inputAiSearch.addEventListener("input", (ev) => {
      aiSessionSearchKeyword = /** @type {HTMLInputElement} */ (ev.target).value || "";
      renderAiSessionList();
    });
  }
  const aiUserInput = document.getElementById("ai-user-input");
  if (aiUserInput) {
    aiUserInput.addEventListener("input", refreshAiUiState);
    aiUserInput.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" || ev.shiftKey) return;
      ev.preventDefault();
      sendAiMessage();
    });
  }
  const btnAiSend = document.getElementById("btn-ai-send");
  if (btnAiSend) btnAiSend.addEventListener("click", sendAiMessage);
  document.getElementById("btn-ai-draft-dismiss")?.addEventListener("click", dismissPendingAiEntryDraft);
  document.getElementById("btn-ai-draft-confirm")?.addEventListener("click", () => {
    confirmPendingAiEntryDraft();
  });
  document.addEventListener("keydown", handleAiGlobalShortcuts);
  initAiContextPolicySelect();
  initCommandPalette();
  renderAiSessionList();
  refreshAiUiState();
  initCustomDropdowns();
}
