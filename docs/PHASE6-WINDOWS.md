# 阶段 6：Windows 本机验收

本文只规定怎么跑、要留下什么证据。没有对应报告之前，`docs/ACCEPTANCE.md` 不得把这些项写成通过。性能数字未达到 SPEC.md 时保留目标，不改指标。

示例工作目录是 `H:\work\md`。命令里的路径改成自己的仓库根目录。工具链放在 `.tools\`，不进入 Git。报告写到 `.reports\`，同样不入库。

## 先确认可以自动执行的部分

在仓库根目录：

```powershell
npm ci
npm test
npm run test:core -- --locked
npm run desktop -- fmt -- --check
node tests/performance.mjs --self-check
node tests/disk-audit.mjs --self-check
```

这些检查只证明脚本、分类规则和 Rust 核心。它们不产生性能成绩，也不代替安装和原生维护。

发布安装包：

```powershell
npm run build:desktop
```

安装包应出现在 `.tools\target\release\bundle\nsis\`，文件名类似 `MD_0.1.0_x64-setup.exe`。`--no-bundle` 的 release 程序不能用来验收安装器。

## 安装关联与卸载

```powershell
$installer = Get-ChildItem .tools\target\release\bundle\nsis\*-setup.exe | Select-Object -First 1
powershell -NoProfile -ExecutionPolicy Bypass -File .\tests\install-audit.ps1 -Installer $installer.FullName -WorkRoot H:\work\md\.runtime\install-audit
```

`WorkRoot` 必须以 `install-audit` 结尾，路径不能含空格，且目录尚不存在或为空；目录本身及其现有父路径不能经过 junction / 符号链接。失败运行留下的目录要先检查，再换用新的空工作根；脚本不会凭目录名称自动清空已有内容。脚本会：

1. 导出并在结束时恢复 `HKCU` 的 `.md`、`.markdown`、`.mdown`、`Markdown 文档`，以及卸载项 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\MD`。
2. 用 `/S /NS /D=` 安装到隔离目录，确认三个扩展名的打开命令指向这次安装的 `md-reader.exe`。
3. 在进程级改写后的 `LOCALAPPDATA` 里放置应用数据，原文放在数据根之外。
4. `uninstall.exe /S` 保留数据根和原文。
5. 再次安装后 `uninstall.exe /S /DELETEAPPDATA` 删除应用数据，原文仍在。
6. 再次安装后 `uninstall.exe /S /UPDATE /DELETEAPPDATA` 仍保留应用数据。
7. 比较用户真实的 `%LOCALAPPDATA%\MdReader` 与 `io.notesae.mdreader`，确认指纹没有变化。

期望证据：`.reports\install-audit.json` 中 `result` 为 `observed`，`paths` 有四条，`specPassed` 为 `false`。退出码 0 只表示这四条路径跑完。脚本不打开主窗口，所以不能把这份报告写成首次启动或系统盘审计通过。

假设（可推翻）：NSIS 传给 `md-reader.exe --uninstall-data` 的环境包含本脚本设置的 `LOCALAPPDATA`。如果真实配置目录指纹变化，这个假设不成立，应先停止并检查安装器实际写入位置。

## 首次启动与系统盘写入

准备 Process Monitor，过滤进程名 `md-reader.exe` 和 `msedgewebview2.exe`，并限定到本次测试应用的进程组 PID，避免其他应用的 WebView 写入混入。操作包含 `CreateFile` 与 `WriteFile`，导出保留 `Process Name`、`Operation`、`Path` 和 `Result` 列。审计脚本同时检查这两个进程名，只纳入成功操作；`CreateFile` 也可能只是打开已有文件，应结合 Detail 判断，不能把它的数量直接当作实际写盘次数。使用一台没有现成 `%LOCALAPPDATA%\MdReader` 的账户，或先确认该目录可以移走。不要把用户正在使用的数据目录拿来做这次实验。

