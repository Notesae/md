// 核心测试无需桌面构建资源；桌面构建时由 Tauri 生成资源与权限上下文。
fn main() {
    #[cfg(feature = "desktop")]
    tauri_build::build();
}
