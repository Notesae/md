import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm, readdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  FORMAL_SAMPLE_COUNT, FORMAL_SWITCH_COUNT, SPEC_OPEN_1MB_P95_MS, SPEC_OPEN_10MB_P95_MS,
  SPEC_SEARCH_1MB_P95_MS, SPEC_STEADY_PRIVATE_BYTES, performanceDocument, selfCheckPerfStats, summarize,
} from "./perf-stats.mjs";

if (process.argv.includes("--self-check")) {
  try { selfCheckPerfStats(); console.log("performance self-check passed"); }
  catch (error) { console.error(error); process.exit(1); }
  process.exit(0);
}
if (process.platform !== "win32") {
  console.error("正式性能采样需要 Windows release 程序、WebView2 和 tauri-driver。可先运行 node tests/performance.mjs --self-check。");
  process.exit(2);
}

// 固定 UTF-8 字节样本。退出时删除，不进入 Git。
const root = process.cwd();
const sizes = [100_000, 1_000_000, 10_000_000];
const files = sizes.map((size) => path.join(root, `fixtures/_perf-${size}.md`));
for (const size of sizes) {
  await writeFile(files[sizes.indexOf(size)], performanceDocument(size));
  assert.equal(Buffer.byteLength(await readFile(files[sizes.indexOf(size)])), size);
}
const preparation = spawnSync(process.execPath, ["scripts/desktop.mjs", "cargo", "run", "--offline", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", "--example", "prepare_test"], { cwd: root, windowsHide: true, encoding: "utf8" });
assert.equal(preparation.status, 0, preparation.stderr);
const binary = path.resolve(process.argv[2] ?? ".tools/target/release/md-reader.exe");
const sampleCount = Number(process.env.MD_PERF_SAMPLES ?? FORMAL_SAMPLE_COUNT);
const switchCount = Number(process.env.MD_SWITCHES ?? FORMAL_SWITCH_COUNT);
assert.ok(Number.isInteger(sampleCount) && sampleCount > 0);
assert.ok(Number.isInteger(switchCount) && switchCount > 0);
const environment = { ...process.env, MD_BOOTSTRAP_DIR: path.join(root, ".runtime/desktop-smoke/bootstrap"), TEMP: path.join(root, ".tools/tmp"), TMP: path.join(root, ".tools/tmp") };
const driver = spawn(path.join(root, ".tools/cargo/bin/tauri-driver.exe"), ["--native-driver", path.join(root, ".tools/webdriver/msedgedriver.exe"), "--port", "4450", "--native-port", "4451"], { cwd: root, windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
let driverLog = ""; let sessionId;
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", (data) => { driverLog = (driverLog + data).slice(-16_384); });
const output = {
  binary, date: new Date().toISOString(), sampleCount, switchCount, formal: sampleCount >= FORMAL_SAMPLE_COUNT && switchCount >= FORMAL_SWITCH_COUNT,
  specPassed: false, specPassedReason: "脚本只保存样本。是否达标要连同硬件、WebView2 版本、冷热缓存和验证记录一起判断。",
  machine: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0]?.model ?? "unknown", logicalProcessors: os.cpus().length, memoryBytes: os.totalmem() },
  environment: null, groups: [], searches: [], scrolling: null, switches: null, memory: {}, result: "running",
};

/** 原始 W3C 错误直接失败，计时取页面 User Timing，排除轮询通信耗时。 */
async function command(method, resource, body) {
  const response = await fetch("http://127.0.0.1:4450" + resource, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const result = await response.json(); if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result)); return result.value;
}
const script = (source, args = []) => command("POST", `/session/${sessionId}/execute/sync`, { script: source, args });
const invoke = (name, payload = {}) => command("POST", `/session/${sessionId}/execute/async`, { script: "const done = arguments[arguments.length-1]; window.__TAURI_INTERNALS__.invoke(arguments[0],arguments[1]).then(value=>done({value}),error=>done({error:String(error)}));", args: [name, payload] }).then((r) => { if (r.error) throw new Error(r.error); return r.value; });

async function until(probe, label, duration = 60_000) {
  const start = Date.now(); while (Date.now() - start < duration) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 100)); } throw new Error(label);
}

