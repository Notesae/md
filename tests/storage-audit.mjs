import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  console.error("WebView 数据位置检查需要 Windows 程序。它也不代替标准安装的系统盘审计。");
  process.exit(2);
}

// WebDriver 会覆盖 WebView2 的用户数据目录，此项单独运行不受驱动干预的程序。
const root = process.cwd();
const data = path.join(root, ".runtime/desktop-smoke/data");
const environment = { ...process.env, MD_BOOTSTRAP_DIR: path.join(root, ".runtime/desktop-smoke/bootstrap"), TEMP: path.join(root, ".tools/tmp"), TMP: path.join(root, ".tools/tmp") };
for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith("WEBVIEW2_")) delete environment[key];
const app = spawn(path.resolve(process.argv[2] ?? ".tools/target/debug/md-reader.exe"), [], { env: environment, windowsHide: true, stdio: "ignore" });
let launchError;
app.on("error", (error) => { launchError = error; });
try {
  let entries = [];
  const started = Date.now();
  while (Date.now() - started < 20_000) {
    if (launchError) throw launchError;
    entries = await readdir(path.join(data, "webview"), { recursive: true });
    if (entries.some((name) => /Preferences$|Local State$|Cookies$/.test(name))) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(entries.some((name) => /Preferences$|Local State$|Cookies$/.test(name)), "用户数据目录没有出现真实 WebView2 文件");
  const evidence = { result: "passed", specPassed: false, standardInstallAudit: "not-run", binary: app.spawnfile, pid: app.pid, root: data, userDataDirectory: path.join(data, "webview"), files: entries.filter((name) => /Preferences$|Local State$|Cookies$/.test(name)) };
  await mkdir(path.join(root, ".reports"), { recursive: true });
  await writeFile(path.join(root, ".reports/storage-audit.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  // 仅终止此测试直接创建的隔离进程，不处理系统 Edge 或其他 WebView 实例。
  app.kill();
}
