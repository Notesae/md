import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, access, cp, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";
import { chromium } from "playwright-core";
import { saveMaintenanceReport } from "./maintenance-report.mjs";

if (process.platform !== "win32") {
  console.error("原生维护需要 Windows 桌面、WebView2，以及完整模式中的原生目录选择器。");
  process.exit(2);
}

// 使用真实 WebView2 的 CDP，不用会覆盖用户数据目录的 WebDriver；故障只注入隔离夹具。
const workspace = process.cwd();
const base = path.join(workspace, ".runtime/native-maintenance", randomUUID());
const binary = path.resolve(process.argv[2] ?? ".tools/target/release/md-reader.exe");
const checks = []; const fixtures = []; const recoveryOnly = process.argv.includes("--recovery-only");
const result = { binary, base, mode: recoveryOnly ? "recovery-only" : "full", checks, result: "running" };
await mkdir(base, { recursive: true }); await mkdir(path.join(workspace, ".reports"), { recursive: true });
const original = path.join(workspace, "fixtures/welcome.md");
const hash = async (file) => createHash("sha256").update(await readFile(file)).digest("hex");
const originalHash = await hash(original);
result.binarySha256 = await hash(binary); result.startedAt = new Date().toISOString(); result.nodeVersion = process.version;
const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const samePath = (left, right) => path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase();
async function exists(file) { try { await access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }

/** 轮询实际窗口与写盘条件，超时保留最后错误以便诊断。 */
async function until(probe, message, timeout = 30_000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) {
    try { const value = await probe(); if (value) return value; } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${message}${last ? `：${last}` : ""}`);
}
async function passed(message) {
  checks.push(message); console.log(`通过：${message}`);
  await saveMaintenanceReport(workspace, result);
}

/** 每例有独立实例归属、引导与文档；原文位于受管根之外，规范化路径与原生端一致。 */
async function fixture(name) {
  const directory = path.join(base, name); const source = path.join(directory, "旧数据");
  const target = path.join(directory, "新位置", "MdReader"); const bootstrap = path.join(directory, "bootstrap");
  const documents = path.join(directory, "原始文章"); const article = path.join(documents, "长文.md");
  for (const item of [bootstrap, documents, path.dirname(target), ...["state", "cache", "webview", "logs", "temp"].map((name) => path.join(source, name))]) await mkdir(item, { recursive: true });
  await writeFile(article, Array.from({ length: 100 }, (_, index) => `## 第 ${index + 1} 节\n\n${"阅读位置与迁移验证，原始正文只读。".repeat(45)}\n\n`).join(""));
  const owner = { app_id: "io.notesae.mdreader", format_version: 1, instance_id: randomUUID(), state_written: true };
  const state = { preferences: { theme: "dark", fontSize: 22, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 },
    recent: [{ path: path.toNamespacedPath(article), position: .45, block: 90, offset: 12, anchorHash: null, openedAt: 1 }],
    folders: [path.toNamespacedPath(documents)], folderClosed: true, lastFile: path.toNamespacedPath(article), window: { width: 1280, height: 860, maximized: false } };
  await writeFile(path.join(source, "owner.json"), JSON.stringify(owner));
  await writeFile(path.join(source, "state/preferences.json"), JSON.stringify(state));
  await writeFile(path.join(source, "cache/old-cache-probe"), "不得迁移的缓存");
  await writeFile(path.join(source, "webview/old-webview-probe"), "不得迁移的浏览器数据");
  const record = { format_version: 1, root: source, instance_id: owner.instance_id };
  const context = { directory, source, target, bootstrap, article, owner, state, record, pids: new Set() };
  context.articleHash = await hash(article); fixtures.push(context); await saveRecord(context); return context;
}
async function saveRecord(context) { for (const name of ["bootstrap.json", "bootstrap.recovery.json"]) await writeFile(path.join(context.bootstrap, name), JSON.stringify(context.record)); }
const readRecord = (context) => readJson(path.join(context.bootstrap, "bootstrap.json"));
const readState = (root) => readJson(path.join(root, "state/preferences.json"));
const invoke = (context, name, payload = {}) => context.page.evaluate(({ name, payload }) => window.__TAURI_INTERNALS__.invoke(name, payload), { name, payload });

/** 只有测试进程继承调试端口；维护重启沿用环境，实际数据目录仍由产品配置。 */
async function launch(context, healthy = true) {
  if (!context.port) {
    const server = createServer(); await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.port = server.address().port; await new Promise((resolve) => server.close(resolve));
  }
  const environment = { ...process.env, MD_BOOTSTRAP_DIR: context.bootstrap, MD_STARTUP_PROBE: "1", TEMP: path.join(workspace, ".tools/tmp"), TMP: path.join(workspace, ".tools/tmp") };
  for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith("WEBVIEW2_")) delete environment[key];
  environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${context.port}`;
  context.app = spawn(binary, [], { env: environment, windowsHide: true, stdio: "ignore" }); context.pids.add(context.app.pid);
  context.app.on("error", (error) => { context.launchError = error; }); await attach(context, undefined, context.app.pid, healthy);
}
async function attach(context, previousPid, expectedPid, healthy = true) {
  if (healthy) await until(async () => {
    if (context.launchError) throw context.launchError;
    const record = await readRecord(context); const probe = await readJson(path.join(record.root, "temp/startup-probe.json"));
    // 探针只在健康提交成功后出现；这里仍要继续等待旧目录清理完成。
    if (probe.processId === previousPid || (expectedPid && probe.processId !== expectedPid)) return false;
    context.pids.add(probe.processId); context.pid = probe.processId; context.root = record.root; return true;
  }, "原生窗口未确认就绪");
  await until(async () => (await fetch(`http://127.0.0.1:${context.port}/json/version`)).ok, "CDP 未就绪");
  context.browser = await chromium.connectOverCDP(`http://127.0.0.1:${context.port}`);
  result.webviewVersion ??= context.browser.version();
  context.page = await until(() => context.browser.contexts()[0]?.pages().find((page) => page.url().includes("tauri.localhost")), "没有找到阅读窗口");
  if (healthy) {
    await context.page.waitForFunction(() => document.querySelectorAll(".md-block").length === 200 && document.querySelector("#document-end")?.hidden === false);
    await context.page.waitForFunction(() => document.querySelector("#reading-pane").scrollTop > 100);
  }
}

