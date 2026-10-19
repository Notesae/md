import assert from "node:assert/strict";

// SPEC 的标准引导预算：单份 16KiB，连同恢复副本和两份原子暂存合计不超过 64KiB。
export const BOOTSTRAP_FILE_LIMIT = 16 * 1024;
export const BOOTSTRAP_TOTAL_LIMIT = 64 * 1024;
const BOOTSTRAP_NAMES = new Set([
  "bootstrap.json",
  "bootstrap.recovery.json",
  "bootstrap.pending",
  "bootstrap.recovery.pending",
]);

export function bootstrapBudget(files) {
  let total = 0;
  const problems = [];
  for (const file of files) {
    if (!BOOTSTRAP_NAMES.has(file.name)) {
      problems.push(`${file.name} 不是引导定位文件`);
      continue;
    }
    total += file.bytes;
    if (file.bytes > BOOTSTRAP_FILE_LIMIT) problems.push(`${file.name} 超过 16KiB`);
  }
  if (total > BOOTSTRAP_TOTAL_LIMIT) problems.push("引导定位文件合计超过 64KiB");
  return { total, ok: problems.length === 0, problems };
}

function normalize(filePath) {
  return filePath.replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
}

/** 只解释调用方明确允许的数据根、引导目录和安装目录。其余写入都留给审计报告。 */
export function explainWrite(filePath, allow) {
  const path = normalize(filePath);
  const groups = [
    ["data-root", allow.dataRoots ?? []],
    ["bootstrap", allow.bootstrapDirs ?? []],
    ["install", allow.installDirs ?? []],
  ];
  for (const [kind, roots] of groups) {
    for (const root of roots) {
      const prefix = normalize(root);
      if (!prefix) continue;
      if (path === prefix || path.startsWith(`${prefix}\\`)) return { explained: true, kind };
    }
  }
  const base = path.split("\\").at(-1) ?? "";
  if (base === "microsoftedgewebview2setup.exe" || base === "microsoftedgewebview2runtimeinstaller.exe") {
    return { explained: true, kind: "webview-runtime-installer" };
  }
  return { explained: false, kind: "unexplained" };
}

function splitCsv(line) {
  const cells = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted && char === '"' && line[index + 1] === '"') { current += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (char === "," && !quoted) { cells.push(current); current = ""; continue; }
    current += char;
  }
  cells.push(current);
  return cells;
}

/** 同时检查应用和 WebView2，避免漏掉由浏览器子进程写到默认系统盘的数据。 */
export function writesFromTable(text) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const header = splitCsv(lines[0]).map((cell) => cell.trim().toLowerCase());
  const processIndex = header.indexOf("process name");
  const operationIndex = header.indexOf("operation");
  const pathIndex = header.indexOf("path");
  const resultIndex = header.indexOf("result");
  if (processIndex < 0 || operationIndex < 0 || pathIndex < 0) throw new Error("表头缺少 Process Name、Operation 或 Path");
  const writes = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsv(line);
    const processName = cells[processIndex] ?? "";
    const operation = cells[operationIndex] ?? "";
    const filePath = cells[pathIndex] ?? "";
    if (!/^(?:md-reader|msedgewebview2)\.exe$/i.test(processName.trim()) || !filePath) continue;
    if (!/^(?:writefile|createfile|filewrite)$/i.test(operation.trim())) continue;
    if (resultIndex >= 0 && cells[resultIndex]?.trim().toUpperCase() !== "SUCCESS") continue;
    writes.push(filePath);
  }
  return writes;
}

export function selfCheckAuditRules() {
  const within = bootstrapBudget([
    { name: "bootstrap.json", bytes: 100 },
    { name: "bootstrap.recovery.json", bytes: 100 },
    { name: "bootstrap.pending", bytes: 16 * 1024 },
    { name: "bootstrap.recovery.pending", bytes: 16 * 1024 },
  ]);
  assert.equal(within.ok, true);
  assert.equal(bootstrapBudget([{ name: "bootstrap.json", bytes: 16 * 1024 + 1 }]).ok, false);
  assert.equal(bootstrapBudget([
    { name: "bootstrap.json", bytes: 16 * 1024 },
    { name: "bootstrap.recovery.json", bytes: 16 * 1024 },
    { name: "bootstrap.pending", bytes: 16 * 1024 },
    { name: "bootstrap.recovery.pending", bytes: 16 * 1024 + 1 },
  ]).ok, false);
  assert.equal(bootstrapBudget([{ name: "instance.lock", bytes: 0 }]).ok, false);
  const allow = { dataRoots: ["D:\\data\\MdReader"], bootstrapDirs: ["C:\\Users\\me\\AppData\\Local\\MdReader"] };
  assert.equal(explainWrite("D:/data/MdReader/webview/EBWebView/Local State", allow).kind, "data-root");
  assert.equal(explainWrite("C:\\Users\\me\\AppData\\Local\\MdReader\\bootstrap.json", allow).kind, "bootstrap");
  assert.equal(explainWrite("C:\\Users\\me\\AppData\\Local\\io.notesae.mdreader\\cache", allow).explained, false);
  assert.equal(explainWrite("D:\\notes\\原文.md", allow).explained, false);
  assert.equal(explainWrite("C:\\Windows\\Temp\\MicrosoftEdgeWebview2Setup.exe", allow).kind, "webview-runtime-installer");
  const writes = writesFromTable([
    "Process Name,Operation,Path,Result",
    "md-reader.exe,CreateFile,D:\\data\\MdReader\\state\\preferences.json,SUCCESS",
    "md-reader.exe,ReadFile,D:\\notes\\原文.md,SUCCESS",
    "msedgewebview2.exe,WriteFile,C:\\Users\\me\\AppData\\Local\\Temp\\stray.bin,SUCCESS",
    "\"md-reader.exe\",WriteFile,\"C:\\Users\\me\\AppData\\Local\\Temp\\unexpected.bin\",SUCCESS",
  ].join("\n"));
  assert.deepEqual(writes, [
    "D:\\data\\MdReader\\state\\preferences.json",
    "C:\\Users\\me\\AppData\\Local\\Temp\\stray.bin",
    "C:\\Users\\me\\AppData\\Local\\Temp\\unexpected.bin",
  ]);
}
