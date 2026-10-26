// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryEntry, ReaderDocument, ReadingPosition, Session } from "../src/types";

const native = vi.hoisted(() => ({
  invoke: vi.fn(), handlers: new Map<string, (event: { payload: string }) => void>(),
  show: vi.fn(), restore: vi.fn(), capture: vi.fn(), closeRequested: vi.fn(),
  search: vi.fn(), jumpMatch: vi.fn(), dispose: vi.fn(), title: vi.fn(),
  // 仅替换原生窗口边界，标题栏仍通过真实控制器响应按钮与窗口状态事件。
  minimize: vi.fn(), toggleMaximize: vi.fn(), close: vi.fn(), isMaximized: vi.fn(), resized: vi.fn(),
  reader: null as { onMessage: (text: string) => void; onSearch: (count: number, index: number, truncated: boolean) => void } | null,
  beforeUpdateInstall: null as (() => Promise<void>) | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke, isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (name: string, handler: (event: { payload: string }) => void) => { native.handlers.set(name, handler); return () => {}; } }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({
  setTitle: native.title, onCloseRequested: native.closeRequested,
  minimize: native.minimize, toggleMaximize: native.toggleMaximize, close: native.close,
  isMaximized: native.isMaximized, onResized: native.resized,
}) }));
vi.mock("../src/storage-settings", () => ({ StorageSettings: class { activate() {} deactivate() {} } }));
vi.mock("../src/update-settings", () => ({ UpdateSettings: class {
  constructor(_container: HTMLElement, save: () => Promise<void>) { native.beforeUpdateInstall = save; }
  activate() {} deactivate() {}
} }));
// 只替换排版和原生边界；真实主窗口控制器、DOM 事件与异步打开流程参与测试。
vi.mock("../src/reader", () => ({ Reader: class {
  onMessage = (_text: string) => {};
  onSearch = (_count: number, _index: number, _truncated: boolean) => {};
  constructor(readonly article: HTMLElement, readonly viewport: HTMLElement) { native.reader = this; }
  capturePosition = native.capture;
  restorePosition = native.restore;
  search = native.search;
  jumpMatch = native.jumpMatch;
  dispose = native.dispose;
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

describe("关闭文章的页面与请求边界", () => {
  const close = () => document.querySelector<HTMLButtonElement>('[data-action="close-document"]')!.click();

  it("从搜索和设置返回统一空状态，清空旧标题、进度及输入，并保留导航历史", async () => {
    document.querySelector<HTMLButtonElement>('[data-action="search"]')!.click();
    const input = document.querySelector<HTMLInputElement>("#search-input")!;
    input.value = "阅读"; input.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector("#search-count")!.textContent = "1 / 8";
    clickSettings(); await settle(); close(); await settle();
    await vi.advanceTimersByTimeAsync(1000);
    expect(settingsVisible()).toBe(false);
    expect(document.querySelector<HTMLElement>("#welcome")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#article")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#search-bar")!.hidden).toBe(true);
    expect(input.value).toBe(""); expect(document.querySelector("#search-count")!.textContent).toBe("");
    expect(native.search).toHaveBeenLastCalledWith(""); expect(native.search).not.toHaveBeenCalledWith("阅读");
    expect(document.querySelector("#read-progress")!.textContent).toBe("—");
    expect(document.querySelector("#document-name")!.getAttribute("title")).toBeNull();
    expect(document.querySelector("#outline-list")!.textContent).toContain("打开文章后显示目录");
    expect(document.querySelector("#recent-files")!.textContent).toContain("阅读.md");
    expect(native.title).toHaveBeenLastCalledWith("MD · Markdown 阅读器");
    expect(document.activeElement?.id).toBe("reading-pane");
  });

  it("后台关闭失败时保留当前文章和设置，允许再次关闭", async () => {
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "close_document" ? Promise.reject(new Error("状态无法保存")) : original(name));
    clickSettings(); await settle(); close(); await settle();
    expect(settingsVisible()).toBe(true);
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 1");
    expect(document.querySelector("#notice-text")!.textContent).toContain("状态无法保存");
    expect(native.dispose).not.toHaveBeenCalled();
    native.invoke.mockImplementation(original); close(); await settle();
    expect(settingsVisible()).toBe(false); expect(native.dispose).toHaveBeenCalledOnce();
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(true);
  });

  it("新文章等待已发出的关闭完成，迟到关闭不清空新文章", async () => {
    const closing = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    const next = "H:\\文章\\下一篇.md";
    native.invoke.mockImplementation((name: string, payload?: { path: string }) => name === "close_document" ? closing.promise
      : name === "open_document" ? Promise.resolve({ ...article(2), path: payload!.path }) : original(name));
    close(); await settle();
    native.handlers.get("open-path")!({ payload: next }); await settle();
    expect(opens()).toHaveLength(1);
    closing.resolve(); await settle();
    expect(opens()).toHaveLength(2);
    expect(document.querySelector("#document-name")!.textContent).toBe("下一篇.md");
    expect(document.querySelector<HTMLElement>("#article")!.hidden).toBe(false);
    expect(native.dispose).not.toHaveBeenCalled();
  });

  it("关闭尚在保存进度时发起新打开，不再发送过期关闭", async () => {
    const saving = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    native.capture.mockReturnValue({ ...anchor, offset: 42 });
    native.invoke.mockImplementation((name: string) => name === "save_position" ? saving.promise : original(name));
    close(); await settle(); native.handlers.get("open-path")!({ payload: path }); await settle();
    saving.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "close_document")).toHaveLength(0);
    expect(opens()).toHaveLength(2); expect(native.dispose).not.toHaveBeenCalled();
  });

  it("关闭等待中打开后又关闭，最后一次关闭取消排队打开并回到欢迎页", async () => {
    const closing = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "close_document" ? closing.promise : original(name));
    close(); await settle();
    native.handlers.get("open-path")!({ payload: path }); await settle(); close(); await settle();
    closing.resolve(); await settle();
    expect(opens()).toHaveLength(1);
    expect(document.querySelector<HTMLElement>("#welcome")!.hidden).toBe(false);
    expect(document.querySelector("#article")!.textContent).toBe("");
  });

  it("旧关闭结束不能释放新关闭的等待边界，后续打开等待最新关闭完成", async () => {
    const first = deferred<void>(); const second = deferred<void>(); let closes = 0;
    const original = native.invoke.getMockImplementation()!; const next = "H:\\文章\\最后一篇.md";
    native.invoke.mockImplementation((name: string, payload?: { path: string }) => name === "close_document" ? (++closes === 1 ? first.promise : second.promise)
      : name === "open_document" ? Promise.resolve({ ...article(2), path: payload!.path }) : original(name));
    close(); await settle(); native.handlers.get("open-path")!({ payload: path }); await settle(); close(); await settle();
    first.resolve(); await settle(); expect(closes).toBe(2);
    native.handlers.get("open-path")!({ payload: next }); await settle(); expect(opens()).toHaveLength(1);
    second.resolve(); await settle();
    expect(opens()).toHaveLength(2); expect(document.querySelector("#document-name")!.textContent).toBe("最后一篇.md");
    expect(document.querySelector<HTMLElement>("#article")!.hidden).toBe(false);
  });

  it("关闭后迟到的打开结果不能恢复旧文章", async () => {
    const opening = deferred<ReaderDocument>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "open_document" ? opening.promise : original(name));
    native.handlers.get("open-path")!({ payload: path }); await settle(); close(); await settle();
    opening.resolve(article(2)); await settle();
    expect(document.querySelector<HTMLElement>("#welcome")!.hidden).toBe(false);
    expect(document.querySelector("#article")!.textContent).toBe("");
    expect(native.show).toHaveBeenCalledTimes(1);
  });

  it("关闭打断启动定位后，旧定位完成不能确认迁移健康", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const restoring = deferred<void>(); native.restore.mockReturnValueOnce(restoring.promise);
    await import("../src/main"); await settle(); close(); await settle();
    restoring.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>("#welcome")!.hidden).toBe(false);
  });
});
let remoteSession: Session;
let narrowViewport: { matches: boolean; addEventListener: ReturnType<typeof vi.fn> };
const documentListeners: [string, EventListenerOrEventListenerObject, boolean | AddEventListenerOptions | undefined][] = [];

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
  // 每次导入都会安装主窗口快捷键；清理测试拥有的监听器，避免旧控制器响应下一例的按键。
  const addListener = document.addEventListener.bind(document);
  vi.spyOn(document, "addEventListener").mockImplementation((type, listener, options) => {
    documentListeners.push([type, listener, options]); addListener(type, listener, options);
  });
  document.body.innerHTML = '<div id="app"></div>';
  narrowViewport = { matches: false, addEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", (query: string) => query === "(max-width: 950px)" ? narrowViewport : { matches: false, addEventListener() {} });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { callback(0); return 0; });
  native.capture.mockReturnValue({ ...anchor }); native.restore.mockResolvedValue(undefined); native.show.mockResolvedValue(undefined);
  native.closeRequested.mockResolvedValue(() => {});
  native.minimize.mockResolvedValue(undefined); native.toggleMaximize.mockResolvedValue(undefined); native.close.mockResolvedValue(undefined);
  native.isMaximized.mockResolvedValue(false); native.resized.mockResolvedValue(() => {});
  remoteSession = {
    root: "H:\\应用数据\\MD", version: "0.1.0", storageNotice: null,
    state: { preferences: { theme: "light", fontSize: 18, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 },
      recent: [{ path, ...anchor, openedAt: 0 }], folders: [], folderClosed: false, lastFile: path, window: { width: 1280, height: 860, maximized: false } },
  };
  native.invoke.mockImplementation(async (name: string) => name === "get_session" ? structuredClone(remoteSession) : name === "open_document" ? article(1) : null);
  await import("../src/main"); await settle();
  expect(native.show).toHaveBeenCalledTimes(1); native.restore.mockClear();
});

