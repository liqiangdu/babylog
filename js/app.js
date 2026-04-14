/**
 * BabyLog — 本地存储的婴儿日常记录
 */

const STORAGE_KEY = "babylog_entries_v1";
const STORAGE_PROFILE_KEY = "babylog_profile_v1";
const STORAGE_VACCINES_KEY = "babylog_vaccines_v1";

/** @type {Array<{id: string, categoryId: string, at: string, fields: Record<string, string|number>, note: string}>} */
let entries = [];
/** @type {{name: string, birthDate: string, gender: string, blood: string}} */
let profile = { name: "", birthDate: "", gender: "", blood: "" };
/** @type {Array<{id: string, name: string, dose: string, dueDate: string, status: "todo"|"done", doneAt: string}>} */
let vaccines = [];
/** @type {{start: string, end: string, preset: string}} */
let statsRange = { start: "", end: "", preset: "7d" };

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
  try {
    const raw = localStorage.getItem(STORAGE_VACCINES_KEY);
    vaccines = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(vaccines)) vaccines = [];
  } catch {
    vaccines = [];
  }
}

function saveVaccines() {
  localStorage.setItem(STORAGE_VACCINES_KEY, JSON.stringify(vaccines));
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

function submitModal() {
  if (!pendingCategoryId) return;
  const { at, fields, note } = collectForm();
  if (editingId) {
    const idx = entries.findIndex((e) => e.id === editingId);
    if (idx >= 0) {
      entries[idx] = { ...entries[idx], categoryId: pendingCategoryId, at, fields, note };
    }
  } else {
    entries.push({
      id: crypto.randomUUID(),
      categoryId: pendingCategoryId,
      at,
      fields,
      note,
    });
  }
  entries.sort((a, b) => new Date(b.at) - new Date(a.at));
  save();
  closeModal();
  render();
}

function deleteEntry(id) {
  if (!confirm("确定删除这条记录？")) return;
  entries = entries.filter((e) => e.id !== id);
  save();
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

function saveProfileFromForm() {
  profile = {
    name: /** @type {HTMLInputElement} */ (document.getElementById("baby-name")).value.trim(),
    birthDate: /** @type {HTMLInputElement} */ (document.getElementById("baby-birth")).value,
    gender: /** @type {HTMLSelectElement} */ (document.getElementById("baby-gender")).value,
    blood: /** @type {HTMLInputElement} */ (document.getElementById("baby-blood")).value.trim(),
  };
  saveProfile();
  renderProfile();
  renderVaccines();
  alert("宝宝信息已保存");
}

function renderStats() {
  const grid = document.getElementById("stats-grid");
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
}

function getEntriesByRange(start, end) {
  if (!start || !end) return [...entries];
  const s = new Date(`${start}T00:00:00`).getTime();
  const e = new Date(`${end}T23:59:59`).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || s > e) return [...entries];
  return entries.filter((x) => {
    const t = new Date(x.at).getTime();
    return t >= s && t <= e;
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
  statsRange = { start, end, preset: "custom" };
  syncStatsRangeInputs();
  renderStats();
}

function buildVaccinePlan() {
  if (!profile.birthDate) {
    alert("请先填写宝宝生日，再生成疫苗计划");
    return;
  }
  const shouldOverwrite = vaccines.length === 0 || confirm("将按生日重建疫苗计划，是否继续？");
  if (!shouldOverwrite) return;

  const base = new Date(profile.birthDate);
  const template = [
    { name: "乙肝疫苗", dose: "第1针", day: 0 },
    { name: "卡介苗", dose: "第1针", day: 0 },
    { name: "脊灰灭活疫苗", dose: "第1针", day: 60 },
    { name: "五联/百白破", dose: "第1针", day: 90 },
    { name: "乙肝疫苗", dose: "第2针", day: 30 },
    { name: "乙肝疫苗", dose: "第3针", day: 180 },
    { name: "麻腮风疫苗", dose: "第1针", day: 240 },
    { name: "流脑A疫苗", dose: "第1针", day: 180 },
    { name: "乙脑减毒活疫苗", dose: "第1针", day: 240 },
  ];
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
    const dueTag = v.dueDate < today && v.status !== "done" ? "（已到期）" : "";
    li.innerHTML = `
      <div class="tl-body">
        <div class="tl-label">${v.name} · ${v.dose}</div>
        <div class="tl-meta">计划日期: ${v.dueDate} ${dueTag} ${v.doneAt ? `· 完成: ${v.doneAt}` : ""}</div>
      </div>
      <div class="tl-actions">
        <button type="button" class="icon-btn" data-vdone>${v.status === "done" ? "↺" : "✓"}</button>
      </div>
    `;
    li.querySelector("[data-vdone]").addEventListener("click", () => toggleVaccineDone(v.id));
    list.appendChild(li);
  }
}

function renderTimeline() {
  const filter = /** @type {HTMLSelectElement} */ (document.getElementById("filter-category")).value;
  const list = document.getElementById("timeline");
  let data = filter ? entries.filter((e) => e.categoryId === filter) : [...entries];

  if (data.length === 0) {
    list.innerHTML = `<li class="empty-state">暂无记录，点上方图标快速添加。</li>`;
    return;
  }

  /** @type {string|null} */
  let lastHeader = null;
  const frag = document.createDocumentFragment();
  for (const e of data) {
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
  reader.onload = () => {
    try {
      const arr = JSON.parse(/** @type {string} */ (reader.result));
      if (!Array.isArray(arr)) throw new Error("格式错误");
      entries = arr.filter((x) => x && x.id && x.categoryId && x.at);
      save();
      render();
      alert(`已导入 ${entries.length} 条记录`);
    } catch {
      alert("导入失败：请确认是 BabyLog 导出的 JSON");
    }
  };
  reader.readAsText(file);
}

function makeSampleFields(categoryId, index) {
  switch (categoryId) {
    case "feeding":
      return { subtype: index % 2 ? "breast" : "bottle", amountMl: 70 + index * 5, side: "both" };
    case "sleep":
      return { subtype: index % 2 ? "nap" : "end", durationMin: 35 + index * 10 };
    case "diaper":
      return { subtype: index % 3 === 0 ? "wet" : index % 3 === 1 ? "dirty" : "both" };
    case "temperature":
      return { celsius: 36.6 + (index % 4) * 0.1, place: "armpit" };
    case "bath":
      return { durationMin: 10 + index * 2 };
    case "medicine":
      return { name: "退烧药", dose: "2.5ml" };
    case "supplement":
      return { name: index % 2 ? "vd" : "dha", dose: index % 2 ? "1滴" : "1粒" };
    case "tummy_time":
      return { durationMin: 8 + index * 3, subtype: index % 2 ? "tummy" : "grip" };
    case "growth":
      return { weightKg: 5.3 + index * 0.15, heightCm: 58.5 + index * 0.6, headCm: 39 + index * 0.2 };
    case "spitup":
      return { subtype: index % 2 ? "light" : "moderate" };
    case "cry":
      return { durationMin: 6 + index * 4, soothe: index % 2 ? "抱哄+拍嗝" : "白噪音+奶嘴" };
    case "outdoor":
      return { durationMin: 20 + index * 10, place: index % 2 ? "小区散步" : "阳台晒太阳" };
    case "pump":
      return { durationMin: 12 + index * 3, amountMl: 90 + index * 20, side: "both" };
    case "solid":
      return { food: index % 2 ? "米粉" : "南瓜泥", amount: index % 2 ? "3勺" : "半小碗" };
    case "custom":
      return {};
    default:
      return {};
  }
}

function generateSampleData() {
  const shouldContinue = confirm("将为每个类别生成测试记录，是否继续？");
  if (!shouldContinue) return;
  const now = Date.now();
  const noteMap = {
    feeding: "状态不错，吃奶节奏稳定",
    sleep: "入睡较快",
    diaper: "皮肤状态正常",
    temperature: "无发热表现",
    bath: "洗澡后情绪平稳",
    medicine: "按医嘱服用",
    supplement: "每日固定时间补充",
    tummy_time: "抬头比昨天更稳",
    growth: "本周复测数据",
    spitup: "拍嗝后缓解",
    cry: "安抚后平静",
    outdoor: "天气好，短时外出",
    pump: "夜间泵奶记录",
    solid: "尝试新口味",
    custom: "今天整体状态良好",
  };

  const samples = [];
  for (let i = 0; i < CATEGORIES.length; i += 1) {
    const cat = CATEGORIES[i];
    const count = cat.id === "feeding" || cat.id === "sleep" || cat.id === "diaper" ? 3 : 2;
    for (let j = 0; j < count; j += 1) {
      const offsetHours = i * 3 + j * 7;
      const at = new Date(now - offsetHours * 60 * 60 * 1000).toISOString();
      samples.push({
        id: crypto.randomUUID(),
        categoryId: cat.id,
        at,
        fields: makeSampleFields(cat.id, j),
        note: noteMap[cat.id] || "测试记录",
      });
    }
  }

  entries = [...entries, ...samples].sort((a, b) => new Date(b.at) - new Date(a.at));
  save();
  render();
  alert(`已生成 ${samples.length} 条测试记录`);
}

function init() {
  load();
  loadProfile();
  loadVaccines();
  renderCategories();
  populateFilter();
  applyPresetRange("7d");
  syncStatsRangeInputs();
  render();

  document.getElementById("filter-category").addEventListener("change", render);
  document.getElementById("btn-save-profile").addEventListener("click", saveProfileFromForm);
  document.getElementById("btn-build-vaccine").addEventListener("click", buildVaccinePlan);
  document.getElementById("stats-preset").addEventListener("change", (ev) => {
    const preset = /** @type {HTMLSelectElement} */ (ev.target).value;
    if (preset === "custom") return;
    applyPresetRange(preset);
  });
  document.getElementById("btn-apply-stats").addEventListener("click", applyCustomStatsRange);
  document.getElementById("btn-seed").addEventListener("click", generateSampleData);
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
