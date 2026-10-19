# 当前用户安装、文件关联，以及保留 / 清理 / 升级三条卸载。
# 不启动主窗口，因此不能证明首次选目录或系统盘全程审计。
# 会暂时改写 HKCU 的 .md 关联和名为 MD 的卸载项，结束时按开始时的导出恢复。
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'

function Assert-SafeRoot([string]$Path) {
  if ($Path -match '\s') { throw "路径不能包含空格，否则 NSIS /D= 不能可靠传递：$Path" }
  $full = [System.IO.Path]::GetFullPath($Path)
  if (-not $full.EndsWith('\install-audit')) { throw "WorkRoot 必须以 install-audit 结尾，避免清理其他目录：$full" }
  $drive = [System.IO.Path]::GetPathRoot($full)
  if ($full.TrimEnd('\') -eq $drive.TrimEnd('\')) { throw "不能把盘符根当作工作目录。" }
  return $full
}

function Invoke-Quiet([string]$File, [string]$Arguments) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $File
  $info.Arguments = $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($info)
  if (-not $process.WaitForExit(180000)) { try { $process.Kill() } catch { }; throw "$File 超过 3 分钟未退出" }
  if ($process.ExitCode -ne 0) { throw "$File $Arguments 退出码 $($process.ExitCode)" }
}

function Get-DefaultValue([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  return [string](Get-Item -LiteralPath $Path).GetValue('')
}

function Assert-Associated([string]$Executable) {
  foreach ($extension in @('.md', '.markdown', '.mdown')) {
    $progid = Get-DefaultValue "HKCU:\Software\Classes\$extension"
    if ($progid -ne 'Markdown 文档') { throw "$extension 的关联不是 Markdown 文档，实际为 $progid" }
  }
  $command = Get-DefaultValue 'HKCU:\Software\Classes\Markdown 文档\shell\open\command'
  if (-not $command -or $command -notlike "*$Executable*") { throw "打开命令没有指向安装程序：$command" }
}

function Initialize-AuditData([string]$LocalAppData, [string]$DataRoot, [string]$Original) {
  $id = [guid]::NewGuid().ToString('D')
  if (Test-Path -LiteralPath $DataRoot) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
  foreach ($name in @('state', 'cache', 'webview', 'logs', 'temp')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $DataRoot $name) | Out-Null
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  $owner = @{ app_id = 'io.notesae.mdreader'; format_version = 1; instance_id = $id; state_written = $false } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText((Join-Path $DataRoot 'owner.json'), $owner, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $DataRoot 'cache\probe.txt'), 'cache', $utf8)
  $boot = Join-Path $LocalAppData 'MdReader'
  if (Test-Path -LiteralPath $boot) { Remove-Item -LiteralPath $boot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $boot | Out-Null
  $record = @{ format_version = 1; root = $DataRoot; instance_id = $id; migration = $null; pending_cleanup = $null; reset_webview = $null; notice = $null; force_recovery = $false } | ConvertTo-Json -Compress -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $boot 'bootstrap.json'), $record, $utf8)
  [System.IO.File]::WriteAllText((Join-Path $boot 'bootstrap.recovery.json'), $record, $utf8)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Original) | Out-Null
  if (-not (Test-Path -LiteralPath $Original)) { [System.IO.File]::WriteAllText($Original, "原文保留`n", $utf8) }
  $bytes = [int64](Get-ChildItem -LiteralPath $boot -File | Measure-Object -Property Length -Sum).Sum
  if ($bytes -gt 64KB) { throw "引导目录超过 64KiB：$bytes" }
  return $boot
}

