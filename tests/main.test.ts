// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderDocument, ReadingPosition, Session } from "../src/types";

const native = vi.hoisted(() => ({
  invoke: vi.fn(), handlers: new Map<string, (event: { payload: string }) => void>(),
  show: vi.fn(), restore: vi.fn(), capture: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, handler: (event: { payload: string }) => void) => { native.handlers.set(name, handler); return () => {}; } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setTitle: async () => {}, onCloseRequested: async () => () => {} }) }));
vi.mock("../src/storage-settings", () => ({ StorageSettings: class { activate() {} deactivate() {} } }));
// 只替换排版和原生边界；真实主窗口控制器、DOM 事件与异步打开流程参与测试。
vi.mock("../src/reader", () => ({ Reader: class {
  constructor(readonly article: HTMLElement, readonly viewport: HTMLElement) {}
  capturePosition = native.capture;
  restorePosition = native.restore;
  async show(value: ReaderDocument, painted: () => void) {
    this.article.textContent = value.blocks.join("");
    painted(); await native.show();
  }
} }));

const path = "H:\\文章\\阅读.md";
const anchor: ReadingPosition = { position: .5, block: 8, offset: 24, anchorHash: "0123456789abcdef" };
const article = (revision: number): ReaderDocument => ({
  path, title: "阅读", bytes: 1000, revision, readMs: 1, parseMs: 1, cacheMs: 0, cacheHit: false, cacheError: null,
  blocks: [`正文修订 ${revision}`], blockHashes: [], headings: [], images: [], links: [],
});

/** 手动控制 IPC 或排版完成时刻，确保竞态每次都以相同顺序发生。 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const clickSettings = () => document.querySelector<HTMLButtonElement>('[data-action="settings"]')!.click();
const settingsVisible = () => !document.querySelector<HTMLElement>("#settings")!.hidden;
const opens = () => native.invoke.mock.calls.filter(([name]) => name === "open_document");
const changed = () => native.handlers.get("document-changed")!({ payload: path });
// 控制器事件使用 void 启动异步工作；排空微任务而不提前触发 250ms 的合并计时器。
const settle = async () => { for (let index = 0; index < 30; index++) await Promise.resolve(); };

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.clearAllMocks(); native.handlers.clear();
  document.body.innerHTML = '<div id="app"></div>';
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {} }));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  native.capture.mockReturnValue({ ...anchor }); native.restore.mockResolvedValue(undefined); native.show.mockResolvedValue(undefined);
  const session: Session = {
    root: "H:\\应用数据\\MD", version: "0.1.0", storageNotice: null,
    state: { preferences: { theme: "light", fontSize: 18, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 },
      recent: [{ path, ...anchor, openedAt: 0 }], folders: [], lastFile: path, window: { width: 1280, height: 860, maximized: false } },
  };
  native.invoke.mockImplementation(async (name: string) => name === "get_session" ? structuredClone(session) : name === "open_document" ? article(1) : null);
  await import("../src/main"); await settle();
  expect(native.show).toHaveBeenCalledTimes(1); native.restore.mockClear();
});

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("文件刷新与设置页交错", () => {
  it("刷新 IPC 已发出后进入设置，迟到结果不能关闭设置或替换正文", async () => {
    const pending = deferred<ReaderDocument>();
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "open_document" ? pending.promise : original(name));
    changed(); await vi.advanceTimersByTimeAsync(250);
    expect(opens()).toHaveLength(2);
    clickSettings(); await settle(); expect(settingsVisible()).toBe(true);
    pending.resolve(article(2)); await settle();
    expect(settingsVisible()).toBe(true);
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 1");
    expect(native.restore).not.toHaveBeenCalled();
    native.invoke.mockImplementation((name: string) => name === "open_document" ? Promise.resolve(article(3)) : original(name));
    clickSettings(); await settle();
    expect(opens()).toHaveLength(3);
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 3");
    expect(native.restore).toHaveBeenLastCalledWith(anchor);
  });

  it("设置期间多次变化合并为返回后的一次刷新，并保留进入设置前的锚点", async () => {
    clickSettings(); await settle();
    changed(); await vi.advanceTimersByTimeAsync(100); changed(); await vi.advanceTimersByTimeAsync(250);
    expect(opens()).toHaveLength(1); expect(settingsVisible()).toBe(true);
    clickSettings(); await settle();
    expect(opens()).toHaveLength(2); expect(settingsVisible()).toBe(false);
    expect(native.restore).toHaveBeenLastCalledWith(anchor);
  });

  it("正文分批渲染时进入设置，完成回调不能显示文末或滚动设置页", async () => {
    const rendering = deferred<void>(); native.show.mockReturnValueOnce(rendering.promise);
    changed(); await vi.advanceTimersByTimeAsync(250);
    expect(native.show).toHaveBeenCalledTimes(2);
    native.capture.mockReturnValue({ position: 0, block: 0, offset: 0, anchorHash: null });
    clickSettings(); await settle();
    rendering.resolve(); await settle();
    expect(settingsVisible()).toBe(true);
    expect(document.querySelector<HTMLElement>("#document-end")!.hidden).toBe(true);
    expect(native.restore).not.toHaveBeenCalled();
    clickSettings(); await settle();
    expect(native.restore).toHaveBeenLastCalledWith(anchor);
  });

  it("主动从设置打开文章仍返回阅读，不被自动刷新保护拦截", async () => {
    clickSettings(); await settle();
    native.handlers.get("open-path")!({ payload: path }); await settle();
    expect(opens()).toHaveLength(2); expect(settingsVisible()).toBe(false);
  });

  it("刷新等待期间切换另一篇文章，旧结果与旧文件事件不能覆盖新文章", async () => {
    const pending = deferred<ReaderDocument>();
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string, payload?: { path: string }) => name === "open_document"
      ? payload?.path === path ? pending.promise : Promise.resolve({ ...article(3), path: "H:\\文章\\另一篇.md" }) : original(name));
    changed(); await vi.advanceTimersByTimeAsync(250);
    native.handlers.get("open-path")!({ payload: "H:\\文章\\另一篇.md" }); await settle();
    pending.resolve(article(2)); await settle();
    changed(); await vi.advanceTimersByTimeAsync(250);
    expect(opens()).toHaveLength(3);
    expect(document.querySelector("#document-name")!.textContent).toBe("另一篇.md");
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 3");
  });
});
