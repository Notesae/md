import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { icon } from "./icons";
import { installScrollbars } from "./scrollbars";
import "./styles.css";
import "./setup.css";

/** 后台对候选位置的只读检查结果；确认时会再次检查。 */
interface SetupTarget {
  parent: string;
  root: string;
  existing: boolean;
  writable: boolean;
  freeBytes: number | null;
  systemDrive: boolean;
  problem: string | null;
}

interface SetupInfo {
  notice: string | null;
  defaultTarget: SetupTarget | null;
  defaultError: string | null;
}

// 尚无阅读偏好，引导页直接跟随系统明暗。
const dark = matchMedia("(prefers-color-scheme: dark)");
const applyTheme = () => { document.documentElement.dataset.theme = dark.matches ? "dark" : "light"; };
applyTheme(); dark.addEventListener("change", applyTheme);

const root = document.querySelector<HTMLDivElement>("#setup")!;
installScrollbars();
root.innerHTML = `<div class="setup-shell">
  <header class="setup-titlebar" data-tauri-drag-region="deep">
    <span class="setup-brand">${icon("book")}MD</span>
    <div class="window-actions" role="group" aria-label="窗口控制" data-tauri-drag-region="false">
      <button class="window-button" data-setup="minimize" title="最小化" aria-label="最小化">${icon("minimize")}</button>
      <button class="window-button window-close" data-setup="close" title="退出" aria-label="退出">${icon("close")}</button>
    </div>
  </header>
  <main class="setup-sheet">
    <p class="setup-eyebrow" id="setup-eyebrow">首次使用</p>
    <h1>选择数据存放位置</h1>
    <p class="setup-lead">阅读进度、偏好设置、解析缓存和浏览器数据都保存在这里。原始 Markdown 文件保留在原位置。</p>
    <p class="setup-notice" id="setup-notice" role="alert" hidden></p>
    <div class="setup-options" role="radiogroup" aria-label="数据位置">
      <label class="setup-option" id="option-default">
        <input class="sr-only" type="radio" name="location" value="default">
        <span class="setup-radio" aria-hidden="true"></span>
        <span class="setup-option-body">
          <span class="setup-option-title">应用所在位置<span class="setup-badge">推荐</span></span>
          <span class="setup-path" id="default-path">正在检查…</span>
          <span class="setup-meta" id="default-meta"></span>
        </span>
      </label>
      <label class="setup-option" id="option-custom">
        <input class="sr-only" type="radio" name="location" value="custom">
        <span class="setup-radio" aria-hidden="true"></span>
        <span class="setup-option-body">
          <span class="setup-option-title">其他位置</span>
          <span class="setup-path" id="custom-path" hidden></span>
          <span class="setup-meta" id="custom-meta">选择已有的 MD 数据目录，或在任意文件夹中新建。</span>
        </span>
        <button class="secondary setup-choose" type="button" data-setup="choose">选择文件夹…</button>
      </label>
    </div>
    <footer class="setup-footer">
      <p class="setup-hint">之后可在设置的「应用数据」中迁移到其他位置。</p>
      <button class="primary setup-confirm" type="button" data-setup="confirm" disabled>开始使用</button>
    </footer>
  </main>
  <dialog id="rebuild-dialog" aria-labelledby="rebuild-title">
    <h2 id="rebuild-title">重建浏览器数据</h2>
    <p>上次在这个位置启动阅读窗口失败。将只清理其中的浏览器数据并重新创建窗口，阅读进度、偏好和原始文章都会保留。</p>
    <div class="dialog-actions"><button class="secondary" type="button" data-setup="rebuild-cancel" autofocus>取消</button><button class="primary" type="button" data-setup="rebuild-confirm">重建并继续</button></div>
  </dialog>
</div>`;

const targets: Record<"default" | "custom", SetupTarget | null> = { default: null, custom: null };
const confirmButton = root.querySelector<HTMLButtonElement>('[data-setup="confirm"]')!;
const dialog = root.querySelector<HTMLDialogElement>("#rebuild-dialog")!;
let busy = false;

const selected = (): "default" | "custom" | null =>
  (root.querySelector<HTMLInputElement>('input[name="location"]:checked')?.value as "default" | "custom" | undefined) ?? null;

