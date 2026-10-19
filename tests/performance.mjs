import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

// 固定 UTF-8 字节样本，补齐部分使用 ASCII 空格，绝不截断多字节字符。
const root = process.cwd();
const sizes = [100_000, 1_000_000, 10_000_000];
const unit = "## 阅读章节\n\n" + "阅读的节奏来自清晰的段落和适当的留白。这个本地文档用于测量全文解析、首屏绘制、目录和搜索。性能验收标记。".repeat(12) + "\n\n- 保留原始文件\n- 后台读取与解析\n- 按需显示正文\n\n> 先测量，再根据证据改进。\n\n";
const files = sizes.map((size) => path.join(root, `fixtures/_perf-${size}.md`));
for (let index = 0; index < sizes.length; index++) {
  const heading = `# ${sizes[index]} 字节性能样本\n\n`;
  const count = Math.floor((sizes[index] - Buffer.byteLength(heading)) / Buffer.byteLength(unit));
  const body = heading + unit.repeat(count);
  await writeFile(files[index], body + " ".repeat(sizes[index] - Buffer.byteLength(body)));
  assert.equal((await readFile(files[index])).length, sizes[index]);
}
const preparation = spawnSync(process.execPath, ["scripts/desktop.mjs", "cargo", "run", "--offline", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", "--example", "prepare_test"], { cwd: root, windowsHide: true, encoding: "utf8" });
assert.equal(preparation.status, 0, preparation.stderr);
const binary = path.resolve(process.argv[2] ?? ".tools/target/release/md-reader.exe");
const sampleCount = Number(process.env.MD_PERF_SAMPLES ?? 30);
assert.ok(Number.isInteger(sampleCount) && sampleCount > 0);
const environment = { ...process.env, MD_BOOTSTRAP_DIR: path.join(root, ".runtime/desktop-smoke/bootstrap"), TEMP: path.join(root, ".tools/tmp"), TMP: path.join(root, ".tools/tmp") };
const driver = spawn(path.join(root, ".tools/cargo/bin/tauri-driver.exe"), ["--native-driver", path.join(root, ".tools/webdriver/msedgedriver.exe"), "--port", "4450", "--native-port", "4451"], { cwd: root, windowsHide: true, env: environment, stdio: ["ignore", "pipe", "pipe"] });
let driverLog = ""; let sessionId;
for (const stream of [driver.stdout, driver.stderr]) stream.on("data", (data) => { driverLog = (driverLog + data).slice(-16_384); });
const output = { binary, date: new Date().toISOString(), sampleCount, machine: { platform: os.platform(), release: os.release(), cpu: os.cpus()[0].model, logicalProcessors: os.cpus().length, memoryBytes: os.totalmem() }, environment: null, groups: [], searches: [], scrolling: null, result: "running" };

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

/** 最近秩统计；保留每次原始读盘/解析/缓存/IPC/绘制与全文完成数据。 */
function summarize(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return { count: values.length, median: ordered[Math.ceil(ordered.length * .5) - 1], p95: ordered[Math.ceil(ordered.length * .95) - 1], max: ordered.at(-1) };
}

try {
  await until(async () => { try { return (await fetch("http://127.0.0.1:4450/status")).ok; } catch { return false; } }, "驱动未启动");
  const created = await command("POST", "/session", { capabilities: { alwaysMatch: { "tauri:options": { application: binary } } } }); sessionId = created.sessionId;
  await until(() => script("return document.querySelector('#article h1') !== null;"), "阅读器未启动");
  await until(() => script("return document.querySelectorAll('#file-tree .file-row').length >= 4;"), "性能样本未出现在授权文件夹");
  output.environment = await script("return {userAgent:navigator.userAgent,width:innerWidth,height:innerHeight,devicePixelRatio,screenWidth:screen.width,screenHeight:screen.height};");
  const initial = await invoke("get_session");
  await script("window.__MD_LONG_TASKS=[]; new PerformanceObserver(list => { for(const entry of list.getEntries()) window.__MD_LONG_TASKS.push({start:entry.startTime,duration:entry.duration}); }).observe({type:'longtask',buffered:false});");
  for (const cached of [false, true]) {
    await invoke("save_preferences", { preferences: { ...initial.state.preferences, persistentCache: cached } });
    for (const size of [1_000_000, 10_000_000]) {
      const group = { bytes: size, persistentCache: cached, osFileCache: "warm; no OS cache purge", samples: [], firstPaint: null, fullText: null };
      output.groups.push(group);
      for (let iteration = 0; iteration < sampleCount + (cached ? 1 : 0); iteration++) {
        await script("window.__MD_LONG_TASKS=[]; Array.from(document.querySelectorAll('#file-tree .file-row')).find(button => button.textContent.includes(arguments[0])).click();", [`_perf-${size}.md`]);
        await until(() => script("return performance.getEntriesByName('md:full-text').length > 0 && document.querySelector('#document-name').textContent === arguments[0];", [`_perf-${size}.md`]), "全文未完成", 120_000);
        const timing = await script("const first=performance.getEntriesByName('md:first-paint').at(-1); const full=performance.getEntriesByName('md:full-text').at(-1); return {firstPaint:{duration:first.duration,detail:first.detail},fullText:{duration:full.duration,detail:full.detail},longTasks:window.__MD_LONG_TASKS};");
        if (!(cached && iteration === 0)) group.samples.push(timing);
      }
      group.firstPaint = summarize(group.samples.map((sample) => sample.firstPaint.duration));
      group.fullText = summarize(group.samples.map((sample) => sample.fullText.duration));
      console.log(JSON.stringify({ bytes: size, persistentCache: cached, firstPaint: group.firstPaint, fullText: group.fullText }));
    }
  }
  await script("Array.from(document.querySelectorAll('#file-tree .file-row')).find(button => button.textContent.includes('_perf-1000000.md')).click();");
  await until(() => script("return performance.getEntriesByName('md:full-text').length > 0 && document.querySelector('#document-name').textContent === '_perf-1000000.md';"), "搜索样本未就绪");
  await script("document.querySelector('[data-action=search]').click();");
  for (let iteration = 0; iteration < sampleCount; iteration++) {
    await script("performance.clearMeasures('md:search-painted'); const input=document.querySelector('#search-input'); input.value='性能验收标记'; input.dispatchEvent(new Event('input',{bubbles:true}));");
    await until(() => script("return performance.getEntriesByName('md:search-painted').length > 0;"), "搜索没有完成");
    output.searches.push(await script("return performance.getEntriesByName('md:search-painted').at(-1).duration;"));
  }
  output.searchSummary = summarize(output.searches);
  await script("document.querySelector('[data-action=close-search]').click(); window.__MD_LONG_TASKS=[]; window.__MD_SCROLL_FRAMES=[]; let previous=performance.now(); const end=previous+5000; const pane=document.querySelector('#reading-pane'); function tick(now){window.__MD_SCROLL_FRAMES.push(now-previous);previous=now;pane.scrollTop+=12;if(now<end) requestAnimationFrame(tick);else window.__MD_SCROLL_DONE=true;} requestAnimationFrame(tick);");
  await until(() => script("return window.__MD_SCROLL_DONE === true;"), "滚动样本未完成");
  const frames = await script("return window.__MD_SCROLL_FRAMES;");
  output.scrolling = { frameMs: summarize(frames), framesOver25ms: frames.filter((duration) => duration > 25).length, longTasks: await script("return window.__MD_LONG_TASKS;") };
  output.result = "measured";
} catch (error) { output.result = "failed"; output.error = String(error); output.driverLog = driverLog; process.exitCode = 1; console.error(error); }
finally {
  await mkdir(path.join(root, ".reports"), { recursive: true });
  await writeFile(path.join(root, ".reports/performance.json"), JSON.stringify(output, null, 2));
  if (sessionId) await command("DELETE", `/session/${sessionId}`).catch(() => {}); driver.kill();
  for (const file of files) await rm(file, { force: true });
}
