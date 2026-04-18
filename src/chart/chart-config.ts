export const TREND_LINE_COLOR = "#6b7280";

/** 图表指标选择器：粗分组，减少零碎感（与统计页核心/非核心心智一致） */
export const CHART_METRIC_BUCKETS = [
  { key: "rhythm", title: "节律与摄入", emoji: "🍼", categoryIds: ["feeding", "sleep", "pump"] },
  { key: "body", title: "身体测量", emoji: "📏", categoryIds: ["temperature", "growth"] },
  { key: "activity", title: "活动与状态", emoji: "☀️", categoryIds: ["bath", "tummy_time", "outdoor", "cry"] },
] as const;

export const CHART_METRIC_SHEET_MAX_W = 640;
