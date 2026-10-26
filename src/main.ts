import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DirectoryEntry, Preferences, ReaderDocument, ReadingPosition, Session } from "./types";
import { Reader } from "./reader";
import { icon } from "./icons";
import type { StorageSettings } from "./storage-settings";
import type { UpdateSettings } from "./update-settings";
import { PreferenceStore } from "./preferences";
import "./styles.css";

// 标题栏与阅读工具共用一行；原生拖动区避开按钮，文件名称与路径仍用文本节点呈现。
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<div class="app-shell">
  <header class="toolbar" data-tauri-drag-region="deep">
    <div class="open-actions" data-tauri-drag-region="false"><button class="secondary open-file" data-action="open" title="打开文件 · Ctrl+O">${icon("file")}<span>打开文件</span></button><button class="icon-button" data-action="folder" title="打开文件夹 · Ctrl+Shift+O" aria-label="打开文件夹">${icon("folder")}</button></div>
    <div class="document-name"><span id="document-name">开始阅读</span><span id="document-description">本地 Markdown</span></div>
    <nav class="view-actions" aria-label="阅读工具" data-tauri-drag-region="false">
      <button class="icon-button" data-action="search" title="搜索正文 · Ctrl+F" aria-label="搜索正文" aria-controls="search-bar" aria-expanded="false" disabled>${icon("search")}</button>
      <button class="icon-button" data-action="sidebar" title="文件侧栏" aria-label="切换文件侧栏">${icon("sidebar")}</button>
      <button class="icon-button" data-action="outline" title="文章目录" aria-label="切换文章目录" aria-controls="outline-panel">${icon("outline")}</button>
      <button class="icon-button" data-action="theme" title="切换主题" aria-label="切换主题">${icon("moon")}</button>
      <button class="icon-button" data-action="settings" title="设置" aria-label="打开设置" aria-controls="settings" aria-expanded="false">${icon("settings")}</button>
    </nav>
    <div class="window-actions" role="group" aria-label="窗口控制" data-tauri-drag-region="false">
      <button class="window-button" data-action="window-minimize" title="最小化" aria-label="最小化">${icon("minimize")}</button>
      <button class="window-button" data-action="window-maximize" title="最大化" aria-label="最大化">${icon("maximize")}</button>
      <button class="window-button window-close" data-action="window-close" title="关闭窗口" aria-label="关闭窗口">${icon("close")}</button>
    </div>
  </header>
  <aside class="sidebar" aria-label="文件导航">
    <section class="nav-section"><div class="section-title"><h2>文件夹</h2><button class="icon-button small" data-action="folder" aria-label="选择文件夹">${icon("folder")}</button></div><div id="folder-controls" class="folder-controls" hidden><label class="sr-only" for="recent-folder">最近文件夹</label><select id="recent-folder"></select><button class="icon-button small" data-action="close-folder" aria-label="关闭文件夹" title="关闭文件夹，保留文章和最近记录">${icon("close")}</button></div><div id="file-tree"><p class="empty-small">打开文件夹，<br>让笔记保持原来的秩序。</p></div></section>
    <section class="nav-section recent-section"><div class="section-title"><h2>最近阅读</h2><span id="recent-count"></span></div><div id="recent-files"></div></section>
    <div class="sidebar-bottom">原文只读，安心阅读。</div>
  </aside>
  <main class="reading-pane" id="reading-pane" tabindex="0" aria-label="正文阅读区">
    <div class="search-bar" id="search-bar" hidden inert><div class="search-controls" role="search" aria-label="文内查找">
      <div class="search-field"><label for="search-input">${icon("search")}<span class="sr-only">搜索正文</span></label><input id="search-input" type="search" placeholder="查找这篇文章…" autocomplete="off" aria-describedby="search-count"><button class="text-button search-clear" data-action="clear-search" aria-label="清除搜索" hidden>清除</button><span id="search-count" role="status"></span></div>
      <div class="search-navigation" role="group" aria-label="搜索结果导航"><button class="icon-button small" data-action="previous-match" title="上一个结果 · Shift+Enter" aria-label="上一个结果" disabled>${icon("up")}</button><button class="icon-button small" data-action="next-match" title="下一个结果 · Enter" aria-label="下一个结果" disabled>${icon("down")}</button></div><button class="icon-button small" data-action="close-search" title="关闭搜索 · Esc" aria-label="关闭搜索">${icon("close")}</button>
    </div></div>
    <div class="welcome-view" id="welcome"><div class="welcome-book">${icon("book")}</div><h1>留一点时间，<br>给阅读。</h1><p>从一篇 Markdown 开始。<br>文字留在原处，目光回到此刻。</p><button class="primary large" data-action="open">${icon("file")}打开一篇文章<kbd>Ctrl O</kbd></button><div class="welcome-hint">也可以拖入文件，或<button class="text-button" data-action="folder">打开文件夹</button></div></div>
    <article class="prose" id="article" hidden></article>
    <div class="document-end" id="document-end" hidden><span></span>读到这里，刚刚好。<span></span><button class="text-button" data-action="top">回到开头</button></div>
    <section id="settings" class="settings" hidden aria-labelledby="settings-title"><button class="text-button back-button" data-action="settings">${icon("previous")}返回阅读</button><h1 id="settings-title" tabindex="-1">阅读与存储</h1><p class="settings-description">调整到适合你的节奏。</p>
      <fieldset class="reading-settings"><legend>阅读</legend>
        <div class="appearance-setting"><div id="appearance-label">外观<span class="setting-help">为不同的光线选择合适的纸面</span></div>
          <div id="theme-setting" class="theme-options" role="radiogroup" aria-labelledby="appearance-label">
            ${[["light", "浅色"], ["dark", "深色"], ["system", "跟随系统"]].map(([value, label]) => `<label class="theme-choice"><input class="sr-only" type="radio" name="theme" value="${value}"><span class="theme-preview theme-preview-${value}" aria-hidden="true"><span class="preview-rail"></span><span class="preview-sheet"><i></i><i></i><i></i></span><span class="theme-check">${icon("check")}</span></span><span class="theme-name">${label}</span></label>`).join("")}
          </div>
        </div>
        <label class="setting-row range-row"><span id="font-label">正文字号</span><span class="range-setting"><span class="range-scale"><input id="font-setting" type="range" min="14" max="28" aria-labelledby="font-label"><span class="range-limits" aria-hidden="true"><span>14</span><span>28</span></span></span><output id="font-value" for="font-setting"></output></span></label>
        <label class="setting-row range-row"><span id="width-label">正文宽度</span><span class="range-setting"><span class="range-scale"><input id="width-setting" type="range" min="560" max="1200" step="20" aria-labelledby="width-label"><span class="range-limits" aria-hidden="true"><span>560</span><span>1200</span></span></span><output id="width-value" for="width-setting"></output></span></label>
      </fieldset>
      <fieldset><legend>应用更新</legend><div id="update-controls"></div></fieldset>
      <fieldset><legend>应用数据</legend><p class="setting-help">阅读记录、偏好和浏览器缓存使用以下位置。原始文章与附件保持原位。</p><p id="data-root" class="path-value"></p><div id="storage-controls"></div></fieldset>
      <fieldset><legend>阅读记录</legend><div class="setting-row"><span>最近文件和阅读进度<span class="setting-help">清除后不影响原始文章或阅读偏好</span></span><button class="secondary" data-action="clear-history">清除记录</button></div></fieldset>
      <p class="version" id="version"></p>
    </section>
  </main>
  <aside class="outline" id="outline-panel" tabindex="-1" aria-label="文章目录"><div class="section-title"><h2>文章目录</h2><span id="heading-count"></span></div><nav id="outline-list"><p class="empty-small">打开文章后，<br>在这里找到方向。</p></nav><div class="outline-bottom"><span>阅读进度</span><span id="read-progress">—</span><div class="progress-track"><div id="progress-fill"></div></div></div></aside>
  <footer class="statusbar"><span class="status-left">本地文件<span class="status-dot"></span>只读</span><span id="document-status">准备好开始阅读</span><button class="text-button" id="close-document" data-action="close-document" hidden>关闭文章</button></footer>
  <div class="notice" id="notice" role="status" hidden inert><span id="notice-text"></span><button class="icon-button small" data-action="dismiss-notice" aria-label="关闭提示">${icon("close")}</button></div>