describe("一体化窗口标题栏", () => {
  const windowButton = (name: string) => document.querySelector<HTMLButtonElement>(`[data-action="window-${name}"]`)!;

  it("打开入口与当前文件共用可拖动的标题栏，操作按钮不参与拖动", () => {
    const toolbar = document.querySelector(".toolbar")!;
    expect(toolbar.getAttribute("data-tauri-drag-region")).toBe("deep");
    expect(toolbar.querySelector(".brand")).toBeNull();
    expect(toolbar.querySelector('[data-action="open"]')).not.toBeNull();
    expect(toolbar.querySelector('[data-action="folder"]')).not.toBeNull();
    expect(toolbar.querySelector("#document-name")!.textContent).toBe("阅读.md");
    expect(toolbar.querySelector("#document-name")!.getAttribute("title")).toBe(path);
    for (const group of [".open-actions", ".view-actions", ".window-actions"]) {
      expect(toolbar.querySelector(group)!.getAttribute("data-tauri-drag-region")).toBe("false");
    }
  });

  it("最小化与最大化交给原生窗口，按钮随实际最大化和还原事件更新", async () => {
    windowButton("minimize").click(); await settle();
    expect(native.minimize).toHaveBeenCalledOnce();
    const maximize = windowButton("maximize");
    expect(maximize.getAttribute("aria-label")).toBe("最大化");
    native.isMaximized.mockResolvedValue(true);
    maximize.click(); await settle();
    expect(native.toggleMaximize).toHaveBeenCalledOnce();
    expect(maximize.getAttribute("aria-label")).toBe("还原窗口");
    expect(maximize.title).toBe("还原窗口");
    native.isMaximized.mockResolvedValue(false);
    native.resized.mock.calls[0][0](); await settle();
    expect(maximize.getAttribute("aria-label")).toBe("最大化");
  });

  it("关闭按钮沿用保存保护，保存失败时保留文章并允许重试", async () => {
    const event = { preventDefault: vi.fn() };
    native.close.mockImplementation(async () => { await native.closeRequested.mock.calls[0][0](event); });
    const original = native.invoke.getMockImplementation()!;
    native.capture.mockReturnValue({ ...anchor, offset: 99 });
    native.invoke.mockImplementation((name: string) => name === "save_position" ? Promise.reject(new Error("磁盘不可写")) : original(name));
    windowButton("close").click(); await settle();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(document.querySelector("#notice-text")!.textContent).toContain("关闭前保存失败");
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 1");
    native.invoke.mockImplementation(original); event.preventDefault.mockClear();
    windowButton("close").click(); await settle();
    expect(native.close).toHaveBeenCalledTimes(2);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(native.invoke).toHaveBeenCalledWith("save_position", { path, ...anchor, offset: 99 });
  });

  it("窗口操作失败给出提示，正文与其他工具保持可用", async () => {
    native.minimize.mockRejectedValueOnce(new Error("窗口暂时不可用"));
    windowButton("minimize").click(); await settle();
    expect(document.querySelector("#notice-text")!.textContent).toContain("窗口暂时不可用");
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 1");
    expect(document.querySelector<HTMLButtonElement>('[data-action="search"]')!.disabled).toBe(false);
  });

  it("维护与更新确认期间保留窗口控制，关闭确认框后恢复阅读工具", async () => {
    clickSettings(); await settle();
    const toolbar = document.querySelector<HTMLElement>(".toolbar")!;
    const shell = toolbar.parentElement;
    for (const id of ["maintenance-dialog", "update-install-dialog"]) {
      // 只模拟原生 dialog 的 open 属性变化，检查同一标题栏是否进入可交互的模态子树。
      const dialog = document.createElement("dialog"); dialog.id = id;
      document.querySelector("#settings")!.append(dialog);
      dialog.setAttribute("open", ""); await settle();
      expect(toolbar.parentElement).toBe(dialog);
      expect(toolbar.querySelector<HTMLElement>(".open-actions")!.inert).toBe(true);
      expect(toolbar.querySelector<HTMLElement>(".view-actions")!.inert).toBe(true);
      expect(toolbar.querySelector<HTMLElement>(".window-actions")!.inert).not.toBe(true);
      windowButton("minimize").click(); await settle();
      dialog.removeAttribute("open"); await settle();
      expect(toolbar.parentElement).toBe(shell);
      expect(toolbar.querySelector<HTMLElement>(".open-actions")!.inert).toBe(false);
      expect(toolbar.querySelector<HTMLElement>(".view-actions")!.inert).toBe(false);
      dialog.remove();
    }
    expect(native.minimize).toHaveBeenCalledTimes(2);
  });
});

