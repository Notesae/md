/** 一个滚动容器的覆盖层：轨道按容器与其可视祖先的交集裁剪，拇指不占布局宽度。 */
interface Rail {
  element: HTMLElement;
  frame: HTMLDivElement;
  vertical: HTMLDivElement;
  horizontal: HTMLDivElement;
  clips: HTMLElement[];
  hideTimer: number;
  hovered: boolean;
  dragging: boolean;
}

const rails = new Map<HTMLElement, Rail>();
const visible = new Set<Rail>();
let layer: HTMLDivElement | null = null;
let painting = 0;
// 静止后保留一会儿再淡出，给用户找到拇指并拖动的时间。
const IDLE_MS = 1100;
const INSET = 3;

const scrollable = (element: Element, axis: "x" | "y"): boolean => {
  const style = getComputedStyle(element);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  if (overflow !== "auto" && overflow !== "scroll") return false;
  return axis === "y" ? element.scrollHeight > element.clientHeight + 1 : element.scrollWidth > element.clientWidth + 1;
};

/** 记录会裁剪此容器的祖先，嵌套代码块滚出正文视口时拇指随之被裁掉。 */
function clipAncestors(element: HTMLElement): HTMLElement[] {
  const clips: HTMLElement[] = [];
  for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if (style.overflowX !== "visible" || style.overflowY !== "visible") clips.push(parent);
  }
  return clips;
}

function railFor(element: HTMLElement): Rail {
  const existing = rails.get(element);
  if (existing) return existing;
  layer ??= Object.assign(document.createElement("div"), { className: "scroll-layer" });
  if (!layer.isConnected) document.body.append(layer);
  const frame = document.createElement("div"); frame.className = "scroll-rail";
  const vertical = document.createElement("div"); vertical.className = "scroll-thumb y";
  const horizontal = document.createElement("div"); horizontal.className = "scroll-thumb x";
  frame.append(vertical, horizontal); layer.append(frame);
  const rail: Rail = { element, frame, vertical, horizontal, clips: clipAncestors(element), hideTimer: 0, hovered: false, dragging: false };
  for (const [thumb, axis] of [[vertical, "y"], [horizontal, "x"]] as const) {
    thumb.addEventListener("pointerenter", () => { rail.hovered = true; show(rail); });
    thumb.addEventListener("pointerleave", () => { rail.hovered = false; show(rail); });
    thumb.addEventListener("pointerdown", (event) => drag(rail, axis, event));
  }
  rails.set(element, rail);
  return rail;
}

/** 拖动按拇指可移动距离换算为滚动距离，松开后照常进入淡出计时。 */
function drag(rail: Rail, axis: "x" | "y", event: PointerEvent): void {
  if (event.button !== 0) return;
  event.preventDefault();
  const thumb = axis === "y" ? rail.vertical : rail.horizontal;
  const { element } = rail;
  const start = axis === "y" ? event.clientY : event.clientX;
  const origin = axis === "y" ? element.scrollTop : element.scrollLeft;
  const track = (axis === "y" ? rail.frame.clientHeight : rail.frame.clientWidth) - INSET * 2;
  const size = axis === "y" ? thumb.offsetHeight : thumb.offsetWidth;
  const range = axis === "y" ? element.scrollHeight - element.clientHeight : element.scrollWidth - element.clientWidth;
  const ratio = range / Math.max(1, track - size);
  rail.dragging = true; thumb.classList.add("dragging"); thumb.setPointerCapture(event.pointerId);
  const move = (next: PointerEvent) => {
    const offset = ((axis === "y" ? next.clientY : next.clientX) - start) * ratio;
    if (axis === "y") element.scrollTop = origin + offset; else element.scrollLeft = origin + offset;
  };
  const end = () => {
    rail.dragging = false; thumb.classList.remove("dragging");
    thumb.removeEventListener("pointermove", move); thumb.removeEventListener("pointerup", end); thumb.removeEventListener("pointercancel", end);
    show(rail);
  };
  thumb.addEventListener("pointermove", move); thumb.addEventListener("pointerup", end); thumb.addEventListener("pointercancel", end);
}

