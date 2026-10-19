param([Parameter(Mandatory = $true)][string]$ProfilePath)
$ErrorActionPreference = 'Stop'
# 只等待命令行明确指向此隔离 WebView 数据目录的进程，不终止任何系统浏览器。
$deadline = [DateTime]::UtcNow.AddSeconds(15)
do {
  $sessions = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($ProfilePath, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  if ($sessions.Count -eq 0) { exit 0 }
  Start-Sleep -Milliseconds 100
} while ([DateTime]::UtcNow -lt $deadline)
throw "隔离 WebView 会话未完全退出：$ProfilePath"