describe("文章错误提示的恢复边界", () => {
  it("打开失败后重试成功，清除常驻的旧文章错误", async () => {
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "open_document" ? Promise.reject(new Error("文件暂不可用")) : original(name));
    native.handlers.get("open-path")!({ payload: path }); await settle(); await vi.advanceTimersByTimeAsync(6000);
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(false);
    native.invoke.mockImplementation(original); native.handlers.get("open-path")!({ payload: path }); await settle();
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(true);
    expect(document.querySelector("#document-status")!.textContent).not.toContain("打开失败");
  });

  it("取消选文件保留失败说明，关闭当前文章后不把旧错误带到欢迎页", async () => {
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "open_document" ? Promise.reject(new Error("文件暂不可用")) : original(name));
    native.handlers.get("open-path")!({ payload: path }); await settle();
    document.querySelector<HTMLButtonElement>('[data-action="open"]')!.click(); await settle();
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(false);
    document.querySelector<HTMLButtonElement>('[data-action="close-document"]')!.click(); await settle();
    expect(document.querySelector<HTMLElement>("#welcome")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(true);
  });

  it("重新打开文章后不继续显示上一篇的增强错误", async () => {
    native.reader!.onMessage("旧文章增强暂不可用");
    native.handlers.get("open-path")!({ payload: path }); await settle();
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(true);
  });

  it("新文章自己的增强错误仍然可见，不在渲染结束时误清除", async () => {
    native.reader!.onMessage("旧文章增强暂不可用");
    native.show.mockImplementationOnce(async () => { native.reader!.onMessage("本次增强仍不可用"); });
    native.handlers.get("open-path")!({ payload: path }); await settle();
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(false);
    expect(document.querySelector("#notice-text")!.textContent).toBe("本次增强仍不可用");
  });

  it("文章恢复不能清掉全局未保存警告，旧计时器也不能将其隐藏", async () => {
    native.reader!.onMessage("旧文章增强暂不可用");
    native.handlers.get("state-error")!({ payload: "磁盘不可写" });
    native.handlers.get("open-path")!({ payload: path }); await settle(); await vi.advanceTimersByTimeAsync(6000);
    expect(document.querySelector<HTMLElement>("#notice")!.hidden).toBe(false);
    expect(document.querySelector("#notice-text")!.textContent).toContain("状态未保存：磁盘不可写");
  });
});

