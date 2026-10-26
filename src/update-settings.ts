import { invoke } from "@tauri-apps/api/core";

export interface UpdateSnapshot {
  phase: "idle" | "checking" | "available" | "current" | "downloading" | "verifying" | "cancelling" | "cancelled" | "ready" | "error" | "handoff";
  job: number; currentVersion: string; channel: "stable" | "preview";
  offer: { version: string; tag: string; prerelease: boolean; releaseUrl: string; notes: string; bytes: number; sha256: string } | null;
  downloaded: number; total: number; message: string; retryAt: number | null; canInstall: boolean;
}
const working = (state: UpdateSnapshot) => ["checking", "downloading", "verifying", "cancelling", "handoff"].includes(state.phase);
const size = (bytes: number) => (bytes / 1024 ** 2).toFixed(1) + " MiB";

/** 更新区只主动检查；远程说明用纯文本呈现，下载和安装确认是两个独立动作。 */
export class UpdateSettings {
  private state: UpdateSnapshot | null = null;
  private channel: "stable" | "preview" = "stable";
  private epoch = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private requestPending = false;
  private active = false;
  private intent = 0;
  private preparing = false;
  private committed = false;
  private readonly dialog: HTMLDialogElement;

  constructor(private readonly container: HTMLElement, private readonly beforeInstall: () => Promise<void>) {
    container.innerHTML = [
      '<div class="setting-row update-current"><span>当前版本 <strong id="update-current-version">—</strong><span class="setting-help">免登录获取公开版本，只在你点击后检查。</span></span><button class="secondary" data-update="release">公开发布页</button></div>',
      '<div class="setting-row update-channel"><span id="update-channel-label">更新通道</span><p class="setting-help" id="update-channel-help">每次启动默认仅稳定版。</p><div id="update-channel" class="segmented-options" role="radiogroup" aria-labelledby="update-channel-label" aria-describedby="update-channel-help"><label class="segmented-option"><input class="sr-only" type="radio" name="update-channel" value="stable" checked><span>仅稳定版</span></label><label class="segmented-option"><input class="sr-only" type="radio" name="update-channel" value="preview"><span>稳定版与预发布</span></label></div></div>',
      '<div class="update-result" data-phase="idle"><p id="update-status" role="status">尚未检查更新。</p><p id="update-retry-at" class="setting-help" hidden></p>',
      '<section id="update-offer" aria-labelledby="update-version-title" hidden><h3 id="update-version-title"></h3><p id="update-package" class="setting-help"></p><details><summary>版本说明</summary><p id="update-notes"></p></details><details id="update-integrity" hidden><summary>完整性校验</summary><p>已核对公开发布的 SHA-256 和构建记录。这不代表 Windows 代码签名。</p><code id="update-sha"></code></details></section>',
      '<div id="update-transfer" hidden><progress id="update-progress" aria-label="安装包下载进度" max="1" value="0"></progress><p id="update-progress-label" class="setting-help"></p></div>',
      '<div class="update-actions"><button class="primary" data-update="primary">检查更新</button><button class="secondary" data-update="check" hidden>重新检查</button><button class="secondary" data-update="cancel" hidden>取消</button></div></div>',
      '<dialog id="update-install-dialog" aria-labelledby="update-install-title" inert><h2 id="update-install-title">安装更新</h2><p id="update-install-version"></p><p>确认后会保存阅读状态并打开 Windows 安装向导，随后退出 MD。请在向导中完成安装；原始文章和应用数据不会由此操作删除。</p><p class="setting-help">独立程序不会原地覆盖，将使用当前用户安装位置。Windows 可能显示未知发布者提示。</p><p id="update-install-status" role="status">安装程序尚未启动。</p><div class="dialog-actions"><button class="secondary" data-update="dismiss" autofocus>暂不安装</button><button class="primary" data-update="confirm">退出并打开安装向导</button></div></dialog>'
    ].join("");
    this.dialog = container.querySelector("#update-install-dialog")!;
    container.addEventListener("click", (event) => {
      const action = (event.target as Element).closest<HTMLElement>("[data-update]")?.dataset.update;
      if (action) void this.action(action);
    });
    container.querySelector("#update-channel")!.addEventListener("change", (event) => {
      const choice = event.target as HTMLInputElement;
      if (!choice.checked || choice.disabled) return;
      const wasFocused = document.activeElement === choice;
      this.channel = choice.value === "preview" ? "preview" : "stable";
      this.cancelConfirmation();
      void this.call("cancel_update").then((ok) => {
        if (ok && this.state) { this.state = { ...this.state, phase: "idle", offer: null, message: "通道已切换，请点击检查更新。" }; this.render(); }
        // 临时禁用可使焦点回到页面，仅在用户尚未转移焦点且设置仍打开时归还。
        if (wasFocused && this.active && choice.isConnected && !choice.disabled && document.activeElement === document.body) choice.focus({ preventScroll: true });
      });
    });
    this.dialog.addEventListener("cancel", (event) => { event.preventDefault(); this.cancelConfirmation(); });
  }
  async activate(): Promise<void> { this.active = true; await this.refresh(); }
  /** 离开设置始终撤下模态层，防止标题栏跟随设置隐藏；已提交的安装仍由原请求完成。 */
  deactivate(): void {
    this.active = false; this.cancelConfirmation();
    this.dialog.close(); this.dialog.inert = true;
  }

