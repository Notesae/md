import { describe, expect, it } from "vitest";
import { PreferenceStore } from "../src/preferences";
import type { Preferences } from "../src/types";

const initial: Preferences = { theme: "light", fontSize: 18, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 };

describe("偏好独立状态与串行持久化", () => {
  it("会话快照刷新不能回退当前主题，后续缓存变更保留用户主题", async () => {
    const remote = { ...initial }; const writes: Preferences[] = [];
    const store = new PreferenceStore(remote, async (value) => { writes.push(value); }, () => {});
    store.update({ theme: "dark" }); remote.theme = "light";
    store.update({ persistentCache: false }); await store.flush();
    expect(writes.at(-1)).toMatchObject({ theme: "dark", persistentCache: false });
  });
  it("前一次写入未结束时，后来的完整偏好必须最后保存", async () => {
    let release!: () => void; const waiting = new Promise<void>((resolve) => { release = resolve; });
    const writes: Preferences[] = [];
    const store = new PreferenceStore(initial, async (value) => { writes.push(value); if (writes.length === 1) await waiting; }, () => {});
    store.update({ theme: "dark" }); const first = store.flush();
    await Promise.resolve(); await Promise.resolve();
    store.update({ fontSize: 22 }); const second = store.flush();
    expect(writes).toHaveLength(1); release(); await first; await second;
    expect(writes).toHaveLength(2); expect(writes[1]).toMatchObject({ theme: "dark", fontSize: 22 });
  });
  it("暂时写入失败后保留待保存状态，显式刷新可重试", async () => {
    let attempts = 0;
    const store = new PreferenceStore(initial, async () => { if (++attempts === 1) throw new Error("磁盘不可写"); }, () => {});
    store.update({ contentWidth: 900 }); await expect(store.flush()).rejects.toThrow("磁盘不可写");
    await store.flush(); expect(attempts).toBe(2); expect(store.snapshot.contentWidth).toBe(900);
  });
  it("旧写入失败不能把已保存的新偏好重新覆盖", async () => {
    let reject!: (error: Error) => void;
    const firstAttempt = new Promise<void>((_, fail) => { reject = fail; });
    const writes: Preferences[] = [];
    const store = new PreferenceStore(initial, async (value) => { writes.push(value); if (writes.length === 1) await firstAttempt; }, () => {});
    store.update({ theme: "dark" }); const first = store.flush();
    const failed = expect(first).rejects.toThrow("旧写入失败");
    await Promise.resolve(); await Promise.resolve();
    store.update({ fontSize: 24 }); const latest = store.flush();
    reject(new Error("旧写入失败")); await failed; await latest; await store.flush();
    expect(writes).toHaveLength(2); expect(writes.at(-1)?.fontSize).toBe(24);
  });
});