const folders = ["H:\\文章", "H:\\其他目录"];
const selectFolder = async (path: string) => {
  const select = document.querySelector<HTMLSelectElement>("#recent-folder")!;
  select.value = path; select.dispatchEvent(new Event("change", { bubbles: true })); await settle();
};

/** 目录用可控原生返回模拟，正文控制器与导航 DOM 仍由实际入口更新。 */
async function prepareFolders(read: (path: string) => Promise<DirectoryEntry[]> = async () => []) {
  remoteSession.state.folders = [...folders];
  const original = native.invoke.getMockImplementation()!;
  native.invoke.mockImplementation((name: string, payload?: { path: string }) => {
    if (name === "pick_directory") return Promise.resolve(folders[0]);
    if (name === "open_recent_directory") {
      remoteSession.state.folders = [payload!.path, ...remoteSession.state.folders.filter((item) => item !== payload!.path)];
      remoteSession.state.folderClosed = false; return Promise.resolve();
    }
    if (name === "close_directory") { remoteSession.state.folderClosed = true; return Promise.resolve(); }
    if (name === "read_directory") return read(payload!.path);
    if (name === "clear_history") { remoteSession.state.folders = []; remoteSession.state.recent = []; return Promise.resolve(); }
    return original(name);
  });
  document.querySelector<HTMLButtonElement>('[data-action="folder"]')!.click(); await settle();
}

