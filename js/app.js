/**
 * BabyLog — 本地存储的婴儿日常记录
 */

const STORAGE_KEY = "babylog_entries_v1";
const STORAGE_PROFILE_KEY = "babylog_profile_v1";
const STORAGE_THEME_KEY = "babylog_theme_mode_v1";
const STORAGE_SIDEBAR_COLLAPSED_KEY = "babylog_sidebar_collapsed_v1";
const STORAGE_AI_INSTRUCTION_KEY = "babylog_ai_instruction_v1";
const STORAGE_AI_PROJECT_KEY = "babylog_ai_project_v1";
const DEFAULT_AI_INSTRUCTION =
  "你是婴幼儿照护与成长数据助手，正在协助家长阅读「BabyLog」里的记录。\n\n回答要清晰、可执行；不要夸大确定性。凡涉及疾病诊断、用药调整或紧急情况，必须提醒家长咨询医生或前往医院。";
const API_BASE = "http://127.0.0.1:8787/api";
/** Origin for uploads and /media (no /api suffix). */
const API_ORIGIN = API_BASE.replace(/\/api\/?$/i, "") || "http://127.0.0.1:8787";

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
const TREND_LINE_COLOR = "#1d9bf0";
let chartRangeMode = "follow";
let chartMetricId = "feeding.amountMl";
let chartHitPoints = [];
let apiReady = false;
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
/**
 * @typedef {{role: 'user'|'assistant', content: string, ts: string}} AiMessage
 * @typedef {{id: string, title: string, createdAt: string, updatedAt: string, messages: AiMessage[]}} AiSession
 * @typedef {{instruction: string, activeSessionId: string, contextPolicy: string, sessions: AiSession[]}} AiProject
 */
/** @type {AiProject} */
let aiProject = { instruction: DEFAULT_AI_INSTRUCTION, activeSessionId: "", contextPolicy: "full_recent", sessions: [] };
let aiStreamRenderScheduled = false;
let aiBusy = false;
let aiSessionSearchKeyword = "";
/** @type {string|null} 列表内删除确认：当前待确认的会话 id */
let aiSessionDeletePendingId = null;

const VACCINE_TEMPLATES = {
  cn: [
    { name: "乙肝疫苗", dose: "第1针", day: 0 },
    { name: "卡介苗", dose: "第1针", day: 0 },
    { name: "乙肝疫苗", dose: "第2针", day: 30 },
    { name: "脊灰灭活疫苗", dose: "第1针", day: 60 },
    { name: "五联/百白破", dose: "第1针", day: 90 },
    { name: "乙肝疫苗", dose: "第3针", day: 180 },
    { name: "流脑A疫苗", dose: "第1针", day: 180 },
    { name: "麻腮风疫苗", dose: "第1针", day: 240 },
    { name: "乙脑减毒活疫苗", dose: "第1针", day: 240 },
  ],
  who: [
    { name: "BCG", dose: "Birth", day: 0 },
    { name: "HepB", dose: "Birth", day: 0 },
    { name: "DTP-HepB-Hib", dose: "6周", day: 42 },
    { name: "PCV", dose: "6周", day: 42 },
    { name: "DTP-HepB-Hib", dose: "10周", day: 70 },
    { name: "PCV", dose: "10周", day: 70 },
    { name: "DTP-HepB-Hib", dose: "14周", day: 98 },
    { name: "MR", dose: "9月龄", day: 270 },
  ],
  us: [
    { name: "HepB", dose: "Dose 1", day: 0 },
    { name: "HepB", dose: "Dose 2", day: 30 },
    { name: "DTaP", dose: "Dose 1", day: 60 },
    { name: "IPV", dose: "Dose 1", day: 60 },
    { name: "Hib", dose: "Dose 1", day: 60 },
    { name: "PCV13", dose: "Dose 1", day: 60 },
    { name: "DTaP", dose: "Dose 2", day: 120 },
    { name: "MMR", dose: "Dose 1", day: 365 },
  ],
};
const DEFAULT_VACCINE_TEMPLATE_LABELS = {
  cn: "中国大陆计划",
  who: "WHO扩展计划",
  us: "美国CDC简版",
};

