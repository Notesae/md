import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { selfCheckAuditRules, writesFromTable } from "./audit-rules.mjs";
import { judgeSnapshot } from "./disk-audit.mjs";

test("引导预算和写入分类拒绝未说明位置", () => {
  selfCheckAuditRules();
});

test("Procmon 同时保留阅读器和 WebView2 的写入，不混入其他程序或失败操作", () => {
  const rows = [
    "Process Name,Operation,Path,Result",
    "md-reader.exe,WriteFile,D:\\MdReader\\state\\preferences.json,SUCCESS",
    "MSEdgeWebView2.exe,WriteFile,C:\\Users\\me\\AppData\\Local\\stray.bin,SUCCESS",
    "msedgewebview2.exe,ReadFile,D:\\notes\\article.md,SUCCESS",
    "editor.exe,WriteFile,C:\\unrelated.bin,SUCCESS",
    "md-reader-helper.exe,WriteFile,C:\\unrelated-helper.bin,SUCCESS",
    "md-reader.exe,WriteFile,C:\\denied.bin,ACCESS DENIED",
  ].join("\n");
  assert.deepEqual(writesFromTable(rows), [
    "D:\\MdReader\\state\\preferences.json",
    "C:\\Users\\me\\AppData\\Local\\stray.bin",
  ]);
});

test("缺少操作列的 Procmon 导出不能被当作完整写入记录", () => {
  assert.throws(() => writesFromTable("Process Name,Path\nmd-reader.exe,C:\\unknown.bin"), /Operation/);
});

test("WebView2 在允许根之外落盘会进入审计发现", async () => {
  const report = await judgeSnapshot({
    procmonText: "Process Name,Operation,Path,Result\nmsedgewebview2.exe,WriteFile,C:\\Users\\me\\AppData\\Local\\stray.bin,SUCCESS",
  });
  assert.equal(report.result, "findings");
  assert.equal(report.procmonWrites, 1);
  assert.equal(report.unexplained[0].path, "C:\\Users\\me\\AppData\\Local\\stray.bin");
  assert.equal(report.specPassed, false);
});

test("快照不跟随符号链接，超限引导和数据根外文件会留下发现", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "md-audit-"));
  const data = path.join(root, "data");
  const bootstrap = path.join(root, "bootstrap");
  const outside = path.join(root, "outside");
  await mkdir(path.join(data, "state"), { recursive: true });
  await mkdir(bootstrap, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(data, "state", "preferences.json"), "{}");
  await writeFile(path.join(bootstrap, "bootstrap.json"), "x".repeat(16 * 1024 + 1));
  let linked = true;
  try { await symlink(outside, path.join(data, "escape"), "dir"); }
  catch (error) { if (error.code !== "EPERM") throw error; linked = false; }
  try {
    const report = await judgeSnapshot({ dataRoots: [data], bootstrapDirs: [bootstrap] });
    assert.equal(report.specPassed, false);
    assert.equal(report.budget.ok, false);
    assert.equal(report.result, "findings");
    assert.equal(report.fileCount, linked ? 3 : 2);
    if (linked) assert.equal(report.unexplained.some((item) => item.kind === "symlink"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
