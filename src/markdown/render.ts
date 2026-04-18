import DOMPurify from "dompurify";
import { marked } from "marked";

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdownToHtml(src: string): string {
  const md = String(src || "");
  if (!md.trim()) return "";
  try {
    const rawHtml = marked.parse(md, { breaks: true, gfm: true }) as string;
    return DOMPurify.sanitize(rawHtml, { USE_PROFILES: { html: true } });
  } catch {
    return `<p>${escapeHtml(md)}</p>`;
  }
}

let streamMdTimer = 0;
let streamMdLastApply = 0;
const STREAM_MD_MIN_MS = 48;

/** Batches streaming Markdown repaints to reduce main-thread parse/sanitize churn. */
export function throttledStreamingMarkdownUpdate(run: () => void, opts?: { flush?: boolean }): void {
  if (opts?.flush) {
    if (streamMdTimer) {
      clearTimeout(streamMdTimer);
      streamMdTimer = 0;
    }
    run();
    streamMdLastApply = typeof performance !== "undefined" ? performance.now() : 0;
    return;
  }
  const now = typeof performance !== "undefined" ? performance.now() : 0;
  if (now - streamMdLastApply >= STREAM_MD_MIN_MS) {
    run();
    streamMdLastApply = now;
    return;
  }
  if (streamMdTimer) return;
  const delay = Math.max(0, STREAM_MD_MIN_MS - (now - streamMdLastApply));
  streamMdTimer = window.setTimeout(() => {
    streamMdTimer = 0;
    run();
    streamMdLastApply = typeof performance !== "undefined" ? performance.now() : 0;
  }, delay);
}

/** Clear pending throttled work (call when a stream ends). */
export function flushStreamingMarkdownThrottle(): void {
  if (streamMdTimer) {
    clearTimeout(streamMdTimer);
    streamMdTimer = 0;
  }
}