async function directoryBytes(directory) {
  let total = 0;
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(child);
      else total += (await stat(child)).size;
    }
  }
  return total;
}

/** 用点击前的时间戳丢掉上一次测量，避免同一文件还没重新打开就被记成新样本。 */
async function openDocument(name) {
  const stamp = await script("return performance.now();");
  const clicked = await script("window.__MD_LONG_TASKS=[]; const button=Array.from(document.querySelectorAll('#file-tree .file-row')).find((item) => item.textContent.includes(arguments[0])); if (!button) return false; button.click(); return true;", [name]);
  if (!clicked) throw new Error(`文件树没有 ${name}`);
  await until(() => script("const full=performance.getEntriesByName('md:full-text').at(-1); const first=performance.getEntriesByName('md:first-paint').at(-1); return !!(full && first && full.startTime > arguments[0] && first.startTime > arguments[0] && document.querySelector('#document-name').textContent === arguments[1]);", [stamp, name]), `${name} 全文未完成`, 120_000);
  return script("const first=performance.getEntriesByName('md:first-paint').at(-1); const full=performance.getEntriesByName('md:full-text').at(-1); return {firstPaint:{duration:first.duration,detail:first.detail},fullText:{duration:full.duration,detail:full.detail},longTasks:window.__MD_LONG_TASKS};");
}

function privateWorkingSet() {
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "tests/process-memory.ps1", "-ExecutablePath", binary], { cwd: root, windowsHide: true, encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || "进程组内存采样失败");
  return JSON.parse(result.stdout);
}