/** 轨道定位到容器与裁剪祖先的交集；拇指长度按可视比例，最短 28px。 */
function paint(rail: Rail): void {
  const { element, frame, vertical, horizontal } = rail;
  if (!element.isConnected) { remove(rail); return; }
  const rect = element.getBoundingClientRect();
  let left = rect.left, top = rect.top, right = rect.right, bottom = rect.bottom;
  for (const clip of rail.clips) {
    const box = clip.getBoundingClientRect();
    left = Math.max(left, box.left); top = Math.max(top, box.top); right = Math.min(right, box.right); bottom = Math.min(bottom, box.bottom);
  }
  frame.style.cssText = `left:${left}px;top:${top}px;width:${Math.max(0, right - left)}px;height:${Math.max(0, bottom - top)}px`;
  // 拇指贴容器右缘与下缘定位，悬停加粗时向内生长，不越出容器。
  const fromRight = right - rect.right + INSET, fromBottom = bottom - rect.bottom + INSET;
  const offsetX = rect.left - left, offsetY = rect.top - top;
  const hasY = element.scrollHeight > element.clientHeight + 1;
  const hasX = element.scrollWidth > element.clientWidth + 1;
  vertical.hidden = !hasY; horizontal.hidden = !hasX;
  if (hasY) {
    const track = rect.height - INSET * 2 - (hasX ? 8 : 0);
    const size = Math.max(28, track * element.clientHeight / element.scrollHeight);
    const at = (track - size) * element.scrollTop / Math.max(1, element.scrollHeight - element.clientHeight);
    vertical.style.cssText = `right:${fromRight}px;height:${size}px;translate:0 ${offsetY + INSET + at}px`;
  }
  if (hasX) {
    const track = rect.width - INSET * 2 - (hasY ? 8 : 0);
    const size = Math.max(28, track * element.clientWidth / element.scrollWidth);
    const at = (track - size) * element.scrollLeft / Math.max(1, element.scrollWidth - element.clientWidth);
    horizontal.style.cssText = `bottom:${fromBottom}px;width:${size}px;translate:${offsetX + INSET + at}px 0`;
  }
}

/** 可见期间逐帧跟随布局（栏宽过渡、嵌套滚动），全部淡出后停止。 */
function loop(): void {
  for (const rail of visible) paint(rail);
  painting = visible.size ? requestAnimationFrame(loop) : 0;
}

function show(rail: Rail): void {
  window.clearTimeout(rail.hideTimer);
  if (!visible.has(rail)) { visible.add(rail); paint(rail); }
  rail.frame.classList.add("visible");
  if (!painting) painting = requestAnimationFrame(loop);
  if (!rail.hovered && !rail.dragging) rail.hideTimer = window.setTimeout(() => hide(rail), IDLE_MS);
}

function hide(rail: Rail): void {
  rail.frame.classList.remove("visible");
  // 淡出结束后再停止跟随，避免过渡期间轨道停在旧位置。
  rail.hideTimer = window.setTimeout(() => { visible.delete(rail); if (!rail.element.isConnected) remove(rail); }, 400);
}

function remove(rail: Rail): void {
  window.clearTimeout(rail.hideTimer); visible.delete(rail); rail.frame.remove(); rails.delete(rail.element);
}

/** 指针靠近可滚动容器右缘或下缘时提前浮现，方便直接拖动。 */
function reveal(event: PointerEvent): void {
  for (let element = event.target instanceof Element ? event.target : null; element && element !== document.body; element = element.parentElement) {
    if (!(element instanceof HTMLElement)) continue;
    const rect = element.getBoundingClientRect();
    const nearY = rect.right - event.clientX < 16 && scrollable(element, "y");
    const nearX = rect.bottom - event.clientY < 16 && scrollable(element, "x");
    if (nearY || nearX) { show(railFor(element)); return; }
  }
}

/** 隐藏原生滚动条后，以捕获阶段统一监听所有元素滚动，按需为容器创建覆盖层。 */
export function installScrollbars(): void {
  document.documentElement.classList.add("overlay-scrollbars");
  document.addEventListener("scroll", (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target !== document.body) show(railFor(target));
  }, { capture: true, passive: true });
  let pending: PointerEvent | null = null;
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType !== "mouse" || event.buttons) return;
    if (!pending) requestAnimationFrame(() => { if (pending) reveal(pending); pending = null; });
    pending = event;
  }, { passive: true });
}
