import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

const script = fileURLToPath(new URL("./install-audit.ps1", import.meta.url));
const PROCESS_TIMEOUT_MS = 15_000;
// 总预算按每例实际启动的 PowerShell 数量计算，另留冷启动与临时夹具清理余量。
const TEST_MARGIN_MS = 5_000;
// 只加载实际脚本的路径校验函数，不运行安装器、注册表备份或清理流程。
const command = `
  $ErrorActionPreference = 'Stop'
  $tokens = $null; $errors = $null
  $source = [System.IO.File]::ReadAllText($env:MD_AUDIT_SCRIPT, [System.Text.Encoding]::UTF8)
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw '安装审计脚本语法无效' }
  $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Assert-SafeRoot' }, $true)
  if (-not $function) { throw '找不到路径校验入口' }
  . ([scriptblock]::Create($function.Extent.Text))
  Assert-SafeRoot $env:MD_AUDIT_TEST_ROOT
`;
function validate(root) {
  return spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, MD_AUDIT_SCRIPT: script, MD_AUDIT_TEST_ROOT: root }, windowsHide: true, encoding: "utf8", timeout: PROCESS_TIMEOUT_MS,
  });
}
async function temporary(run) {
  const base = await mkdtemp(path.join(tmpdir(), "md-install-guard-"));
  try { await run(base); }
  finally {
    // 只清理由本测试在系统临时目录直接创建的夹具；rm 不跟随夹具内的 junction。
    assert.equal(path.dirname(await realpath(base)), await realpath(tmpdir()));
    await rm(base, { recursive: true, force: true });
  }
}

test.skipIf(process.platform !== "win32")("安装审计接受尚未创建的隔离工作根", () => temporary(async (base) => {
  const result = validate(path.join(base, "install-audit"));
  assert.equal(result.status, 0, result.stderr);
}), PROCESS_TIMEOUT_MS + TEST_MARGIN_MS);

test.skipIf(process.platform !== "win32")("安装审计拒绝已有内容，保留同名目录中的原始文件", () => temporary(async (base) => {
  const root = path.join(base, "install-audit");
  await mkdir(root); await writeFile(path.join(root, "original.md"), "原文不能被测试清理");
  const result = validate(root);
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(path.join(root, "original.md"), "utf8"), "原文不能被测试清理");
}), PROCESS_TIMEOUT_MS + TEST_MARGIN_MS);

test.skipIf(process.platform !== "win32")("安装审计拒绝 junction 工作根及其后代", () => temporary(async (base) => {
  const outside = path.join(base, "outside"); await mkdir(outside);
  const alias = path.join(base, "install-audit"); await symlink(outside, alias, "junction");
  assert.notEqual(validate(alias).status, 0);
  assert.notEqual(validate(path.join(alias, "install-audit")).status, 0);
}), 2 * PROCESS_TIMEOUT_MS + TEST_MARGIN_MS);
