param([Parameter(Mandatory = $true)][string]$ExecutablePath)
$ErrorActionPreference = 'Stop'
# 使用系统的私有工作集字段，不能用进程私有提交量或工作集总量代替。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class MdMemoryProbe {
  [StructLayout(LayoutKind.Sequential)]
  public struct Counters {
    public uint cb, PageFaultCount;
    public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage,
      QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage,
      PrivateUsage, PrivateWorkingSetSize;
    public ulong SharedCommitUsage;
  }
  [DllImport("psapi.dll", SetLastError=true)]
  public static extern bool GetProcessMemoryInfo(IntPtr process, ref Counters counters, uint size);
  public static ulong PrivateWorkingSet(int id) {
    using(var process=System.Diagnostics.Process.GetProcessById(id)) {
      var counters=new Counters(); counters.cb=(uint)Marshal.SizeOf(typeof(Counters));
      if(!GetProcessMemoryInfo(process.Handle,ref counters,counters.cb)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
      return counters.PrivateWorkingSetSize.ToUInt64();
    }
  }
}
'@
$all = @(Get-CimInstance Win32_Process)
$resolvedExecutable = [System.IO.Path]::GetFullPath($ExecutablePath)
$roots = @($all | Where-Object { $_.ExecutablePath -and [string]::Equals($_.ExecutablePath, $resolvedExecutable, [System.StringComparison]::OrdinalIgnoreCase) })
if ($roots.Count -ne 1) { throw "期望一个隔离阅读器进程，实际为 $($roots.Count) 个。" }
$owned = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$owned.Add([uint32]$roots[0].ProcessId)
do {
  $before = $owned.Count
  foreach ($process in $all) { if ($owned.Contains([uint32]$process.ParentProcessId)) { [void]$owned.Add([uint32]$process.ProcessId) } }
} while ($owned.Count -ne $before)
$members = @($all | Where-Object { $owned.Contains([uint32]$_.ProcessId) } | ForEach-Object {
  [PSCustomObject]@{ processId = $_.ProcessId; parentProcessId = $_.ParentProcessId; name = $_.Name; privateWorkingSetBytes = [MdMemoryProbe]::PrivateWorkingSet([int]$_.ProcessId) }
})
[PSCustomObject]@{ rootProcessId = $roots[0].ProcessId; privateWorkingSetBytes = ($members | Measure-Object -Property privateWorkingSetBytes -Sum).Sum; members = $members } | ConvertTo-Json -Depth 5 -Compress
