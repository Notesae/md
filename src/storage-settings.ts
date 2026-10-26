import { invoke } from "@tauri-apps/api/core";
import type { Preferences } from "./types";
import { icon } from "./icons";

/** 后台按需统计的实际空间；残留仅来自带归属的迁移记录。 */
interface StorageInfo {
  usage: { stateBytes: number; cacheBytes: number; webviewBytes: number; logsBytes: number; tempBytes: number; totalBytes: number; freeBytes: number };
  residual: { path: string; bytes: number } | null;
  notice: string | null;
}

const bytes = (value: number) => value >= 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(2)} GiB` : value >= 1024 ** 2 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024).toFixed(1)} KiB`;

/** 存储面板按需加载，分类统计、确认和迁移均在主窗口内完成。 */
export class StorageSettings {
  private epoch = 0;
  private info: StorageInfo | null = null;
  private maintenance: "migrate" | "webview" | "cache" | null = null;
  private selectedTarget: string | null = null;
  // 统计刷新与维护意图分开计代，离开设置或取消后不能提交旧选择。
  private viewActive = false;
  private maintenanceEpoch = 0;
  private choosing = false;
  private targetClear: Promise<void> = Promise.resolve();
  private operation: { committed: boolean } | null = null;

  constructor(private readonly container: HTMLElement, private readonly getPreferences: () => Preferences,
    private readonly updatePreferences: (patch: Partial<Preferences>) => void,
    private readonly beforeMaintenance: () => Promise<void>, private readonly message: (text: string, persistent?: boolean) => void) {
    container.innerHTML = `<div class="storage-actions"><button class="secondary" data-storage="reveal">打开数据目录</button><button class="secondary" data-storage="migrate">更改位置…</button></div>
      <div class="section-title storage-heading"><h3>空间占用</h3><button class="text-button" data-storage="refresh">重新统计</button></div>
      <p id="storage-status" class="setting-help" role="status">尚未统计</p><dl id="storage-usage" class="storage-usage"></dl>
      <p id="webview-warning" class="setting-help" hidden>浏览器数据超过建议的 256MiB 提醒阈值，可在退出当前会话后清理。这不是浏览器数据的硬性上限。</p>
      <label class="setting-row"><span><span id="cache-enabled-label">持久解析缓存</span><span class="setting-help" id="cache-enabled-help">关闭后不再读写文章缓存；阅读记录始终保留</span></span><span class="switch-control"><span class="switch-state" aria-hidden="true"></span><input id="cache-enabled" class="switch-input" type="checkbox" role="switch" aria-labelledby="cache-enabled-label" aria-describedby="cache-enabled-help"><span class="switch-track" aria-hidden="true"></span></span></label>
      <div class="setting-row cache-budget-row"><span><span id="cache-budget-label">应用缓存预算</span><span class="setting-help" id="cache-budget-help">只约束应用解析缓存，不包含浏览器数据</span></span>
        <div class="budget-setting"><div class="number-stepper" role="group" aria-labelledby="cache-budget-label">
          <button class="stepper-button" type="button" data-storage="budget-decrease" title="减少 16 MiB" aria-label="减少缓存预算">${icon("minus")}</button>
          <label class="budget-value" for="cache-budget"><input id="cache-budget" type="number" min="0" max="2048" step="16" required aria-labelledby="cache-budget-label" aria-describedby="cache-budget-help cache-budget-range"><span class="budget-unit">MiB</span></label>
          <button class="stepper-button" type="button" data-storage="budget-increase" title="增加 16 MiB" aria-label="增加缓存预算">${icon("plus")}</button>
        </div><span id="cache-budget-range" class="budget-limit">0–2048 MiB · 每次 16 MiB</span><p id="cache-budget-error" class="control-error" role="alert" hidden>请输入 0–2048 范围内、以 16 为步长的 MiB 数值。</p></div>
      </div>
      <div class="storage-actions"><button class="secondary" data-storage="cache">清理应用缓存…</button><button class="secondary" data-storage="webview">清理浏览器数据…</button></div>
      <div id="migration-residual" class="migration-residual" hidden><h3>待清理的旧数据</h3><p id="residual-path" class="path-value"></p><p id="residual-size" class="setting-help"></p><button class="secondary" data-storage="retry">重试清理</button></div>
      <dialog id="maintenance-dialog" aria-labelledby="maintenance-title" data-phase="ready" inert><h2 id="maintenance-title"></h2><p id="maintenance-description"></p><p id="maintenance-target" class="path-value" hidden></p><p id="maintenance-status" role="status"></p><div class="dialog-actions"><button class="secondary" data-storage="cancel" autofocus>取消</button><button class="primary" data-storage="confirm" id="maintenance-confirm"></button></div></dialog>`;
    container.addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-storage]");
      if (button) void this.action(button.dataset.storage!).catch((error) => this.message(String(error), true));
    });
    container.querySelector("#cache-enabled")!.addEventListener("change", (event) => this.updatePreferences({ persistentCache: (event.target as HTMLInputElement).checked }));
    container.querySelector("#cache-budget")!.addEventListener("change", (event) => {
      const input = event.target as HTMLInputElement;
      if (this.syncBudget()) this.updatePreferences({ cacheMib: input.valueAsNumber });
    });
    // 合法值恢复时立即解锁步进；输入尚未完成时不逐字弹出校验错误。
    container.querySelector("#cache-budget")!.addEventListener("input", (event) => {
      if ((event.target as HTMLInputElement).validity.valid) this.syncBudget();
    });
    container.querySelector("#maintenance-dialog")!.addEventListener("cancel", (event) => {
      event.preventDefault();
      if (!this.operation?.committed) void this.cancelMaintenance().catch((error) => this.message(String(error), true));
    });
  }

  /** 设置页打开立即呈现，后台扫描有自己的取消代次，与文档解析互不占用。 */
  async activate(): Promise<void> {
    this.viewActive = true; this.updateMaintenanceButtons();
    this.container.querySelector<HTMLInputElement>("#cache-enabled")!.checked = this.getPreferences().persistentCache;
    this.container.querySelector<HTMLInputElement>("#cache-budget")!.value = String(this.getPreferences().cacheMib);
    this.syncBudget();
    const epoch = ++this.epoch;
    this.container.querySelector("#storage-status")!.textContent = "正在后台统计，可继续调整阅读设置…";
    try {
      const info = await invoke<StorageInfo>("get_storage_info");
      if (epoch !== this.epoch) return;
      this.info = info;
      const list = this.container.querySelector("#storage-usage")!; list.replaceChildren();
      const values: [string, number][] = [["必要数据", info.usage.stateBytes], ["应用缓存", info.usage.cacheBytes], ["浏览器数据", info.usage.webviewBytes], ["诊断日志", info.usage.logsBytes], ["临时文件", info.usage.tempBytes], ["迁移残留", info.residual?.bytes ?? 0]];
      for (const [label, value] of values) { const term = document.createElement("dt"); term.textContent = label; const description = document.createElement("dd"); description.textContent = bytes(value); list.append(term, description); }
      this.container.querySelector("#storage-status")!.textContent = `总占用 ${bytes(info.usage.totalBytes + (info.residual?.bytes ?? 0))} · 当前盘可用 ${bytes(info.usage.freeBytes)}`;
      this.container.querySelector<HTMLElement>("#webview-warning")!.hidden = info.usage.webviewBytes <= 256 * 1024 ** 2;
      this.container.querySelector<HTMLElement>("#migration-residual")!.hidden = !info.residual;
      if (info.residual) { this.container.querySelector("#residual-path")!.textContent = info.residual.path; this.container.querySelector("#residual-size")!.textContent = `${bytes(info.residual.bytes)}，清理不会影响当前位置的阅读数据。`; }
      if (info.notice) this.message(info.notice, true);
    } catch (error) { if (epoch === this.epoch) this.container.querySelector("#storage-status")!.textContent = `无法统计：${String(error)}。可点击重新统计。`; }
  }

  deactivate(): void {
    this.viewActive = false; this.epoch++; void invoke("cancel_storage_stats").catch(() => {});
    void this.cancelMaintenance().catch((error) => this.message(`取消迁移目标未完成：${String(error)}`, true));
  }

  /** 直接输入与步进共用原生范围校验，就地说明错误并同步边界按钮，空值不能被保存为零。 */
  private syncBudget(): boolean {
    const input = this.container.querySelector<HTMLInputElement>("#cache-budget")!;
    const valid = input.checkValidity();
    input.setAttribute("aria-invalid", String(!valid));
    input.setAttribute("aria-describedby", `cache-budget-help cache-budget-range${valid ? "" : " cache-budget-error"}`);
    this.container.querySelector<HTMLElement>("#cache-budget-error")!.hidden = valid;
    this.container.querySelector<HTMLButtonElement>('[data-storage="budget-decrease"]')!.disabled = !valid || input.valueAsNumber <= Number(input.min);
    this.container.querySelector<HTMLButtonElement>('[data-storage="budget-increase"]')!.disabled = !valid || input.valueAsNumber >= Number(input.max);
    return valid;
  }

  /** 选择器与确认操作各自串行；提交原生维护后不再提供无效的取消入口。 */
  private updateMaintenanceButtons(): void {
    for (const action of ["migrate", "webview", "cache"]) this.container.querySelector<HTMLButtonElement>(`[data-storage="${action}"]`)!.disabled = !this.viewActive || this.choosing || !!this.operation;
    this.container.querySelector('[data-storage="migrate"]')!.textContent = this.choosing ? "正在选择…" : "更改位置…";
    this.container.querySelector<HTMLButtonElement>('[data-storage="cancel"]')!.disabled = this.operation?.committed ?? false;
    this.container.querySelector("#maintenance-confirm")!.setAttribute("aria-busy", String(!!this.operation));
  }

  /** 撤销准备中的维护及暂存授权；清理串行完成后才允许选择新目标。 */
  private cancelMaintenance(): Promise<void> {
    this.maintenanceEpoch++;
    const committed = this.operation?.committed;
    if (!committed) this.operation = null;
    this.maintenance = null; this.selectedTarget = null;
    this.updateMaintenanceButtons();
    const dialog = this.container.querySelector<HTMLDialogElement>("#maintenance-dialog")!;
    dialog.inert = true; dialog.close();
    if (committed) return Promise.resolve();
    this.targetClear = this.targetClear.catch(() => {}).then(() => invoke<void>("cancel_storage_target"));
    return this.targetClear;
  }

  /** 确认界面明确列出影响范围，迁移目标由原生选择器授权后才可提交。 */
  private async action(action: string): Promise<void> {
    if (!this.viewActive) return;
    if (action === "budget-decrease" || action === "budget-increase") {
      if (!this.syncBudget()) return;
      const input = this.container.querySelector<HTMLInputElement>("#cache-budget")!;
      if (action === "budget-increase") input.stepUp(); else input.stepDown();
      if (this.syncBudget()) this.updatePreferences({ cacheMib: input.valueAsNumber });
      return;
    }
    const dialog = this.container.querySelector<HTMLDialogElement>("#maintenance-dialog")!;
    const title = this.container.querySelector("#maintenance-title")!;
    const description = this.container.querySelector("#maintenance-description")!;
    const target = this.container.querySelector<HTMLElement>("#maintenance-target")!;
    const status = this.container.querySelector<HTMLElement>("#maintenance-status")!;
    const confirm = this.container.querySelector<HTMLButtonElement>("#maintenance-confirm")!;
    if (action === "reveal") { await invoke("reveal_data_directory"); return; }
    if (action === "refresh") { await this.activate(); return; }
    if (action === "retry") { const epoch = this.maintenanceEpoch; await invoke("retry_storage_cleanup"); if (this.viewActive && epoch === this.maintenanceEpoch) await this.activate(); return; }
    if (action === "cancel") { if (!this.operation?.committed) await this.cancelMaintenance(); return; }
    if (["migrate", "webview", "cache"].includes(action)) {
      if (this.choosing || this.operation || dialog.open) return;
      const epoch = ++this.maintenanceEpoch;
      if (!this.info && action !== "migrate") {
        await this.activate(); if (!this.viewActive || epoch !== this.maintenanceEpoch) return;
        if (!this.info) throw new Error("请先完成空间统计，再确认清理范围。");
      }
      let path: string | null = null;
      if (action === "migrate") {
        this.choosing = true; this.updateMaintenanceButtons();
        try {
          await this.targetClear.catch(() => {}); if (!this.viewActive || epoch !== this.maintenanceEpoch) return;
          path = await invoke<string | null>("choose_storage_target");
          if (!this.viewActive || epoch !== this.maintenanceEpoch) { if (path) await this.cancelMaintenance(); return; }
          if (!path) return;
        } finally { this.choosing = false; this.updateMaintenanceButtons(); }
      }
      this.selectedTarget = path;
      this.maintenance = action as typeof this.maintenance;
      target.hidden = !path; target.textContent = path; status.textContent = "准备好后可确认，也可以取消。"; status.dataset.error = "false"; confirm.disabled = false;
      dialog.dataset.phase = "ready"; dialog.inert = false;
      title.textContent = action === "migrate" ? "迁移应用数据" : action === "webview" ? "清理浏览器数据" : "清理应用缓存";
      description.textContent = action === "migrate" ? "保存阅读进度后，应用会关闭并重新启动。偏好和记录将迁移到以下位置，缓存重新生成，原始文章与附件保持原位。请避开同步盘和可拔出存储。" : action === "webview" ? `应用会关闭并重新启动，再清理约 ${bytes(this.info?.usage.webviewBytes ?? 0)} 的浏览器数据。阅读记录、偏好和原始文章保留。` : `将清理约 ${bytes(this.info?.usage.cacheBytes ?? 0)} 的应用解析缓存，下次打开时可重新生成。阅读记录、偏好和原始文章保留。`;
      confirm.textContent = action === "migrate" ? "迁移并重新启动" : action === "webview" ? "清理并重新启动" : "清理缓存";
      this.container.querySelector<HTMLElement>(`[data-storage="${action}"]`)!.focus({ preventScroll: true });
      dialog.showModal(); return;
    }
    if (action === "confirm" && this.maintenance && dialog.open && !this.operation) {
      const kind = this.maintenance; const selectedTarget = this.selectedTarget; const epoch = this.maintenanceEpoch;
      const operation = { committed: false }; this.operation = operation;
      confirm.disabled = true; status.textContent = "正在保存阅读设置，可取消…"; status.dataset.error = "false"; dialog.dataset.phase = "preparing"; this.updateMaintenanceButtons();
      let succeeded = false;
      try {
        await this.beforeMaintenance();
        if (!this.viewActive || epoch !== this.maintenanceEpoch || this.operation !== operation) return;
        operation.committed = true; this.updateMaintenanceButtons(); dialog.dataset.phase = "working"; status.textContent = kind === "cache" ? "正在清理…" : "正在准备重新启动…";
        await invoke(kind === "migrate" ? "migrate_storage" : kind === "webview" ? "reset_webview" : "clear_cache", kind === "migrate" ? { target: selectedTarget } : {});
        succeeded = true;
        if (!this.viewActive || epoch !== this.maintenanceEpoch || this.operation !== operation) return;
        if (kind === "cache") {
          this.maintenance = null; this.selectedTarget = null; this.operation = null; this.updateMaintenanceButtons(); dialog.inert = true; dialog.close();
          this.message("应用缓存已清理，阅读状态已保留。"); await this.activate();
        }
      } catch (error) {
        if (this.viewActive && epoch === this.maintenanceEpoch && this.operation === operation) { confirm.disabled = false; status.textContent = `操作未完成：${String(error)}`; status.dataset.error = "true"; dialog.dataset.phase = "error"; }
      } finally {
        if (this.operation === operation && (!succeeded || kind === "cache")) { this.operation = null; this.updateMaintenanceButtons(); }
      }
    }
  }
}