</div>`;

// showModal 会禁用对话框外的页面；临时移入同一标题栏，窗口控制可用而阅读工具继续锁定。
const toolbar = app.querySelector<HTMLElement>(".toolbar")!;
const toolbarHome = toolbar.parentElement!;
new MutationObserver((records) => {
  if (!records.some(({ target }) => target instanceof HTMLDialogElement)) return;
  const host = app.querySelector<HTMLDialogElement>("dialog[open]") ?? toolbarHome;
  if (toolbar.parentElement === host) return;
  host.prepend(toolbar);
  toolbar.querySelectorAll<HTMLElement>(".open-actions, .view-actions").forEach((group) => { group.inert = host !== toolbarHome; });
}).observe(app, { subtree: true, attributes: true, attributeFilter: ["open"] });

const pane = document.querySelector<HTMLElement>("#reading-pane")!;
const narrowLayout = matchMedia("(max-width: 950px)");
const reader = new Reader(document.querySelector<HTMLElement>("#article")!, pane);
// 界面序号丢弃过期 IPC；后台另有独立取消机制，避免文件切换竞态。
let request = 0;
// 目录读取不影响正文请求；切换或关闭后旧列表不能重新挂回界面。
let directoryEpoch = 0;
let folderBusy = false;
let session: Session;
let current: Omit<ReaderDocument, "blocks"> | null = null;
// 新打开请求等待已发出的关闭 IPC 完成，防止后台迟到的关闭清空新文章。
let closingDocument: Promise<void> | null = null;
let settingsOpen = false;
// 设置页隐藏正文时保留原锚点，文件变化延迟到返回阅读后处理。
let settingsPosition: ReadingPosition | undefined;
let refreshOnReturn = false;
// 正文尚在分批渲染时仍使用目标锚点，避免设置页记住渲染过程中的临时位置。
let restoringPosition: ReadingPosition | undefined;
let positionTimer = 0;
let searchTimer = 0;
// 只保留最后一次输入到可见高亮的耗时，不记录搜索词或文章内容。
let searchStart: number | null = null;
let refreshTimer = 0;
let scrollFrame = 0;
let noticeTimer = 0;
// 文章恢复时只清除已过期的文章提示，未保存状态及存储警告仍由用户确认。
let noticeScope: "app" | "document" = "app";
// 偏好写入串行，快速切换主题或字号时旧请求不能最后覆盖新设置。
let preferences: PreferenceStore;
let storageView: StorageSettings | null = null;
let updateView: UpdateSettings | null = null;
let readinessSent = false;
// 会话读取与定位各有完成边界；设置切换或新请求会使旧定位失去健康确认资格。
let healthySessionRequest = 0;
let positionEpoch = 0;

/** 正文与阅读位置恢复完成后确认健康，未确认前后台始终保留迁移源。 */
async function confirmReady(): Promise<void> {
  if (readinessSent) return;
  readinessSent = true;
  try { const notice = await invoke<string | null>("app_ready"); if (notice) message(notice, true); }
  catch (error) { readinessSent = false; message(`启动健康确认失败：${String(error)}`, true); }
}

/** 只让当前会话的最后一次成功定位确认健康，避免旧异步回调提前清理迁移源。 */
async function restoreReadingPosition(saved: ReadingPosition, ticket = request): Promise<void> {
  const epoch = ++positionEpoch;
  restoringPosition = saved;
  try {
    await reader.restorePosition(saved);
    if (ticket === request && epoch === positionEpoch && healthySessionRequest === ticket && !settingsOpen) void confirmReady();
  } catch (error) {
    if (ticket === request && epoch === positionEpoch) throw error;
  } finally {
    if (ticket === request && epoch === positionEpoch) restoringPosition = undefined;
  }
}

function message(text: string, persistent = false, scope: "app" | "document" = "app"): void {
  noticeScope = scope;
  document.querySelector("#notice-text")!.textContent = text;
  document.querySelector<HTMLElement>("#notice")!.hidden = false;
  document.querySelector<HTMLElement>("#notice")!.inert = false;
  clearTimeout(noticeTimer);
  if (!persistent) noticeTimer = window.setTimeout(hideNotice, 5500);
}

/** 视觉退场交给 CSS；焦点与隐藏语义立即生效，不等待动画回调。 */
function hideNotice(): void {
  const notice = document.querySelector<HTMLElement>("#notice")!;
  if (notice.contains(document.activeElement)) pane.focus({ preventScroll: true });
  notice.hidden = true;
  notice.inert = true;
}

/** 成功换文或关闭后收起旧文章提示，取消选择或打开失败不算恢复成功。 */
function clearDocumentNotice(): void {
  if (noticeScope !== "document") return;
  clearTimeout(noticeTimer); noticeScope = "app";
  hideNotice();
}

const displayPath = (path: string) => path.replace(/^\\\\\?\\/, "");
const filename = (path: string) => displayPath(path).split(/[\\/]/).pop() ?? path;
const sizeLabel = (bytes: number) => bytes < 1_000_000 ? `${(bytes / 1000).toFixed(1)} KB` : `${(bytes / 1_000_000).toFixed(1)} MB`;

/** 同时更新正文、主题和侧栏，不重新渲染文章。 */
function applyPreferences(): void {
  const p = preferences.snapshot;
  const dark = p.theme === "dark" || (p.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--body-size", `${p.fontSize}px`);
  document.documentElement.style.setProperty("--body-width", `${p.contentWidth}px`);
  app.classList.toggle("no-sidebar", !p.sidebar); app.classList.toggle("no-outline", !p.outline);
  document.querySelector('[data-action="theme"]')!.innerHTML = icon(dark ? "sun" : "moon");
  document.querySelectorAll<HTMLInputElement>('#theme-setting input').forEach((choice) => { choice.checked = choice.value === p.theme; });
  // 滑块沿用原生键盘语义，轨道填充和辅助朗读值与同一份已保存偏好同步。
  for (const [id, value] of [["font-setting", p.fontSize], ["width-setting", p.contentWidth]] as const) {
    const input = document.querySelector<HTMLInputElement>(`#${id}`)!;
    input.value = String(value);
    input.style.setProperty("--range-progress", `${(value - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100}%`);
    input.setAttribute("aria-valuetext", `${value} 像素`);
  }
  document.querySelector("#font-value")!.textContent = `${p.fontSize} px`;
  document.querySelector("#width-value")!.textContent = `${p.contentWidth} px`;
  document.querySelector('[data-action="sidebar"]')!.setAttribute("aria-pressed", String(p.sidebar));
  syncOutlineButton();
}

