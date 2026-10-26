/** 纸页滑行：像把纸推到指定位置，起步和停稳都放缓；每帧重新测量目标，适应延迟排版的块高度变化。 */
const active = new WeakMap<HTMLElement, () => void>();
const reduced = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
// 起止都缓的五次曲线；比三次更长的停稳段，让终点有“落定”的感觉。
const ease = (t: number) => (t < .5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2);

/**
 * 滑动到 target() 给出的 scrollTop；用户滚轮、触摸、按键或拖动会立即接管。
 * 远距离先无动画靠近到约 1.2 屏之外再滑入，避免掠过整篇文档触发大量排版。
 */
export function glideTo(viewport: HTMLElement, target: () => number): Promise<void> {
  active.get(viewport)?.();
  const clamp = (value: number) => Math.max(0, Math.min(value, viewport.scrollHeight - viewport.clientHeight));
  if (reduced() || typeof requestAnimationFrame !== "function") { viewport.scrollTop = clamp(target()); return Promise.resolve(); }
  const span = viewport.clientHeight * 1.2;
  const first = clamp(target());
  if (Math.abs(first - viewport.scrollTop) > span * 2) viewport.scrollTop = first - Math.sign(first - viewport.scrollTop) * span;
  const start = viewport.scrollTop;
  const distance = Math.abs(first - start);
  // 时长随距离增长但有上下限：短跳 420ms，最长 900ms。
  const duration = Math.min(900, 420 + Math.sqrt(distance) * 12);
  return new Promise((resolve) => {
    let frame = 0; const began = performance.now();
    const stop = () => {
      cancelAnimationFrame(frame); active.delete(viewport);
      for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) viewport.removeEventListener(name, stop);
      resolve();
    };
    const step = (now: number) => {
      const progress = Math.min(1, (now - began) / duration);
      viewport.scrollTop = start + (clamp(target()) - start) * ease(progress);
      if (progress < 1) frame = requestAnimationFrame(step); else stop();
    };
    for (const name of ["wheel", "touchstart", "keydown", "pointerdown"]) viewport.addEventListener(name, stop, { passive: true });
    active.set(viewport, stop);
    frame = requestAnimationFrame(step);
  });
}

/** 元素顶部对齐到视口顶部（扣除 scroll-margin-top）。 */
export function topOf(viewport: HTMLElement, element: Element, margin = parseFloat(getComputedStyle(element).scrollMarginTop) || 0): () => number {
  return () => viewport.scrollTop + element.getBoundingClientRect().top - viewport.getBoundingClientRect().top - margin;
}

/** 矩形中心对齐到视口中心，用于搜索结果。 */
export function centerOf(viewport: HTMLElement, rect: () => DOMRect): () => number {
  return () => {
    const box = viewport.getBoundingClientRect(); const target = rect();
    return viewport.scrollTop + target.top + target.height / 2 - box.top - box.height / 2;
  };
}

/** 只在目标超出可视区时滑动，用于让目录当前项保持可见。 */
export function glideIntoView(viewport: HTMLElement, element: HTMLElement, padding = 24): void {
  const box = viewport.getBoundingClientRect(); const rect = element.getBoundingClientRect();
  if (rect.top >= box.top + padding && rect.bottom <= box.bottom - padding) return;
  const offset = rect.top < box.top + padding ? rect.top - box.top - padding : rect.bottom - box.bottom + padding;
  const goal = viewport.scrollTop + offset;
  void glideTo(viewport, () => goal);
}
