// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateSettings, type UpdateSnapshot } from "../src/update-settings";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const initial = (): UpdateSnapshot => ({ phase: "idle", job: 0, currentVersion: "0.1.2", channel: "stable", offer: null, downloaded: 0, total: 0, message: "尚未检查更新。", retryAt: null, canInstall: true });
const offer = { version: "0.1.3", tag: "v0.1.3", prerelease: true, releaseUrl: "https://github.com/Notesae/md/releases/tag/v0.1.3", notes: '<img src=x onerror="alert(1)">公开说明', bytes: 4 * 1024 ** 2, sha256: "a".repeat(64) };
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let host: HTMLDivElement, view: UpdateSettings, state: UpdateSnapshot;
let save = vi.fn<() => Promise<void>>();
const button = (action: string) => host.querySelector<HTMLButtonElement>('[data-update="' + action + '"]')!;
const dialog = () => host.querySelector<HTMLDialogElement>("dialog")!;
async function show(next: Partial<UpdateSnapshot>) { state = { ...state, ...next }; await view.activate(); }

beforeEach(() => {
  vi.useFakeTimers(); host = document.createElement("div"); document.body.append(host); state = initial(); save = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value() { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value() { this.open = false; } });
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "check_for_updates") state = { ...state, phase: "checking", job: state.job + 1, message: "正在检查公开版本…" };
    if (command === "cancel_update") state = { ...state, phase: "cancelled", offer: null, message: "已取消。" };
    return state;
  });
  view = new UpdateSettings(host, save);
});
afterEach(() => { view.deactivate(); host.remove(); document.body.removeAttribute("tabindex"); vi.clearAllTimers(); vi.useRealTimers(); });