/** 小窗口使用临时目录抽屉，按钮反映实际可见性，桌面目录偏好仍单独保留。 */
function syncOutlineButton(): void {
  if (!preferences) return;
  const visible = !settingsOpen && (narrowLayout.matches ? app.classList.contains("outline-drawer") : preferences.snapshot.outline);
  const button = document.querySelector<HTMLButtonElement>('[data-action="outline"]')!;
  button.setAttribute("aria-pressed", String(visible)); button.setAttribute("aria-expanded", String(visible));
  const panel = document.querySelector<HTMLElement>("#outline-panel")!;
  if (!visible && panel.contains(document.activeElement)) button.focus({ preventScroll: true });
  panel.inert = !visible;
}

/** 栏宽过渡期间锁住 scrollTop，避免正文重排时滚动锚定把阅读位置带走。 */
let paneOffsetTimer = 0;
let paneOffsetHold: (() => void) | null = null;
function withStableOffset(change: () => void): void {
  const shell = document.querySelector<HTMLElement>(".app-shell")!;
  const root = document.querySelector("#app")!;
  const columns = () => `${root.classList.contains("no-sidebar")}:${root.classList.contains("no-outline")}`;
  const before = columns();
  const top = pane.scrollTop;
  shell.classList.add("pane-resizing");
  change();
  if (columns() === before) { if (!paneOffsetHold) shell.classList.remove("pane-resizing"); return; }
  if (paneOffsetHold) pane.removeEventListener("scroll", paneOffsetHold);
  if (pane.scrollTop !== top) pane.scrollTop = top;
  const hold = () => { if (pane.scrollTop !== top) pane.scrollTop = top; };
  paneOffsetHold = hold;
  pane.addEventListener("scroll", hold);
  window.clearTimeout(paneOffsetTimer);
  paneOffsetTimer = window.setTimeout(() => {
    pane.removeEventListener("scroll", hold);
    if (paneOffsetHold === hold) paneOffsetHold = null;
    if (pane.scrollTop !== top) pane.scrollTop = top;
    shell.classList.remove("pane-resizing");
  }, matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 240);
}