function sizeLabel(bytes: number): string {
  return bytes >= 1024 ** 4 ? `${(bytes / 1024 ** 4).toFixed(1)} TB` : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(0)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

/** 状态说明按“沿用或新建 · 剩余空间 · 系统盘”组合，问题单独以错误色显示。 */
function renderTarget(kind: "default" | "custom", target: SetupTarget | null, fallback = ""): void {
  const option = root.querySelector<HTMLElement>(`#option-${kind}`)!;
  const path = root.querySelector<HTMLElement>(`#${kind}-path`)!;
  const meta = root.querySelector<HTMLElement>(`#${kind}-meta`)!;
  option.classList.toggle("has-problem", !!target?.problem);
  if (!target) { path.hidden = kind === "custom"; path.textContent = fallback; return; }
  path.hidden = false; path.textContent = target.root; path.title = target.root;
  const parts = target.problem ? [target.problem] : [
    target.existing ? "已有 MD 数据，将继续使用" : "将新建 MdReader 文件夹",
    ...(target.freeBytes === null ? [] : [`可用 ${sizeLabel(target.freeBytes)}`]),
    ...(target.systemDrive ? ["位于系统盘"] : []),
  ];
  meta.textContent = parts.join(" · ");
  if (kind === "custom") root.querySelector<HTMLButtonElement>('[data-setup="choose"]')!.textContent = "更换…";
}

function syncConfirm(): void {
  const kind = selected();
  const target = kind ? targets[kind] : null;
  confirmButton.disabled = busy || !target || !!target.problem;
  confirmButton.setAttribute("aria-busy", String(busy));
  confirmButton.textContent = busy ? "正在准备…" : target?.existing ? "继续使用" : "开始使用";
}

function showError(text: string): void {
  const notice = root.querySelector<HTMLElement>("#setup-notice")!;
  notice.textContent = text; notice.hidden = false;
}

async function choose(): Promise<void> {
  if (busy) return;
  try {
    const target = await invoke<SetupTarget | null>("setup_choose");
    if (target) { targets.custom = target; renderTarget("custom", target); root.querySelector<HTMLInputElement>('input[value="custom"]')!.checked = true; }
  } catch (error) { showError(`无法打开文件夹选择器：${String(error)}`); }
  syncConfirm();
}

/** 确认成功后后台会关闭本窗口并打开阅读窗口；失败保留选择以便重试。 */
async function confirm(rebuildWebview = false): Promise<void> {
  const kind = selected(); const target = kind ? targets[kind] : null;
  if (!target || busy) return;
  busy = true; syncConfirm();
  try {
    const launched = await invoke<boolean>("setup_confirm", { parent: target.parent, rebuildWebview });
    if (!launched) dialog.showModal();
  } catch (error) { showError(String(error)); }
  finally { busy = false; syncConfirm(); }
}

root.addEventListener("click", (event) => {
  const action = (event.target as Element).closest<HTMLElement>("[data-setup]")?.dataset.setup;
  if (!action) return;
  if (action === "choose") { event.preventDefault(); void choose(); }
  else if (action === "confirm") void confirm();
  else if (action === "rebuild-cancel") dialog.close();
  else if (action === "rebuild-confirm") { dialog.close(); void confirm(true); }
  else if (action === "minimize") void getCurrentWindow().minimize();
  else if (action === "close") void getCurrentWindow().close();
});
root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  // 首次选中“其他位置”且尚无路径时直接打开选择器，取消则停留在未确定状态。
  if (input.name === "location" && input.value === "custom" && !targets.custom) void choose();
  syncConfirm();
});

async function start(): Promise<void> {
  try {
    const info = await invoke<SetupInfo>("setup_info");
    if (info.notice) { root.querySelector("#setup-eyebrow")!.textContent = "需要重新选择"; showError(info.notice); }
    targets.default = info.defaultTarget;
    renderTarget("default", info.defaultTarget, info.defaultError ?? "无法确定应用所在位置");
    const usable = info.defaultTarget && !info.defaultTarget.problem;
    root.querySelector<HTMLInputElement>(`input[value="${usable ? "default" : "custom"}"]`)!.checked = !!usable;
    if (!usable) root.querySelector<HTMLElement>("#option-default")!.classList.add("has-problem");
  } catch (error) { showError(`无法读取默认位置：${String(error)}`); }
  syncConfirm();
}

void start();
