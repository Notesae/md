import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { DirectoryEntry, Preferences, ReaderDocument, ReadingPosition, Session } from "./types";
import { Reader } from "./reader";
import { icon } from "./icons";
import type { StorageSettings } from "./storage-settings";
import { PreferenceStore } from "./preferences";
import "./styles.css";

// 主窗口复用阅读视图和设置页，所有文件名称与路径用文本节点呈现。
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<div class="app-shell">
  <header class="toolbar">
    <div class="brand"><span class="wordmark">md<span>·</span></span><span class="brand-name">阅读器</span></div>
    <div class="open-actions"><button class="primary" data-action="open">${icon("file")}<span>打开文件</span></button><button class="icon-button" data-action="folder" title="打开文件夹 · Ctrl+Shift+O" aria-label="打开文件夹">${icon("folder")}</button></div>
    <div class="document-name"><span id="document-name">开始阅读</span><span id="document-description">本地 Markdown</span></div>
    <nav class="view-actions" aria-label="阅读工具">
      <button class="icon-button" data-action="search" title="搜索正文 · Ctrl+F" aria-label="搜索正文">${icon("search")}</button>
      <button class="icon-button" data-action="sidebar" title="文件侧栏" aria-label="切换文件侧栏">${icon("sidebar")}</button>
      <button class="icon-button" data-action="outline" title="文章目录" aria-label="切换文章目录">${icon("outline")}</button>
      <button class="icon-button" data-action="theme" title="切换主题" aria-label="切换主题">${icon("moon")}</button>
      <button class="icon-button" data-action="settings" title="设置" aria-label="打开设置">${icon("settings")}</button>
    </nav>
  </header>
  <aside class="sidebar" aria-label="文件导航">
    <section class="nav-section"><div class="section-title"><h2>文件夹</h2><button class="icon-button small" data-action="folder" aria-label="选择文件夹">${icon("folder")}</button></div><div id="file-tree"><p class="empty-small">打开文件夹，<br>让笔记保持原来的秩序。</p></div></section>
    <section class="nav-section recent-section"><div class="section-title"><h2>最近阅读</h2><span id="recent-count"></span></div><div id="recent-files"></div></section>
    <div class="sidebar-bottom">原文只读，安心阅读。</div>
  </aside>
  <main class="reading-pane" id="reading-pane" tabindex="0" aria-label="正文阅读区">
    <div class="search-bar" id="search-bar" hidden><label for="search-input">${icon("search")}<span class="sr-only">搜索正文</span></label><input id="search-input" type="search" placeholder="查找这篇文章…" autocomplete="off"><span id="search-count" role="status"></span><button class="icon-button small" data-action="previous-match" aria-label="上一个结果">${icon("previous")}</button><button class="icon-button small" data-action="next-match" aria-label="下一个结果">${icon("next")}</button><button class="icon-button small" data-action="close-search" aria-label="关闭搜索">${icon("close")}</button></div>
    <div class="welcome-view" id="welcome"><div class="welcome-book">${icon("book")}</div><h1>留一点时间，<br>给阅读。</h1><p>从一篇 Markdown 开始。<br>文字留在原处，目光回到此刻。</p><button class="primary large" data-action="open">${icon("file")}打开一篇文章<kbd>Ctrl O</kbd></button><div class="welcome-hint">也可以拖入文件，或<button class="text-button" data-action="folder">打开文件夹</button></div></div>
    <article class="prose" id="article" hidden></article>
    <div class="document-end" id="document-end" hidden><span></span>读到这里，刚刚好。<span></span><button class="text-button" data-action="top">回到开头</button></div>
    <section id="settings" class="settings" hidden aria-labelledby="settings-title"><button class="text-button back-button" data-action="settings">${icon("previous")}返回阅读</button><h1 id="settings-title" tabindex="-1">阅读与存储</h1><p class="settings-description">调整到适合你的节奏。</p>
      <fieldset><legend>阅读</legend>
        <label class="setting-row"><span>外观<span class="setting-help">为不同的光线选择合适的纸面</span></span><select id="theme-setting"><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label>
        <label class="setting-row"><span>正文字号</span><span class="range-setting"><input id="font-setting" type="range" min="14" max="28"><output id="font-value"></output></span></label>
        <label class="setting-row"><span>正文宽度</span><span class="range-setting"><input id="width-setting" type="range" min="560" max="1200" step="20"><output id="width-value"></output></span></label>
      </fieldset>
      <fieldset><legend>应用数据</legend><p class="setting-help">阅读记录、偏好和浏览器缓存使用以下位置。原始文章与附件保持原位。</p><p id="data-root" class="path-value"></p><div id="storage-controls"></div></fieldset>
      <fieldset><legend>阅读记录</legend><div class="setting-row"><span>最近文件和阅读进度<span class="setting-help">清除后不影响原始文章或阅读偏好</span></span><button class="secondary" data-action="clear-history">清除记录</button></div></fieldset>
      <p class="version" id="version"></p>
    </section>
  </main>
  <aside class="outline" aria-label="文章目录"><div class="section-title"><h2>文章目录</h2><span id="heading-count"></span></div><nav id="outline-list"><p class="empty-small">打开文章后，<br>在这里找到方向。</p></nav><div class="outline-bottom"><span>阅读进度</span><span id="read-progress">—</span><div class="progress-track"><div id="progress-fill"></div></div></div></aside>
  <footer class="statusbar"><span class="status-left">本地文件<span class="status-dot"></span>只读</span><span id="document-status">准备好开始阅读</span><button class="text-button" id="close-document" data-action="close-document" hidden>关闭文章</button></footer>
  <div class="notice" id="notice" role="status" hidden><span id="notice-text"></span><button class="icon-button small" data-action="dismiss-notice" aria-label="关闭提示">${icon("close")}</button></div>
