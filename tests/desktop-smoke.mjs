import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";

// 使用 Tauri 官方驱动和真实 WebView2/IPC，所有状态与测试产物隔离于工作目录。
const root = process.cwd();
const report = path.join(root, ".reports");
const captures = path.join(root, ".impeccable/review");
await mkdir(report, { recursive: true }); await mkdir(captures, { recursive: true });
const binary = path.resolve(process.argv[2] ?? ".tools/target/debug/md-reader.exe");
const driver = spawn(path.join(root, ".tools/cargo/bin/tauri-driver.exe"), ["--native-driver", path.join(root, ".tools/webdriver/msedgedriver.exe"), "--port", "4450", "--native-port", "4451"], {
  cwd: root, windowsHide: true, env: { ...process.env, MD_BOOTSTRAP_DIR: path.join(root, ".runtime/desktop-smoke/bootstrap"), TEMP: path.join(root, ".tools/tmp"), TMP: path.join(root, ".tools/tmp") },
  stdio: ["ignore", "pipe", "pipe"],
});
let driverLog = "";
driver.stdout.on("data", (chunk) => { driverLog = (driverLog + chunk).slice(-16_384); });
driver.stderr.on("data", (chunk) => { driverLog = (driverLog + chunk).slice(-16_384); });
driver.on("error", (error) => { driverLog += error.message; });
const endpoint = "http://127.0.0.1:4450";
let sessionId;
const checks = [];

/** 保留 WebDriver 原始错误，不将不支持或脚本失败吞掉并伪装为测试成功。 */
async function command(method, resource, body) {
  const response = await fetch(endpoint + resource, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}
const script = (source, args = []) => command("POST", `/session/${sessionId}/execute/sync`, { script: source, args });
const click = (selector) => script("document.querySelector(arguments[0]).click();", [selector]);
const invoke = (name, payload = {}) => command("POST", `/session/${sessionId}/execute/async`, {
  script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({value}), error => done({error: String(error)}));", args: [name, payload],
}).then((result) => { if (result.error) throw new Error(result.error); return result.value; });

async function until(probe, message, duration = 20_000) {
  const start = Date.now();
  while (Date.now() - start < duration) { try { if (await probe()) return; } catch { /* 启动观察期间连接尚未就绪，持续检查同一驱动。 */ } await new Promise((resolve) => setTimeout(resolve, 150)); }
  throw new Error(message);
}

async function screenshot(name) {
  const png = await command("GET", `/session/${sessionId}/screenshot`);
  await writeFile(path.join(captures, `${name}.png`), Buffer.from(png, "base64"));
}

try {
  await until(async () => { const r = await fetch(endpoint + "/status"); return r.ok; }, "驱动未启动：" + driverLog, 30_000);
  const created = await command("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: binary } } } });
  sessionId = created.sessionId;
  await until(() => script("return document.querySelector('#article h1')?.textContent.includes('留一点时间');"), "真实窗口未恢复阅读样例");
  checks.push("真实桌面启动、恢复文章与全文渲染");
  const state = await invoke("get_session");
  assert.equal(path.normalize(state.root), path.join(root, ".runtime/desktop-smoke/data"));
  const bootstrap = JSON.parse(await readFile(path.join(root, ".runtime/desktop-smoke/bootstrap/bootstrap.json"), "utf8"));
  assert.equal(path.normalize(bootstrap.root), path.normalize(state.root));
  checks.push("真实 IPC 返回隔离数据根，定位信息一致");

  await click('[data-action="search"]');
  await script("const input = document.querySelector('#search-input'); input.value = '原始'; input.dispatchEvent(new Event('input', {bubbles:true}));");
  await until(() => script("return document.querySelector('#search-count').textContent.includes('/');"), "搜索未产生结果");
  assert.ok(await script("return CSS.highlights.get('matches').size > 0;"));
  checks.push("正文搜索使用真实文本范围与 CSS 高亮");
  await click('[data-action="close-search"]');

  await script("document.querySelector('.outline-link:last-child').click();");
  await until(() => script("return document.querySelector('#reading-pane').scrollTop > 200;"), "目录跳转没有移动正文");
  await script("document.querySelector('.math').scrollIntoView({block: 'center'});");
  await until(() => script("return document.querySelector('.katex') !== null;"), "可见公式没有完成 Worker 排版");
  await script("document.querySelector('pre').scrollIntoView({block: 'center'});");
  await until(() => script("return document.querySelector('pre code[data-enhanced]') !== null;"), "可见代码没有完成高亮");
  checks.push("目录跳转、可视公式与代码 Worker 增强");

  await click('[data-action="top"]');
  await screenshot("desktop");
  await click('[data-action="theme"]');
  await until(() => script("return document.documentElement.dataset.theme === 'dark';"), "深色切换失败");
  await screenshot("desktop-dark");
  await click('[data-action="settings"]');
  await until(() => script("return !document.querySelector('#settings').hidden;"), "设置未打开");
  await screenshot("settings");
  assert.ok(await script("return document.querySelector('#data-root').textContent.length > 0;"));
  checks.push("同窗口设置、深色主题与实际数据位置");
  await click('[data-action="settings"]');
  assert.ok(await script("return document.documentElement.scrollWidth <= document.documentElement.clientWidth;"));

  await new Promise((resolve) => setTimeout(resolve, 900));
  const persisted = JSON.parse(await readFile(path.join(state.root, "state/preferences.json"), "utf8"));
  assert.equal(persisted.preferences.theme, "dark");
  assert.ok(persisted.recent.length > 0);
  checks.push("主题与阅读历史实际写入 state，独立于 WebView 缓存");
  await writeFile(path.join(report, "desktop-smoke.json"), JSON.stringify({ binary, date: new Date().toISOString(), checks, result: "passed" }, null, 2));
  console.log(JSON.stringify({ result: "passed", checks }, null, 2));
} catch (error) {
  await writeFile(path.join(report, "desktop-smoke.json"), JSON.stringify({ binary, checks, result: "failed", error: String(error), driverLog }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  if (sessionId) await command("DELETE", `/session/${sessionId}`).catch(() => {});
  driver.kill();
  await writeFile(path.join(report, "webdriver.log"), driverLog);
}
