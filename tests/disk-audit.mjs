import { lstat, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { bootstrapBudget, explainWrite, selfCheckAuditRules, writesFromTable } from "./audit-rules.mjs";

const workspace = process.cwd();

function flag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function repeated(name) {
  const values = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === name && process.argv[index + 1]) values.push(process.argv[index + 1]);
  }
  return values;
}

/** 不跟随符号链接。链接本身记下来，避免审计顺着 junction 走出数据根。 */
async function collectFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    let metadata;
    try { metadata = await lstat(current); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (metadata.isSymbolicLink()) { files.push({ path: current, bytes: metadata.size, symlink: true }); continue; }
    if (metadata.isDirectory()) {
      const entries = await readdir(current);
      for (const name of entries) pending.push(path.join(current, name));
      continue;
    }
    files.push({ path: current, bytes: metadata.size, symlink: false });
  }
  return files;
}

export async function judgeSnapshot({ dataRoots = [], bootstrapDirs = [], installDirs = [], procmonText = "" }) {
  const seen = [];
  for (const root of [...dataRoots, ...bootstrapDirs, ...installDirs]) seen.push(...await collectFiles(root));
  const allow = { dataRoots, bootstrapDirs, installDirs };
  const classified = seen.map((file) => ({ ...file, ...explainWrite(file.path, allow), symlink: file.symlink }));
  for (const file of classified) if (file.symlink) { file.explained = false; file.kind = "symlink"; }
  const procmon = procmonText ? writesFromTable(procmonText).map((filePath) => ({ path: filePath, ...explainWrite(filePath, allow) })) : [];
  const bootstrapFiles = [];
  for (const directory of bootstrapDirs) {
    for (const file of classified) {
      if (path.dirname(file.path) === directory) bootstrapFiles.push({ name: path.basename(file.path), bytes: file.bytes });
    }
  }
  const budget = bootstrapBudget(bootstrapFiles.filter((file) => file.name !== "instance.lock"));
  const unexplained = [...classified, ...procmon].filter((file) => !file.explained).slice(0, 40);
  return {
    specPassed: false,
    specPassedReason: "目录快照和可选的 CSV 不能代替全程 Process Monitor，也不能证明首次启动取消后没有回落系统盘。",
    budget,
    unexplained,
    fileCount: classified.length,
    procmonWrites: procmon.length,
    result: unexplained.length === 0 && budget.ok ? "no-unexplained-files-observed" : "findings",
  };
}

const invoked = process.argv[1]?.endsWith(`${path.sep}disk-audit.mjs`) || process.argv[1]?.endsWith("disk-audit.mjs");
if (invoked) {
  if (process.argv.includes("--self-check")) {
    try { selfCheckAuditRules(); console.log("disk-audit self-check passed"); }
    catch (error) { console.error(error); process.exit(1); }
    process.exit(0);
  }
  if (invoked && process.argv.includes("--capture")) {
    const dataRoots = repeated("--data-root");
    const bootstrapDirs = repeated("--bootstrap-dir");
    const installDirs = repeated("--install-dir");
    if (!dataRoots.length || !bootstrapDirs.length) {
      console.error("用法：node tests/disk-audit.mjs --capture --data-root <数据根> --bootstrap-dir <引导目录> [--install-dir <安装目录>] [--procmon <csv>]");
      process.exit(2);
    }
    const procmonPath = flag("--procmon");
    const procmonText = procmonPath ? await readFile(procmonPath, "utf8") : "";
    const report = await judgeSnapshot({ dataRoots, bootstrapDirs, installDirs, procmonText });
    report.capturedAt = new Date().toISOString();
    report.procmon = procmonPath ?? null;
    await mkdir(path.join(workspace, ".reports"), { recursive: true });
    await writeFile(path.join(workspace, ".reports/disk-audit.json"), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ result: report.result, unexplained: report.unexplained.length, budgetOk: report.budget.ok, specPassed: false }));
    process.exit(report.result === "findings" ? 1 : 0);
  }
}