describe("阅读工具的焦点与可见状态", () => {
  const outline = () => document.querySelector<HTMLButtonElement>('[data-action="outline"]')!;
  const drawerVisible = () => document.querySelector("#app")!.classList.contains("outline-drawer");

  it("目录退场立即退出键盘路径，Escape 返回触发按钮，反复开关保留最终意图", async () => {
    narrowViewport.matches = true; narrowViewport.addEventListener.mock.calls[0][1]();
    const panel = document.querySelector<HTMLElement>("#outline-panel")!;
    for (let count = 0; count < 12; count++) {
      outline().click(); expect(panel.inert).toBe(false);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(panel.inert).toBe(true); expect(document.activeElement).toBe(outline());
    }
    outline().click(); await vi.advanceTimersByTimeAsync(250);
    expect(panel.inert).toBe(false); expect(outline().getAttribute("aria-expanded")).toBe("true"); expect(drawerVisible()).toBe(true);
    narrowViewport.matches = false; narrowViewport.addEventListener.mock.calls[0][1](); outline().click();
    narrowViewport.matches = true; narrowViewport.addEventListener.mock.calls[0][1](); outline().click();
    narrowViewport.matches = false; narrowViewport.addEventListener.mock.calls[0][1]();
    expect(panel.inert).toBe(true); expect(document.activeElement).toBe(outline());
  });

  it("返回阅读后键盘焦点落在阅读区，保持原锚点", async () => {
    clickSettings(); await settle(); expect(document.activeElement?.id).toBe("settings-title");
    expect(document.querySelector('[data-action="settings"]')!.getAttribute("aria-expanded")).toBe("true");
    document.querySelector<HTMLButtonElement>('.back-button')!.click(); await settle();
    expect(document.activeElement?.id).toBe("reading-pane");
    expect(document.querySelector('[data-action="settings"]')!.getAttribute("aria-expanded")).toBe("false");
    expect(native.restore).toHaveBeenLastCalledWith(anchor);
  });

  it("小窗口目录的关闭、设置和断点变化同步按钮状态，不改写桌面偏好", async () => {
    narrowViewport.matches = true;
    const changedLayout = narrowViewport.addEventListener.mock.calls[0][1]; changedLayout();
    expect(outline().getAttribute("aria-pressed")).toBe("false");
    outline().click(); expect(drawerVisible()).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(drawerVisible()).toBe(false); expect(outline().getAttribute("aria-pressed")).toBe("false");
    outline().click(); clickSettings(); await settle();
    expect(drawerVisible()).toBe(false); expect(outline().getAttribute("aria-pressed")).toBe("false");
    narrowViewport.matches = false; changedLayout();
    expect(outline().getAttribute("aria-pressed")).toBe("false");
    document.querySelector<HTMLButtonElement>('.back-button')!.click(); await settle();
    expect(outline().getAttribute("aria-pressed")).toBe("true");
    expect(native.invoke.mock.calls.filter(([name]) => name === "save_preferences")).toHaveLength(0);
  });

  it("没有文章时禁用正文搜索，快捷键不能在欢迎页留下空搜索栏", async () => {
    document.querySelector<HTMLButtonElement>('[data-action="close-document"]')!.click(); await settle();
    expect(document.querySelector<HTMLButtonElement>('[data-action="search"]')!.disabled).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "f", ctrlKey: true, bubbles: true }));
    expect(document.querySelector<HTMLElement>("#search-bar")!.hidden).toBe(true);
    native.handlers.get("open-path")!({ payload: path }); await settle();
    expect(document.querySelector<HTMLButtonElement>('[data-action="search"]')!.disabled).toBe(false);
  });
});

describe("维护确认期间的快捷键边界", () => {
  it("模态确认接管 Escape，后台阅读和文件快捷键不越过确认框", async () => {
    clickSettings(); await settle();
    const modal = document.createElement("dialog"); modal.open = true; document.body.append(modal);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(settingsVisible()).toBe(true);
    for (const key of ["o", "f", "w", "F5"]) {
      const event = new KeyboardEvent("keydown", { key, ctrlKey: key !== "F5", cancelable: true, bubbles: true });
      document.dispatchEvent(event); expect(event.defaultPrevented).toBe(true);
    }
    await settle(); expect(callsFor("pick_file")).toBe(0); expect(callsFor("close_document")).toBe(0);
    expect(document.querySelector<HTMLElement>("#search-bar")!.hidden).toBe(true);
    modal.open = false; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await settle();
    expect(settingsVisible()).toBe(false); expect(opens()).toHaveLength(1);
  });
  const callsFor = (command: string) => native.invoke.mock.calls.filter(([name]) => name === command).length;
});

