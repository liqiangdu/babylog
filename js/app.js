/**
 * BabyLog — 本地存储的婴儿日常记录
 */

const STORAGE_KEY = "babylog_entries_v1";

/** @type {Array<{id: string, categoryId: string, at: string, fields: Record<string, string|number>, note: string}>} */
let entries = [];

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

function init() {
  load();
  renderCategories();
  populateFilter();
  render();

  document.getElementById("filter-category").addEventListener("change", render);
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
