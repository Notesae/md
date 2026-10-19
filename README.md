# MD

面向 Windows 的本地 Markdown 桌面阅读器，采用 Tauri 2、Rust 与 TypeScript。

当前正在建立初版。完整产品要求见 [SPEC.md](SPEC.md)，模块和数据边界见 [架构](docs/ARCHITECTURE.md)，实施进度见 [任务](tasks/todo.md)。性能目标尚待实测。

只读访问原始文章和附件；应用数据与 WebView 数据使用用户选择的位置。首版不包含编辑、同步和插件系统。

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

`tests/desktop-smoke.mjs` 使用真正的桌面程序和 Tauri 官方驱动；测试前用 `src-tauri/examples/prepare_test.rs` 创建 `.runtime/desktop-smoke`，并在 `.tools/cargo/bin` 与 `.tools/webdriver` 提供对应驱动。`tests/storage-audit.mjs` 独立检查实际 WebView 数据位置。完整结果和未测项见 [验证记录](docs/VALIDATION.md) 与 [验收矩阵](docs/ACCEPTANCE.md)。