describe("搜索的显示与输入合并", () => {
  const search = () => document.querySelector<HTMLButtonElement>('[data-action="search"]')!.click();
  const closeSearch = () => document.querySelector<HTMLButtonElement>('[data-action="close-search"]')!.click();
  const input = () => document.querySelector<HTMLInputElement>("#search-input")!;

  it("快速开关立即更新隐藏语义和焦点，设置返回也反映实际搜索状态", async () => {
    const bar = document.querySelector<HTMLElement>("#search-bar")!;
    const trigger = document.querySelector('[data-action="search"]')!;
    for (let count = 0; count < 12; count++) { search(); closeSearch(); }
    search(); expect(bar.hidden).toBe(false); expect(bar.inert).toBe(false);
    expect(trigger.getAttribute("aria-expanded")).toBe("true"); expect(document.activeElement).toBe(input());
    clickSettings(); await settle(); expect(bar.inert).toBe(true); expect(trigger.getAttribute("aria-expanded")).toBe("false");
    document.querySelector<HTMLButtonElement>('.back-button')!.click(); await settle();
    expect(bar.inert).toBe(false); expect(trigger.getAttribute("aria-expanded")).toBe("true");
    closeSearch(); expect(bar.hidden).toBe(true); expect(bar.inert).toBe(true);
    expect(document.activeElement?.id).toBe("reading-pane");
    await vi.advanceTimersByTimeAsync(250); expect(bar.hidden).toBe(true);
  });

  it("关闭时移除旧结果提示，重新打开后用保留的搜索词恢复结果", async () => {
    search(); input().value = "阅读"; input().dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(40); expect(native.search).toHaveBeenLastCalledWith("阅读");
    document.querySelector("#search-count")!.textContent = "1 / 8";
    closeSearch(); expect(document.querySelector("#search-count")!.textContent).toBe("");
    search(); expect(input().value).toBe("阅读"); expect(native.search).toHaveBeenLastCalledWith("阅读");
    expect(document.activeElement).toBe(input());
  });

  it("输入合并尚未触发时关闭，迟到计时器不能在隐藏搜索栏后重新高亮", async () => {
    search(); native.search.mockClear();
    input().value = "尚未提交"; input().dispatchEvent(new Event("input", { bubbles: true }));
    closeSearch(); await vi.advanceTimersByTimeAsync(100);
    expect(native.search).toHaveBeenCalledExactlyOnceWith("");
    expect(document.querySelector<HTMLElement>("#search-bar")!.hidden).toBe(true);
  });

  it("清除入口取消待执行的搜索，保留浮层、输入焦点和阅读位置", async () => {
    const pane = document.querySelector<HTMLElement>("#reading-pane")!; pane.scrollTop = 320;
    search(); native.search.mockClear();
    const clear = document.querySelector<HTMLButtonElement>('[data-action="clear-search"]');
    expect(clear).not.toBeNull(); expect(clear!.hidden).toBe(true);
    input().value = "待搜索的词"; input().dispatchEvent(new Event("input", { bubbles: true }));
    expect(clear!.hidden).toBe(false);
    clear!.click(); native.reader!.onSearch(0, -1, false); await settle();
    await vi.advanceTimersByTimeAsync(100);
    expect(input().value).toBe(""); expect(clear!.hidden).toBe(true);
    expect(native.search).toHaveBeenCalledExactlyOnceWith("");
    expect(document.querySelector("#search-count")!.textContent).toBe("");
    expect(document.querySelector<HTMLElement>("#search-bar")!.hidden).toBe(false);
    expect(document.activeElement).toBe(input()); expect(pane.scrollTop).toBe(320);
  });

  it("结果计数、上下导航和无匹配状态保持一致", () => {
    search(); input().value = "阅读";
    const previous = document.querySelector<HTMLButtonElement>('[data-action="previous-match"]')!;
    const next = document.querySelector<HTMLButtonElement>('[data-action="next-match"]')!;
    native.reader!.onSearch(8, 2, false);
    expect(document.querySelector("#search-count")!.textContent).toBe("3 / 8");
    expect(previous.title).toContain("Shift+Enter"); expect(next.title).toContain("Enter");
    previous.click(); next.click();
    expect(native.jumpMatch.mock.calls).toEqual([[-1], [1]]);
    native.reader!.onSearch(0, -1, false);
    expect(document.querySelector("#search-count")!.textContent).toBe("无匹配");
    expect(previous.disabled).toBe(true); expect(next.disabled).toBe(true);
  });
});

describe("阅读偏好控件", () => {
  it("纸面选择使用单选语义，与工具栏切换及持久化偏好同步", async () => {
    clickSettings(); await settle();
    const choices = document.querySelectorAll<HTMLInputElement>('#theme-setting input[type="radio"]');
    expect(choices).toHaveLength(3);
    expect([...choices].filter((choice) => choice.checked).map((choice) => choice.value)).toEqual(["light"]);
    const dark = document.querySelector<HTMLInputElement>('input[name="theme"][value="dark"]')!;
    dark.click(); expect(document.documentElement.dataset.theme).toBe("dark"); expect(dark.checked).toBe(true);
    document.querySelector<HTMLButtonElement>('[data-action="theme"]')!.click();
    expect(document.querySelector<HTMLInputElement>('input[name="theme"][value="light"]')!.checked).toBe(true);
    document.querySelector<HTMLInputElement>('input[name="theme"][value="system"]')!.click();
    await vi.advanceTimersByTimeAsync(180);
    expect(native.invoke).toHaveBeenCalledWith("save_preferences", { preferences: expect.objectContaining({ theme: "system" }) });
  });

  it("滑块两端的轨道进度、读数与可访问值随实际偏好更新", () => {
    for (const [id, output] of [["font-setting", "font-value"], ["width-setting", "width-value"]]) {
      const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
      for (const [value, progress] of [[input.min, "0%"], [input.max, "100%"]]) {
        input.value = value; input.dispatchEvent(new Event("input", { bubbles: true }));
        expect(input.style.getPropertyValue("--range-progress")).toBe(progress);
        expect(input.getAttribute("aria-valuetext")).toBe(`${value} 像素`);
        expect(document.querySelector(`#${output}`)!.textContent).toBe(`${value} px`);
      }
    }
  });
});