const CATEGORIES = [
  { id: "feeding", label: "喝奶", emoji: "🍼", fields: [
    { key: "subtype", label: "方式", type: "select", options: [
      { v: "breast", t: "母乳" },
      { v: "bottle", t: "瓶喂配方/母乳" },
      { v: "mixed", t: "混合" },
    ]},
    { key: "amountMl", label: "奶量 (ml)", type: "number", placeholder: "可选" },
    { key: "side", label: "单侧/双侧", type: "select", options: [
      { v: "", t: "—" },
      { v: "L", t: "左侧" },
      { v: "R", t: "右侧" },
      { v: "both", t: "双侧" },
    ]},
  ]},
  { id: "sleep", label: "睡觉", emoji: "😴", fields: [
    { key: "subtype", label: "状态", type: "select", options: [
      { v: "start", t: "开始睡" },
      { v: "end", t: "醒来" },
      { v: "nap", t: "小睡片段" },
    ]},
    { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
  ]},
  { id: "diaper", label: "换尿布", emoji: "👶", fields: [
    { key: "subtype", label: "类型", type: "select", options: [
      { v: "wet", t: "小便" },
      { v: "dirty", t: "大便" },
      { v: "both", t: "都有" },
      { v: "dry", t: "干爽检查" },
    ]},
  ]},
  { id: "temperature", label: "体温", emoji: "🌡️", fields: [
    { key: "celsius", label: "体温 (°C)", type: "number", step: "0.1", placeholder: "如 36.8" },
    { key: "place", label: "测量部位", type: "select", options: [
      { v: "armpit", t: "腋下" },
      { v: "ear", t: "耳温" },
      { v: "forehead", t: "额温" },
      { v: "rectal", t: "肛温" },
    ]},
  ]},
  { id: "bath", label: "洗澡", emoji: "🛁", fields: [
    { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
  ]},
  { id: "medicine", label: "用药", emoji: "💊", fields: [
    { key: "name", label: "药名", type: "text", placeholder: "如 退烧药" },
    { key: "dose", label: "剂量", type: "text", placeholder: "如 2.5ml" },
  ]},
  { id: "supplement", label: "补剂", emoji: "✨", fields: [
    { key: "name", label: "种类", type: "select", options: [
      { v: "vd", t: "维生素 D" },
      { v: "ad", t: "维生素 AD" },
      { v: "dha", t: "DHA" },
      { v: "probiotic", t: "益生菌" },
      { v: "other", t: "其他" },
    ]},
    { key: "dose", label: "说明", type: "text", placeholder: "滴数/粒数等" },
  ]},
  { id: "tummy_time", label: "趴玩/大运动", emoji: "🐣", fields: [
    { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
    { key: "subtype", label: "内容", type: "select", options: [
      { v: "tummy", t: "趴卧抬头" },
      { v: "grip", t: "抓握练习" },
      { v: "roll", t: "翻身引导" },
      { v: "other", t: "其他" },
    ]},
  ]},
  { id: "growth", label: "生长测量", emoji: "📏", fields: [
    { key: "weightKg", label: "体重 (kg)", type: "number", step: "0.01", placeholder: "可选" },
    { key: "heightCm", label: "身长 (cm)", type: "number", step: "0.1", placeholder: "可选" },
    { key: "headCm", label: "头围 (cm)", type: "number", step: "0.1", placeholder: "可选" },
  ]},
  { id: "spitup", label: "吐奶/溢奶", emoji: "💧", fields: [
    { key: "subtype", label: "程度", type: "select", options: [
      { v: "light", t: "少量溢奶" },
      { v: "moderate", t: "吐一口" },
      { v: "heavy", t: "较多" },
    ]},
  ]},
  { id: "cry", label: "哭闹/安抚", emoji: "😢", fields: [
    { key: "durationMin", label: "持续 (分钟)", type: "number", placeholder: "可选" },
    { key: "soothe", label: "安抚方式", type: "text", placeholder: "抱哄/白噪音等" },
  ]},
  { id: "outdoor", label: "外出/晒太阳", emoji: "☀️", fields: [
    { key: "durationMin", label: "外出时长 (分钟)", type: "number", placeholder: "可选" },
    { key: "place", label: "地点/备注", type: "text", placeholder: "可选" },
  ]},
  { id: "pump", label: "吸奶", emoji: "🤱", fields: [
    { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
    { key: "amountMl", label: "吸出量 (ml)", type: "number", placeholder: "可选" },
    { key: "side", label: "侧", type: "select", options: [
      { v: "L", t: "左侧" },
      { v: "R", t: "右侧" },
      { v: "both", t: "双侧" },
    ]},
  ]},
  { id: "solid", label: "辅食", emoji: "🥣", fields: [
    { key: "food", label: "食物", type: "text", placeholder: "如 米粉+南瓜" },
    { key: "amount", label: "食量说明", type: "text", placeholder: "几勺/吃完等" },
  ]},
  { id: "custom", label: "其他", emoji: "📝", fields: [] },
];

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

async function apiRequest(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return null;
}

function mapEntryFromApi(item) {
  return {
    id: item.id,
    categoryId: item.category_id,
    at: item.at,
    fields: item.fields || {},
    note: item.note || "",
    photos: Array.isArray(item.photos) ? item.photos : [],
  };
}

function mapEntryToApi(item) {
  return {
    category_id: item.categoryId,
    at: item.at,
    fields: item.fields || {},
    note: item.note || "",
    photos: Array.isArray(item.photos) ? item.photos : [],
  };
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
    titleEl.textContent = activeNavText.textContent || "BabyLog";
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
    const target = /** @type {HTMLElement|null} */ (ev.target instanceof HTMLElement ? ev.target.closest(".module-nav-item") : null);
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
    const [
      apiProfile,
      apiEntriesResp,
      apiVaccines,
      apiVaccineSettings,
      apiVaccineTemplates,
    ] = await Promise.all([
      apiRequest("/profile"),
      apiRequest("/entries?limit=5000&offset=0"),
      apiRequest("/vaccines"),
      apiRequest("/vaccine-settings"),
      apiRequest("/vaccine-templates"),
    ]);
    profile = {
      name: apiProfile?.name || "",
      birthDate: apiProfile?.birth_date || "",
      gender: apiProfile?.gender || "",
      blood: apiProfile?.blood || "",
      avatar: apiProfile?.avatar || apiProfile?.avatar_url || profile.avatar || "",
    };
    const items = Array.isArray(apiEntriesResp?.items) ? apiEntriesResp.items : [];
    entries = items.map(mapEntryFromApi).sort((a, b) => new Date(b.at) - new Date(a.at));
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

function toLocalDateKey(input) {
  const d = new Date(input);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
    else if (f.key === "durationMin") parts.push(`${v} 分钟`);
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
      opts.push({
        id: `${c.id}.${f.key}`,
        label: `${c.emoji} ${c.label} · ${f.label}`,
        categoryId: c.id,
        fieldKey: f.key,
        unit: inferMetricUnit(f),
      });
    }
  }
  return opts;
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

const MAX_ENTRY_PHOTOS = 8;
const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

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
    body: form,
  });
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
    <label for="field-photos">照片（可选，最多 ${MAX_ENTRY_PHOTOS} 张，需后端；存对象存储+URL）</label>
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
  render();
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
  render();
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
    const photos = collectGalleryPhotos();
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
    aiSummary.innerHTML = `
      <span class="module-summary-item">会话数 <strong>${aiProject.sessions.length}</strong></span>
      <span class="module-summary-item">用户消息 <strong>${userTurns}</strong></span>
      <span class="module-summary-item">上下文记录 <strong>最多 300 条</strong></span>
    `;
  }
}

