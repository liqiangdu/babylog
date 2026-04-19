export const TREND_LINE_COLOR = "#6b7280";

/** Line + area fill (continuous totals: ml, minutes, etc.) */
export type ChartViz = "area_line" | "line" | "bar";

/** Synthetic metric: count entries per time bucket (no numeric field on category). */
export type EventCountMetric = {
  id: string;
  label: string;
  categoryId: string;
  unit: string;
  kind: "event_count";
  viz: ChartViz;
  /** Sentinel for code paths that expect fieldKey */
  fieldKey: "__eventCount__";
};

export const EVENT_COUNT_METRICS: readonly EventCountMetric[] = [
  {
    id: "diaper.eventCount",
    label: "👶 换尿布 · 换片次数",
    categoryId: "diaper",
    unit: "次",
    kind: "event_count",
    viz: "bar",
    fieldKey: "__eventCount__",
  },
  {
    id: "bath.eventCount",
    label: "🛁 洗澡 · 次数",
    categoryId: "bath",
    unit: "次",
    kind: "event_count",
    viz: "bar",
    fieldKey: "__eventCount__",
  },
  {
    id: "spitup.eventCount",
    label: "💧 吐奶/溢奶 · 次数",
    categoryId: "spitup",
    unit: "次",
    kind: "event_count",
    viz: "bar",
    fieldKey: "__eventCount__",
  },
  {
    id: "medicine.eventCount",
    label: "💊 用药 · 次数",
    categoryId: "medicine",
    unit: "次",
    kind: "event_count",
    viz: "bar",
    fieldKey: "__eventCount__",
  },
  {
    id: "supplement.eventCount",
    label: "✨ 补剂 · 次数",
    categoryId: "supplement",
    unit: "次",
    kind: "event_count",
    viz: "bar",
    fieldKey: "__eventCount__",
  },
  {
    id: "solid.eventCount",
    label: "🥣 辅食 · 次数",
    categoryId: "solid",
    unit: "次",
    kind: "event_count",
    viz: "bar",
    fieldKey: "__eventCount__",
  },
] as const;

/** 图表指标选择器：粗分组，减少零碎感（与统计页核心/非核心心智一致） */
export const CHART_METRIC_BUCKETS = [
  { key: "rhythm", title: "节律与摄入", emoji: "🍼", categoryIds: ["feeding", "sleep", "pump"] },
  { key: "body", title: "身体测量", emoji: "📏", categoryIds: ["temperature", "growth"] },
  {
    key: "frequency",
    title: "频次与记录",
    emoji: "📌",
    categoryIds: ["diaper", "bath", "spitup", "medicine", "supplement", "solid"],
  },
  { key: "activity", title: "活动与状态", emoji: "☀️", categoryIds: ["bath", "tummy_time", "outdoor", "cry"] },
] as const;

export const CHART_METRIC_SHEET_MAX_W = 640;
