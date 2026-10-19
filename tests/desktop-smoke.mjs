import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, appendFile, rm } from "node:fs/promises";
import path from "node:path";

// 使用 Tauri 官方驱动和真实 WebView2/IPC，所有状态与测试产物隔离于工作目录。
const root = process.cwd();
// 每次运行从同一偏好与文章开始，前次失败不能影响本次断言。
const preparation = spawnSync(process.execPath, ["scripts/desktop.mjs", "cargo", "run", "--offline", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", "--example", "prepare_test"], { cwd: root, windowsHide: true, encoding: "utf8" });
assert.equal(preparation.status, 0, preparation.stderr);
const report = path.join(root, ".reports");
const captures = path.join(root, ".impeccable/review");
await mkdir(report, { recursive: true }); await mkdir(captures, { recursive: true });
const watched = path.join(root, "fixtures/_watch-smoke.md");
await writeFile(watched, "# 阅读位置验证\n\n" + Array.from({ length: 160 }, (_, index) => `## 段落 ${index}\n\n第 ${index} 段内容：外部更新后，应保留用户正在阅读的内容与位置。\n\n`).join(""));
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
const positions = [];
// 记录视口中实际命中的源块，区分百分比变化和可见内容漂移。
const visiblePosition = () => script("const pane = document.querySelector('#reading-pane'); const rect = pane.getBoundingClientRect(); const block = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(80, rect.height / 3))?.closest('.md-block'); return {ratio: pane.scrollTop / (pane.scrollHeight - pane.clientHeight), heading: document.querySelector('.outline-link[aria-current]')?.textContent, block: block?.dataset.block, text: block?.textContent.slice(0,100), top: block?.getBoundingClientRect().top, scroll: pane.scrollTop, height: pane.scrollHeight};");

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
  await until(async () => (await invoke("get_session")).state.preferences.theme === "dark", "深色偏好未写入后台");
  await screenshot("desktop-dark");
  await click('[data-action="settings"]');
  await until(() => script("return !document.querySelector('#settings').hidden;"), "设置未打开");
  await until(() => script("return document.querySelector('#storage-status')?.textContent.includes('总占用');"), "存储分类统计没有完成");
  await screenshot("settings");
  assert.ok(await script("return document.querySelector('#data-root').textContent.length > 0;"));
  checks.push("同窗口设置、深色主题与实际数据位置");
  const storageBefore = await invoke("get_storage_info");
  assert.ok(storageBefore.usage.cacheBytes > 0);
  const stateBeforeCleanup = await invoke("get_session");
  await invoke("clear_cache");
  assert.equal((await invoke("get_storage_info")).usage.cacheBytes, 0);
  const stateAfterCleanup = await invoke("get_session");
  assert.deepEqual(stateBeforeCleanup.state, stateAfterCleanup.state);
  checks.push("实际缓存生成、分类统计、清缓存保留偏好和历史");
  await click("#cache-enabled");
  await until(async () => !(await invoke("get_session")).state.preferences.persistentCache, "关闭缓存未保存");
  await click('[data-action="settings"]');
  const oldRevision = await script("return document.querySelector('#article').dataset.revision;");
  await script("Array.from(document.querySelectorAll('#file-tree .file-row')).find(button => button.textContent.includes('welcome.md')).click();");
  await until(() => script("return document.querySelector('#article').dataset.revision !== arguments[0] && !document.querySelector('#document-status').textContent.includes('正在打开');", [oldRevision]), "关闭缓存后重新打开未完成");
  assert.equal((await invoke("get_storage_info")).usage.cacheBytes, 0);
  await click('[data-action="settings"]'); await click("#cache-enabled");
  await until(async () => (await invoke("get_session")).state.preferences.persistentCache, "重新启用缓存未保存");
  await click('[data-action="settings"]');
  checks.push("设置页关闭持久缓存后实际打开文章不产生缓存");
  assert.ok(await script("return document.documentElement.scrollWidth <= document.documentElement.clientWidth;"));

  await new Promise((resolve) => setTimeout(resolve, 900));
  const persisted = JSON.parse(await readFile(path.join(state.root, "state/preferences.json"), "utf8"));
  assert.equal(persisted.preferences.theme, "dark");
  assert.ok(persisted.recent.length > 0);
  checks.push("主题与阅读历史实际写入 state，独立于 WebView 缓存");

  await until(() => script("return Array.from(document.querySelectorAll('#file-tree .file-row')).some(button => button.textContent.includes('_watch-smoke.md'));"), "按需目录没有包含测试文章");
  await script("Array.from(document.querySelectorAll('#file-tree .file-row')).find(button => button.textContent.includes('_watch-smoke.md')).click();");
  await until(() => script("return document.querySelector('#article h1')?.textContent.includes('阅读位置验证');"), "文件树没有打开文章");
  await until(() => script("return document.querySelectorAll('#article .md-block').length >= 320;"), "长篇文章未完整展示");
  await script("const pane = document.querySelector('#reading-pane'); pane.scrollTop = (pane.scrollHeight - pane.clientHeight) * .5;");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const beforeRefresh = await visiblePosition(); positions.push(beforeRefresh);
  await appendFile(watched, "\n## 外部更新验证\n\n应自动刷新。\n");
  await until(() => script("return document.querySelector('#article').textContent.includes('外部更新验证');"), "外部修改没有自动刷新");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterRefresh = await visiblePosition(); positions.push(afterRefresh);
  assert.ok(Math.abs(beforeRefresh.ratio - afterRefresh.ratio) < .05, JSON.stringify({ beforeRefresh, afterRefresh }));
  assert.equal(afterRefresh.heading, beforeRefresh.heading, "刷新应保留正在阅读的标题位置");
  checks.push("文件树打开、编辑器写入后自动刷新与阅读位置保持");
  await click('[data-action="settings"]');
  await appendFile(watched, "\n## 设置页期间更新\n\n返回阅读后刷新。\n");
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await script("return document.querySelector('#settings').hidden;"), false);
  await click('[data-action="settings"]');
  await until(() => script("return document.querySelector('#article').textContent.includes('设置页期间更新');"), "返回阅读后没有刷新延迟的变更");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await script("return document.querySelector('.outline-link[aria-current]')?.textContent;"), beforeRefresh.heading);
  checks.push("设置页期间文件变化延迟刷新并保留原阅读锚点");
  await script("Array.from(document.querySelectorAll('#file-tree .file-row')).find(button => button.textContent.includes('welcome.md')).click();");
  await until(() => script("return document.querySelector('#document-name').textContent === 'welcome.md';"), "测试后未恢复样例文章");
  await writeFile(path.join(report, "desktop-smoke.json"), JSON.stringify({ binary, date: new Date().toISOString(), checks, result: "passed" }, null, 2));
  console.log(JSON.stringify({ result: "passed", checks }, null, 2));
} catch (error) {
  const trace = sessionId ? await invoke("get_session").catch(() => null) : null;
  if (sessionId) await screenshot("failure").catch(() => {});
  await writeFile(path.join(report, "desktop-smoke.json"), JSON.stringify({ binary, checks, result: "failed", error: String(error), driverLog, trace, positions }, null, 2));
  console.error(error); process.exitCode = 1;
} finally {
  if (sessionId) await command("DELETE", `/session/${sessionId}`).catch(() => {});
  driver.kill();
  await rm(watched, { force: true });
  await writeFile(path.join(report, "webdriver.log"), driverLog);
}
