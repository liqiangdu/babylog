import type { CategoryDef, VaccineTemplateRow } from "../types/models";

export const STORAGE_KEY = "babylog_entries_v1";
export const STORAGE_PROFILE_KEY = "babylog_profile_v1";
export const STORAGE_THEME_KEY = "babylog_theme_mode_v1";
export const STORAGE_SIDEBAR_COLLAPSED_KEY = "babylog_sidebar_collapsed_v1";
export const STORAGE_AI_INSTRUCTION_KEY = "babylog_ai_instruction_v1";
export const STORAGE_AI_PROJECT_KEY = "babylog_ai_project_v1";
/** Legacy key: removed from UI; app deletes this on load/login/clear for migration. */
export const STORAGE_AUTH_LOCAL_ONLY_KEY = "babylog_auth_local_only_v1";
export const AUTH_CSRF_COOKIE = "babylog_csrf";
export const DEFAULT_AI_INSTRUCTION =
  "你是婴幼儿照护与成长数据助手，正在协助家长阅读「Babylog」里的记录。\n\n回答要清晰、可执行；不要夸大确定性。凡涉及疾病诊断、用药调整或紧急情况，必须提醒家长咨询医生或前往医院。";

export const MAX_ENTRY_PHOTOS = 8;
export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

export const VACCINE_TEMPLATES: Record<string, VaccineTemplateRow[]> = {
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

export const DEFAULT_VACCINE_TEMPLATE_LABELS: Record<string, string> = {
  cn: "中国大陆计划",
  who: "WHO扩展计划",
  us: "美国CDC简版",
};

export const CATEGORIES: CategoryDef[] = [
  {
    id: "feeding",
    label: "喝奶",
    emoji: "🍼",
    fields: [
      {
        key: "subtype",
        label: "方式",
        type: "select",
        options: [
          { v: "breast", t: "母乳" },
          { v: "bottle", t: "瓶喂配方/母乳" },
          { v: "mixed", t: "混合" },
        ],
      },
      { key: "amountMl", label: "奶量 (ml)", type: "number", placeholder: "可选" },
      {
        key: "side",
        label: "单侧/双侧",
        type: "select",
        options: [
          { v: "", t: "—" },
          { v: "L", t: "左侧" },
          { v: "R", t: "右侧" },
          { v: "both", t: "双侧" },
        ],
      },
    ],
  },
  {
    id: "sleep",
    label: "睡觉",
    emoji: "😴",
    fields: [
      {
        key: "subtype",
        label: "状态",
        type: "select",
        options: [
          { v: "start", t: "开始睡" },
          { v: "end", t: "醒来" },
          { v: "nap", t: "小睡片段" },
        ],
      },
      { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
    ],
  },
  {
    id: "diaper",
    label: "换尿布",
    emoji: "👶",
    fields: [
      {
        key: "subtype",
        label: "类型",
        type: "select",
        options: [
          { v: "wet", t: "小便" },
          { v: "dirty", t: "大便" },
          { v: "both", t: "都有" },
          { v: "dry", t: "干爽检查" },
        ],
      },
    ],
  },
  {
    id: "temperature",
    label: "体温",
    emoji: "🌡️",
    fields: [
      { key: "celsius", label: "体温 (°C)", type: "number", step: "0.1", placeholder: "如 36.8" },
      {
        key: "place",
        label: "测量部位",
        type: "select",
        options: [
          { v: "armpit", t: "腋下" },
          { v: "ear", t: "耳温" },
          { v: "forehead", t: "额温" },
          { v: "rectal", t: "肛温" },
        ],
      },
    ],
  },
  {
    id: "bath",
    label: "洗澡",
    emoji: "🛁",
    fields: [{ key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" }],
  },
  {
    id: "medicine",
    label: "用药",
    emoji: "💊",
    fields: [
      { key: "name", label: "药名", type: "text", placeholder: "如 退烧药" },
      { key: "dose", label: "剂量", type: "text", placeholder: "如 2.5ml" },
    ],
  },
  {
    id: "supplement",
    label: "补剂",
    emoji: "✨",
    fields: [
      {
        key: "name",
        label: "种类",
        type: "select",
        options: [
          { v: "vd", t: "维生素 D" },
          { v: "ad", t: "维生素 AD" },
          { v: "dha", t: "DHA" },
          { v: "probiotic", t: "益生菌" },
          { v: "other", t: "其他" },
        ],
      },
      { key: "dose", label: "说明", type: "text", placeholder: "滴数/粒数等" },
    ],
  },
  {
    id: "tummy_time",
    label: "趴玩/大运动",
    emoji: "🐣",
    fields: [
      { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
      {
        key: "subtype",
        label: "内容",
        type: "select",
        options: [
          { v: "tummy", t: "趴卧抬头" },
          { v: "grip", t: "抓握练习" },
          { v: "roll", t: "翻身引导" },
          { v: "other", t: "其他" },
        ],
      },
    ],
  },
  {
    id: "growth",
    label: "生长测量",
    emoji: "📏",
    fields: [
      { key: "weightKg", label: "体重 (kg)", type: "number", step: "0.01", placeholder: "可选" },
      { key: "heightCm", label: "身长 (cm)", type: "number", step: "0.1", placeholder: "可选" },
      { key: "headCm", label: "头围 (cm)", type: "number", step: "0.1", placeholder: "可选" },
    ],
  },
  {
    id: "spitup",
    label: "吐奶/溢奶",
    emoji: "💧",
    fields: [
      {
        key: "subtype",
        label: "程度",
        type: "select",
        options: [
          { v: "light", t: "少量溢奶" },
          { v: "moderate", t: "吐一口" },
          { v: "heavy", t: "较多" },
        ],
      },
    ],
  },
  {
    id: "cry",
    label: "哭闹/安抚",
    emoji: "😢",
    fields: [
      { key: "durationMin", label: "持续 (分钟)", type: "number", placeholder: "可选" },
      { key: "soothe", label: "安抚方式", type: "text", placeholder: "抱哄/白噪音等" },
    ],
  },
  {
    id: "outdoor",
    label: "外出/晒太阳",
    emoji: "☀️",
    fields: [
      { key: "durationMin", label: "外出时长 (分钟)", type: "number", placeholder: "可选" },
      { key: "place", label: "地点/备注", type: "text", placeholder: "可选" },
    ],
  },
  {
    id: "pump",
    label: "吸奶",
    emoji: "🤱",
    fields: [
      { key: "durationMin", label: "时长 (分钟)", type: "number", placeholder: "可选" },
      { key: "amountMl", label: "吸出量 (ml)", type: "number", placeholder: "可选" },
      {
        key: "side",
        label: "侧",
        type: "select",
        options: [
          { v: "L", t: "左侧" },
          { v: "R", t: "右侧" },
          { v: "both", t: "双侧" },
        ],
      },
    ],
  },
  {
    id: "solid",
    label: "辅食",
    emoji: "🥣",
    fields: [
      { key: "food", label: "食物", type: "text", placeholder: "如 米粉+南瓜" },
      { key: "amount", label: "食量说明", type: "text", placeholder: "几勺/吃完等" },
    ],
  },
  { id: "custom", label: "其他", emoji: "📝", fields: [] },
];
