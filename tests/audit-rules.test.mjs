import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { test } from "vitest";
import { selfCheckAuditRules } from "./audit-rules.mjs";
import { judgeSnapshot } from "./disk-audit.mjs";

test("引导预算和写入分类拒绝未说明位置", () => {
  selfCheckAuditRules();
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
