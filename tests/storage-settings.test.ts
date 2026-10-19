// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StorageSettings } from "../src/storage-settings";

const native = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
let view: StorageSettings;
let container: HTMLElement;
let beforeMaintenance: Mock<() => Promise<void>>;
let message: Mock<(text: string, persistent?: boolean) => void>;
const info = { usage: { stateBytes: 0, cacheBytes: 1024, webviewBytes: 2048, logsBytes: 0, tempBytes: 0, totalBytes: 3072, freeBytes: 1024 ** 3 }, residual: null, notice: null };
const preferences = { theme: "light" as const, fontSize: 18, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 };
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const click = (name: string) => container.querySelector<HTMLButtonElement>(`[data-storage="${name}"]`)!.click();
const dialog = () => container.querySelector<HTMLDialogElement>("dialog")!;
const calls = (name: string) => native.invoke.mock.calls.filter(([command]) => command === name);

beforeEach(async () => {
  vi.clearAllMocks(); native.invoke.mockReset(); document.body.innerHTML = '<section id="storage"></section>'; container = document.querySelector("#storage")!;
  // jsdom 只替换对话框的原生展示边界，实际控制器和 DOM 事件仍参与测试。
  native.invoke.mockImplementation(async name => name === "get_storage_info" ? structuredClone(info) : null);
  beforeMaintenance = vi.fn<() => Promise<void>>().mockResolvedValue(undefined); message = vi.fn();
  view = new StorageSettings(container, () => preferences, vi.fn(), beforeMaintenance, message);
  Object.assign(dialog(), { showModal(this: HTMLDialogElement) { this.open = true; }, close(this: HTMLDialogElement) { this.open = false; } });
  await view.activate();
});
afterEach(() => { vi.restoreAllMocks(); });

