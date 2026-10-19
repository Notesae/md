import hljs from "highlight.js/lib/common";
import katex from "katex";

/** 增强任务仅在可视区域触发；运行于独立线程，不向 DOM 或桌面暴露任何能力。 */
interface EnhanceJob { id: number; kind: "code" | "math"; text: string; language?: string; display?: boolean }

self.onmessage = (event: MessageEvent<EnhanceJob>) => {
  const job = event.data;
  const start = performance.now();
  try {
    let html: string | null = null;
    if (job.kind === "math" && job.text.length <= 32_768) {
      html = katex.renderToString(job.text, { displayMode: job.display, throwOnError: false, trust: false, maxExpand: 500, maxSize: 20, strict: "ignore" });
    } else if (job.kind === "code" && job.text.length <= 65_536 && job.language && hljs.getLanguage(job.language)) {
      html = hljs.highlight(job.text, { language: job.language, ignoreIllegals: true }).value;
    }
    self.postMessage({ id: job.id, html, duration: performance.now() - start });
  } catch { self.postMessage({ id: job.id, html: null, duration: performance.now() - start }); }
};