1. 从开始菜单或安装目录启动 `md-reader.exe`，不要设置 `MD_BOOTSTRAP_DIR`。
2. 在原生目录选择器选择“取消”。进程应退出。`%LOCALAPPDATA%`、`%APPDATA%` 和 `%TEMP%` 中不应留下新的 `MdReader` 数据根或 WebView 用户数据。标准引导目录最多出现空的定位目录；出现正文、历史或 WebView 配置则失败。
3. 再次启动，选择非系统盘上的空父目录。应用应创建该目录下的 `MdReader`，而不是改写到 `C:`。
4. 打开一篇本地 Markdown，切换主题，确认 `webview\EBWebView` 出现在所选数据根里。
5. 导出 Process Monitor CSV。

然后：

```powershell
node tests\disk-audit.mjs --capture --data-root F:\AppData\MdReader --bootstrap-dir $env:LOCALAPPDATA\MdReader --procmon .reports\procmon.csv
```

把 `--data-root` 换成实际选择的数据根。期望 `.reports\disk-audit.json` 记下未解释写入和引导文件体积。`specPassed` 固定为 `false`：目录快照和一份 CSV 仍要由人对照 SPEC.md §5、§6 判断是否覆盖了首次启动、普通阅读、设置修改和异常退出。引导文件单份不超过 16KiB，`bootstrap.json`、`bootstrap.recovery.json` 及两份 `.pending` 合计不超过 64KiB。

## 原生维护

```powershell
node tests\native-maintenance.mjs .tools\target\release\md-reader.exe
```

看到 `PICKER_PARENT=` 时，在原生目录选择器里选择等号后面的目录，不要选它的子目录 `MdReader`。脚本用这个父目录核对迁移目标。完整模式包含 WebView 重建、真实迁移、再次启动，以及复制中断、校验失败、未确认回滚、正文恢复失败、旧会话占用和残留重试。

只跑故障恢复、不操作选择器：

```powershell
node tests\native-maintenance.mjs .tools\target\release\md-reader.exe --recovery-only
```

`--recovery-only` 仍会打开真实窗口，不能代替完整模式。最新完整与恢复报告分别保存在 `.reports\native-maintenance-full.json` 和 `.reports\native-maintenance-recovery-only.json`，每次运行另存 `.reports\native-maintenance\<本次夹具 UUID>.json`；`.reports\native-maintenance.json` 只指向最近一次运行。期望完整模式报告的 `result` 为 `passed`，并且 `checks` 包含两条真实维护记录。不要拿恢复模式或旧运行的报告代替本次完整验收，也不要只保留最新文件而丢失失败记录。

## 性能、内存、滚动和 100 次切换

使用 release 程序，不要用调试构建。先准备驱动：`.tools\cargo\bin\tauri-driver.exe` 与匹配的 `.tools\webdriver\msedgedriver.exe`。

```powershell
$env:MD_PERF_SAMPLES = '30'
$env:MD_SWITCHES = '100'
node tests\performance.mjs .tools\target\release\md-reader.exe
node tests\startup.mjs .tools\target\release\md-reader.exe
```

`MD_PERF_SAMPLES` 少于 30 或 `MD_SWITCHES` 少于 100 时，报告里的 `formal` 应为 `false`，不能用来对照 P95。

期望：

- `.reports\performance.json` 的 `result` 为 `measured`，`specPassed` 为 `false`。
- 100KB、1MB、10MB 在持久缓存开和关时都有样本；缓存开启的第一次写入不计入该组。
- `comparison` 可以显示是否落在 SPEC 目标内，但验收记录还要写 CPU、系统版本、WebView2 版本、分辨率、缩放，并分开冷缓存和热缓存。
- 1MB 静置后的进程组私有工作集来自 `tests\process-memory.ps1`。WebDriver 会换掉 WebView 用户数据目录，所以 JSON 里的缓存字节只统计应用 `cache\`。
- 滚动记录帧间隔和超过 50ms 的长任务。
- `.reports\startup.json` 把第一次初始化单独列出，其后的样本才进入中位和 P95。目标仍是恢复约 100KB 文档时 P95 ≤ 1.5 秒。

当前没有把任何一次未在目标机器上完成的采样写成达标。
