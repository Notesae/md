import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, stat, access } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import path from "node:path";

// 使用独立归属和真实 WebView2；离线注入已持久化的维护意图，模拟重启交接点。
const workspace = process.cwd();
const base = path.join(workspace, ".runtime/native-maintenance", randomUUID());
const source = path.join(base, "source"); const target = path.join(base, "target");
const bootstrap = path.join(base, "bootstrap"); const instance = randomUUID();
const article = path.join(workspace, "fixtures/welcome.md");
const originalHash = createHash("sha256").update(await readFile(article)).digest("hex");
const binary = path.resolve(process.argv[2] ?? ".tools/target/release/md-reader.exe");
const preferences = { theme: "dark", fontSize: 22, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 };
for (const directory of [bootstrap, ...["state", "cache", "webview", "logs", "temp"].map((name) => path.join(source, name))]) await mkdir(directory, { recursive: true });
await writeFile(path.join(source, "owner.json"), JSON.stringify({ app_id: "io.notesae.mdreader", format_version: 1, instance_id: instance, state_written: true }));
await writeFile(path.join(source, "state/preferences.json"), JSON.stringify({ preferences, recent: [], folders: [path.dirname(article)], lastFile: article, window: { width: 1280, height: 860, maximized: false } }));
await writeFile(path.join(source, "cache/old-session-probe"), "不得迁移的缓存");
let record = { format_version: 1, root: source, instance_id: instance };
const environment = { ...process.env, MD_BOOTSTRAP_DIR: bootstrap, TEMP: path.join(workspace, ".tools/tmp"), TMP: path.join(workspace, ".tools/tmp") };
for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith("WEBVIEW2_")) delete environment[key];
let app; const checks = [];

/** 维护前后均写两份有效引导，仅用于隔离夹具的故障边界准备。 */
async function saveRecord() { for (const name of ["bootstrap.json", "bootstrap.recovery.json"]) await writeFile(path.join(bootstrap, name), JSON.stringify(record)); }
const readRecord = async () => JSON.parse(await readFile(path.join(bootstrap, "bootstrap.json"), "utf8"));
const readState = async (root) => JSON.parse(await readFile(path.join(root, "state/preferences.json"), "utf8"));
async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

async function until(probe, message) {
  const start = Date.now(); while (Date.now() - start < 60_000) { if (await probe()) return; if (app?.exitCode !== null) throw new Error(`程序提前退出 ${app.exitCode}`); await new Promise((resolve) => setTimeout(resolve, 150)); } throw new Error(message);
}

/** 仅关闭本测试创建的应用进程；残存 WebView 会由真实启动协议等待退出。 */
async function stop() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((resolve) => app.once("exit", resolve)); app.kill(); await exited; app = undefined;
}
function launch() { app = spawn(binary, [], { env: environment, windowsHide: true, stdio: "ignore" }); app.on("error", (error) => { throw error; }); }

const result = { binary, base, checks, result: "running" };
try {
  await saveRecord(); launch();
  await until(async () => (await readState(source)).recent.length > 0 && await exists(path.join(source, "webview/EBWebView/Local State")), "初次真实会话没有就绪");
  await writeFile(path.join(source, "webview/old-session-probe"), "旧会话清理探针");
  const oldBrowser = (await stat(path.join(source, "webview/EBWebView/Local State"))).birthtimeMs;
  await stop(); record = await readRecord(); record.reset_webview = []; await saveRecord(); launch();
  await until(async () => { const current = await readRecord(); return !current.reset_webview && (current.notice ?? "").includes("重建") && !await exists(path.join(source, "webview/old-session-probe")) && await exists(path.join(source, "webview/EBWebView/Local State")); }, "真实旧会话退出后的浏览器重建失败");
  assert.deepEqual((await readState(source)).preferences, preferences);
  assert.ok((await stat(path.join(source, "webview/EBWebView/Local State"))).birthtimeMs >= oldBrowser);
  checks.push("真实 WebView2 会话退出后重建用户数据，偏好与历史保留");
  await stop(); record = await readRecord(); record.migration = { source, target, instance_id: instance, phase: "Preparing", previous: [] }; await saveRecord(); launch();
  await until(async () => { const current = await readRecord(); return path.normalize(current.root) === target && !current.migration && !current.pending_cleanup && !await exists(source); }, "真实迁移未完成健康提交与旧根清理");
  assert.deepEqual((await readState(target)).preferences, preferences);
  assert.ok(await exists(path.join(target, "webview/EBWebView/Local State")));
  assert.equal(await exists(path.join(target, "cache/old-session-probe")), false);
  assert.equal(createHash("sha256").update(await readFile(article)).digest("hex"), originalHash);
  checks.push("启动前复制校验、切换新根、真实首屏健康确认、清理旧根，原文保持不变");
  result.result = "passed";
} catch (error) { result.result = "failed"; result.error = String(error); process.exitCode = 1; console.error(error); }
finally { await stop(); await mkdir(path.join(workspace, ".reports"), { recursive: true }); await writeFile(path.join(workspace, ".reports/native-maintenance.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
