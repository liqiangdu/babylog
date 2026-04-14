/**
 * BabyLog — 本地存储的婴儿日常记录
 */

const STORAGE_KEY = "babylog_entries_v1";
const STORAGE_PROFILE_KEY = "babylog_profile_v1";
const STORAGE_THEME_KEY = "babylog_theme_mode_v1";
const API_BASE = "http://127.0.0.1:8787/api";

/** @type {Array<{id: string, categoryId: string, at: string, fields: Record<string, string|number>, note: string}>} */
let entries = [];
/** @type {{name: string, birthDate: string, gender: string, blood: string}} */
let profile = { name: "", birthDate: "", gender: "", blood: "" };
/** @type {Array<{id: string, name: string, dose: string, dueDate: string, status: "todo"|"done", doneAt: string}>} */
let vaccines = [];
let vaccineSettings = { region: "cn", reminderDays: 3, notificationsEnabled: false, notifiedMap: {} };
let customVaccineTemplates = {};
/** @type {{start: string, end: string, preset: string}} */
let statsRange = { start: "", end: "", preset: "7d" };
let statsMode = "cards";
let timelineVisibleCount = 20;
const TREND_LINE_COLOR = "#0a84ff";
let chartRangeMode = "follow";
let chartMetricId = "feeding.amountMl";
let chartHitPoints = [];
let apiReady = false;
let themeMode = "system";

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
    };
  } catch {
    profile = { name: "", birthDate: "", gender: "", blood: "" };
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
  };
}

function mapEntryToApi(item) {
  return {
    category_id: item.categoryId,
    at: item.at,
    fields: item.fields || {},
    note: item.note || "",
  };
}