/** 合并滑块写入；失败提示持久化状态，不能伪装保存成功。 */
function changePreferences(patch: Partial<Preferences>): void {
  preferences.update(patch); applyPreferences();
}

async function refreshSession(): Promise<void> {
  session = await invoke<Session>("get_session");
}

/** 目录历史只供显式选择；关闭状态独立保留，路径始终通过文本节点显示。 */
function renderFolderControls(): void {
  const folders = session.state.folders;
  document.querySelector<HTMLElement>("#folder-controls")!.hidden = !folders.length;
  const select = document.querySelector<HTMLSelectElement>("#recent-folder")!;
  select.replaceChildren();
  const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "选择最近文件夹…"; placeholder.disabled = true; select.append(placeholder);
  for (const path of folders) {
    const option = document.createElement("option"); option.value = path; option.textContent = displayPath(path); select.append(option);
  }
  select.value = session.state.folderClosed ? "" : folders[0] ?? "";
  select.title = select.value ? displayPath(select.value) : "选择最近文件夹"; select.disabled = folderBusy;
  document.querySelector<HTMLButtonElement>('[data-action="close-folder"]')!.disabled = folderBusy || session.state.folderClosed || !folders.length;
  document.querySelectorAll<HTMLButtonElement>('[data-action="folder"]').forEach((button) => { button.disabled = folderBusy; });
}

function renderFolderView(): void {
  const epoch = ++directoryEpoch;
  renderFolderControls();
  const tree = document.querySelector<HTMLElement>("#file-tree")!;
  const path = !session.state.folderClosed && session.state.folders[0];
  if (path) void renderDirectory(path, tree, epoch);
  else tree.innerHTML = '<p class="empty-small">尚未打开文件夹。<br>可选择最近目录，或打开其他文件夹。</p>';
}

/** 串行提交目录变更，状态落盘后更新导航；失败保留可重试的当前目录。 */
async function folderAction(kind: "pick" | "recent" | "close", path?: string): Promise<void> {
  if (folderBusy) return;
  folderBusy = true; renderFolderControls();
  if (kind === "close") directoryEpoch++;
  try {
    const selected = await invoke<string | null>(kind === "pick" ? "pick_directory" : kind === "recent" ? "open_recent_directory" : "close_directory", kind === "recent" ? { path } : {});
    if (kind === "pick" && !selected) return;
    await refreshSession(); renderFolderView();
    if (kind !== "close") withStableOffset(() => changePreferences({ sidebar: true }));
  } catch (error) { renderFolderView(); throw error; }
  finally { folderBusy = false; renderFolderControls(); }
}

/** 最近列表最多展示有限条，用户可以显式查看其余有界历史。 */
function renderRecent(all = false): void {
  const list = document.querySelector<HTMLElement>("#recent-files")!; list.replaceChildren();
  document.querySelector("#recent-count")!.textContent = session.state.recent.length ? String(session.state.recent.length) : "";
  if (!session.state.recent.length) { list.innerHTML = '<p class="empty-small">读过的文章会留在这里。</p>'; return; }
  for (const item of session.state.recent.slice(0, all ? 1000 : 12)) {
    const button = document.createElement("button"); button.className = "file-row"; button.type = "button"; button.innerHTML = icon("file");
    const label = document.createElement("span"); label.textContent = filename(item.path); button.append(label); button.title = displayPath(item.path);
    button.classList.toggle("active", item.path === current?.path); button.onclick = () => { void openPath(item.path); }; list.append(button);
  }
  if (!all && session.state.recent.length > 12) {
    const button = document.createElement("button"); button.className = "text-button more-recents"; button.textContent = "查看全部记录";
    button.onclick = () => renderRecent(true); list.append(button);
  }
}

/** 每次只查询一层目录；失败保留重试操作，不递归扫描文章。 */
async function renderDirectory(path: string, container: HTMLElement, epoch: number): Promise<void> {
  container.textContent = "正在读取…";
  try {
    const entries = await invoke<DirectoryEntry[]>("read_directory", { path });
    if (epoch !== directoryEpoch || !container.isConnected) return;
    container.replaceChildren();
    if (!entries.length) { container.innerHTML = '<p class="empty-small">这里没有 Markdown 文件。</p>'; return; }
    for (const entry of entries) {
      const label = document.createElement("span"); label.textContent = entry.name;
      if (entry.directory) {
        const details = document.createElement("details"); details.className = "directory";
        const summary = document.createElement("summary"); summary.innerHTML = icon("chevron") + icon("folder"); summary.append(label); summary.title = displayPath(entry.path);
        const children = document.createElement("div"); children.className = "directory-children"; details.append(summary, children);
        let loaded = false; details.ontoggle = () => { if (details.open && !loaded && epoch === directoryEpoch) { loaded = true; void renderDirectory(entry.path, children, epoch); } }; container.append(details);
      } else {
        const button = document.createElement("button"); button.type = "button"; button.className = "file-row"; button.innerHTML = icon("file"); button.append(label); button.title = displayPath(entry.path);
        button.onclick = () => { void openPath(entry.path); }; container.append(button);
      }
    }
  } catch (error) {
    if (epoch !== directoryEpoch || !container.isConnected) return;
    container.textContent = `目录不可用：${String(error)}`;
    const retry = document.createElement("button"); retry.className = "text-button"; retry.textContent = "重试"; retry.onclick = () => { void renderDirectory(path, container, epoch); }; container.append(retry);
  }
}