function renderStats() {
  const grid = document.getElementById("stats-grid");
  const chartWrap = document.getElementById("stats-chart-wrap");
  const rangeHint = document.getElementById("stats-range-hint");
  const inRangeEntries = getEntriesByRange(statsRange.start, statsRange.end);
  const feedMl = inRangeEntries
    .filter((e) => e.categoryId === "feeding")
    .reduce((sum, e) => sum + (Number(e.fields?.amountMl) || 0), 0);
  const sleepMin = inRangeEntries
    .filter((e) => e.categoryId === "sleep")
    .reduce((sum, e) => sum + (Number(e.fields?.durationMin) || 0), 0);
  const wetCount = inRangeEntries.filter((e) => e.categoryId === "diaper" && ["wet", "both"].includes(String(e.fields?.subtype || ""))).length;
  const dirtyCount = inRangeEntries.filter((e) => e.categoryId === "diaper" && ["dirty", "both"].includes(String(e.fields?.subtype || ""))).length;
  const bathCount = inRangeEntries.filter((e) => e.categoryId === "bath").length;
  const medicineCount = inRangeEntries.filter((e) => e.categoryId === "medicine").length;
  const doneVaccines = vaccines.filter((v) => v.status === "done").length;
  const rangeLabel = statsRange.start && statsRange.end ? `${statsRange.start} 至 ${statsRange.end}` : "全部时间";

  if (rangeHint) {
    rangeHint.textContent = `当前范围：${rangeLabel}`;
  }

  const cards = [
    { k: "范围记录总数", v: `${inRangeEntries.length} 条`, tone: "priority" },
    { k: "范围喂奶总量", v: `${feedMl} ml`, tone: "priority" },
    { k: "范围睡眠时长", v: `${sleepMin} 分钟` },
    { k: "范围尿布", v: `小便 ${wetCount} / 大便 ${dirtyCount}` },
    { k: "范围洗澡次数", v: `${bathCount} 次` },
    { k: "范围用药次数", v: `${medicineCount} 次` },
    { k: "疫苗完成进度", v: vaccines.length ? `${doneVaccines}/${vaccines.length}` : "未生成" },
    { k: "累计总记录", v: `${entries.length} 条` },
  ];
  grid.innerHTML = cards
    .map((c) => `<div class="stat-card ${c.tone || ""}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`)
    .join("");
  if (statsMode === "chart") {
    grid.classList.add("hidden");
    chartWrap.classList.remove("hidden");
    renderTrendChart();
  } else {
    chartWrap.classList.add("hidden");
    grid.classList.remove("hidden");
  }
}