  private async refresh(): Promise<void> {
    const epoch = ++this.epoch;
    try {
      const state = await invoke<UpdateSnapshot>("get_update_status");
      if (epoch !== this.epoch) return;
      if (!state) throw new Error("更新状态暂不可用");
      this.state = state; this.render(); this.schedule();
    } catch (error) { if (epoch === this.epoch) this.error("无法读取更新状态：" + String(error)); }
  }
  /** 仅轮询本地状态；离开设置后下载仍可继续，不会自动检查或下载。 */
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.state && working(this.state)) this.timer = setTimeout(() => { void this.refresh(); }, 250);
    else if (this.state?.retryAt && this.state.retryAt * 1000 > Date.now()) this.timer = setTimeout(() => { this.render(); this.schedule(); }, Math.min(3_600_000, this.state.retryAt * 1000 - Date.now() + 100));
  }
  private error(text: string): void { const status = this.container.querySelector("#update-status")!; status.setAttribute("role", "alert"); status.textContent = text; }
  private async call(command: string, args?: Record<string, unknown>): Promise<boolean> {
    if (this.requestPending) return false;
    this.requestPending = true; ++this.epoch; clearTimeout(this.timer); this.render();
    let error: unknown;
    try { this.state = await invoke<UpdateSnapshot>(command, args); return true; }
    catch (value) { error = value; return false; }
    finally { this.requestPending = false; this.render(); this.schedule(); if (error) this.error(String(error)); }
  }
  private render(): void {
    const state = this.state, busy = !!state && working(state), offer = state?.offer, ready = state?.phase === "ready";
    const limited = !!state?.retryAt && state.retryAt * 1000 > Date.now();
    this.container.querySelector("#update-current-version")!.textContent = state?.currentVersion ?? "—";
    // 两个选项共享同一忙碌边界，刷新状态不能把本次会话选择重置成默认通道。
    this.container.querySelectorAll<HTMLInputElement>("#update-channel input").forEach((choice) => {
      choice.checked = choice.value === this.channel; choice.disabled = busy || ready || this.requestPending;
    });
    this.container.querySelector("#update-channel-help")!.textContent = this.channel === "stable" ? "每次启动默认仅稳定版。" : "包含测试版本，可能尚未完成验证；本次会话内有效。";
    const status = this.container.querySelector("#update-status")!;
    status.setAttribute("role", state?.phase === "error" ? "alert" : "status"); status.textContent = state?.message ?? "尚未检查更新。";
    this.container.querySelector<HTMLElement>(".update-result")!.dataset.phase = state?.phase ?? "idle";
    const retry = this.container.querySelector<HTMLElement>("#update-retry-at")!; retry.hidden = !limited;
    if (limited) retry.textContent = "请在 " + new Date(state!.retryAt! * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " 后手动重试，不会自动请求。";
    this.container.querySelector<HTMLElement>("#update-offer")!.hidden = !offer;
    if (offer) {
      this.container.querySelector("#update-version-title")!.textContent = "MD " + offer.version + (offer.prerelease ? " · 预发布" : " · 稳定版");
      this.container.querySelector("#update-package")!.textContent = "Windows x64 安装包 · " + size(offer.bytes) + (state?.canInstall ? "" : " · 当前平台仅可查看发布页");
      this.container.querySelector("#update-notes")!.textContent = offer.notes; this.container.querySelector("#update-sha")!.textContent = offer.sha256;
    }
    this.container.querySelector<HTMLElement>("#update-integrity")!.hidden = !ready;
    this.container.querySelector<HTMLElement>("#update-transfer")!.hidden = !(state && ["downloading", "verifying", "cancelling"].includes(state.phase) && state.total > 0);
    const progress = this.container.querySelector<HTMLProgressElement>("#update-progress")!;
    progress.max = Math.max(1, state?.total ?? 1); progress.value = Math.min(state?.downloaded ?? 0, progress.max);
    this.container.querySelector("#update-progress-label")!.textContent = state ? size(state.downloaded) + " / " + size(state.total) + " · " + Math.min(100, Math.floor(state.downloaded * 100 / Math.max(1, state.total))) + "%" : "";
    const primary = this.container.querySelector<HTMLButtonElement>('[data-update="primary"]')!;
    primary.textContent = busy ? (state?.phase === "checking" ? "检查中…" : "处理中…") : ready ? "安装更新…" : offer ? "下载安装包" : "检查更新";
    primary.disabled = busy || this.requestPending || limited || (!!offer && !state?.canInstall); primary.setAttribute("aria-busy", String(busy || this.requestPending));
    const check = this.container.querySelector<HTMLButtonElement>('[data-update="check"]')!;
    check.hidden = !offer || ready || busy; check.disabled = this.requestPending || limited;
    const cancel = this.container.querySelector<HTMLButtonElement>('[data-update="cancel"]')!;
    cancel.hidden = !busy && !ready; cancel.disabled = this.requestPending || state?.phase === "cancelling" || state?.phase === "handoff"; cancel.textContent = ready ? "丢弃下载" : "取消";
  }
  private cancelConfirmation(): void {
    if (this.committed) return;
    // 只有关闭实际确认框才归还焦点，切换通道不额外抢走单选控件的焦点。
    const wasOpen = this.dialog.open;
    ++this.intent; this.preparing = false; this.dialog.close(); this.dialog.inert = true;
    this.container.querySelector<HTMLButtonElement>('[data-update="confirm"]')!.disabled = false;
    if (wasOpen && this.active) this.container.querySelector<HTMLButtonElement>('[data-update="primary"]')!.focus();
  }
  private async action(action: string): Promise<void> {
    if (action === "release") { try { await invoke("open_update_release"); } catch (error) { this.error(String(error)); } return; }
    if (action === "dismiss") { this.cancelConfirmation(); return; }
    if (action === "cancel") { this.cancelConfirmation(); await this.call("cancel_update"); return; }
    if (action === "check") { await this.call("check_for_updates", { channel: this.channel }); return; }
    if (action === "primary") {
      if (!this.state) { await this.refresh(); return; }
      if (working(this.state) || this.requestPending) return;
      if (this.state.phase === "ready") {
        this.container.querySelector("#update-install-version")!.textContent = "即将安装 MD " + this.state.offer!.version + (this.state.offer!.prerelease ? "（预发布）" : "") + "。";
        const status = this.container.querySelector("#update-install-status")!; status.textContent = "安装程序尚未启动。"; status.setAttribute("role", "status");
        ++this.intent; this.dialog.inert = false; this.dialog.showModal(); return;
      }
      await this.call(this.state.offer ? "download_update" : "check_for_updates", this.state.offer ? undefined : { channel: this.channel }); return;
    }
    if (action !== "confirm" || !this.dialog.open || this.preparing || this.committed) return;
    const intent = this.intent; this.preparing = true;
    const confirm = this.container.querySelector<HTMLButtonElement>('[data-update="confirm"]')!, cancel = this.container.querySelector<HTMLButtonElement>('[data-update="dismiss"]')!;
    confirm.disabled = true; const status = this.container.querySelector("#update-install-status")!; status.textContent = "正在保存阅读状态，可暂不安装…";
    try {
      await this.beforeInstall(); if (intent !== this.intent || !this.dialog.open) return;
      this.committed = true; cancel.disabled = true; status.textContent = "正在打开安装向导…"; await invoke("install_update");
    } catch (error) {
      if (intent !== this.intent) return;
      this.committed = false; status.textContent = "安装程序未启动：" + String(error); status.setAttribute("role", "alert"); await this.refresh();
    } finally { if (intent === this.intent) { this.preparing = false; confirm.disabled = this.committed; cancel.disabled = this.committed; } }
  }
}
