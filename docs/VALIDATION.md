# 验证记录

## 2026-10-19 工程骨架检查

- 当前平台：Windows x64，Node 22.17.1，npm 11.5.1；Rust 1.99.1（项目本地安装），WebView2 155.0.4283.62。
- `npm run build`：通过，TypeScript 严格检查和 Vite 生产构建均成功。此时为工程骨架，不能视作阅读功能或性能通过。
- `npm run test:core`：未执行到行为测试。MSVC `link.exe` 缺失，编译依赖阶段失败；安装器日志显示 UAC 未通过，等待安装环境恢复。
- Windows CI 将在阶段提交后验证存储测试、桌面编译与 release 构建；CI 结果和本机实际运行必须分别记录。
- SPEC.md 中的性能、迁移故障注入、实际落盘和文件关联尚未验证，不宣告达标。

## 本机工具链恢复与阅读核心

- 用户通过 UAC 后，微软工具安装退出码为 0；主体位于 `.tools/BuildTools`。Rust、Cargo、npm 下载缓存和临时目录均定位到工作盘。
- 修复 Windows `Path` 大小写与 `cmd` 引号问题后，`npm run test:core` 在本机通过 8 项行为测试：4 项存储、4 项文档解析/安全/取消。
- `npm test` 通过 3 项搜索行为测试，包含中文、字面量转义、Unicode 偏移与结果截断。
- 文档核心测试先观察到缺失模块导致的失败，再实现并验证通过。先前的 MSVC 依赖失败不计为行为测试失败。
- 本次只是阅读核心检查点，原生窗口交互和完整初版仍在实施。

## Windows 桌面阅读闭环

- `npm run check:desktop` 与 `npm run desktop -- build --debug --no-bundle` 通过，产物为真实 `md-reader.exe`。
- `node tests/desktop-smoke.mjs`：6 组真实 WebView2 检查通过，包括恢复文章、IPC 数据根、正文范围搜索、目录跳转、Worker 高亮/公式、深色/设置，以及磁盘上实际保存的偏好和历史。
- `node tests/storage-audit.mjs`：独立启动不受 WebDriver 干预的程序，在 `.runtime/desktop-smoke/data/webview/EBWebView/Local State` 观察到真实用户数据文件。
- 单独检查的原因：微软 WebDriver 会覆盖 WebView2 用户数据目录，驱动下的截图不能证明应用配置的目录被采用。
- 截图已检查：1280×860 的浅色阅读、深色阅读和同窗口设置。深色切换瞬间存在控件颜色过渡，下一轮需等待过渡结束后复核；窄窗口仍待验证。
- 原生 Windows 自动化插件初始化失败（组件导出不匹配），未执行任何输入；随后使用 Tauri 官方 `tauri-driver 2.1.0` 和微软 Edge Driver 155.0.4283.62 完成真实桌面检查。
- 测试数据均为仓库样例，位于隔离工作盘目录；没有改写原始用户文章。调试构建的首屏数字不用于 SPEC.md 性能验收。
- 原生首次位置选择、文件拖放、外部变更、重启位置、安装文件关联、存储迁移及 release 性能尚待覆盖，详见 ACCEPTANCE.md。