</div>`;

const pane = document.querySelector<HTMLElement>("#reading-pane")!;
const reader = new Reader(document.querySelector<HTMLElement>("#article")!, pane);
// 界面序号丢弃过期 IPC；后台另有独立取消机制，避免文件切换竞态。
let request = 0;
let session: Session;
let current: ReaderDocument | null = null;
let settingsOpen = false;
// 设置页隐藏正文时保留原锚点，文件变化延迟到返回阅读后处理。
let settingsPosition: ReadingPosition | undefined;
let refreshOnReturn = false;
let positionTimer = 0;
let searchTimer = 0;
let refreshTimer = 0;
let scrollFrame = 0;
let noticeTimer = 0;
// 偏好写入串行，快速切换主题或字号时旧请求不能最后覆盖新设置。
let preferences: PreferenceStore;
let storageView: StorageSettings | null = null;
let readinessSent = false;

/** 首屏出现后确认新数据位置健康，未确认前后台始终保留迁移源。 */
async function confirmReady(): Promise<void> {
  if (readinessSent) return;
  readinessSent = true;
  try { const notice = await invoke<string | null>("app_ready"); if (notice) message(notice, true); }
  catch (error) { message(`启动健康确认失败：${String(error)}`, true); }
}

function message(text: string, persistent = false): void {
  document.querySelector("#notice-text")!.textContent = text;
  document.querySelector<HTMLElement>("#notice")!.hidden = false;
  clearTimeout(noticeTimer);
  if (!persistent) noticeTimer = window.setTimeout(() => { document.querySelector<HTMLElement>("#notice")!.hidden = true; }, 5500);
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
  document.querySelector<HTMLSelectElement>("#theme-setting")!.value = p.theme;
  document.querySelector<HTMLInputElement>("#font-setting")!.value = String(p.fontSize);
  document.querySelector("#font-value")!.textContent = `${p.fontSize} px`;
  document.querySelector<HTMLInputElement>("#width-setting")!.value = String(p.contentWidth);
  document.querySelector("#width-value")!.textContent = `${p.contentWidth} px`;
  document.querySelector('[data-action="sidebar"]')!.setAttribute("aria-pressed", String(p.sidebar));
  document.querySelector('[data-action="outline"]')!.setAttribute("aria-pressed", String(p.outline));
}

/** 合并滑块写入；失败提示持久化状态，不能伪装保存成功。 */
function changePreferences(patch: Partial<Preferences>): void {
  preferences.update(patch); applyPreferences();
}

async function refreshSession(): Promise<void> {
  session = await invoke<Session>("get_session");
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
async function renderDirectory(path: string, container: HTMLElement): Promise<void> {
  container.textContent = "正在读取…";
  try {
    const entries = await invoke<DirectoryEntry[]>("read_directory", { path }); container.replaceChildren();
    if (!entries.length) { container.innerHTML = '<p class="empty-small">这里没有 Markdown 文件。</p>'; return; }
    for (const entry of entries) {
      const label = document.createElement("span"); label.textContent = entry.name;
      if (entry.directory) {
        const details = document.createElement("details"); details.className = "directory";
        const summary = document.createElement("summary"); summary.innerHTML = icon("chevron") + icon("folder"); summary.append(label); summary.title = displayPath(entry.path);
        const children = document.createElement("div"); children.className = "directory-children"; details.append(summary, children);
        let loaded = false; details.ontoggle = () => { if (details.open && !loaded) { loaded = true; void renderDirectory(entry.path, children); } }; container.append(details);
      } else {
        const button = document.createElement("button"); button.type = "button"; button.className = "file-row"; button.innerHTML = icon("file"); button.append(label); button.title = displayPath(entry.path);
        button.onclick = () => { void openPath(entry.path); }; container.append(button);
      }
    }
  } catch (error) {
    container.textContent = `目录不可用：${String(error)}`;
    const retry = document.createElement("button"); retry.className = "text-button"; retry.textContent = "重试"; retry.onclick = () => { void renderDirectory(path, container); }; container.append(retry);
  }
}

function renderOutline(): void {
  const list = document.querySelector("#outline-list")!; list.replaceChildren();
  document.querySelector("#heading-count")!.textContent = current?.headings.length ? String(current.headings.length) : "";
  for (const heading of current?.headings ?? []) {
    const button = document.createElement("button"); button.type = "button"; button.className = "outline-link"; button.textContent = heading.title; button.title = heading.title;
    button.style.setProperty("--level", String(Math.min(heading.level - 1, 3))); button.dataset.heading = heading.id;
    button.onclick = () => { void reader.jumpHeading(heading.id); }; list.append(button);
  }
  if (!current?.headings.length) list.innerHTML = '<p class="empty-small">这篇文章没有标题目录。</p>';
}

function position(): number { return Math.max(0, Math.min(1, pane.scrollTop / Math.max(1, pane.scrollHeight - pane.clientHeight))); }

async function persistPosition(): Promise<void> {
  if (!current || settingsOpen) return;
  const path = current.path; const progress = reader.capturePosition();
  const item = session.state.recent.find((item) => item.path === path);
  if (!item || (item.position === progress.position && item.block === progress.block && item.offset === progress.offset)) return;
  await invoke("save_position", { path, ...progress });
  const latest = session.state.recent.find((item) => item.path === path); if (latest) Object.assign(latest, progress);
}

/** 旧请求不能覆盖新文章；首屏、全文展示与读盘解析分别可观测。 */
async function openPath(path: string, restore?: ReadingPosition): Promise<void> {
  refreshOnReturn = false;
  const ticket = ++request; const start = performance.now();
  try {
    await persistPosition().catch((error) => message(`阅读进度未保存：${String(error)}`, true));
    if (ticket !== request) return;
    document.querySelector("#document-status")!.textContent = "正在打开…"; app.classList.add("opening");
    const result = await invoke<ReaderDocument>("open_document", { path });
    if (ticket !== request) return;
    const saved = restore ?? session.state.recent.find((item) => item.path === result.path) ?? { position: 0, block: null, offset: 0, anchorHash: null };
    current = result; if (settingsOpen) toggleSettings(false);
    document.querySelector<HTMLElement>("#welcome")!.hidden = true; reader.article.hidden = false;
    document.querySelector<HTMLElement>("#close-document")!.hidden = false;
    document.querySelector("#document-name")!.textContent = filename(result.path);
    document.querySelector<HTMLElement>("#document-name")!.title = displayPath(result.path);
    document.querySelector("#document-description")!.textContent = `${sizeLabel(result.bytes)} · Markdown`;
    if (isTauri()) void getCurrentWindow().setTitle(`${filename(result.path)} · MD`);
    renderOutline();
    await reader.show(result, () => {
      if (ticket !== request) return;
      app.classList.remove("opening"); document.querySelector("#document-status")!.textContent = `${sizeLabel(result.bytes)} · 首屏 ${(performance.now() - start).toFixed(0)} ms`;
      void confirmReady();
    });
    if (ticket !== request) return;
    document.querySelector<HTMLElement>("#document-end")!.hidden = false; await reader.restorePosition(saved);
    await refreshSession(); if (ticket !== request) return;
    renderRecent(); updateProgress();
    if (result.cacheError) message(`应用缓存未写入，正文仍可阅读：${result.cacheError}`, true);
    if (!document.querySelector<HTMLElement>("#search-bar")!.hidden) reader.search(document.querySelector<HTMLInputElement>("#search-input")!.value);
  } catch (error) {
    if (ticket === request) { message(`无法打开文章：${String(error)}`, true); document.querySelector("#document-status")!.textContent = "打开失败，可重新选择文件"; }
  } finally { if (ticket === request) app.classList.remove("opening"); }
}

/** 滚动只修改进度和目录状态，避免重建正文；磁盘写入另外合并。 */
function updateProgress(): void {
  if (!current || settingsOpen) return;
  const percent = Math.round(position() * 100); document.querySelector("#read-progress")!.textContent = `${percent}%`;
  document.querySelector<HTMLElement>("#progress-fill")!.style.width = `${percent}%`;
  reader.capturePosition();
}

function toggleSettings(refresh = true): void {
  if (!settingsOpen) settingsPosition = current ? reader.capturePosition() : undefined;
  settingsOpen = !settingsOpen; app.classList.toggle("settings-open", settingsOpen);
  document.querySelector<HTMLElement>("#settings")!.hidden = !settingsOpen; reader.article.hidden = settingsOpen || !current;
  document.querySelector<HTMLElement>("#welcome")!.hidden = settingsOpen || !!current;
  document.querySelector<HTMLElement>("#document-end")!.hidden = settingsOpen || !current;
  if (settingsOpen) {
    pane.scrollTop = 0; document.querySelector<HTMLElement>("#settings-title")!.focus();
    void import("./storage-settings").then(({ StorageSettings }) => {
      storageView ??= new StorageSettings(document.querySelector<HTMLElement>("#storage-controls")!, () => preferences.snapshot, changePreferences, () => preferences.flush(), message);
      if (settingsOpen) void storageView.activate();
    }).catch((error) => message(`无法打开存储设置：${String(error)}`, true));
  } else {
    storageView?.deactivate();
    const saved = settingsPosition; settingsPosition = undefined;
    if (refresh && refreshOnReturn && current) { refreshOnReturn = false; void openPath(current.path, saved); }
    else if (refresh && saved) void reader.restorePosition(saved);
  }
}

function toggleSearch(show: boolean): void {
  document.querySelector<HTMLElement>("#search-bar")!.hidden = !show;
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  if (show) { if (settingsOpen) toggleSettings(); input.focus(); input.select(); }
  else { reader.search(""); pane.focus({ preventScroll: true }); }
}

/** 工具栏和空状态共用动作，所有打开入口都走同一个授权及请求处理流程。 */
async function action(name: string): Promise<void> {
  try {
    if (name === "open") { const path = await invoke<string | null>("pick_file"); if (path) await openPath(path); }
    else if (name === "folder") { const path = await invoke<string | null>("pick_directory"); if (path) { await refreshSession(); await renderDirectory(path, document.querySelector<HTMLElement>("#file-tree")!); changePreferences({ sidebar: true }); } }
    else if (name === "search") toggleSearch(true);
    else if (name === "close-search") toggleSearch(false);
    else if (name === "previous-match") reader.jumpMatch(-1);
    else if (name === "next-match") reader.jumpMatch(1);
    else if (name === "sidebar") changePreferences({ sidebar: !preferences.snapshot.sidebar });
    else if (name === "outline") {
      if (matchMedia("(max-width: 950px)").matches) {
        const visible = app.classList.toggle("outline-drawer");
        document.querySelector('[data-action="outline"]')!.setAttribute("aria-pressed", String(visible));
      } else changePreferences({ outline: !preferences.snapshot.outline });
    }
    else if (name === "theme") changePreferences({ theme: document.documentElement.dataset.theme === "dark" ? "light" : "dark" });
    else if (name === "settings") { if (!settingsOpen) await persistPosition(); toggleSettings(); }
    else if (name === "top") pane.scrollTo({ top: 0 });
    else if (name === "dismiss-notice") document.querySelector<HTMLElement>("#notice")!.hidden = true;
    else if (name === "clear-history") { await invoke("clear_history"); await refreshSession(); renderRecent(); message("最近记录已清除，原始文章与偏好已保留。"); }
    else if (name === "close-document") {
      await persistPosition(); request++; await invoke("close_document"); reader.dispose(); reader.article.replaceChildren(); current = null;
      reader.article.hidden = true; document.querySelector<HTMLElement>("#document-end")!.hidden = true;
      document.querySelector<HTMLElement>("#welcome")!.hidden = false; document.querySelector<HTMLElement>("#close-document")!.hidden = true;
      document.querySelector("#document-name")!.textContent = "开始阅读"; document.querySelector("#document-description")!.textContent = "本地 Markdown";
      document.querySelector("#document-status")!.textContent = "准备好开始阅读"; renderOutline(); renderRecent();
    }
  } catch (error) { message(String(error), true); }
}

app.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLElement>("[data-action]"); if (target) void action(target.dataset.action!);
});
document.querySelector("#search-input")!.addEventListener("input", () => {
  clearTimeout(searchTimer); searchTimer = window.setTimeout(() => reader.search(document.querySelector<HTMLInputElement>("#search-input")!.value), 40);
});
document.querySelector("#search-input")!.addEventListener("keydown", (event) => {
  if ((event as KeyboardEvent).key === "Enter") { event.preventDefault(); reader.jumpMatch((event as KeyboardEvent).shiftKey ? -1 : 1); }
});
document.querySelector("#theme-setting")!.addEventListener("change", (event) => changePreferences({ theme: (event.target as HTMLSelectElement).value as Preferences["theme"] }));
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
  if (event.ctrlKey && event.key.toLowerCase() === "o") { event.preventDefault(); void action(event.shiftKey ? "folder" : "open"); }
  if (event.ctrlKey && event.key.toLowerCase() === "f") { event.preventDefault(); toggleSearch(true); }
  if (event.ctrlKey && event.key.toLowerCase() === "w") { event.preventDefault(); void action("close-document"); }
  if (event.key === "Escape") { app.classList.remove("outline-drawer"); if (settingsOpen) toggleSettings(); else toggleSearch(false); }
  if (event.key === "F5" && current) { event.preventDefault(); if (settingsOpen) refreshOnReturn = true; else void openPath(current.path, reader.capturePosition()); }
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { if (session) applyPreferences(); });
reader.onMessage = message;
reader.onHeading = (id) => {
  const previous = document.querySelector<HTMLElement>('.outline-link[aria-current="location"]');
  previous?.classList.remove("active"); previous?.removeAttribute("aria-current");
  const next = document.querySelector<HTMLElement>(`.outline-link[data-heading="${CSS.escape(id)}"]`);
  next?.classList.add("active"); next?.setAttribute("aria-current", "location");
};
reader.onSearch = (count, index, truncated) => {
  document.querySelector("#search-count")!.textContent = !document.querySelector<HTMLInputElement>("#search-input")!.value ? "" : count ? `${index + 1} / ${count}${truncated ? "+" : ""}` : "无匹配";
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
        else void openPath(current.path, reader.capturePosition());
      }, 250);
    });
    session = await invoke<Session>("get_session");
    preferences = new PreferenceStore(session.state.preferences, (preferences) => invoke<void>("save_preferences", { preferences }), (error) => message(`设置未保存：${String(error)}`, true));
    // 拦截关闭并提交合并中的偏好和进度；成功后移除监听，让原生关闭保存窗口尺寸。
    let closing = false;
    const stopClose = await getCurrentWindow().onCloseRequested(async (event) => {
      event.preventDefault(); if (closing) return; closing = true;
      try { await preferences.flush(); await persistPosition(); stopClose(); await getCurrentWindow().close(); }
      catch (error) { closing = false; message(`关闭前保存失败，请重试：${String(error)}`, true); }
    });
    applyPreferences(); renderRecent();
    document.querySelector("#data-root")!.textContent = displayPath(session.root);
    document.querySelector("#version")!.textContent = `MD ${session.version} · 本地 Markdown 阅读器`;
    if (session.state.lastFile) await openPath(session.state.lastFile);
    else { await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }
    void confirmReady();
    if (session.state.folders[0]) void renderDirectory(session.state.folders[0], document.querySelector<HTMLElement>("#file-tree")!);
  } catch (error) { message(`无法恢复会话：${String(error)}`, true); }
}

void start();
