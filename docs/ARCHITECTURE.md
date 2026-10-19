# MD 初始架构

## 决策

采用 Tauri 2 / Rust / Vite / 原生 TypeScript。单主窗口复用 WebView，设置在同一窗口显示。Markdown 在 Rust 使用 pulldown-cmark 全文解析，按顶层合法块返回；前端分批插入，异步补充高亮和公式。原始 HTML 作为文本显示，链接和图片经过协议、路径与属性边界处理，正文不能调用桌面接口。

## 模块边界

- `src-tauri/src/storage.rs`：目录归属、原子状态、引导记录、占用、缓存配额与安全清理；不依赖 WebView，先建立可测试核心。
- `src-tauri/src/migration.rs`：迁移阶段、目标盘暂存校验、旧进程退出等待、启动恢复和残留清理。
- `src-tauri/src/document.rs`：只读文件、UTF-8 校验、全文 Markdown 解析、目录与图片资源授权；不承担界面状态。
- `src-tauri/src/lib.rs`：启动、单实例、原生选择器、受限命令、监听、关闭和重启编排。
- `src/reader.ts`：正文分批展示、导航、搜索、复制、延迟增强及阅读位置。
- `src/main.ts`：窗口布局、文件树、最近记录、设置和桌面桥接；不自行读写磁盘。
- `src/styles.css`：主题和排版，尊重减少动画偏好，无远程字体依赖。

IPC 使用具名命令与结构化 DTO。文件选择、拖入和进程参数由后台授权，再读取；本地图片限定在当前文档目录的真实子路径内，不开放通配文件系统。远程图片默认禁用，明确操作后只允许 HTTPS 图片，不允许文章脚本、iframe、SVG 活动内容或外部样式。

## 启动与持久化

先取得单实例锁，再读取最大 16KiB 的引导文件并恢复迁移。缺失或无效时原生选择新目录或已有目录，取消退出；主 WebView 创建时将 `data_directory` 指向选择位置。标准用户配置仅保存小型定位记录，其余数据全部归入自定义根目录。状态使用临时文件 + 原子替换，读取损坏状态应报错并保留原件。

根目录使用 `owner.json` 标识应用身份、格式和实例；拒绝盘根、UNC、映射网络盘、重解析点、未归属的非空目录和嵌套迁移。主程序同时只允许一个写入者。迁移先保存状态和持久化意图，再退出当前进程；下一次启动、创建 WebView 之前复制并校验必要状态，在目标盘暂存，提交后原子更新引导。首次健康确认前保留源数据；失败回滚，成功后清理旧应用自有目录，失败残留在设置页可见并可重试。WebView 清理同样只在下一启动且旧进程退出后执行。

引导区使用 `bootstrap.json`、`bootstrap.recovery.json` 和各自固定的暂存名。每份内容最多 16KiB，总预算不超过 64KiB；不使用崩溃后可能累积的随机引导暂存文件。Windows 原子替换使用 write-through，旧目录仅在新位置健康及两份指针已保存后清理。

不建立文章持久缓存的第一条路径天然满足关闭缓存的行为；缓存预算与有界淘汰在引入缓存时一起验证。阅读历史最多 1000 项，内存文档仅持有当前文档，后台解析串行，过期请求丢弃。日志不记正文或查询词。

## 官方依据

- [Tauri Windows 前置条件](https://v2.tauri.app/start/prerequisites/)
- [Tauri 配置](https://v2.tauri.app/reference/config/)
- [WebviewWindowBuilder 的数据目录接口](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html#method.data_directory)
- [pulldown-cmark](https://pulldown-cmark.github.io/pulldown-cmark/)

## 验证

存储核心覆盖清缓存保留状态、归属/重解析点边界、嵌套目标、原子写入与迁移中断；文档核心覆盖 Markdown 扩展、HTML/协议隔离与图片路径。前端覆盖竞态、搜索及分批渲染。Windows release 构建实测文件打开、数据重定向、迁移、重启及进程组性能。环境不足、失败与未测项在验证报告如实保留，不视作通过。
