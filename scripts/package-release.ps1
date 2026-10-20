$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$out = Join-Path $root '.runtime\release-artifacts'
$stage = Join-Path $root '.runtime\release-stage'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Utf8([string]$File, [string]$Text) {
  [System.IO.File]::WriteAllText($File, $Text, $utf8)
}
function File-Sha([string]$File) {
  return (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant()
}

# 只在固定工作区输出；已有文件和路径别名都拒绝覆盖，不清理用户目录。
foreach ($directory in @($out, $stage)) {
  $cursor = $directory
  while ($cursor -and $cursor.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "输出路径不是普通目录：$cursor" }
    }
    if ($cursor -eq $root) { break }
    $cursor = [IO.Path]::GetDirectoryName($cursor)
  }
  if (Test-Path -LiteralPath $directory) {
    if (@(Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1).Count -gt 0) { throw "输出目录已有内容：$directory" }
  } else { [void](New-Item -ItemType Directory -Path $directory) }
}

$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$tauri = Get-Content -LiteralPath (Join-Path $root 'src-tauri\tauri.conf.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$toml = Get-Content -LiteralPath (Join-Path $root 'src-tauri\Cargo.toml') -Raw -Encoding UTF8
$version = $package.version
$cargoVersion = [regex]::Match($toml, '(?m)^version = "([^"]+)"').Groups[1].Value
if ($version -notmatch '^\d+\.\d+\.\d+$' -or $tauri.version -ne $version -or $cargoVersion -ne $version) { throw '版本元数据不一致' }

$binary = Join-Path $root '.tools\target\release\md-reader.exe'
$installer = Join-Path $root ('.tools\target\release\bundle\nsis\MD_{0}_x64-setup.exe' -f $version)
$notesTemplate = Join-Path $root ('docs\releases\v{0}.md' -f $version)
foreach ($file in @($binary, $installer, $notesTemplate)) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw "缺少构建输入：$file" }
}
$productVersion = (Get-Item -LiteralPath $binary).VersionInfo.ProductVersion
if ($productVersion -notmatch ('^' + [regex]::Escape($version) + '(?:\.0)?(?:\+.*)?$')) { throw "程序版本与元数据不一致：$productVersion" }

$audit = Get-Content -LiteralPath (Join-Path $root '.reports\install-audit.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($audit.result -ne 'observed' -or $audit.restoredRegistry -ne $true -or $audit.specPassed -ne $false -or $audit.paths.Count -ne 4 -or $audit.restoreErrors.Count -ne 0) { throw '隔离安装审计未完成或结论不符' }

$commit = (& git -C $root rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw '无法确认构建提交' }
$tree = (& git -C $root rev-parse 'HEAD^{tree}').Trim()
if ($LASTEXITCODE -ne 0) { throw '无法确认构建代码树' }
if ($env:GITHUB_SHA -and $env:GITHUB_SHA -ne $commit) { throw 'CI 提交与实际检出不一致' }
& git -C $root diff --quiet HEAD --
if ($LASTEXITCODE -ne 0) { throw '构建修改了受跟踪的源文件' }

$binarySha = File-Sha $binary
$installerOut = Join-Path $out ('MD_{0}_x64-setup.exe' -f $version)
Copy-Item -LiteralPath $installer -Destination $installerOut
$readme = Join-Path $stage 'README.txt'
Write-Utf8 $readme (("MD {0} prerelease - Windows x64" -f $version) + [Environment]::NewLine + 'Run md-reader.exe. WebView2 is required. Choose the application data location when prompted; original Markdown and attachments remain read-only.' + [Environment]::NewLine + 'This package does not establish native performance, complete migration acceptance, GitHub client login, or private in-app update validation.' + [Environment]::NewLine)
$standalone = Join-Path $out ('MD_{0}_x64-standalone.zip' -f $version)
Compress-Archive -LiteralPath @($binary, $readme) -DestinationPath $standalone -CompressionLevel Optimal

# 直接校验 ZIP 内程序字节，不启动应用或执行安装。
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($standalone)
try {
  $entry = $zip.GetEntry('md-reader.exe')
  if ($zip.Entries.Count -ne 2 -or -not $entry -or -not $zip.GetEntry('README.txt')) { throw '独立包内容不符' }
  $stream = $entry.Open()
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { $zippedSha = [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
  if ($zippedSha -ne $binarySha) { throw 'ZIP 内程序与构建输出不一致' }
} finally { $zip.Dispose() }

$ciUrl = if ($env:GITHUB_RUN_ID) { 'https://github.com/Notesae/md/actions/runs/' + $env:GITHUB_RUN_ID } else { $null }
$notesOut = Join-Path $out 'RELEASE-NOTES.md'
$notes = [IO.File]::ReadAllText($notesTemplate, [Text.Encoding]::UTF8)
$notes += [Environment]::NewLine + 'Source commit: ' + $commit + [Environment]::NewLine + 'Source tree: ' + $tree + [Environment]::NewLine + 'CI: ' + $ciUrl + [Environment]::NewLine
Write-Utf8 $notesOut $notes
$payload = @($installerOut, $standalone, $notesOut)
$info = [ordered]@{
  product = 'MD'; version = $version; platform = 'windows-x64'
  commit = $commit; tree = $tree; expectedTag = 'v' + $version
  createdAtUtc = [DateTime]::UtcNow.ToString('o')
  workflow = [ordered]@{ url = $ciUrl; attempt = $env:GITHUB_RUN_ATTEMPT; event = $env:GITHUB_EVENT_NAME; ref = $env:GITHUB_REF }
  checksBeforePackaging = @('frontend build', 'behavior tests', 'Rust core tests', 'desktop compilation', 'isolated installer audit')
  installerAudit = [ordered]@{ result = $audit.result; paths = $audit.paths; restoredRegistry = $audit.restoredRegistry; specPassed = $audit.specPassed; specPassedReason = $audit.specPassedReason }
  nativeAcceptanceEstablished = $false; privateInAppUpdateValidated = $false
  executable = [ordered]@{ name = 'md-reader.exe'; productVersion = $productVersion; sha256 = $binarySha; bytes = (Get-Item -LiteralPath $binary).Length }
  payload = @($payload | ForEach-Object { [ordered]@{ name = [IO.Path]::GetFileName($_); bytes = (Get-Item -LiteralPath $_).Length; sha256 = File-Sha $_ } })
}
$infoOut = Join-Path $out 'BUILD-INFO.json'
Write-Utf8 $infoOut ($info | ConvertTo-Json -Depth 8)
$payload += $infoOut
$sumLines = @($payload | Sort-Object { [IO.Path]::GetFileName($_) } | ForEach-Object { (File-Sha $_) + '  ' + [IO.Path]::GetFileName($_) })
Write-Utf8 (Join-Path $out 'SHA256SUMS.txt') (($sumLines -join [char]10) + [char]10)
if (@(Get-ChildItem -LiteralPath $out -File).Count -ne 5) { throw '发布目录必须恰好包含五个附件' }
Write-Host ($info | ConvertTo-Json -Depth 8)
