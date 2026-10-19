import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Session } from "./types";
import "./styles.css";

// 初始骨架先证明自定义数据目录和桌面桥接；后续阶段接入完整阅读操作。
const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `<main class="welcome"><span class="wordmark">md<span>·</span></span>
  <h1>留一点时间，给阅读。</h1><p>MD · 本地 Markdown 阅读器</p>
  <p id="status" role="status">正在连接桌面会话…</p></main>`;

async function start(): Promise<void> {
  const status = document.querySelector<HTMLParagraphElement>("#status")!;
  if (!isTauri()) {
    status.textContent = "此页面为桌面应用界面，请运行 npm run desktop 启动。";
    return;
  }
  try {
    const session = await invoke<Session>("get_session");
    status.textContent = `数据位置：${session.root}`;
    document.documentElement.dataset.theme = session.state.preferences.theme;
  } catch (error) { status.textContent = `无法连接：${String(error)}`; }
}

void start();