function renderOutline(): void {
  const list = document.querySelector("#outline-list")!; list.replaceChildren();
  document.querySelector("#heading-count")!.textContent = current?.headings.length ? String(current.headings.length) : "";
  for (const heading of current?.headings ?? []) {
    const button = document.createElement("button"); button.type = "button"; button.className = "outline-link"; button.textContent = heading.title; button.title = heading.title;
    button.style.setProperty("--level", String(Math.min(heading.level - 1, 3))); button.dataset.heading = heading.id;
    button.onclick = () => {
      if (narrowLayout.matches) { app.classList.remove("outline-drawer"); syncOutlineButton(); pane.focus({ preventScroll: true }); }
      void reader.jumpHeading(heading.id);
    }; list.append(button);
  }
  if (!current?.headings.length) list.innerHTML = current
    ? '<p class="empty-small">这篇文章没有标题目录。</p>'
    : '<p class="empty-small">打开文章后，<br>在这里找到方向。</p>';
}

function position(): number { return Math.max(0, Math.min(1, pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight))); }

// 设置页复用滚动区域；安装前使用进入设置时捕获的位置，不能读取设置页的滚动进度。
async function persistPosition(captured?: ReadingPosition): Promise<void> {
  if (!current || (settingsOpen && !captured)) return;
  const path = current.path; const progress = captured ?? restoringPosition ?? reader.capturePosition();
  const item = session.state.recent.find((item) => item.path === path);
  if (!item || (item.position === progress.position && item.block === progress.block && item.offset === progress.offset)) return;
  await invoke("save_position", { path, ...progress });
  const latest = session.state.recent.find((item) => item.path === path); if (latest) Object.assign(latest, progress);
}

/** 旧请求不能覆盖新文章；首屏、全文展示与读盘解析分别可观测。 */
async function openPath(path: string, restore?: ReadingPosition, kind: "open" | "refresh" = "open"): Promise<void> {
  refreshOnReturn = false;
  const ticket = ++request; const start = performance.now();
  healthySessionRequest = 0; positionEpoch++;
  performance.clearMeasures("md:first-paint"); performance.clearMeasures("md:full-text");
  try {
    await closingDocument?.catch(() => {});
    if (ticket !== request) return;
    await persistPosition().catch((error) => message(`阅读进度未保存：${String(error)}`, true));
    if (ticket !== request) return;
    document.querySelector("#document-status")!.textContent = "正在打开…"; app.classList.add("opening");
    const ipcStart = performance.now();
    const result = await invoke<ReaderDocument>("open_document", { path });
    if (ticket !== request) return;
    // 请求发出后用户仍可能进入设置；自动刷新不能改变当前页面，返回阅读后重新读取最新内容。
    if (kind === "refresh" && settingsOpen) { refreshOnReturn = true; return; }
    clearDocumentNotice();
    // User Timing 供本机性能验收使用；记录有限数值，不保留路径或原文。
    const timing = { bytes: result.bytes, readMs: result.readMs, parseMs: result.parseMs, cacheMs: result.cacheMs, cacheHit: result.cacheHit, ipcMs: performance.now() - ipcStart };
    const saved = restore ?? session.state.recent.find((item) => item.path === result.path) ?? { position: 0, block: null, offset: 0, anchorHash: null };
    // 正文字符串只交给本次渲染；主界面不额外持有已经构建 DOM 的整篇 HTML。
    const { blocks, ...metadata } = result;
    current = metadata; if (settingsOpen) toggleSettings(false);
    document.querySelector<HTMLButtonElement>('[data-action="search"]')!.disabled = false;
    document.querySelector<HTMLElement>("#welcome")!.hidden = true; reader.article.hidden = false;
    document.querySelector<HTMLElement>("#close-document")!.hidden = false;
    document.querySelector("#document-name")!.textContent = filename(result.path);
    document.querySelector<HTMLElement>("#document-name")!.title = displayPath(result.path);
    document.querySelector("#document-description")!.textContent = sizeLabel(result.bytes);
    if (isTauri()) void getCurrentWindow().setTitle(`${filename(result.path)} · MD`);
    renderOutline();
    restoringPosition = saved;
    await reader.show({ ...metadata, blocks }, () => {
      if (ticket !== request) return;
      performance.measure("md:first-paint", { start, end: performance.now(), detail: timing });
      app.classList.remove("opening"); document.querySelector("#document-status")!.textContent = `${sizeLabel(metadata.bytes)} · 首屏 ${(performance.now() - start).toFixed(0)} ms`;
    });
    if (ticket !== request) return;
    performance.measure("md:full-text", { start, end: performance.now(), detail: timing });
    document.querySelector<HTMLElement>("#document-end")!.hidden = settingsOpen;
    await refreshSession(); if (ticket !== request) return;
    healthySessionRequest = ticket;
    renderRecent(); updateProgress();
    if (result.cacheError) message(`应用缓存未写入，正文仍可阅读：${result.cacheError}`, true, "document");
    if (!document.querySelector<HTMLElement>("#search-bar")!.hidden) reader.search(document.querySelector<HTMLInputElement>("#search-input")!.value);
    // 首屏绘制只用于计时；必要状态尚未恢复时不能授权后台清理迁移源。
    if (!settingsOpen) await restoreReadingPosition(saved, ticket);
  } catch (error) {
    if (ticket === request) { restoringPosition = undefined; message(`无法打开文章：${String(error)}`, true, "document"); document.querySelector("#document-status")!.textContent = "打开失败，可重新选择文件"; }
  } finally { if (ticket === request) { if (settingsOpen) restoringPosition = undefined; app.classList.remove("opening"); } }
}