describe("公开更新设置的用户意图与确认边界", () => {
  it("打开设置只读本地状态，默认稳定通道，不自动检查、下载或安装", async () => {
    await view.activate(); await vi.advanceTimersByTimeAsync(3000);
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["get_update_status"]);
    expect(host.querySelectorAll('#update-channel input[type="radio"]')).toHaveLength(2);
    expect(host.querySelector<HTMLInputElement>('#update-channel input:checked')!.value).toBe("stable");
    button("primary").click(); await settle();
    expect(invoke).toHaveBeenCalledWith("check_for_updates", { channel: "stable" });
  });
  it("显式选择预发布后仍需手动检查，旧候选不再显示", async () => {
    await show({ phase: "available", offer });
    const preview = host.querySelector<HTMLInputElement>('input[name="update-channel"][value="preview"]')!;
    preview.focus(); preview.click(); await settle();
    expect(preview.checked).toBe(true); expect(document.activeElement).toBe(preview);
    expect(host.querySelector<HTMLElement>("#update-offer")!.hidden).toBe(true);
    expect(invoke.mock.calls.filter(([name]) => name === "check_for_updates")).toHaveLength(0);
    button("primary").click(); await settle(); expect(invoke).toHaveBeenCalledWith("check_for_updates", { channel: "preview" });
  });
  it("检查、下载和待安装期间锁定两个通道，取消旧候选完成后才恢复选择", async () => {
    const choices = () => [...host.querySelectorAll<HTMLInputElement>('#update-channel input')];
    expect(choices()).toHaveLength(2);
    for (const phase of ["checking", "downloading", "ready"] as const) {
      await show({ phase, offer });
      expect(choices().every(choice => choice.disabled)).toBe(true);
      choices()[1].click(); expect(choices()[0].checked).toBe(true);
    }
    await show({ phase: "idle", offer: null }); const pending = deferred();
    invoke.mockImplementation(async (name: string) => { if (name === "cancel_update") await pending.promise; return state; });
    choices()[1].click(); expect(choices().every(choice => choice.disabled)).toBe(true);
    pending.resolve(); await settle();
    expect(choices().every(choice => !choice.disabled)).toBe(true); expect(choices()[1].checked).toBe(true);
    expect(invoke.mock.calls.filter(([name]) => name === "check_for_updates")).toHaveLength(0);
  });
  it("通道请求完成只恢复丢失的焦点，不覆盖用户转移或离开设置的意图", async () => {
    await view.activate();
    document.body.tabIndex = -1;
    for (const mode of ["restore", "moved", "inactive"]) {
      const pending = deferred();
      invoke.mockImplementation(async (name: string) => { if (name === "cancel_update") await pending.promise; return state; });
      const choice = host.querySelector<HTMLInputElement>('#update-channel input:not(:checked)')!;
      choice.focus(); choice.click();
      // 显式模拟控件禁用期间焦点退回页面，不依赖 jsdom 自动执行失焦。
      document.body.focus();
      if (mode === "moved") button("release").focus();
      if (mode === "inactive") view.deactivate();
      pending.resolve(); await settle();
      expect(document.activeElement).toBe(mode === "restore" ? choice : mode === "moved" ? button("release") : document.body);
    }
  });
  it("远程版本说明以纯文本呈现，进度使用实际下载字节", async () => {
    await show({ phase: "downloading", offer, downloaded: 2 * 1024 ** 2, total: offer.bytes });
    expect(host.querySelector("#update-notes")!.textContent).toBe(offer.notes); expect(host.querySelector("#update-notes img")).toBeNull();
    expect(host.querySelector<HTMLProgressElement>("progress")!.value).toBe(2 * 1024 ** 2);
    expect(host.querySelector("#update-progress-label")!.textContent).toContain("50%");
    expect(button("cancel").hidden).toBe(false); button("cancel").click(); await settle(); expect(invoke).toHaveBeenCalledWith("cancel_update", undefined);
  });
  it("检查请求未返回时双击不会重复提交", async () => {
    await view.activate(); const pending = deferred();
    invoke.mockImplementation(async (name: string) => { if (name === "check_for_updates") await pending.promise; return state; });
    button("primary").click(); button("primary").click(); await settle();
    expect(invoke.mock.calls.filter(([name]) => name === "check_for_updates")).toHaveLength(1); pending.resolve(); await settle();
  });
  it("下载完成不会自动安装，取消保存中的确认会撤销迟到交接", async () => {
    await show({ phase: "ready", offer, downloaded: offer.bytes, total: offer.bytes });
    expect(invoke.mock.calls.filter(([name]) => name === "install_update")).toHaveLength(0);
    const pending = deferred(); save.mockReturnValue(pending.promise);
    button("primary").click(); button("confirm").click(); await settle();
    expect(dialog().open).toBe(true); button("dismiss").click(); pending.resolve(); await settle();
    expect(dialog().open).toBe(false); expect(invoke.mock.calls.filter(([name]) => name === "install_update")).toHaveLength(0);
  });
  it("离开设置撤销尚未提交的安装确认，旧保存结果不能执行安装", async () => {
    await show({ phase: "ready", offer }); const pending = deferred(); save.mockReturnValue(pending.promise);
    button("primary").click(); button("confirm").click(); await settle(); view.deactivate(); pending.resolve(); await settle();
    expect(invoke.mock.calls.filter(([name]) => name === "install_update")).toHaveLength(0);
  });
  it("安装已提交后离开设置也撤下确认框，迟到失败不会恢复隐藏的模态层", async () => {
    await show({ phase: "ready", offer }); const pending = deferred();
    invoke.mockImplementation(async (name: string) => {
      if (name === "install_update") { await pending.promise; throw new Error("安装器未启动"); }
      return state;
    });
    button("primary").click(); button("confirm").click(); await settle();
    expect(invoke.mock.calls.filter(([name]) => name === "install_update")).toHaveLength(1);
    view.deactivate();
    expect(dialog().open).toBe(false); expect(dialog().inert).toBe(true);
    expect(invoke.mock.calls.filter(([name]) => name === "cancel_update")).toHaveLength(0);
    pending.resolve(); await settle();
    expect(dialog().open).toBe(false);
    await view.activate(); button("primary").click();
    expect(dialog().open).toBe(true); expect(button("confirm").disabled).toBe(false);
  });
  it("保存失败保留确认、宣告错误且不启动安装", async () => {
    await show({ phase: "ready", offer }); save.mockRejectedValue(new Error("数据盘不可用"));
    button("primary").click(); button("confirm").click(); await settle();
    expect(dialog().open).toBe(true); expect(button("confirm").disabled).toBe(false);
    expect(host.querySelector("#update-install-status")!.textContent).toContain("数据盘不可用");
    expect(invoke.mock.calls.filter(([name]) => name === "install_update")).toHaveLength(0);
  });
  it("仅单独确认才交接，失败后允许重试并保留应用", async () => {
    await show({ phase: "ready", offer });
    invoke.mockImplementation(async (name: string) => { if (name === "install_update") throw new Error("安装器未启动"); return state; });
    button("primary").click(); button("confirm").click(); button("confirm").click(); await settle();
    expect(invoke.mock.calls.filter(([name]) => name === "install_update")).toHaveLength(1);
    expect(button("confirm").disabled).toBe(false); expect(button("dismiss").disabled).toBe(false);
  });
  it("限流等待不自动请求，时间到后仅恢复手动按钮", async () => {
    await show({ phase: "error", message: "匿名请求已限流", retryAt: Math.floor(Date.now() / 1000) + 60 });
    expect(button("primary").disabled).toBe(true); expect(host.querySelector("#update-status")!.getAttribute("role")).toBe("alert");
    await vi.advanceTimersByTimeAsync(61_000); expect(button("primary").disabled).toBe(false);
    expect(invoke.mock.calls.filter(([name]) => name === "check_for_updates")).toHaveLength(0);
    button("release").click(); await settle(); expect(invoke).toHaveBeenCalledWith("open_update_release");
  });
});