function getChartDateRange() {
  if (chartRangeMode === "follow") {
    return { start: statsRange.start, end: statsRange.end };
  }
  const days = Number(chartRangeMode) || 7;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (days - 1));
  const fmt = (d) => toLocalDateKey(d);
  return { start: fmt(start), end: fmt(end) };
}

function renderTrendChart() {
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("stats-chart"));
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = canvas.clientWidth || 900;
  const cssHeight = 320;
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);

  const trend = buildTrendData();
  const points = trend.points;
  const vals = points.map((p) => p.value);
  if (points.length === 0) {
    ctx.fillStyle = "rgba(128, 128, 128, 0.6)";
    ctx.font = '13px "SF Pro Text", "Helvetica Neue", Arial';
    ctx.fillText("当前范围暂无可绘制数据", 16, 28);
    return;
  }
  const maxY = Math.max(10, ...vals);
  const left = 56;
  const right = 12;
  const top = 22;
  const bottom = 30;
  const pw = cssWidth - left - right;
  const ph = cssHeight - top - bottom;
  const unit = trend.unit || "数值";

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
    const v = Math.round(maxY - (maxY / 4) * i);
    ctx.fillText(String(v), 8, y + 4);
  }
  ctx.fillText(unit, 8, 14);

  const mapX = (i) => left + (pw * i) / Math.max(1, points.length - 1);
  const mapY = (v) => top + ph - (v / maxY) * ph;
  chartHitPoints = points.map((p, i) => ({
    x: mapX(i),
    y: mapY(p.value),
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
  // 点线图: 先画线，再画点
  const gradient = ctx.createLinearGradient(0, top, 0, top + ph);
  gradient.addColorStop(0, "rgba(92, 156, 245, 0.18)");
  gradient.addColorStop(1, "rgba(92, 156, 245, 0.01)");
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

  drawSeries(vals, TREND_LINE_COLOR);
  ctx.fillStyle = TREND_LINE_COLOR;
  points.forEach((p, i) => {
    const x = mapX(i);
    const y = mapY(p.value);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = TREND_LINE_COLOR;
    ctx.fill();
  });

  ctx.fillStyle = "rgba(128, 128, 128, 0.6)";
  ctx.font = '11px "SF Pro Text", "Helvetica Neue", Arial';
  points.forEach((p, i) => {
    if (i % Math.ceil(points.length / 6) !== 0 && i !== points.length - 1) return;
    ctx.fillText(p.label, mapX(i) - 12, cssHeight - 8);
  });
}

function hideChartTooltip() {
  const tip = document.getElementById("chart-tooltip");
  if (!tip) return;
  tip.classList.add("hidden");
}

function onChartHover(ev) {
  if (statsMode !== "chart") return;
  const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("stats-chart"));
  const tip = document.getElementById("chart-tooltip");
  if (!canvas || !tip || chartHitPoints.length === 0) return;
  const rect = canvas.getBoundingClientRect();
  const mx = ev.clientX - rect.left;
  const my = ev.clientY - rect.top;

  let nearest = null;
  let minDist = Infinity;
  for (const p of chartHitPoints) {
    const dx = p.x - mx;
    const dy = p.y - my;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < minDist) {
      minDist = dist;
      nearest = p;
    }
  }
  if (!nearest || minDist > 18) {
    hideChartTooltip();
    return;
  }

  tip.innerHTML = `<div class="chart-tip-label">${nearest.label}</div><div class="chart-tip-value">${nearest.value} ${nearest.unit}</div>`;
  const offsetX = Math.min(rect.width - 130, Math.max(6, nearest.x + 10));
  const offsetY = Math.max(6, nearest.y - 42);
  tip.style.left = `${offsetX}px`;
  tip.style.top = `${offsetY}px`;
  tip.classList.remove("hidden");
}