/** 滚动只修改进度和目录状态，避免重建正文；磁盘写入另外合并。 */
function updateProgress(): void {
  if (!current || settingsOpen) return;
  const percent = Math.round(position() * 100); document.querySelector("#read-progress")!.textContent = `${percent}%`;
  document.querySelector<HTMLElement>("#progress-fill")!.style.width = `${percent}%`;
  reader.capturePosition();
}

function toggleSettings(refresh = true): void {
  positionEpoch++;
  if (!settingsOpen) settingsPosition = current ? restoringPosition ?? reader.capturePosition() : undefined;
  settingsOpen = !settingsOpen; app.classList.toggle("settings-open", settingsOpen);
  document.querySelector('[data-action="settings"]')!.setAttribute("aria-expanded", String(settingsOpen));
  document.querySelector<HTMLElement>("#settings")!.hidden = !settingsOpen; reader.article.hidden = settingsOpen || !current;
  document.querySelector<HTMLElement>("#welcome")!.hidden = settingsOpen || !!current;
  document.querySelector<HTMLElement>("#document-end")!.hidden = settingsOpen || !current;
  if (settingsOpen) {
    app.classList.remove("outline-drawer"); syncOutlineButton();
    pane.scrollTop = 0; document.querySelector<HTMLElement>("#settings-title")!.focus({ preventScroll: true });
    void import("./storage-settings").then(({ StorageSettings }) => {
      storageView ??= new StorageSettings(document.querySelector<HTMLElement>("#storage-controls")!, () => preferences.snapshot, changePreferences, () => preferences.flush(), message);
      if (settingsOpen) void storageView.activate();
    }).catch((error) => message(`无法打开存储设置：${String(error)}`, true));
    void import("./update-settings").then(({ UpdateSettings }) => {
      updateView ??= new UpdateSettings(document.querySelector<HTMLElement>("#update-controls")!, async () => { await persistPosition(settingsPosition); await preferences.flush(); });
      if (settingsOpen) void updateView.activate();
    }).catch((error) => message(`无法打开更新设置：${String(error)}`, true));
  } else {
    storageView?.deactivate();
    updateView?.deactivate();
    pane.focus({ preventScroll: true });
    const saved = settingsPosition; settingsPosition = undefined;
    if (refresh && refreshOnReturn && current) { refreshOnReturn = false; void openPath(current.path, saved, "refresh"); }
    else if (refresh && saved) {
      void restoreReadingPosition(saved)
        .catch((error) => message(`阅读位置恢复失败：${String(error)}`, true));
    }
  }
  syncOutlineButton();
  const searchBar = document.querySelector<HTMLElement>("#search-bar")!;
  searchBar.inert = settingsOpen || searchBar.hidden;
  document.querySelector('[data-action="search"]')!.setAttribute("aria-expanded", String(!searchBar.inert));
}

function toggleSearch(show: boolean): void {
  if (show && !current) return;
  clearTimeout(searchTimer); searchStart = null;
  const bar = document.querySelector<HTMLElement>("#search-bar")!;
  bar.hidden = !show; bar.inert = !show;
  document.querySelector('[data-action="search"]')!.setAttribute("aria-expanded", String(show));
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  document.querySelector<HTMLButtonElement>('[data-action="clear-search"]')!.hidden = !input.value;
  if (show) { if (settingsOpen) toggleSettings(); reader.search(input.value); input.focus({ preventScroll: true }); input.select(); }
  else { reader.search(""); document.querySelector("#search-count")!.textContent = ""; pane.focus({ preventScroll: true }); }
}

/** 关闭成功才清理阅读界面；旧关闭不能覆盖此后发起的新打开请求。 */
function closeDocument(): Promise<void> {
  if (!current) return closingDocument ?? Promise.resolve();
  const pending = closingDocument;
  const ticket = ++request;
  healthySessionRequest = 0; positionEpoch++;
  clearTimeout(refreshTimer);
  const closing: Promise<void> = (async () => {
    // 重复关闭仍是新的用户意图；串行完成原生关闭，并取消中间排队的打开请求。
    await pending?.catch(() => {});
    await persistPosition();
    if (ticket !== request) return;
    await invoke("close_document");
    if (ticket !== request) return;
    clearDocumentNotice();
    if (settingsOpen) toggleSettings(false);
    clearTimeout(positionTimer); clearTimeout(searchTimer);
    searchStart = null; restoringPosition = undefined; settingsPosition = undefined; refreshOnReturn = false;
    const input = document.querySelector<HTMLInputElement>("#search-input")!;
    input.value = ""; reader.search(""); reader.dispose(); reader.article.replaceChildren(); current = null;
    document.querySelector<HTMLElement>("#search-bar")!.hidden = true;
    document.querySelector<HTMLElement>("#search-bar")!.inert = true;
    document.querySelector('[data-action="search"]')!.setAttribute("aria-expanded", "false");
    document.querySelector("#search-count")!.textContent = "";
    app.classList.remove("opening", "outline-drawer");
    syncOutlineButton(); document.querySelector<HTMLButtonElement>('[data-action="search"]')!.disabled = true;
    reader.article.hidden = true; document.querySelector<HTMLElement>("#document-end")!.hidden = true;
    document.querySelector<HTMLElement>("#welcome")!.hidden = false; document.querySelector<HTMLElement>("#close-document")!.hidden = true;
    document.querySelector("#document-name")!.textContent = "开始阅读"; document.querySelector("#document-name")!.removeAttribute("title");
    document.querySelector("#document-description")!.textContent = "本地 Markdown";
    document.querySelector("#document-status")!.textContent = "准备好开始阅读";
    document.querySelector("#read-progress")!.textContent = "—"; document.querySelector<HTMLElement>("#progress-fill")!.style.width = "0";
    if (isTauri()) void getCurrentWindow().setTitle("MD · Markdown 阅读器");
    renderOutline(); renderRecent(); pane.scrollTop = 0; pane.focus({ preventScroll: true });
  })().finally(() => { if (closingDocument === closing) closingDocument = null; });
  closingDocument = closing;
  return closing;
}