try {
  await until(async () => { try { return (await fetch("http://127.0.0.1:4450/status")).ok; } catch { return false; } }, "驱动未启动");
  const created = await command("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: binary } } } }); sessionId = created.sessionId;
  await until(() => script("return document.querySelector('#article h1') !== null;"), "阅读器未启动");
  await until(() => script("return document.querySelectorAll('#file-tree .file-row').length >= 4;"), "性能样本未出现在授权文件夹");
  output.environment = await script("return {userAgent:navigator.userAgent,width:innerWidth,height:innerHeight,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height};");
  const initial = await invoke("get_session");
  await script("window.__MD_LONG_TASKS=[]; new PerformanceObserver(list => { for(const entry of list.getEntries()) window.__MD_LONG_TASKS.push({start:entry.startTime,duration:entry.duration}); }).observe({type:'longtask',buffered:false});");
  const cacheDirectory = path.join(root, ".runtime/desktop-smoke/data/cache");
  for (const cached of [false, true]) {
    await invoke("save_preferences", { preferences: { ...initial.state.preferences, persistentCache: cached } });
    for (const size of [100_000, 1_000_000, 10_000_000]) {
      const group = { bytes: size, persistentCache: cached, osFileCache: "warm; no OS cache purge", samples: [], firstPaint: null, fullText: null };
      output.groups.push(group);
      for (let iteration = 0; iteration < sampleCount + (cached ? 1 : 0); iteration++) {
        const timing = await openDocument(`_perf-${size}.md`);
        // 开启缓存时第一次是写入，不和后续命中混在同一组。
        if (!(cached && iteration === 0)) group.samples.push(timing);
      }
      group.firstPaint = summarize(group.samples.map((sample) => sample.firstPaint.duration));
      group.fullText = summarize(group.samples.map((sample) => sample.fullText.duration));
      console.log(JSON.stringify({ bytes: size, persistentCache: cached, firstPaint: group.firstPaint, fullText: group.fullText }));
    }
  }
  await openDocument("_perf-1000000.md");
  output.memory.after1Mb = privateWorkingSet();
  await script("document.querySelector('[data-action=search]').click();");
  for (let iteration = 0; iteration < sampleCount; iteration++) {
    const stamp = await script("return performance.now();");
    await script("performance.clearMeasures('md:search-painted'); const input=document.querySelector('#search-input'); input.value='性能验收标记'; input.dispatchEvent(new Event('input',{bubbles:true}));");
    await until(() => script("const entry=performance.getEntriesByName('md:search-painted').at(-1); return !!(entry && entry.startTime > arguments[0]);", [stamp]), "搜索没有完成");
    output.searches.push(await script("return performance.getEntriesByName('md:search-painted').at(-1).duration;"));
  }
  output.searchSummary = summarize(output.searches);
  await script("document.querySelector('[data-action=close-search]').click(); window.__MD_LONG_TASKS=[]; window.__MD_SCROLL_FRAMES=[]; let previous=performance.now(); const end=previous+5000; const pane=document.querySelector('#reading-pane'); function tick(now){window.__MD_SCROLL_FRAMES.push(now-previous);previous=now;pane.scrollTop+=12;if(now<end) requestAnimationFrame(tick);else window.__MD_SCROLL_DONE=true;} requestAnimationFrame(tick);");
  await until(() => script("return window.__MD_SCROLL_DONE === true;"), "滚动样本未完成", 20_000);
  const frames = await script("return window.__MD_SCROLL_FRAMES;");
  const longTasks = await script("return window.__MD_LONG_TASKS;");
  output.scrolling = { frameMs: summarize(frames), framesOver25ms: frames.filter((duration) => duration > 25).length, longTasksOver50ms: longTasks.filter((task) => task.duration > 50).length, longTasks };
  output.switches = { count: switchCount, samples: [], cacheBytesBefore: await directoryBytes(cacheDirectory) };
  for (let iteration = 0; iteration < switchCount; iteration++) {
    const name = iteration % 2 === 0 ? "_perf-100000.md" : "_perf-1000000.md";
    output.switches.samples.push((await openDocument(name)).firstPaint.duration);
  }
  output.switches.firstPaint = summarize(output.switches.samples);
  output.switches.cacheBytesAfter = await directoryBytes(cacheDirectory);
  output.memory.afterSwitches = privateWorkingSet();
  delete output.switches.samples;
  const open1 = output.groups.find((group) => group.bytes === 1_000_000 && group.persistentCache === false);
  const open10 = output.groups.find((group) => group.bytes === 10_000_000 && group.persistentCache === false);
  output.comparison = {
    formalSampleFloor: output.formal,
    open1MbP95WithinTarget: !!open1 && open1.firstPaint.count >= FORMAL_SAMPLE_COUNT && open1.firstPaint.p95 <= SPEC_OPEN_1MB_P95_MS,
    open10MbP95WithinTarget: !!open10 && open10.firstPaint.count >= FORMAL_SAMPLE_COUNT && open10.firstPaint.p95 <= SPEC_OPEN_10MB_P95_MS,
    searchP95WithinTarget: output.searchSummary.count >= FORMAL_SAMPLE_COUNT && output.searchSummary.p95 <= SPEC_SEARCH_1MB_P95_MS,
    steadyPrivateWorkingSetWithinTarget: output.memory.after1Mb.privateWorkingSetBytes <= SPEC_STEADY_PRIVATE_BYTES,
    webviewDiskNote: "WebDriver 会改用自己的 WebView 用户数据目录。这里的缓存字节只统计应用 cache/，不能代替产品 WebView 目录的磁盘曲线。",
  };
  output.result = "measured";
} catch (error) { output.result = "failed"; output.error = String(error); output.driverLog = driverLog; process.exitCode = 1; console.error(error); }
finally {
  await mkdir(path.join(root, ".reports"), { recursive: true });
  await writeFile(path.join(root, ".reports/performance.json"), JSON.stringify(output, null, 2));
  if (sessionId) await command("DELETE", `/session/${sessionId}`).catch(() => {}); driver.kill();
  for (const file of files) await rm(file, { force: true });
}