/** 正常关闭优先；异常只终止本脚本记录的应用 PID，从不杀系统 Edge/WebView。 */
async function stop(context) {
  if (!context) return;
  if (context.page && !context.page.isClosed()) {
    await context.page.evaluate(() => { void window.__TAURI_INTERNALS__.invoke("plugin:window|close", { label: "main" }); }).catch(() => {}); await delay(500);
  }
  for (const pid of context.pids) { try { process.kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  await context.browser?.close().catch(() => {}); context.browser = undefined; context.page = undefined;
  for (const root of [context.source, context.target]) await new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tests/wait-profile.ps1", "-ProfilePath", path.join(root, "webview")], { windowsHide: true, stdio: "pipe" });
    let output = ""; child.stderr.on("data", (data) => { output += data; }); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(output))); child.on("error", reject);
  });
  context.pids.clear();
}
async function verifyRestored(context, expected) {
  const session = await invoke(context, "get_session");
  assert.deepEqual(session.state.preferences, expected.preferences); assert.deepEqual(session.state.folders, expected.folders);
  assert.equal(session.state.folderClosed, true); assert.equal(session.state.lastFile, expected.lastFile);
  const saved = session.state.recent.find((item) => item.path === expected.lastFile); const old = expected.recent.find((item) => item.path === expected.lastFile);
  assert.equal(saved.block, old.block); assert.ok(Math.abs(saved.offset - old.offset) < 1, "持久位置偏移超过 1px");
  if (old.anchorHash) assert.equal(saved.anchorHash, old.anchorHash);
  assert.equal(await context.page.locator("#recent-files .file-row").count(), 1); assert.equal(await context.page.locator("#recent-folder").inputValue(), "");
  assert.equal(await context.page.locator("html").getAttribute("data-theme"), expected.preferences.theme);
  const anchor = await context.page.evaluate((block) => document.querySelector(`[data-block="${block}"]`).getBoundingClientRect().top - document.querySelector("#reading-pane").getBoundingClientRect().top, old.block);
  assert.ok(Math.abs(anchor + old.offset) < 8, `阅读锚点漂移 ${anchor}, 预期 ${-old.offset}`);
}
const intent = (context, phase = "Preparing") => ({ source: context.source, target: context.target, instance_id: context.owner.instance_id, phase, previous: [] });