/** 按实际窗口状态更新还原图标，也覆盖双击标题栏、系统快捷键等外部尺寸变化。 */
async function syncWindowState(): Promise<void> {
  try {
    const maximized = await getCurrentWindow().isMaximized();
    const button = document.querySelector<HTMLButtonElement>('[data-action="window-maximize"]')!;
    button.innerHTML = icon(maximized ? "restore" : "maximize");
    button.title = maximized ? "还原窗口" : "最大化";
    button.setAttribute("aria-label", button.title);
  } catch (error) { message(`无法读取窗口状态：${String(error)}`, true); }
}

/** 工具栏和空状态共用动作，窗口关闭仍经过原生关闭事件中的保存保护。 */
async function action(name: string): Promise<void> {
  try {
    if (name === "window-minimize") await getCurrentWindow().minimize();
    else if (name === "window-maximize") { await getCurrentWindow().toggleMaximize(); await syncWindowState(); }
    else if (name === "window-close") await getCurrentWindow().close();
    else if (name === "open") { const path = await invoke<string | null>("pick_file"); if (path) await openPath(path); }
    else if (name === "folder") await folderAction("pick");
    else if (name === "close-folder") await folderAction("close");
    else if (name === "search") toggleSearch(true);
    else if (name === "close-search") toggleSearch(false);
    else if (name === "clear-search") {
      const input = document.querySelector<HTMLInputElement>("#search-input")!;
      input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus({ preventScroll: true });
    }
    else if (name === "previous-match") reader.jumpMatch(-1);
    else if (name === "next-match") reader.jumpMatch(1);
    else if (name === "sidebar") withStableOffset(() => changePreferences({ sidebar: !preferences.snapshot.sidebar }));
    else if (name === "outline") {
      if (settingsOpen) toggleSettings();
      if (narrowLayout.matches) {
        app.classList.toggle("outline-drawer"); syncOutlineButton();
        if (app.classList.contains("outline-drawer")) (document.querySelector<HTMLElement>('.outline-link[aria-current="location"]') ?? document.querySelector<HTMLElement>(".outline-link") ?? document.querySelector<HTMLElement>("#outline-panel"))!.focus({ preventScroll: true });
      } else withStableOffset(() => changePreferences({ outline: !preferences.snapshot.outline }));
    }
    else if (name === "theme") changePreferences({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" });
    else if (name === "settings") { if (!settingsOpen) await persistPosition(); toggleSettings(); }
    else if (name === "top") pane.scrollTo({ top: 0 });
    else if (name === "dismiss-notice") hideNotice();
    else if (name === "clear-history") { await invoke("clear_history"); await refreshSession(); renderRecent(); renderFolderView(); message("最近记录已清除，原始文章与偏好已保留。"); }
    else if (name === "close-document") await closeDocument();
  } catch (error) { message(String(error), true, name === "close-document" ? "document" : "app"); }
}

app.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-action]"); if (target) void action(target.dataset.action!);
});
document.querySelector("#recent-folder")!.addEventListener("change", (event) => {
  const path = (event.target as HTMLSelectElement).value;
  if (path) void folderAction("recent", path).catch((error) => message(String(error), true));
});
document.querySelector("#search-input")!.addEventListener("input", () => {
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  document.querySelector<HTMLButtonElement>('[data-action="clear-search"]')!.hidden = !input.value;
  clearTimeout(searchTimer); searchStart = input.value ? performance.now() : null;
  // 清空立即移除高亮；非空输入仍合并处理，旧计时器不能重新提交已清除的词。
  if (!input.value) { reader.search(""); return; }
  searchTimer = window.setTimeout(() => reader.search(input.value), 40);
});
document.querySelector("#search-input")!.addEventListener("keydown", (event) => {
  if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); reader.jumpMatch((event as KeyboardEvent).shiftKey ? -1 : 1); }
});
document.querySelector("#theme-setting")!.addEventListener("change", (event) => {
  const choice = event.target as HTMLInputElement;
  if (choice.checked) changePreferences({ theme: choice.value as Preferences["theme"] });
});
document.querySelector("#font-setting")!.addEventListener("input", (event) => changePreferences({ fontSize: Number((event.target as HTMLInputElement).value) }));
document.querySelector("#width-setting")!.addEventListener("input", (event) => changePreferences({ contentWidth: Number((event.target as HTMLInputElement).value) }));
pane.addEventListener("scroll", () => {
  // content-visibility 的块在首帧进入布局，下一帧再校准目录，避免高亮停在前一段。
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => {
    updateProgress(); scrollFrame = requestAnimationFrame(() => { updateProgress(); scrollFrame = 0; });
  });
  clearTimeout(positionTimer); positionTimer = window.setTimeout(() => { void persistPosition().catch((error) => message(String(error), true)); }, 700);
}, { passive: true });
// 浏览器完成自动跳过块的布局后可能校正滚动锚点；在稳定位置同步目录。
pane.addEventListener("scrollend", updateProgress);
reader.article.addEventListener("contentvisibilityautostatechange", () => {
  if (!scrollFrame) scrollFrame = requestAnimationFrame(() => { updateProgress(); scrollFrame = 0; });
}, true);
document.addEventListener("keydown", (event) => {
  // 模态确认使用自己的 Escape 和焦点规则，后台快捷键不能关闭设置或打开其他页面。
  if (document.querySelector("dialog[open]")) {
    if ((event.ctrlKey && ["o", "f", "w"].includes(event.key.toLowerCase())) || event.key === "F5") event.preventDefault();
    return;
  }
  if (event.ctrlKey && event.key.toLowerCase() === "o") { event.preventDefault(); void action(event.shiftKey ? "folder" : "open"); }
  if (event.ctrlKey && event.key.toLowerCase() === "f") { event.preventDefault(); toggleSearch(true); }
  if (event.ctrlKey && event.key.toLowerCase() === "w") { event.preventDefault(); void action("close-document"); }
  if (event.key === "Escape") {
    if (app.classList.contains("outline-drawer")) {
      app.classList.remove("outline-drawer"); syncOutlineButton();
      document.querySelector<HTMLElement>('[data-action="outline"]')!.focus({ preventScroll: true });
    } else if (settingsOpen) toggleSettings();
    else if (!document.querySelector<HTMLElement>("#search-bar")!.hidden) toggleSearch(false);
  }
  if (event.key === "F5" && current) { event.preventDefault(); if (settingsOpen) refreshOnReturn = true; else void openPath(current.path, reader.capturePosition(), "refresh"); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (session) applyPreferences(); });
narrowLayout.addEventListener("change", () => { app.classList.remove("outline-drawer"); if (session) syncOutlineButton(); });
reader.onMessage = (text) => message(text, false, "document");
reader.onHeading = (id) => {
  const previous = document.querySelector<HTMLElement>('.outline-link[aria-current="location"]');
  previous?.classList.remove("active"); previous?.removeAttribute("aria-current");
  const next = document.querySelector<HTMLElement>(`.outline-link[data-heading="${CSS.escape(id)}"]`);
  next?.classList.add("active"); next?.setAttribute("aria-current", "location");
};
reader.onSearch = (count, index, truncated) => {
  document.querySelector("#search-count")!.textContent = !document.querySelector<HTMLInputElement>("#search-input")!.value ? "" : count ? `${index + 1} / ${count}${truncated ? "+" : ""}` : "无匹配";
  for (const action of ["previous-match", "next-match"]) document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.disabled = count === 0;
  const start = searchStart;
  if (start !== null) requestAnimationFrame(() => requestAnimationFrame(() => {
    if (searchStart !== start) return;
    performance.clearMeasures("md:search-painted"); performance.measure("md:search-painted", { start, end: performance.now() }); searchStart = null;
  }));
};
reader.onLink = (index) => {
  if (!current) return;
  const url = current.links[index];
  if (url.startsWith("#")) {
    let fragment = url.slice(1); try { fragment = decodeURIComponent(fragment); } catch { /* 无效百分号保持原样。 */ }
    const heading = current.headings.find((item) => item.id === fragment || item.title === fragment || item.title.toLowerCase().replace(/\s+/g, "-") === fragment);
    if (heading) void reader.jumpHeading(heading.id); else message("没有找到对应标题。");
  } else void invoke<string | null>("follow_link", { revision: current.revision, index }).then((path) => { if (path) void openPath(path); }, (error) => message(String(error), true));
};

/** 先订阅原生事件再恢复文章，避免窗口初始化期间丢失打开请求。 */
async function start(): Promise<void> {
  if (!isTauri()) {
    message("请运行 npm run desktop 从桌面程序打开；当前为界面预览。", true);
    document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; }); return;
  }
  try {
    await listen<string>("open-path", (event) => { void openPath(event.payload); });
    await listen<string>("state-error", (event) => message(`状态未保存：${event.payload}`, true));
    await listen<string>("document-changed", (event) => {
      if (event.payload !== current?.path) return;
      clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => {
        if (current?.path !== event.payload) return;
        if (settingsOpen) refreshOnReturn = true;
        else void openPath(current.path, reader.capturePosition(), "refresh");
      }, 250);
    });
    session = await invoke<Session>("get_session");
    preferences = new PreferenceStore(session.state.preferences, (preferences) => invoke<void>("save_preferences", { preferences }), (error) => message(`设置未保存：${String(error)}`, true));
    // Tauri 会等待异步处理后销毁窗口；成功时放行，失败或重复请求才阻止关闭。
    let closing = false;
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (closing) { event.preventDefault(); return; } closing = true;
      try { await preferences.flush(); await persistPosition(); }
      catch (error) { event.preventDefault(); closing = false; message(`关闭前保存失败，请重试：${String(error)}`, true); }
    });
    // 窗口状态不阻塞打开事件订阅和会话恢复，订阅失败也不阻止阅读。
    void getCurrentWindow().onResized(() => { void syncWindowState(); }).then(syncWindowState)
      .catch((error) => message(`无法监听窗口尺寸：${String(error)}`, true));
    applyPreferences(); renderRecent();
    document.querySelector("#data-root")!.textContent = displayPath(session.root);
    document.querySelector("#version")!.textContent = `MD ${session.version} · 本地 Markdown 阅读器`;
    if (session.state.lastFile) await openPath(session.state.lastFile);
    else {
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      void confirmReady();
    }
    renderFolderView();
  } catch (error) { message(`无法恢复会话：${String(error)}`, true); }
}

void start();
