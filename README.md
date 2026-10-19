# MD

面向 Windows 的本地 Markdown 桌面阅读器，采用 Tauri 2、Rust 与 TypeScript。

当前正在建立初版。完整产品要求见 [SPEC.md](SPEC.md)，模块和数据边界见 [架构](docs/ARCHITECTURE.md)，实施进度见 [任务](tasks/todo.md)。性能目标尚待实测。

只读访问原始文章和附件；应用数据与 WebView 数据使用用户选择的位置。首版不包含编辑、同步和插件系统。

左侧文件夹下拉框可切换最近目录，旁边的关闭按钮只关闭目录导航，保留当前文章与历史；重启保持目录关闭。失效目录会提示重新选择，设置中的“清除记录”会同时清除最近文件与目录。

## 开发与验证

依赖 Node.js 22.12+、Rust stable、Visual Studio C++ 桌面构建工具、Windows SDK 和 WebView2。运行前执行 `npm ci`。

```powershell
npm run desktop
npm run build
npm test
npm run test:core
npm run check:desktop
npm run desktop -- fmt -- --check
npm run desktop -- build --debug --no-bundle
```

开发脚本优先使用 `.tools/` 下的本地工具，否则使用系统工具；Cargo 构建产物和可控临时目录定位到工作盘 `.tools/`。不修改全局 PATH。本项目不使用 Maven。

没有全局 npm 时，可在 `.tools/bin/npm.cmd` 提供调用本地 npm CLI 的入口；`node scripts/desktop.mjs build --no-bundle` 会自动将该目录加入子进程 PATH。Rust/Cargo、MSVC 和驱动的当前验证版本见 [验证记录](docs/VALIDATION.md)，本地工具不进入仓库。

`tests/desktop-smoke.mjs` 使用真正的桌面程序和 Tauri 官方驱动；测试前用 `src-tauri/examples/prepare_test.rs` 创建 `.runtime/desktop-smoke`，并在 `.tools/cargo/bin` 与 `.tools/webdriver` 提供对应驱动。`tests/storage-audit.mjs` 独立检查实际 WebView 数据位置。完整结果和未测项见 [验证记录](docs/VALIDATION.md) 与 [验收矩阵](docs/ACCEPTANCE.md)。

原生维护回归连接 release 程序自身的 WebView2 调试端口，不覆盖其数据目录，也无需下载 Chromium：

```powershell
node tests/native-maintenance.mjs .tools/target/release/md-reader.exe
```

脚本创建独立归属的 `.runtime/native-maintenance/<随机实例>/`，执行真实设置入口、维护重启、状态恢复和故障阶段恢复。出现 `PICKER_PARENT=...` 时，在原生目录选择器选择打印的隔离父目录；脚本继续确认迁移并验证再次启动。`--recovery-only` 只运行无需操作选择器的故障场景，仍会启动真实窗口，不能替代完整回归，也不适用于禁止干扰桌面的验证场景。报告保存在 `.reports/native-maintenance.json`；测试数据和报告均不入库。前端测试只收集根目录 `tests/`，不会执行本地工具中的旧工程副本。

当前迁移健康确认已经与首屏计时分离，只有完整正文、会话刷新及最后一次有效定位成功后才允许清理迁移源。启动探针也要等这次提交成功后才写入。后台回归覆盖打开/定位/会话失败、设置交错、目标损坏或归属改变、回滚与源保留。

Windows 上的安装关联、卸载、首次启动、系统盘审计、原生维护和正式性能采样步骤见 [阶段 6 本机验收](docs/PHASE6-WINDOWS.md)。没有对应报告时，这些项在 [验收矩阵](docs/ACCEPTANCE.md) 中保持未测。