$WorkRoot = Assert-SafeRoot $WorkRoot
$Installer = [System.IO.Path]::GetFullPath($Installer)
if ($Installer -match '\s') { throw "安装包路径不能包含空格：$Installer" }
if (-not (Test-Path -LiteralPath $Installer)) { throw "找不到安装包：$Installer" }
$repo = Split-Path -Parent $PSScriptRoot
$backup = Join-Path ([System.IO.Path]::GetTempPath()) ('md-install-audit-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $backup | Out-Null
$savedKeys = @()
$shortcutBackup = @()
$report = [ordered]@{
  result = 'running'
  specPassed = $false
  specPassedReason = '没有启动主窗口，不能证明首次选择、取消退出或系统盘全程写入。'
  installer = $Installer
  workRoot = $WorkRoot
  paths = @()
}
function Get-TreeFingerprint([string]$Directory) {
  if (-not (Test-Path -LiteralPath $Directory)) { return '' }
  return ((Get-ChildItem -LiteralPath $Directory -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName + '=' + $_.Length } | Sort-Object) -join '|')
}
# 在改写进程环境之前记住真实配置目录，结束时确认测试没有碰到用户自己的数据。
$realLocal = $env:LOCALAPPDATA
$realMd = Join-Path $realLocal 'MdReader'
$realBundle = Join-Path $realLocal 'io.notesae.mdreader'
$beforeRealMd = Get-TreeFingerprint $realMd
$beforeRealBundle = Get-TreeFingerprint $realBundle
$installDir = Join-Path $WorkRoot 'app'
$exe = Join-Path $installDir 'md-reader.exe'
$dataRoot = Join-Path $WorkRoot 'library'
$original = Join-Path $WorkRoot 'originals\文章.md'
$keys = @(
  'HKCU\Software\Classes\.md',
  'HKCU\Software\Classes\.markdown',
  'HKCU\Software\Classes\.mdown',
  'HKCU\Software\Classes\Markdown 文档',
  'HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MD'
)
$shortcuts = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'MD.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'MD.lnk')
)

