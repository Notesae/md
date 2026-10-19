import type { Preferences } from "./types";

/** 偏好独立于可刷新的会话快照，合并频繁变更并按顺序写入，失败只保留最新待保存值。 */
export class PreferenceStore {
  private value: Preferences;
  private version = 0;
  private pending: { value: Preferences; version: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private saving: Promise<void> = Promise.resolve();

  constructor(initial: Preferences, private readonly save: (value: Preferences) => Promise<void>, private readonly onError: (error: unknown) => void) {
    this.value = { ...initial };
  }

  get snapshot(): Preferences { return { ...this.value }; }

  update(patch: Partial<Preferences>): void {
    this.value = { ...this.value, ...patch };
    this.pending = { value: this.snapshot, version: ++this.version };
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.flush().catch(this.onError); }, 180);
  }

  /** 强制提交最新快照，用于维护和退出边界；旧失败不能恢复成更新之后的待保存值。 */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    const pending = this.pending;
    this.pending = null;
    if (!pending) return this.saving;
    this.saving = this.saving.catch(() => {}).then(async () => {
      try { await this.save(pending.value); }
      catch (error) {
        if (this.version === pending.version && !this.pending) this.pending = pending;
        throw error;
      }
    });
    return this.saving;
  }
}
