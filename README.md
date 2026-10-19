# MD

面向 Windows 的本地 Markdown 桌面阅读器，采用 Tauri 2、Rust 与 TypeScript。

当前正在建立初版。完整产品要求见 [SPEC.md](SPEC.md)，模块和数据边界见 [架构](docs/ARCHITECTURE.md)，实施进度见 [任务](tasks/todo.md)。性能目标尚待实测。

只读访问原始文章和附件；应用数据与 WebView 数据使用用户选择的位置。首版不包含编辑、同步和插件系统。

构建、运行与验证命令随可运行工程一起补充。本项目不使用 Maven。