describe("最近目录与关闭导航", () => {
  it("切换最近目录仅更换文件树，保留正文", async () => {
    await prepareFolders(async (path) => [{ path: `${path}\\样例.md`, name: path === folders[0] ? "第一篇.md" : "第二篇.md", directory: false }]);
    await selectFolder(folders[1]);
    expect(document.querySelector("#file-tree")!.textContent).toContain("第二篇.md");
    expect(document.querySelector("#file-tree")!.textContent).not.toContain("第一篇.md");
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 1");
    expect(native.show).toHaveBeenCalledTimes(1);
  });

  it("关闭期间迟到的目录列表不能回填，历史保留并可重新打开", async () => {
    const pending = deferred<DirectoryEntry[]>();
    await prepareFolders(async (path) => path === folders[1] ? pending.promise : []);
    await selectFolder(folders[1]);
    document.querySelector<HTMLButtonElement>('[data-action="close-folder"]')!.click(); await settle();
    pending.resolve([{ path: "迟到.md", name: "迟到文章", directory: false }]); await settle();
    expect(document.querySelector("#file-tree")!.textContent).not.toContain("迟到文章");
    expect(document.querySelector<HTMLSelectElement>("#recent-folder")!.value).toBe("");
    expect(document.querySelector<HTMLSelectElement>("#recent-folder")!.options).toHaveLength(3);
    await selectFolder(folders[1]);
    expect(document.querySelector("#file-tree")!.textContent).toContain("迟到文章");
  });

  it("最近目录不可用时保留原导航并提供失败说明", async () => {
    await prepareFolders(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string, payload: unknown) => name === "open_recent_directory" ? Promise.reject(new Error("最近目录不可用")) : original(name, payload));
    await selectFolder(folders[1]);
    expect(document.querySelector<HTMLSelectElement>("#recent-folder")!.value).toBe(folders[0]);
    expect(document.querySelector("#notice-text")!.textContent).toContain("最近目录不可用");
  });

  it("清除记录同步移除目录导航，保持当前正文可读", async () => {
    await prepareFolders();
    document.querySelector<HTMLButtonElement>('[data-action="clear-history"]')!.click(); await settle();
    expect(document.querySelector<HTMLElement>("#folder-controls")!.hidden).toBe(true);
    expect(document.querySelector("#file-tree .file-row")).toBeNull();
    expect(document.querySelector("#article")!.textContent).toContain("正文修订 1");
  });
});