function buildTrendData() {
  const metrics = getNumericMetricOptions();
  const metric = metrics.find((m) => m.id === chartMetricId) || metrics[0];
  if (!metric) return { mode: "range-line", points: [], unit: "数值" };
  const legend = document.getElementById("chart-legend-text");
  if (legend) legend.textContent = metric.label;

  const range = getChartDateRange();
  const source = getEntriesByRange(range.start, range.end);
  const data = [];
  if (!range.start || !range.end) return { mode: "range-line", points: data };
  const start = new Date(`${range.start}T00:00:00`);
  const end = new Date(`${range.end}T00:00:00`);
  const isSingleDay = range.start === range.end;
  if (isSingleDay) {
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
    return { mode: "day-points", points: dayPoints, unit: metric.unit };
  }
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const key = toLocalDateKey(d);
    const label = `${d.getMonth() + 1}/${d.getDate()}`;
    const dayEntries = source.filter((e) => toLocalDateKey(e.at) === key && e.categoryId === metric.categoryId);
    const value = dayEntries.reduce((sum, e) => sum + (Number(e.fields?.[metric.fieldKey]) || 0), 0);
    data.push({ label, value });
  }
  return { mode: "range-line", points: data, unit: metric.unit };
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

function applyCustomStatsRange() {
  const start = /** @type {HTMLInputElement} */ (document.getElementById("stats-start")).value;
  const end = /** @type {HTMLInputElement} */ (document.getElementById("stats-end")).value;
  if (start && end && start > end) {
    alert("开始日期不能晚于结束日期");
    return;
  }
  statsRange = { start, end, preset: "custom" };
  syncStatsRangeInputs();
  render();
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
  render();
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
      new Notification("BabyLog 疫苗提醒", {
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
  render();
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

function collectGalleryPhotos() {
  /** @type {Array<{entryId: string, at: string, categoryLabel: string, url: string}>} */
  const photos = [];
  for (const entry of entries) {
    const urls = Array.isArray(entry.photos) ? entry.photos : [];
    if (!urls.length) continue;
    const cat = getCategory(entry.categoryId);
    for (const url of urls) {
      photos.push({
        entryId: entry.id,
        at: entry.at,
        categoryLabel: cat.label,
        url,
      });
    }
  }
  return photos.sort((a, b) => new Date(b.at) - new Date(a.at));
}

let galleryPhotos = [];

function renderPhotoGallery() {
  const summaryEl = document.getElementById("photo-gallery-summary");
  const galleryEl = document.getElementById("photo-gallery");
  if (!summaryEl || !galleryEl) return;
  galleryPhotos = collectGalleryPhotos();
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
  if (!["full_recent"].includes(aiProject.contextPolicy)) aiProject.contextPolicy = "full_recent";
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

function migrateLegacyAiMessagesIfNeeded() {
  if (aiProject.sessions.some((s) => Array.isArray(s.messages) && s.messages.length > 0)) return;
  const legacy = Array.isArray(globalThis.aiMessages) ? globalThis.aiMessages : null;
  if (!legacy || !legacy.length) return;
  const first = getActiveAiSession();
  if (!first) return;
  first.messages = legacy
    .filter((m) => m && (m.role === "user" || m.role === "assistant"))
    .map((m) => ({ role: m.role, content: String(m.content || ""), ts: nowIso() }));
  if (first.messages.length > 0 && (!first.title || first.title === "默认会话" || first.title === "新会话")) {
    const lead = first.messages.find((m) => m.role === "user");
    if (lead && lead.content) first.title = summarizeAsTitle(lead.content);
  }
  first.updatedAt = nowIso();
}

function loadAiInstruction() {
  let legacyInstruction = DEFAULT_AI_INSTRUCTION;
  try {
    const raw = localStorage.getItem(STORAGE_AI_INSTRUCTION_KEY);
    legacyInstruction = raw && String(raw).trim() ? String(raw) : DEFAULT_AI_INSTRUCTION;
  } catch {
    legacyInstruction = DEFAULT_AI_INSTRUCTION;
  }
  try {
    const rawProject = localStorage.getItem(STORAGE_AI_PROJECT_KEY);
    if (rawProject) {
      const data = JSON.parse(rawProject);
      aiProject = {
        instruction: String(data?.instruction || legacyInstruction || DEFAULT_AI_INSTRUCTION),
        activeSessionId: String(data?.activeSessionId || ""),
        contextPolicy: String(data?.contextPolicy || "full_recent"),
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
      aiProject = { instruction: legacyInstruction, activeSessionId: "", contextPolicy: "full_recent", sessions: [] };
    }
  } catch {
    aiProject = { instruction: legacyInstruction, activeSessionId: "", contextPolicy: "full_recent", sessions: [] };
  }
  ensureAiProjectConsistency();
  migrateLegacyAiMessagesIfNeeded();
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

function saveAiInstructionFromForm() {
  const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-instruction"));
  if (!ta) return;
  aiProject.instruction = ta.value.trim() ? ta.value : DEFAULT_AI_INSTRUCTION;
  aiInstruction = aiProject.instruction;
  saveAiProject();
  syncAiInstructionField();
  closeAiInstructionEditor();
  showToast("指令已保存");
}

function openAiInstructionEditor() {
  const modal = document.getElementById("ai-instruction-modal");
  const ta = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-instruction"));
  if (!modal) return;
  modal.classList.remove("hidden");
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
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

function renderMarkdownToHtml(src) {
  const md = String(src || "");
  if (!md.trim()) return "";
  const markedFn = typeof marked !== "undefined" ? /** @type {any} */ (marked) : null;
  const purify = typeof DOMPurify !== "undefined" ? DOMPurify : null;
  if (!markedFn || !purify) {
    return `<p>${escapeHtml(md)}</p>`;
  }
  try {
    const rawHtml = markedFn.parse(md, { breaks: true, gfm: true });
    return purify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  } catch {
    return `<p>${escapeHtml(md)}</p>`;
  }
}

function buildBabyContextForAi() {
  const lines = [];
  const genderMap = { boy: "男", girl: "女", other: "未设置/其他" };
  lines.push("## 宝宝档案");
  lines.push(`昵称: ${profile.name || "未填写"}`);
  lines.push(`出生日期: ${profile.birthDate || "未填写"}`);
  lines.push(`性别: ${profile.gender ? genderMap[profile.gender] || profile.gender : "未填写"}`);
  lines.push(`血型: ${profile.blood || "未填写"}`);
  lines.push(`月龄参考: ${getAgeText()}`);
  lines.push("");
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
  lines.push("## 最近记录（时间倒序，最多 300 条；文本由应用汇总）");
  const slice = entries.slice(0, 300);
  if (!slice.length) {
    lines.push("暂无记录。");
  } else {
    for (const e of slice) {
      const cat = getCategory(e.categoryId);
      const detail = summarizeFields(cat, e.fields || {});
      const metaLine = [formatDateHeader(e.at), formatTime(e.at), `${cat.emoji} ${cat.label}`, detail, e.note]
        .filter((x) => x !== undefined && x !== null && String(x).trim() !== "")
        .join(" | ");
      lines.push(metaLine);
    }
    if (entries.length > 300) lines.push(`… 共 ${entries.length} 条记录，仅附最近 300 条`);
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
  if (moduleEl) moduleEl.classList.toggle("ai-busy", aiBusy);
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
    root.innerHTML = `<div class="empty-state"><div class="ai-empty-greeting">你好，有什么可以帮你的？</div><div class="ai-empty-hint">输入问题开始对话</div></div>`;
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
      const content = m.content || (aiBusy ? "…" : "");
      bubble.innerHTML = content ? renderMarkdownToHtml(content) : "";
      if (isLastAssistantStreaming) {
        bubble.classList.add("ai-streaming");
      }
    } else {
      bubble.textContent = m.content;
    }
    row.appendChild(bubble);
    root.appendChild(row);
  }
  root.scrollTop = root.scrollHeight;
  refreshAiUiState();
}

/**
 * @param {object} payload
 * @param {(chunk: string) => void} onChunk
 */
async function consumeSseChatStream(payload, onChunk) {
  const res = await fetch(`${API_BASE}/chat/stream`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
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
        if (obj && typeof obj.c === "string" && obj.c) onChunk(obj.c);
      }
    }
  }
}

async function sendAiMessage() {
  if (aiBusy) return;
  const input = /** @type {HTMLTextAreaElement|null} */ (document.getElementById("ai-user-input"));
  if (!input) return;
  const text = input.value.trim();
  if (!text) return;
  if (!apiReady) {
    alert("AI 对话需要后端：请先启动 babylog-api，并在进程环境中设置 DEEPSEEK_API_KEY。");
    return;
  }
  let active = getActiveAiSession();
  if (!active) {
    createAiSession();
    active = getActiveAiSession();
    if (!active) return;
  }
  input.value = "";
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
  setAiStatus("AI 正在生成回复…");
  const assistant = assistantMsg;
  const messageWindow = active.messages.slice(0, -1).slice(-40).map((m) => ({ role: m.role, content: m.content }));
  const payload = {
    instruction: aiProject.instruction || aiInstruction,
    baby_context: buildBabyContextForAi(),
    messages: messageWindow,
  };
  try {
    await consumeSseChatStream(payload, (chunk) => {
      assistant.content += chunk;
      assistant.ts = nowIso();
      scheduleAiChatRender();
    });
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
    aiBusy = false;
    setAiStatus("");
    refreshAiUiState();
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
  const sel = /** @type {HTMLSelectElement} */ (document.getElementById("chart-metric"));
  const opts = getNumericMetricOptions();
  sel.innerHTML = "";
  for (const o of opts) {
    const el = document.createElement("option");
    el.value = o.id;
    el.textContent = o.label;
    sel.appendChild(el);
  }
  if (!opts.some((x) => x.id === chartMetricId) && opts[0]) chartMetricId = opts[0].id;
  sel.value = chartMetricId;
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
    try {
      const arr = JSON.parse(/** @type {string} */ (reader.result));
      if (!Array.isArray(arr)) throw new Error("格式错误");
      entries = arr
        .filter((x) => x && x.id && x.categoryId && x.at)
        .map((x) => ({ ...x, photos: Array.isArray(x.photos) ? x.photos : [] }));
      if (apiReady) {
        for (const e of entries) {
          await apiRequest("/entries", {
            method: "POST",
            body: JSON.stringify(mapEntryToApi(e)),
          });
        }
      } else {
        save();
      }
      render();
      alert(`已导入 ${entries.length} 条记录`);
    } catch {
      alert("导入失败：请确认是 BabyLog 导出的 JSON");
    }
  };
  reader.readAsText(file);
}

async function init() {
  initTheme();
  initSidebarCollapse();
  loadProfile();
  loadAiInstruction();
  await initDataSource();
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
  document.getElementById("btn-apply-stats").addEventListener("click", applyCustomStatsRange);
  document.getElementById("stats-mode").addEventListener("change", (ev) => {
    statsMode = /** @type {HTMLSelectElement} */ (ev.target).value;
    renderStats();
  });
  document.getElementById("chart-metric").addEventListener("change", (ev) => {
    chartMetricId = /** @type {HTMLSelectElement} */ (ev.target).value;
    if (statsMode === "chart") renderTrendChart();
  });
  document.getElementById("chart-range-mode").addEventListener("change", (ev) => {
    chartRangeMode = /** @type {HTMLSelectElement} */ (ev.target).value;
    if (statsMode === "chart") renderTrendChart();
  });
  window.addEventListener("resize", () => {
    if (statsMode === "chart") renderTrendChart();
  });
  const chartCanvas = document.getElementById("stats-chart");
  chartCanvas.addEventListener("mousemove", onChartHover);
  chartCanvas.addEventListener("mouseleave", hideChartTooltip);
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
  const aiInstrModal = document.getElementById("ai-instruction-modal");
  if (aiInstrModal) {
    aiInstrModal.addEventListener("click", (ev) => {
      if (ev.target === aiInstrModal) {
        syncAiInstructionField();
        closeAiInstructionEditor();
      }
    });
    aiInstrModal.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") {
        syncAiInstructionField();
        closeAiInstructionEditor();
      }
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
  document.addEventListener("keydown", handleAiGlobalShortcuts);
  renderAiSessionList();
  refreshAiUiState();
}

document.addEventListener("DOMContentLoaded", init);