try {
  foreach ($key in $keys) {
    $file = Join-Path $backup (($key -replace '[\\: ]', '_') + '.reg')
    & reg.exe query $key *> $null
    if ($LASTEXITCODE -eq 0) {
      & reg.exe export $key $file /y | Out-Null
      if ($LASTEXITCODE -ne 0) { throw "无法导出注册表 $key" }
      $savedKeys += [pscustomobject]@{ Key = $key; File = $file; Existed = $true }
    } else { $savedKeys += [pscustomobject]@{ Key = $key; File = $null; Existed = $false } }
  }
  foreach ($shortcut in $shortcuts) {
    if (Test-Path -LiteralPath $shortcut) {
      $dest = Join-Path $backup ([System.IO.Path]::GetFileName($shortcut) + '-' + [guid]::NewGuid().ToString('N'))
      Copy-Item -LiteralPath $shortcut -Destination $dest -Force
      $shortcutBackup += [pscustomobject]@{ Path = $shortcut; Backup = $dest }
    }
  }
  if (Test-Path -LiteralPath $WorkRoot) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $installDir | Out-Null
  # 只隔离这个安装进程看到的配置和临时目录，不改用户级环境变量。
  $env:LOCALAPPDATA = Join-Path $WorkRoot 'local'
  $env:APPDATA = Join-Path $WorkRoot 'roaming'
  $env:TEMP = Join-Path $WorkRoot 'temp'
  $env:TMP = $env:TEMP
  foreach ($directory in @($env:LOCALAPPDATA, $env:APPDATA, $env:TEMP)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }

  Invoke-Quiet $Installer "/S /NS /D=$installDir"
  if (-not (Test-Path -LiteralPath $exe)) { throw "安装后没有主程序：$exe" }
  $profileWrites = @(Get-ChildItem -LiteralPath $env:LOCALAPPDATA -Recurse -File -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\MdReader\\|\\io\.notesae\.mdreader\\' })
  if ($profileWrites.Count -gt 0) { throw "安装器在首次启动前写入了应用数据：$($profileWrites.FullName -join ', ')" }
  Assert-Associated $exe
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in $shortcuts) {
    if (Test-Path -LiteralPath $shortcut) {
      $target = $shell.CreateShortcut($shortcut).TargetPath
      if ($target -and $target.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)) { throw "/NS 仍创建了指向测试安装目录的快捷方式：$shortcut" }
    }
  }
  $report.paths += '安装完成，三个扩展名关联到当前用户安装目录，安装阶段没有创建 MdReader 数据'

  $boot = Initialize-AuditData $env:LOCALAPPDATA $dataRoot $original
  Invoke-Quiet (Join-Path $installDir 'uninstall.exe') '/S'
  if (Test-Path -LiteralPath $exe) { throw '保留数据的卸载后程序仍在' }
  if (-not (Test-Path -LiteralPath $dataRoot)) { throw '保留数据的卸载删除了数据根' }
  if (-not (Test-Path -LiteralPath $original)) { throw '卸载删除了原始文章' }
  if (-not (Test-Path -LiteralPath (Join-Path $boot 'bootstrap.json'))) { throw '保留数据的卸载删除了引导记录' }
  $command = Get-DefaultValue 'HKCU:\Software\Classes\Markdown 文档\shell\open\command'
  if ($command -and $command -like "*$exe*") { throw '保留卸载后关联仍指向已删除程序' }
  $report.paths += '静默卸载保留隔离数据根、引导记录和原始文章，并移除文件关联'

  Invoke-Quiet $Installer "/S /NS /D=$installDir"
  Assert-Associated $exe
  Invoke-Quiet (Join-Path $installDir 'uninstall.exe') '/S /DELETEAPPDATA'
  if (Test-Path -LiteralPath $dataRoot) { throw '勾选清理后数据根仍在' }
  if (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'MdReader\bootstrap.json')) { throw '勾选清理后引导记录仍在' }
  if (-not (Test-Path -LiteralPath $original)) { throw '清理数据时删除了原始文章' }
  $report.paths += '静默 /DELETEAPPDATA 删除隔离应用数据，原始文章仍在'

  Invoke-Quiet $Installer "/S /NS /D=$installDir"
  Initialize-AuditData $env:LOCALAPPDATA $dataRoot $original | Out-Null
  Invoke-Quiet (Join-Path $installDir 'uninstall.exe') '/S /UPDATE /DELETEAPPDATA'
  if (-not (Test-Path -LiteralPath $dataRoot)) { throw '升级卸载删除了数据根' }
  if (-not (Test-Path -LiteralPath (Join-Path $env:LOCALAPPDATA 'MdReader\bootstrap.json'))) { throw '升级卸载删除了引导记录' }
  if (-not (Test-Path -LiteralPath $original)) { throw '升级卸载删除了原始文章' }
  $report.paths += '带 /UPDATE 时即使传入 /DELETEAPPDATA 也保留应用数据'
  if ((Get-TreeFingerprint $realMd) -ne $beforeRealMd -or (Get-TreeFingerprint $realBundle) -ne $beforeRealBundle) {
    throw '测试过程改动了用户真实的 LocalAppData 应用目录。隔离环境变量没有覆盖全部写入。'
  }
  $report.result = 'observed'
} catch {
  $report.result = 'failed'
  $report.error = "$_"
  throw
} finally {
  $restoreErrors = @()
  foreach ($item in $savedKeys) {
    & reg.exe delete $item.Key /f *> $null
    if ($item.Existed) {
      & reg.exe import $item.File | Out-Null
      if ($LASTEXITCODE -ne 0) { $restoreErrors += "无法恢复 $($item.Key)" }
    }
  }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($shortcut in $shortcuts) {
    if (Test-Path -LiteralPath $shortcut) {
      $target = $shell.CreateShortcut($shortcut).TargetPath
      if ($target -and $target.StartsWith($installDir, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $shortcut -Force
      }
    }
  }
  foreach ($item in $shortcutBackup) {
    Copy-Item -LiteralPath $item.Backup -Destination $item.Path -Force
  }
  $reportDirectory = Join-Path $repo '.reports'
  New-Item -ItemType Directory -Force -Path $reportDirectory | Out-Null
  $report.restoredRegistry = $restoreErrors.Count -eq 0
  ($report | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath (Join-Path $reportDirectory 'install-audit.json') -Encoding UTF8
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Recurse -Force }
  if ($report.result -eq 'observed' -and (Test-Path -LiteralPath $WorkRoot)) { Remove-Item -LiteralPath $WorkRoot -Recurse -Force }
  if ($restoreErrors.Count -gt 0) { throw ($restoreErrors -join '; ') }
}