function applyTheme(mode) {
  const root = document.documentElement;
  themeMode = ["system", "light", "dark"].includes(mode) ? mode : "system";
  if (themeMode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", themeMode);
  localStorage.setItem(STORAGE_THEME_KEY, themeMode);
}

function initTheme() {
  const saved = localStorage.getItem(STORAGE_THEME_KEY) || "system";
  applyTheme(saved);
  const sel = /** @type {HTMLSelectElement|null} */ (document.getElementById("theme-select"));
  if (!sel) return;
  sel.value = themeMode;
  sel.addEventListener("change", (ev) => {
    applyTheme(/** @type {HTMLSelectElement} */ (ev.target).value);
  });
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

function openModal(categoryId, existing) {
  pendingCategoryId = categoryId;
  editingId = existing ? existing.id : null;
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
  return { at, fields, note };
}

async function submitModal() {
  if (!pendingCategoryId) return;
  const { at, fields, note } = collectForm();
  let changedEntry = null;
  if (editingId) {
    const idx = entries.findIndex((e) => e.id === editingId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], categoryId: pendingCategoryId, at, fields, note };
      changedEntry = entries[idx];
    }
  } else {
    changedEntry = {
      id: crypto.randomUUID(),
      categoryId: pendingCategoryId,
      at,
      fields,
      note,
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
  if (!confirm("确定删除这条记录？")) return;
  entries = entries.filter((e) => e.id !== id);
  if (apiReady) {
    try {
      await apiRequest(`/entries/${id}`, { method: "DELETE" });
    } catch {
      apiReady = false;
      save();
      alert("后端暂不可用，已回退到本地存储。");
    }
  } else {
    save();
  }
  render();
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

function renderProfile() {
  const nameEl = /** @type {HTMLInputElement} */ (document.getElementById("baby-name"));
  const birthEl = /** @type {HTMLInputElement} */ (document.getElementById("baby-birth"));
  const genderEl = /** @type {HTMLSelectElement} */ (document.getElementById("baby-gender"));
  const bloodEl = /** @type {HTMLInputElement} */ (document.getElementById("baby-blood"));
  const summary = document.getElementById("profile-summary");

  nameEl.value = profile.name || "";
  birthEl.value = profile.birthDate || "";
  genderEl.value = profile.gender || "";
  bloodEl.value = profile.blood || "";

  const gMap = { boy: "男宝宝", girl: "女宝宝", other: "未设置" };
  const details = [
    profile.name ? `昵称: ${profile.name}` : "昵称未设置",
    profile.birthDate ? `生日: ${profile.birthDate}` : "生日未设置",
    `月龄: ${getAgeText()}`,
    profile.gender ? `性别: ${gMap[profile.gender] || profile.gender}` : "",
    profile.blood ? `血型: ${profile.blood}` : "",
  ].filter(Boolean);
  summary.textContent = details.join(" | ");
}

async function saveProfileFromForm() {
  profile = {
    name: /** @type {HTMLInputElement} */ (document.getElementById("baby-name")).value.trim(),
    birthDate: /** @type {HTMLInputElement} */ (document.getElementById("baby-birth")).value,
    gender: /** @type {HTMLSelectElement} */ (document.getElementById("baby-gender")).value,
    blood: /** @type {HTMLInputElement} */ (document.getElementById("baby-blood")).value.trim(),
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
      alert("后端暂不可用，已回退到本地存储。");
    }
  } else {
    saveProfile();
  }
  renderProfile();
  renderVaccines();
  alert("宝宝信息已保存");
}

function renderStats() {
  const grid = document.getElementById("stats-grid");
  const chartWrap = document.getElementById("stats-chart-wrap");
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

  const cards = [
    { k: `范围记录总数 (${rangeLabel})`, v: `${inRangeEntries.length} 条` },
    { k: "范围喂奶总量", v: `${feedMl} ml` },
    { k: "范围睡眠时长", v: `${sleepMin} 分钟` },
    { k: "范围尿布", v: `小便 ${wetCount} / 大便 ${dirtyCount}` },
    { k: "范围洗澡次数", v: `${bathCount} 次` },
    { k: "范围用药次数", v: `${medicineCount} 次` },
    { k: "疫苗完成进度", v: vaccines.length ? `${doneVaccines}/${vaccines.length}` : "未生成" },
    { k: "总记录数", v: `${entries.length} 条` },
  ];
  grid.innerHTML = cards.map((c) => `<div class="stat-card"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`).join("");
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
    ctx.fillStyle = "rgba(255,255,255,0.86)";
    ctx.font = '14px "SF Pro Text", "Helvetica Neue", Arial';
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

  ctx.strokeStyle = "rgba(128,128,128,0.25)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255,255,255,0.86)";
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
  ctx.fillText(unit, 8, 12);

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
    ctx.lineWidth = 2;
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
  drawSeries(vals, TREND_LINE_COLOR);
  ctx.fillStyle = TREND_LINE_COLOR;
  points.forEach((p, i) => {
    const x = mapX(i);
    const y = mapY(p.value);
    ctx.beginPath();
    ctx.arc(x, y, 3.2, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.fillStyle = "rgba(255,255,255,0.86)";
  ctx.font = '12px "SF Pro Text", "Helvetica Neue", Arial';
  points.forEach((p, i) => {
    if (i % Math.ceil(points.length / 6) !== 0 && i !== points.length - 1) return;
    ctx.fillText(p.label, mapX(i) - 10, cssHeight - 8);
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

  tip.innerHTML = `<div>${nearest.label}</div><div>${nearest.value} ${nearest.unit}</div>`;
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
    alert("请先填写宝宝生日，再生成疫苗计划");
    return;
  }
  const shouldOverwrite = vaccines.length === 0 || confirm("将按生日重建疫苗计划，是否继续？");
  if (!shouldOverwrite) return;

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

function checkVaccineReminders(showToast) {
  const summary = document.getElementById("vaccine-reminder-summary");
  const dueItems = vaccines.filter((v) => v.status !== "done").filter((v) => {
    const state = getVaccineReminderState(v);
    return typeof state.daysLeft === "number" && state.daysLeft <= vaccineSettings.reminderDays;
  });
  if (summary) {
    summary.textContent = dueItems.length
      ? `提醒：${dueItems.length} 项接种在提醒范围内（提前 ${vaccineSettings.reminderDays} 天）`
      : "当前无接种提醒";
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

  if (showToast) alert(dueItems.length ? `发现 ${dueItems.length} 条疫苗提醒` : "当前没有需要提醒的疫苗");
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
    list.innerHTML = `<li class="empty-state">暂无计划，请先填写生日并点击“生成接种计划”。</li>`;
    return;
  }
  list.innerHTML = "";
  const today = new Date().toISOString().slice(0, 10);
  for (const v of vaccines) {
    const li = document.createElement("li");
    li.className = "vaccine-row";
    const state = getVaccineReminderState(v);
    const badge = state.text ? `<span class="vaccine-badge ${state.cls}">${state.text}</span>` : "";
    li.innerHTML = `
      <div class="tl-body">
        <div class="tl-label">${v.name} · ${v.dose} ${badge}</div>
        <div class="tl-meta">计划日期: ${v.dueDate} ${v.doneAt ? `· 完成: ${v.doneAt}` : ""}</div>
      </div>
      <div class="tl-actions">
        <button type="button" class="icon-btn" data-vdone>${v.status === "done" ? "↺" : "✓"}</button>
      </div>
    `;
    li.querySelector("[data-vdone]").addEventListener("click", () => toggleVaccineDone(v.id));
    list.appendChild(li);
  }
  checkVaccineReminders(false);
}

function renderTimeline() {
  const filter = /** @type {HTMLSelectElement} */ (document.getElementById("filter-category")).value;
  const day = /** @type {HTMLInputElement} */ (document.getElementById("filter-day")).value;
  const list = document.getElementById("timeline");
  const moreWrap = document.getElementById("timeline-more-wrap");
  let data = filter ? entries.filter((e) => e.categoryId === filter) : [...entries];
  if (day) data = data.filter((e) => toLocalDateKey(e.at) === day);

  if (data.length === 0) {
    list.innerHTML = `<li class="empty-state">暂无记录，点上方图标快速添加。</li>`;
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
        <div class="tl-label">${cat.emoji} ${cat.label}</div>
        <div class="tl-meta"></div>
      </div>
      <div class="tl-actions">
        <button type="button" class="icon-btn" data-edit title="编辑">✎</button>
        <button type="button" class="icon-btn" data-del title="删除">🗑</button>
      </div>
    `;
    const metaEl = li.querySelector(".tl-meta");
    if (metaEl) metaEl.textContent = metaLine;
    li.querySelector("[data-edit]").addEventListener("click", () => openModal(e.categoryId, e));
    li.querySelector("[data-del]").addEventListener("click", () => deleteEntry(e.id));
    frag.appendChild(li);
  }
  list.innerHTML = "";
  list.appendChild(frag);
  if (visible.length < data.length) moreWrap.classList.remove("hidden");
  else moreWrap.classList.add("hidden");
}

function render() {
  renderProfile();
  renderStats();
  renderVaccines();
  renderTimeline();
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
      entries = arr.filter((x) => x && x.id && x.categoryId && x.at);
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
  await initDataSource();
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
}

document.addEventListener("DOMContentLoaded", init);
