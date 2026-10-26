import { invoke } from "@tauri-apps/api/core";
import type { ReaderDocument, ReadingPosition } from "./types";
import { findMatches } from "./search";
import { icon } from "./icons";
import { centerOf, glideTo, topOf } from "./glide";
import "katex/dist/katex.min.css";

/** 用一帧让出主线程，保证长文构建期间仍可处理切换、滚动和关闭。 */
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** 管理当前文章的 DOM、可视增强和搜索；切换时终止旧 Worker 并释放所有图片 URL。 */
export class Reader {
  private epoch = 0;
  private current: Omit<ReaderDocument, "blocks"> | null = null;
  private worker: Worker | null = null;
  private enhancementUnavailable = false;
  private observer: IntersectionObserver | null = null;
  private activeHeading = "";
  private jobs = new Map<number, HTMLElement>();
  private blobs = new Map<HTMLElement, string>();
  private jobId = 0;
  private ranges: Range[] = [];
  private matchIndex = -1;
  // 保留截断标记，切换结果时继续向用户显示搜索上限。
  private matchesTruncated = false;
  private query = "";
  private complete = false;
  private searchTimer = 0;
  private finished: Promise<void> = Promise.resolve();
  onSearch: (count: number, index: number, truncated: boolean) => void = () => {};
  onLink: (index: number) => void = () => {};
  onMessage: (message: string) => void = () => {};
  onHeading: (id: string) => void = () => {};

  constructor(readonly article: HTMLElement, readonly viewport: HTMLElement) {
    article.addEventListener("click", (event) => {
      const target = event.target as Element;
      const link = target.closest<HTMLAnchorElement>("a[data-link]");
      if (link) { event.preventDefault(); this.onLink(Number(link.dataset.link)); }
      const copy = target.closest<HTMLButtonElement>(".code-copy");
      if (copy) {
        void navigator.clipboard.writeText(copy.parentElement!.querySelector("code")!.textContent ?? "")
          .then(() => { this.onMessage("代码已复制"); }, () => { this.onMessage("复制失败，请选中文字后按 Ctrl+C。"); });
      }
      const imageAction = target.closest<HTMLButtonElement>(".load-remote,.image-retry");
      if (imageAction) void this.loadImage(imageAction.closest<HTMLElement>(".image-slot")!, true);
    });
  }