describe("存储维护的异步确认边界", () => {
  it("选择目录返回前离开设置，迟到选择不能打开隐藏页面的确认框", async () => {
    const choosing = deferred<string | null>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "choose_storage_target" ? choosing.promise : original(name));
    click("migrate"); await settle(); view.deactivate(); choosing.resolve("R:\\合成数据\\新位置"); await settle();
    expect(dialog().open).toBe(false); expect(calls("cancel_storage_target").length).toBeGreaterThan(0);
    expect(calls("migrate_storage")).toHaveLength(0);
  });

  it("确认仍在保存偏好时取消，不执行后续缓存清理", async () => {
    const saving = deferred<void>(); beforeMaintenance.mockReturnValueOnce(saving.promise);
    click("cache"); await settle(); click("confirm"); await settle(); click("cancel"); await settle();
    saving.resolve(); await settle(); expect(dialog().open).toBe(false); expect(calls("clear_cache")).toHaveLength(0);
  });

  it("Escape 在保存准备期间同样取消，旧保存回调不能提交维护", async () => {
    const saving = deferred<void>(); beforeMaintenance.mockReturnValueOnce(saving.promise);
    click("cache"); await settle(); click("confirm"); await settle();
    dialog().dispatchEvent(new Event("cancel", { cancelable: true })); saving.resolve(); await settle();
    expect(dialog().open).toBe(false); expect(calls("clear_cache")).toHaveLength(0);
  });

  it("原生清理已开始后禁用取消和重复提交，Escape 不能伪装取消成功", async () => {
    const cleaning = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "clear_cache" ? cleaning.promise : original(name));
    click("cache"); await settle(); click("confirm"); await settle();
    expect(container.querySelector<HTMLButtonElement>('[data-storage="cancel"]')!.disabled).toBe(true);
    click("confirm"); click("cancel"); const escape = new Event("cancel", { cancelable: true }); dialog().dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(true); expect(dialog().open).toBe(true); expect(calls("clear_cache")).toHaveLength(1);
    cleaning.resolve(); await settle(); expect(dialog().open).toBe(false); expect(message).toHaveBeenCalledOnce();
  });

  it("维护开始后离开页面，迟到完成不会重新激活隐藏设置", async () => {
    const cleaning = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "clear_cache" ? cleaning.promise : original(name));
    click("cache"); await settle(); click("confirm"); await settle(); view.deactivate();
    cleaning.resolve(); await settle(); expect(calls("get_storage_info")).toHaveLength(1); expect(dialog().open).toBe(false);
    expect(calls("cancel_storage_target")).toHaveLength(0);
  });

  it("保存失败保留确认范围和目标，可重试同一次迁移", async () => {
    const original = native.invoke.getMockImplementation()!; const target = "R:\\合成数据\\新位置";
    native.invoke.mockImplementation((name: string) => name === "choose_storage_target" ? Promise.resolve(target) : original(name));
    beforeMaintenance.mockRejectedValueOnce(new Error("偏好未保存")); click("migrate"); await settle(); click("confirm"); await settle();
    expect(dialog().open).toBe(true); expect(container.querySelector("#maintenance-status")!.textContent).toContain("偏好未保存");
    expect(calls("migrate_storage")).toHaveLength(0); expect(container.querySelector<HTMLButtonElement>("#maintenance-confirm")!.disabled).toBe(false);
    click("confirm"); await settle(); expect(calls("migrate_storage")).toEqual([["migrate_storage", { target }]]);
  });

  it("旧选择撤销完成前不发起新选择，不会用迟到取消清掉新授权", async () => {
    const choosing = deferred<string>(); const clearing = deferred<void>(); const original = native.invoke.getMockImplementation()!;
    let picks = 0; let cancels = 0; let authorized: string | null = null;
    native.invoke.mockImplementation((name: string) => {
      if (name === "choose_storage_target") return ++picks === 1 ? choosing.promise.then(path => { authorized = path; return path; }) : Promise.resolve(authorized = "R:\\新目标");
      if (name === "cancel_storage_target") return ++cancels === 1 ? Promise.resolve(authorized = null) : clearing.promise.then(() => { authorized = null; });
      return original(name);
    });
    click("migrate"); await settle(); view.deactivate(); await view.activate(); click("migrate"); await settle(); expect(picks).toBe(1);
    choosing.resolve("R:\\旧目标"); await settle(); click("migrate"); await settle(); expect(picks).toBe(1);
    clearing.resolve(); await settle(); click("migrate"); await settle();
    expect(picks).toBe(2); expect(authorized).toBe("R:\\新目标"); expect(container.querySelector("#maintenance-target")!.textContent).toBe("R:\\新目标");
  });

  it("清理完成后的后台统计不继续锁住新的维护入口", async () => {
    const stats = deferred<typeof info>(); const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "get_storage_info" ? stats.promise : original(name));
    click("cache"); await settle(); click("confirm"); await settle();
    expect(dialog().open).toBe(false); expect(container.querySelector<HTMLButtonElement>('[data-storage="cache"]')!.disabled).toBe(false);
    stats.resolve(structuredClone(info)); await settle();
  });

  it("原生维护失败恢复取消和重试，重试成功后清除错误状态", async () => {
    let attempts = 0; const original = native.invoke.getMockImplementation()!;
    native.invoke.mockImplementation((name: string) => name === "clear_cache" && ++attempts === 1 ? Promise.reject(new Error("合成清理失败")) : original(name));
    click("cache"); await settle(); click("confirm"); await settle();
    expect(dialog().open).toBe(true); expect(container.querySelector("#maintenance-status")!.getAttribute("data-error")).toBe("true");
    expect(container.querySelector<HTMLButtonElement>('[data-storage="cancel"]')!.disabled).toBe(false);
    click("confirm"); await settle(); expect(dialog().open).toBe(false); expect(calls("clear_cache")).toHaveLength(2);
    expect(container.querySelector("#maintenance-status")!.getAttribute("data-error")).toBe("false");
  });
});
