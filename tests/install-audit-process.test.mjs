import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "vitest";

const script = fileURLToPath(new URL("./install-audit.ps1", import.meta.url));
const PROCESS_TIMEOUT_MS = 15_000;
// 测试总预算覆盖子进程上限，并为 PowerShell 冷启动和夹具调度留出余量。
const TEST_TIMEOUT_MS = PROCESS_TIMEOUT_MS + 5_000;
// 从实际脚本加载包装函数；用 cmd 的纯退出码替代 reg.exe，不读写注册表或运行安装器。
function run(command) {
  return spawnSync(path.join(process.env.SystemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-Command", `
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $ErrorActionPreference = 'Stop'
    $tokens = $null; $errors = $null
    $source = [System.IO.File]::ReadAllText($env:MD_AUDIT_SCRIPT, [System.Text.Encoding]::UTF8)
    $ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
    if ($errors.Count) { throw '安装审计脚本语法无效' }
    $function = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-Reg' }, $true)
    if (-not $function) { throw '找不到注册表命令包装函数' }
    . ([scriptblock]::Create($function.Extent.Text))
    Set-Alias -Name reg.exe -Value $env:ComSpec
    ${command}
  `], { env: { ...process.env, MD_AUDIT_SCRIPT: script }, windowsHide: true, encoding: "utf8", timeout: PROCESS_TIMEOUT_MS });
}

test.skipIf(process.platform !== "win32")("预期的注册表非零结果不污染 GitHub PowerShell 的步骤退出码", () => {
  const result = run(`
    $global:LASTEXITCODE = 0
    $code = Invoke-Reg /d /c 'exit 1'
    if ($code -ne 1) { throw '预期的不存在结果被吞掉' }
    if ($ErrorActionPreference -ne 'Stop') { throw '错误偏好没有恢复' }
    # 与 GitHub Actions powershell 的步骤尾部采用相同判定。
    if (Test-Path -LiteralPath variable:\\LASTEXITCODE) { exit $LASTEXITCODE }
  `);
  assert.equal(result.status, 0, result.stderr);
}, TEST_TIMEOUT_MS);

test.skipIf(process.platform !== "win32")("成功的注册表命令也不会清除调用方已有的原生命令失败", () => {
  const result = run(`
    $global:LASTEXITCODE = 37
    $code = Invoke-Reg /d /c 'exit 0'
    if ($code -ne 0 -or $LASTEXITCODE -ne 37) { throw '调用方的退出码被覆盖' }
  `);
  assert.equal(result.status, 0, result.stderr);
}, TEST_TIMEOUT_MS);

test.skipIf(process.platform !== "win32")("真实操作失败仍通过返回值触发断言，不被作用域隔离掩盖", () => {
  const result = run(`
    $global:LASTEXITCODE = 0
    if ((Invoke-Reg /d /c 'exit 1') -ne 0) { throw 'fixture-operation-failed' }
  `);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /fixture-operation-failed/);
}, TEST_TIMEOUT_MS);

test.skipIf(process.platform !== "win32")("没有调用方退出码时，不为步骤尾部凭空创建一个失败状态", () => {
  const result = run(`
    Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue
    $code = Invoke-Reg /d /c 'exit 1'
    if ($code -ne 1) { throw '操作结果丢失' }
    if (Get-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue) { throw '退出码变量泄漏' }
  `);
  assert.equal(result.status, 0, result.stderr);
}, TEST_TIMEOUT_MS);