  /** 首屏先显示实际正文，再逐帧追加合法块；整篇文档保留在 DOM 中以支持复制和全文搜索。 */
  show(document: ReaderDocument, onFirstPaint: () => void): Promise<void> {
    this.dispose();
    // DOM 构建后只保留导航及资源元数据，不能让整篇 HTML 字符串随阅读会话常驻。
    const { blocks, ...metadata } = document;
    this.current = metadata;
    this.complete = false;
    this.article.replaceChildren();
    this.article.dataset.revision = String(document.revision);
    this.viewport.scrollTop = 0;
    const epoch = this.epoch;
    this.observer = new IntersectionObserver((entries) => {
      if (epoch !== this.epoch) return;
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (element.matches(".image-slot")) {
          element.dataset.visible = String(entry.isIntersecting);
          if (entry.isIntersecting) {
            const image = this.current?.images[Number(element.dataset.image)];
            if (image && !image.remote && element.dataset.failed !== "true") void this.loadImage(element, false);
          } else if (this.blobs.has(element)) {
            element.style.minHeight = `${element.getBoundingClientRect().height}px`;
            URL.revokeObjectURL(this.blobs.get(element)!);
            this.blobs.delete(element);
            // 移除聚焦图片前交回阅读区，避免键盘滚动落到禁止滚动的 body。
            if (element.contains(window.document.activeElement)) this.viewport.focus({ preventScroll: true });
            element.textContent = element.dataset.alt ?? "本地图片";
          }
        } else if (entry.isIntersecting) {
          this.observer?.unobserve(element);
          this.enhance(element);
        }
      }
    }, { root: this.viewport, rootMargin: "600px 0px" });
    this.finished = this.appendBlocks(blocks, epoch, onFirstPaint);
    return this.finished;
  }

  /** 隔离临时渲染作用域，避免常驻观察器与正文数组、首屏回调共享闭包。 */
  private async appendBlocks(blocks: string[], epoch: number, onFirstPaint: () => void): Promise<void> {
    let index = 0;
    let painted = false;
    while (index < blocks.length && epoch === this.epoch) {
      const start = performance.now();
      // 浏览器按渲染批次跳过离屏布局，避免每个小段都成为独立布局容器。
      const chunk = window.document.createElement("div"); chunk.className = "md-chunk";
      let bytes = 0;
      do {
        const section = window.document.createElement("section");
        section.className = "md-block";
        section.dataset.block = String(index);
        section.innerHTML = blocks[index];
        bytes += blocks[index].length;
        this.prepareBlock(section);
        chunk.append(section);
        index++;
      } while (index < blocks.length && performance.now() - start < 5 && bytes < 30_000);
      this.article.append(chunk);
      await frame();
      if (!painted && epoch === this.epoch) { await frame(); painted = true; if (epoch === this.epoch) onFirstPaint(); }
    }
    if (epoch !== this.epoch) return;
    this.complete = true;
    if (!painted) onFirstPaint();
    if (this.query) this.search(this.query);
  }

  /** 统一添加复制操作和资源占位；源文档无法提供按钮或改变此处行为。 */
  private prepareBlock(section: HTMLElement): void {
    for (const code of section.querySelectorAll<HTMLElement>("pre > code")) {
      const pre = code.parentElement!;
      pre.classList.add("code-frame");
      const button = document.createElement("button");
      button.type = "button"; button.className = "code-copy"; button.title = "复制代码";
      button.setAttribute("aria-label", "复制代码"); button.innerHTML = icon("copy");
      pre.prepend(button);
      this.observer?.observe(code);
    }
    for (const element of section.querySelectorAll<HTMLElement>(".math")) this.observer?.observe(element);
    for (const element of section.querySelectorAll<HTMLElement>(".image-slot")) {
      element.dataset.alt = element.textContent || "图片";
      const image = this.current?.images[Number(element.dataset.image)];
      if (image?.remote) {
        const button = document.createElement("button");
        button.type = "button"; button.className = "load-remote";
        button.textContent = `${element.dataset.alt} · 加载远程图片`;
        element.replaceChildren(button);
      }
      this.observer?.observe(element);
    }
  }

  /** 高亮和 KaTeX 仅在 Worker 处理；更换文章时直接终止，不留下过期队列。 */
  private enhance(element: HTMLElement): void {
    if (this.enhancementUnavailable) return;
    try {
      if (!this.worker) {
        const epoch = this.epoch;
        const worker = new Worker(new URL("./enhance.worker.ts", import.meta.url), { type: "module" }); this.worker = worker;
        worker.onmessage = (event: MessageEvent<{ id: number; html: string | null }>) => {
          if (epoch !== this.epoch || this.worker !== worker) return;
          const target = this.jobs.get(event.data.id);
          this.jobs.delete(event.data.id);
          if (!target?.isConnected || !event.data.html) return;
          target.innerHTML = event.data.html;
          target.dataset.enhanced = "true";
          if (this.query) {
            window.clearTimeout(this.searchTimer);
            this.searchTimer = window.setTimeout(() => this.search(this.query), 40);
          }
        };
        worker.onerror = () => { if (epoch === this.epoch && this.worker === worker) this.failEnhancement(); };
      }
      const id = ++this.jobId;
      this.jobs.set(id, element);
      this.worker.postMessage({ id, kind: element.classList.contains("math") ? "math" : "code", text: element.textContent ?? "",
        language: element.className.match(/language-([\w+-]+)/)?.[1], display: element.dataset.display === "true" });
    } catch { this.failEnhancement(); }
  }

  /** 本篇只降级一次并释放失败队列；重新打开文章后再尝试增强。 */
  private failEnhancement(): void {
    if (this.enhancementUnavailable) return;
    this.enhancementUnavailable = true;
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); this.worker = null; }
    this.jobs.clear();
    this.onMessage("增强处理暂不可用，正文、代码和公式原文仍可阅读。重新打开文章后会重试。");
  }

  /** 失败资源立即释放，错误以文本呈现；重试仍走原有图片授权边界。 */
  private imageFailure(slot: HTMLElement, reason: string, restoreFocus = false): void {
    const focused = slot.contains(document.activeElement) || (restoreFocus && document.activeElement === document.body);
    const source = this.blobs.get(slot);
    if (source) { URL.revokeObjectURL(source); this.blobs.delete(slot); }
    slot.dataset.failed = "true";
    const status = document.createElement("span"); status.role = "status"; status.textContent = `${slot.dataset.alt} · ${reason}`;
    const button = document.createElement("button"); button.type = "button"; button.className = "secondary image-retry";
    button.textContent = "重新加载图片"; button.setAttribute("aria-label", `重新加载图片：${slot.dataset.alt}`);
    slot.replaceChildren(status, button);
    if (focused) button.focus({ preventScroll: true });
  }

  /** 本地资源从受限 IPC 读取二进制；远程资源只在用户点击且为 HTTPS 时加载。 */
  private async loadImage(slot: HTMLElement, explicit: boolean): Promise<void> {
    if (!this.current || !slot.isConnected || slot.dataset.loading === "true" || this.blobs.has(slot) || slot.querySelector("img")) return;
    const epoch = this.epoch;
    const index = Number(slot.dataset.image);
    const image = this.current.images[index];
    slot.dataset.loading = "true";
    delete slot.dataset.failed;
    const button = slot.querySelector<HTMLButtonElement>("button");
    const restoreFocus = button === document.activeElement;
    if (button) { button.disabled = true; button.textContent = "正在加载图片…"; }
    try {
      let source: string;
      if (image.remote) {
        if (!explicit || new URL(image.url).protocol !== "https:") throw new Error("远程图片仅支持手动加载 HTTPS 地址。");
        source = image.url;
      } else {
        const data = await invoke<ArrayBuffer>("read_image", { revision: this.current.revision, index });
        if (epoch !== this.epoch || !slot.isConnected || slot.dataset.visible === "false") return;
        source = URL.createObjectURL(new Blob([data]));
        this.blobs.set(slot, source);
      }
      if (epoch !== this.epoch) return;
      const element = document.createElement("img");
      element.alt = slot.dataset.alt ?? ""; element.decoding = "async"; element.referrerPolicy = "no-referrer";
      element.onerror = () => { if (epoch === this.epoch && slot.isConnected && slot.contains(element)) this.imageFailure(slot, "图片加载失败"); };
      element.src = source;
      // 禁用重试按钮后浏览器会暂时把焦点放到 body；用户已转到其他控件时不抢回焦点。
      const focused = restoreFocus && (document.activeElement === button || document.activeElement === document.body);
      slot.replaceChildren(element);
      if (focused) { element.tabIndex = -1; element.focus({ preventScroll: true }); }
    } catch (error) { if (epoch === this.epoch && slot.isConnected) this.imageFailure(slot, String(error), restoreFocus); }
    finally { slot.dataset.loading = "false"; }
  }

  /** 用 CSS Highlight 高亮原有文本节点，避免插入 mark 破坏选择、代码和公式结构。 */
  search(query: string): void {
    this.query = query;
    this.ranges = [];
    this.matchIndex = -1;
    CSS.highlights.delete("matches"); CSS.highlights.delete("current-match");
    if (!query || !this.complete) { this.onSearch(0, -1, false); return; }
    const walker = document.createTreeWalker(this.article, NodeFilter.SHOW_TEXT, { acceptNode: (node) =>
      node.parentElement?.closest("button,.image-slot,.katex-mathml") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    const nodes: { node: Text; start: number; end: number }[] = [];
    const text: string[] = [];
    let length = 0;
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const content = node.textContent ?? "";
      if (!content) continue;
      nodes.push({ node: node as Text, start: length, end: length + content.length });
      text.push(content); length += content.length;
    }
    const result = findMatches(text.join(""), query);
    this.matchesTruncated = result.truncated;
    let cursor = 0;
    for (const match of result.matches) {
      while (cursor < nodes.length - 1 && nodes[cursor].end <= match.start) cursor++;
      const start = nodes[cursor];
      let endIndex = cursor;
      while (endIndex < nodes.length - 1 && nodes[endIndex].end < match.end) endIndex++;
      const end = nodes[endIndex];
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, match.start - start.start);
      range.setEnd(end.node, match.end - end.start);
      this.ranges.push(range);
    }
    CSS.highlights.set("matches", new Highlight(...this.ranges));
    this.onSearch(this.ranges.length, -1, result.truncated);
    if (this.ranges.length) this.jumpMatch(1, result.truncated);
  }

  jumpMatch(step: number, truncated = this.matchesTruncated): void {
    if (!this.ranges.length) return;
    this.matchIndex = (this.matchIndex + step + this.ranges.length) % this.ranges.length;
    const range = this.ranges[this.matchIndex];
    CSS.highlights.set("current-match", new Highlight(range));
    // 结果循环切换，正文滑到结果所在行的中央，而不是瞬间跳过去。
    void glideTo(this.viewport, centerOf(this.viewport, () => range.getBoundingClientRect()));
    this.onSearch(this.ranges.length, this.matchIndex, truncated);
  }

  async jumpHeading(id: string): Promise<void> {
    const epoch = this.epoch;
    await this.finished;
    if (epoch !== this.epoch) return;
    const heading = this.article.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
    if (!heading) return;
    heading.tabIndex = -1; heading.focus({ preventScroll: true });
    await glideTo(this.viewport, topOf(this.viewport, heading));
  }

  /** 只命中视口内的一个块，目录用有序元数据二分定位，滚动时不扫描全文布局。 */
  capturePosition(): ReadingPosition {
    const rect = this.viewport.getBoundingClientRect();
    const element = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(80, rect.height / 3));
    const section = element?.closest<HTMLElement>(".md-block");
    const block = section && this.article.contains(section) ? Number(section.dataset.block) : null;
    const result = { position: Math.max(0, Math.min(1, this.viewport.scrollTop / Math.max(1, this.viewport.scrollHeight - this.viewport.clientHeight))),
      block, offset: section ? rect.top - section.getBoundingClientRect().top : 0, anchorHash: block === null ? null : this.current?.blockHashes[block] ?? null };
    if (block !== null && this.current) {
      const headings = this.current.headings; let low = 0; let high = headings.length;
      while (low < high) { const middle = (low + high) >>> 1; if (headings[middle].block <= block) low = middle + 1; else high = middle; }
      const id = headings[low - 1]?.id ?? "";
      if (id !== this.activeHeading) { this.activeHeading = id; this.onHeading(id); }
    }
    return result;
  }

  /** 优先匹配源块摘要；插入新段时选择最邻近的同内容块，找不到才回退百分比。 */
  async restorePosition(position: ReadingPosition): Promise<void> {
    const epoch = this.epoch; await this.finished;
    if (!this.current || epoch !== this.epoch || this.article.hidden) return;
    let block = position.block;
    if (position.anchorHash && (block === null || this.current.blockHashes[block] !== position.anchorHash)) {
      let nearest: number | null = null;
      for (let index = 0; index < this.current.blockHashes.length; index++) {
        if (this.current.blockHashes[index] === position.anchorHash && (nearest === null || Math.abs(index - (block ?? 0)) < Math.abs(nearest - (block ?? 0)))) nearest = index;
      }
      block = nearest;
    }
    const section = block === null ? null : this.article.querySelector<HTMLElement>(`[data-block="${block}"]`);
    if (!section) { this.viewport.scrollTop = position.position * (this.viewport.scrollHeight - this.viewport.clientHeight); return; }
    section.scrollIntoView({ block: "start" }); await frame();
    // 首次定位让出一帧期间可能进入设置，不能再用正文偏移滚动设置页面。
    if (epoch !== this.epoch || this.article.hidden) return;
    this.viewport.scrollTop += section.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top + position.offset;
  }

  /** 释放一篇文章持有的线程、观察器、范围及图片，不保留无限文档缓存。 */
  dispose(): void {
    this.epoch++;
    if (this.worker) { this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate(); this.worker = null; }
    this.enhancementUnavailable = false;
    this.observer?.disconnect(); this.observer = null;
    this.activeHeading = "";
    this.jobs.clear();
    for (const url of this.blobs.values()) URL.revokeObjectURL(url);
    this.blobs.clear();
    this.ranges = []; this.complete = false;
    this.current = null;
    this.finished = Promise.resolve();
    window.clearTimeout(this.searchTimer);
    CSS.highlights.delete("matches"); CSS.highlights.delete("current-match");
  }
}
