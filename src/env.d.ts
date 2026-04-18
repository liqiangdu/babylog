/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** CDN scripts from index.html */
declare const marked: {
  parse: (src: string, options?: unknown) => string;
};

declare const DOMPurify: {
  sanitize: (html: string, config?: unknown) => string;
};