let active; let occupiedSession;
try {
  if (!recoveryOnly) {
    active = await fixture("真实维护"); await launch(active); await verifyRestored(active, active.state);
    await active.page.locator('[data-action="theme"]').click();
    await until(async () => (await readState(active.source)).preferences.theme === "light", "主题未落盘");
    await active.page.evaluate(() => localStorage.setItem("native-maintenance-probe", "旧浏览器会话"));
    await active.page.locator('[data-action="settings"]').first().click(); await active.page.locator('[data-storage="webview"]').click();
    await active.page.locator("#maintenance-dialog").waitFor({ state: "visible" });
    const expected = await readState(active.source); const oldPid = active.pid;
    await active.page.locator("#maintenance-confirm").click(); await attach(active, oldPid);
    assert.notEqual(active.pid, oldPid); assert.match((await readRecord(active)).notice, /重建/);
    assert.equal(await exists(path.join(active.source, "webview/old-webview-probe")), false);
    assert.equal(await active.page.evaluate(() => localStorage.getItem("native-maintenance-probe")), null); await verifyRestored(active, expected);
    await passed("真实设置入口重建 WebView 并原生重启：偏好、历史、关闭目录及阅读锚点保留，旧浏览器数据消失");

    await active.page.locator('[data-action="settings"]').first().click(); await active.page.locator('[data-storage="migrate"]').click();
    console.log(`PICKER_PARENT=${path.dirname(active.target)}`);
    // 原生选择器由桌面自动化或操作者选择上述隔离父目录，不伪造产品授权字段。
    await active.page.locator("#maintenance-dialog").waitFor({ state: "visible", timeout: 180_000 });
    assert.ok(samePath(await active.page.locator("#maintenance-target").innerText(), active.target));
    const beforeMigration = await readState(active.source); const beforePid = active.pid;
    await active.page.locator("#maintenance-confirm").click(); await attach(active, beforePid);
    await until(async () => { const record = await readRecord(active); return samePath(record.root, active.target) && !record.migration && !record.pending_cleanup && !await exists(active.source); }, "迁移未完成健康提交与旧目录清理");
    await verifyRestored(active, beforeMigration); assert.equal(await exists(path.join(active.target, "cache/old-cache-probe")), false);
    assert.ok(await exists(path.join(active.target, "webview/EBWebView/Local State")));
    await stop(active); await launch(active); await verifyRestored(active, beforeMigration);
    await passed("真实原生选目录、设置确认、维护重启与再次启动：新根有效、旧根清除、必要状态及位置保留，缓存重新生成"); await stop(active);
  }

  active = await fixture("复制中断恢复"); await mkdir(path.join(active.target, "temp/migration-state"), { recursive: true });
  await writeFile(path.join(active.target, "owner.json"), JSON.stringify(active.owner)); await writeFile(path.join(active.target, "temp/migration-state/preferences.json"), "partial");
  active.record.migration = intent(active); await saveRecord(active); await launch(active); await verifyRestored(active, active.state);
  await until(async () => !(await readRecord(active)).pending_cleanup && !await exists(active.source), "中断恢复后旧目录未清理");
  await passed("复制中断的残缺暂存从源重建，经真实新窗口健康确认后清理旧根"); await stop(active);

  active = await fixture("复制失败回滚");
  await writeFile(path.join(active.source, "state/oversized-probe"), Buffer.alloc(8 * 1024 * 1024 + 1));
  active.record.migration = intent(active); await saveRecord(active); await launch(active); await verifyRestored(active, active.state);
  let record = await readRecord(active); assert.ok(samePath(record.root, active.source)); assert.match(record.notice, /迁移预算/);
  assert.ok(record.pending_cleanup); assert.ok(await exists(path.join(active.source, "state/oversized-probe")));
  await invoke(active, "retry_storage_cleanup"); assert.equal(await exists(active.target), false);
  await passed("复制必要状态超出预算时中止：真实启动回滚源根、源文件完整，目标暂存可安全重试清理"); await stop(active);

  active = await fixture("目标校验失败"); await cp(active.source, active.target, { recursive: true });
  await writeFile(path.join(active.target, "state/preferences.json"), "{}"); active.record.migration = intent(active, "TargetReady");
  await saveRecord(active); await launch(active); await verifyRestored(active, active.state);
  record = await readRecord(active); assert.ok(samePath(record.root, active.source)); assert.equal(record.migration, null);
  assert.ok(samePath(record.pending_cleanup.path, active.target)); assert.match(record.notice, /不一致/);
  await invoke(active, "retry_storage_cleanup"); assert.equal(await exists(active.target), false);
  await passed("目标提交后内容不一致：真实启动回滚源位置、保留状态，残留通过原生重试清理"); await stop(active);

  active = await fixture("新窗口未确认"); await cp(active.source, active.target, { recursive: true });
  active.record.root = active.target; active.record.migration = intent(active, "AwaitingHealth");
  await saveRecord(active); await launch(active); await verifyRestored(active, active.state);
  record = await readRecord(active); assert.ok(samePath(record.root, active.source)); assert.match(record.notice, /未通过健康确认/);
  assert.ok(await exists(active.source)); assert.ok(samePath(record.pending_cleanup.path, active.target));
  await invoke(active, "retry_storage_cleanup"); assert.equal(await exists(active.target), false);
  await passed("首次新位置未确认的持久阶段：下次真实启动回滚源根，目标只作为可重试残留"); await stop(active);

  active = await fixture("首次正文恢复失败");
  // 让恢复入口指向不可用文章，实际前端必须拒绝健康确认；已有原文不修改。
  active.state.lastFile = path.toNamespacedPath(path.join(active.directory, "不可用.md"));
  active.state.recent[0].path = active.state.lastFile;
  await writeFile(path.join(active.source, "state/preferences.json"), JSON.stringify(active.state));
  active.record.migration = intent(active); await saveRecord(active); await launch(active, false);
  await active.page.waitForFunction(() => document.querySelector("#notice-text")?.textContent.includes("无法打开文章"));
  record = await readRecord(active); assert.ok(samePath(record.root, active.target)); assert.equal(record.migration?.phase, "AwaitingHealth");
  assert.ok(await exists(active.source), "恢复失败时不能删除迁移源");
  assert.deepEqual((await readState(active.target)).recent, active.state.recent);
  await stop(active); await launch(active, false);
  await active.page.waitForFunction(() => document.querySelector("#notice-text")?.textContent.includes("无法打开文章"));
  record = await readRecord(active); assert.ok(samePath(record.root, active.source)); assert.match(record.notice, /未通过健康确认/);
  assert.deepEqual((await invoke(active, "get_session")).state.preferences, active.state.preferences);
  assert.deepEqual((await readState(active.source)).recent, active.state.recent);
  await invoke(active, "retry_storage_cleanup"); assert.equal(await exists(active.target), false);
  await passed("真实新窗口正文恢复失败不确认健康，源根保留；关闭再启动实际回滚，历史和偏好完整"); await stop(active);

  active = await fixture("旧会话未释放");
  // 用本脚本的子进程注入旧会话占用信号，真实启动必须等待超时且完全保留浏览器目录。
  occupiedSession = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(active.source, "webview")], { windowsHide: true, stdio: "ignore" });
  active.record.reset_webview = []; await saveRecord(active); await launch(active); await verifyRestored(active, active.state);
  record = await readRecord(active); assert.match(record.notice, /旧浏览器会话尚未释放/);
  assert.equal(await readFile(path.join(active.source, "webview/old-webview-probe"), "utf8"), "不得迁移的浏览器数据");
  occupiedSession.kill(); await new Promise((resolve) => occupiedSession.once("exit", resolve)); occupiedSession = undefined;
  await passed("注入旧会话占用时原生维护超时中止，旧 WebView 探针和必要状态完整保留"); await stop(active);

  active = await fixture("旧根清理失败"); await writeFile(path.join(active.source, "foreign.txt"), "外来文件不可删除");
  active.record.migration = intent(active); await saveRecord(active); await launch(active); await verifyRestored(active, active.state);
  await until(async () => (await readRecord(active)).notice?.includes("残留"), "清理失败没有报告残留");
  record = await readRecord(active); assert.ok(samePath(record.root, active.target)); assert.equal(record.migration, null);
  assert.ok(samePath(record.pending_cleanup.path, active.source)); assert.equal(await readFile(path.join(active.source, "foreign.txt"), "utf8"), "外来文件不可删除");
  assert.deepEqual(await readState(active.source), active.state); assert.ok(await exists(path.join(active.source, "cache/old-cache-probe")));
  await active.page.locator('[data-action="settings"]').first().click(); await active.page.locator("#migration-residual").waitFor({ state: "visible" });
  assert.ok(samePath(await active.page.locator("#residual-path").innerText(), active.source));
  await stop(active); await launch(active); await verifyRestored(active, active.state);
  assert.ok((await readRecord(active)).pending_cleanup, "清理失败必须跨重启保留任务");
  // 仅解除本用例创建的故障探针；先核验根归属和边界，不能借测试删除未知文件。
  assert.equal((await readJson(path.join(active.source, "owner.json"))).instance_id, active.owner.instance_id);
  assert.ok(active.source.startsWith(`${base}${path.sep}`)); await unlink(path.join(active.source, "foreign.txt"));
  await active.page.locator('[data-action="settings"]').first().click(); await active.page.locator('[data-storage="retry"]').click();
  await until(async () => !(await readRecord(active)).pending_cleanup && !await exists(active.source), "设置重试未清理旧目录");
  await passed("旧根含外来文件时整体保留，设置显示路径与占用；跨重启保留任务，解除故障后设置重试清理");
  assert.equal(await hash(original), originalHash);
  for (const context of fixtures) assert.equal(await hash(context.article), context.articleHash, "原始文章不得迁移或修改");
  result.result = "passed";
} catch (error) { result.result = "failed"; result.error = String(error); process.exitCode = 1; console.error(error); }
finally {
  occupiedSession?.kill();
  await stop(active).catch((error) => { result.result = "failed"; result.shutdownError = String(error); process.exitCode = 1; });
  result.completedAt = new Date().toISOString();
  await saveMaintenanceReport(workspace, result); console.log(JSON.stringify(result));
}