afterEach(() => {
  for (const [type, listener, options] of documentListeners.splice(0)) document.removeEventListener(type, listener, options);
  vi.restoreAllMocks(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals();
});

describe("迁移健康确认", () => {
  it("原生打开失败时不以空界面代替恢复成功", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "open_document" ? Promise.reject(new Error("文章不可用")) : original(name));
    await import("../src/main"); await settle();
    expect(document.querySelector("#notice-text")!.textContent).toContain("文章不可用");
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
  });

  it("会话刷新失败后返回阅读也不能确认健康", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const rendering = deferred<void>(); let reads = 0;
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "get_session" && ++reads > 1 ? Promise.reject(new Error("会话读取失败")) : original(name));
    native.show.mockReturnValueOnce(rendering.promise);
    await import("../src/main"); await settle(); clickSettings(); await settle();
    rendering.resolve(); await settle(); clickSettings(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
  });

  it("健康确认写入失败不锁死重试，下一次成功定位可再次提交", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const original = native.invoke.getMockImplementation()!; let attempts = 0;
    native.invoke.mockImplementation((name: string) => name === "app_ready" && ++attempts === 1 ? Promise.reject(new Error("引导不可写")) : original(name));
    await import("../src/main"); await settle();
    expect(document.querySelector("#notice-text")!.textContent).toContain("健康确认失败");
    clickSettings(); await settle(); clickSettings(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(2);
  });

  it("旧定位完成不能替代返回阅读后的新定位，最新定位完成前保留迁移源", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const first = deferred<void>(); const latest = deferred<void>();
    native.restore.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise);
    await import("../src/main"); await settle();
    clickSettings(); await settle(); clickSettings(); await settle();
    first.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
    latest.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(1);
  });

  it("返回阅读的定位先完成时，仍须等待本次会话刷新成功才能确认健康", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const rendering = deferred<void>(); const session = deferred<Session>(); let reads = 0;
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "get_session" && ++reads > 1 ? session.promise : original(name));
    native.show.mockReturnValueOnce(rendering.promise);
    await import("../src/main"); await settle(); clickSettings(); await settle();
    rendering.resolve(); await settle(); clickSettings(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
    session.resolve(structuredClone(remoteSession)); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(1);
  });

  it("首屏已绘制但位置尚未恢复时不提交健康，恢复完成后才确认一次", async () => {
    vi.resetModules(); native.invoke.mockClear(); native.show.mockClear();
    document.body.innerHTML = '<div id="app"></div>';
    const restoring = deferred<void>(); native.restore.mockReturnValueOnce(restoring.promise);
    await import("../src/main"); await settle();
    expect(native.show).toHaveBeenCalledTimes(1);
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
    restoring.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(1);
  });

  it("阅读状态恢复失败时不确认新位置，保留源目录供下次启动回滚", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    native.restore.mockRejectedValueOnce(new Error("恢复位置失败"));
    await import("../src/main"); await settle();
    expect(document.querySelector("#notice-text")!.textContent).toContain("恢复位置失败");
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
  });

  it("首屏后进入设置会推迟确认，返回阅读并恢复锚点后才允许清理源目录", async () => {
    vi.resetModules(); native.invoke.mockClear(); document.body.innerHTML = '<div id="app"></div>';
    const rendering = deferred<void>(); native.show.mockReturnValueOnce(rendering.promise);
    await import("../src/main"); await settle(); clickSettings(); await settle();
    rendering.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
    const restoring = deferred<void>(); native.restore.mockReturnValueOnce(restoring.promise);
    clickSettings(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(0);
    restoring.resolve(); await settle();
    expect(native.invoke.mock.calls.filter(([name]) => name === "app_ready")).toHaveLength(1);
  });
});

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

describe("异步关闭保存", () => {
  it("等待最后一次偏好保存后放行原关闭请求，同时拦截重复关闭", async () => {
    const saving = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "save_preferences" ? saving.promise : original(name));
    const input = document.querySelector<HTMLInputElement>("#font-setting")!;
    input.value = "20"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const first = { preventDefault: vi.fn() }; const duplicate = { preventDefault: vi.fn() };
    const handler = native.closeRequested.mock.calls[0][0];
    let finished = false; const closing = handler(first).then(() => { finished = true; }); await settle();
    expect(finished).toBe(false); await handler(duplicate); expect(duplicate.preventDefault).toHaveBeenCalledOnce();
    saving.resolve(); await closing; expect(first.preventDefault).not.toHaveBeenCalled();
  });

  it("保存失败时保留窗口并允许再次关闭重试", async () => {
    const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "save_preferences" ? Promise.reject(new Error("磁盘不可写")) : original(name));
    const input = document.querySelector<HTMLInputElement>("#font-setting")!;
    input.value = "20"; input.dispatchEvent(new Event("input", { bubbles: true }));
    const handler = native.closeRequested.mock.calls[0][0]; const failed = { preventDefault: vi.fn() };
    await handler(failed); expect(failed.preventDefault).toHaveBeenCalledOnce();
    expect(document.querySelector("#notice-text")!.textContent).toContain("关闭前保存失败");
    native.invoke.mockImplementation(original); const retry = { preventDefault: vi.fn() };
    await handler(retry); expect(retry.preventDefault).not.toHaveBeenCalled();
  });
});

it("安装确认保存进入设置前的位置，失败必须阻止交接并可重试", async () => {
  await vi.advanceTimersByTimeAsync(0);
  const original = native.invoke.getMockImplementation()!;
  const entering = deferred<void>();
  native.capture.mockReturnValue({ ...anchor, offset: 77 });
  native.invoke.mockImplementation((name: string, args?: unknown) => name === "save_position"
    ? entering.promise : original(name, args));
  clickSettings(); await settle();
  // 进入设置前的保存尚未返回时，用户继续滚动；设置快照必须保留这个更新位置。
  const captured = { ...anchor, offset: 88 };
  native.capture.mockReturnValue(captured); entering.resolve(); await settle();
  native.capture.mockReturnValue({ position: 0, block: null, offset: 0 });
  native.invoke.mockImplementation((name: string, args?: unknown) => name === "save_position"
    ? Promise.reject(new Error("位置保存失败")) : original(name, args));
  await expect(native.beforeUpdateInstall!()).rejects.toThrow("位置保存失败");
  expect(native.invoke).toHaveBeenCalledWith("save_position", { path, ...captured });
  native.invoke.mockImplementation(original);
  await expect(native.beforeUpdateInstall!()).resolves.toBeUndefined();
  expect(native.invoke).toHaveBeenLastCalledWith("save_position", { path, ...captured });
});
