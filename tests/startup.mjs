import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

if (process.platform !== "win32") {
  console.error("启动采样需要 Windows release 程序。本脚本不在其他系统上宣称成绩。");
  process.exit(2);
}

// 每轮完全退出应用及其专属 WebView 会话；首次初始化单列，不混入热文件缓存样本。
// 探针文件在健康提交成功后才出现。文件里的时刻在进入 app_ready 时采样，不包含旧目录清理。
const workspace = process.cwd(); const base = path.join(workspace, ".runtime/startup", randomUUID());
const root = path.join(base, "data"); const bootstrap = path.join(base, "bootstrap");
const instance = randomUUID(); const article = path.join(base, "articles/sample.md");
for (const directory of [bootstrap, path.dirname(article), ...["state", "cache", "webview", "logs", "temp"].map((name) => path.join(root, name))]) await mkdir(directory, { recursive: true });
const unit = "## 阅读的节奏\n\n文字留在原处，目光回到此刻。这是用于测量启动的普通本地 Markdown 文档。\n\n";
const body = unit.repeat(Math.floor(100_000 / Buffer.byteLength(unit)));
await writeFile(article, body + " ".repeat(100_000 - Buffer.byteLength(body)));
await writeFile(path.join(root, "owner.json"), JSON.stringify({ app_id: "io.notesae.mdreader", format_version: 1, instance_id: instance, state_written: true }));
// 与桌面授权采用相同的规范化文档路径，不能把打开失败后的空界面当成启动完成。
await writeFile(path.join(root, "state/preferences.json"), JSON.stringify({ preferences: { theme: "light", fontSize: 18, contentWidth: 780, sidebar: true, outline: true, persistentCache: true, cacheMib: 256 }, recent: [], folders: [path.toNamespacedPath(path.dirname(article))], lastFile: path.toNamespacedPath(article), window: { width: 1280, height: 860, maximized: false } }));
for (const name of ["bootstrap.json", "bootstrap.recovery.json"]) await writeFile(path.join(bootstrap, name), JSON.stringify({ format_version: 1, root, instance_id: instance }));
const binary = path.resolve(process.argv[2] ?? ".tools/target/release/md-reader.exe");
const environment = { ...process.env, MD_STARTUP_PROBE: "1", MD_BOOTSTRAP_DIR: bootstrap, TEMP: path.join(workspace, ".tools/tmp"), TMP: path.join(workspace, ".tools/tmp") };
for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith("WEBVIEW2_")) delete environment[key];
const count = Number(process.env.MD_PERF_SAMPLES ?? 30); assert.ok(Number.isInteger(count) && count > 0);
const result = { binary, base, bytes: 100_000, osFileCache: "warm; no OS cache purge", firstInitialization: null, samples: [], summary: null, specPassed: false, specPassedReason: "至少 30 次且需记录硬件与冷热缓存后，才能对照 SPEC 的启动 P95。脚本不代验收。", result: "running" };
let app;

async function stop() {
  if (app && app.exitCode === null) { const exited = new Promise((resolve) => app.once("exit", resolve)); app.kill(); await exited; }
  app = undefined;
  const waited = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tests/wait-profile.ps1", "-ProfilePath", path.join(root, "webview")], { cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 30_000 });
  assert.equal(waited.status, 0, waited.stderr);
}

try {
  for (let iteration = 0; iteration <= count; iteration++) {
    const requestedAt = Date.now(); let launchError;
    app = spawn(binary, [], { env: environment, windowsHide: true, stdio: "ignore" }); app.on("error", (error) => { launchError = error; });
    let probe;
    while (Date.now() - requestedAt < 30_000) {
      if (launchError) throw launchError; if (app.exitCode !== null) throw new Error(`程序提前退出 ${app.exitCode}`);
      try { const value = JSON.parse(await readFile(path.join(root, "temp/startup-probe.json"), "utf8")); if (value.processId === app.pid) { probe = value; break; } } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(probe, "首屏健康确认未生成启动探针");
    const sample = { processId: app.pid, requestToReadyMs: probe.readyAtUnixMs - requestedAt, rustEntryToReadyMs: probe.elapsedMs };
    if (iteration === 0) result.firstInitialization = sample; else result.samples.push(sample);
    await stop(); console.log(JSON.stringify({ iteration, ...sample }));
  }
  const ordered = result.samples.map((sample) => sample.requestToReadyMs).sort((a, b) => a - b);
  result.summary = { count, median: ordered[Math.ceil(count * .5) - 1], p95: ordered[Math.ceil(count * .95) - 1], max: ordered.at(-1) };
  result.result = "measured";
} catch (error) { result.result = "failed"; result.error = String(error); process.exitCode = 1; console.error(error); }
finally { await stop(); await mkdir(path.join(workspace, ".reports"), { recursive: true }); await writeFile(path.join(workspace, ".reports/startup.json"), JSON.stringify(result, null, 2)); }
