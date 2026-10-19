import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { saveMaintenanceReport } from "./maintenance-report.mjs";

test("原生完整与恢复运行各留报告，后续运行不覆盖此前的检查结果和失败证据", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "md-native-report-"));
  const read = async (file) => JSON.parse(await readFile(path.join(root, ".reports", file), "utf8"));
  const first = { base: path.join(root, "first-run"), mode: "full", result: "failed", checks: ["WebView 重建完成"], error: "选择目录时中断" };
  const recovery = { base: path.join(root, "recovery-run"), mode: "recovery-only", result: "passed", checks: ["回滚保留源文件"] };
  const next = { base: path.join(root, "next-run"), mode: "full", result: "running", checks: [] };
  try {
    await saveMaintenanceReport(root, first);
    await saveMaintenanceReport(root, recovery);
    assert.deepEqual(await read("native-maintenance-full.json"), first);
    assert.deepEqual(await read("native-maintenance.json"), recovery);
    await saveMaintenanceReport(root, next);
    assert.deepEqual(await read("native-maintenance/first-run.json"), first);
    assert.deepEqual(await read("native-maintenance/recovery-run.json"), recovery);
    assert.deepEqual(await read("native-maintenance-recovery-only.json"), recovery);
    assert.deepEqual(await read("native-maintenance-full.json"), next);
    assert.deepEqual(await read("native-maintenance.json"), next);
  } finally {
    assert.equal(path.dirname(await realpath(root)), await realpath(tmpdir()));
    await rm(root, { recursive: true, force: true });
  }
});
