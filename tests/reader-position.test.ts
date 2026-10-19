// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Reader } from "../src/reader";
import type { ReaderDocument, ReadingPosition } from "../src/types";

const position: ReadingPosition = { position: .5, block: 0, offset: 24, anchorHash: null };
let reader: Reader;
let pane: HTMLElement;
let article: HTMLElement;
let section: HTMLElement;

beforeEach(async () => {
  document.body.innerHTML = '<main><article></article></main>';
  pane = document.querySelector("main")!; article = document.querySelector("article")!;
  vi.stubGlobal("CSS", { highlights: new Map() });
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  reader = new Reader(article, pane);
  const value: ReaderDocument = { path: "阅读.md", title: "阅读", bytes: 10, revision: 1, readMs: 0, parseMs: 0, cacheMs: 0, cacheHit: false, cacheError: null,
    blocks: ["<p>正文</p>"], blockHashes: [], headings: [], images: [], links: [] };
  await reader.show(value, () => {});
  section = article.querySelector("section")!; section.scrollIntoView = vi.fn();
  pane.scrollTop = 480;
});

afterEach(() => { reader.dispose(); vi.unstubAllGlobals(); });

describe("正文隐藏时取消阅读位置恢复", () => {
  it("锚点段落后移时使用源块摘要恢复，并保留段内像素偏移", async () => {
    const value: ReaderDocument = { path: "阅读.md", title: "阅读", bytes: 30, revision: 2, readMs: 0, parseMs: 0, cacheMs: 0, cacheHit: false, cacheError: null,
      blocks: ["<p>新增段落</p>", "<p>原段落</p>"], blockHashes: ["new", "saved"], headings: [], images: [], links: [] };
    await reader.show(value, () => {});
    const restored = article.querySelector<HTMLElement>('[data-block="1"]')!;
    restored.scrollIntoView = vi.fn(); pane.scrollTop = 100;
    vi.spyOn(restored, "getBoundingClientRect").mockReturnValue({ top: 30 } as DOMRect);
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ top: 10 } as DOMRect);
    await reader.restorePosition({ ...position, block: 0, anchorHash: "saved" });
    expect(restored.scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    expect(pane.scrollTop).toBe(144);
  });

  it("源块已删除时按保存比例恢复，不使用旧块的像素偏移", async () => {
    Object.defineProperty(pane, "scrollHeight", { value: 1200 });
    Object.defineProperty(pane, "clientHeight", { value: 400 });
    await reader.restorePosition({ ...position, anchorHash: "removed" });
    expect(pane.scrollTop).toBe(400); expect(section.scrollIntoView).not.toHaveBeenCalled();
  });

  it("设置已经显示时不执行正文定位", async () => {
    article.hidden = true; await reader.restorePosition(position);
    expect(section.scrollIntoView).not.toHaveBeenCalled(); expect(pane.scrollTop).toBe(480);
  });

  it("定位已让出一帧时进入设置，不把段落偏移叠加到设置页滚动位置", async () => {
    let nextFrame!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 0; });
    const restoring = reader.restorePosition(position); await Promise.resolve();
    expect(section.scrollIntoView).toHaveBeenCalledTimes(1);
    article.hidden = true; nextFrame(0); await restoring;
    expect(pane.scrollTop).toBe(480);
  });
});
