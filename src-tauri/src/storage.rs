use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// 归属标记只标识本应用实例；清理和迁移必须同时校验路径边界及该标记。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Owner {
    pub format_version: u32,
    pub instance_id: Uuid,
}

/// 阅读偏好独立于浏览器存储，重建 WebView 后仍然有效。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub theme: String,
    pub font_size: u16,
    pub content_width: u16,
    pub sidebar: bool,
    pub outline: bool,
    pub persistent_cache: bool,
    pub cache_mib: u32,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: "light".into(),
            font_size: 18,
            content_width: 780,
            sidebar: true,
            outline: true,
            persistent_cache: true,
            cache_mib: 256,
        }
    }
}

/// 仅保存路径和阅读进度，绝不将原始正文复制到历史记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFile {
    pub path: String,
    pub position: f64,
    pub opened_at: u64,
}

/// 主窗口布局随必要数据保存，不依赖会被清理的 WebView 本地存储。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowState {
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: 1280,
            height: 860,
            maximized: false,
        }
    }
}

/// 有界应用状态；最近文件最多 1000 项，最近目录最多 20 项。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AppState {
    pub preferences: Preferences,
    pub recent: Vec<RecentFile>,
    pub folders: Vec<String>,
    pub last_file: Option<String>,
    pub window: WindowState,
}

/// 系统配置目录仅保存用于定位自定义数据根的小型记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bootstrap {
    pub format_version: u32,
    pub root: PathBuf,
    pub instance_id: Uuid,
}

/// 拒绝共享路径、盘根以及任意层级的符号链接或 Windows 重解析点。
pub fn validate_local_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || path.parent().is_none() {
        return Err("请选择本地磁盘中的应用专属目录，不能选择盘根。".into());
    }
    let text = path.to_string_lossy();
    if text.starts_with(r"\\") || text.starts_with("//") {
        return Err("首版不支持网络目录或设备命名路径。".into());
    }
    for ancestor in path.ancestors() {
        if let Ok(meta) = fs::symlink_metadata(ancestor) {
            if meta.file_type().is_symlink() {
                return Err("数据路径不能包含符号链接。".into());
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if meta.file_attributes() & 0x400 != 0 {
                    return Err("数据路径不能包含 junction 或其他重解析点。".into());
                }
            }
        }
    }
    Ok(())
}

/// 按大小上限读取 JSON；损坏数据向上报错，不默默覆盖或恢复默认值。
pub fn read_json<T: DeserializeOwned>(path: &Path, limit: u64) -> Result<T, String> {
    let file = fs::File::open(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err(format!("配置文件超过允许大小：{}", path.display()));
    }
    serde_json::from_reader(file)
        .map_err(|e| format!("配置损坏，已保留原文件 {}：{e}", path.display()))
}

/// 在同一目录暂存、同步并原子替换，失败时保持旧文件且自动清除暂存文件。
pub fn atomic_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or("配置路径没有父目录")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temp, value).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path)
        .map_err(|e| format!("无法保存状态（请检查空间和权限）：{e}"))?;
    Ok(())
}

/// 只初始化空目录，已有数据必须有有效归属标记，避免接管用户的文章目录。
pub fn initialize_root(root: &Path) -> Result<Owner, String> {
    validate_local_path(root)?;
    if root.join("owner.json").exists() {
        return read_owner(root);
    }
    if root.exists()
        && fs::read_dir(root)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
    {
        return Err("目标不是空目录，也没有 MD 的归属标记，请选择其他位置。".into());
    }
    fs::create_dir_all(root).map_err(|e| format!("无法创建数据目录：{e}"))?;
    let owner = Owner {
        format_version: 1,
        instance_id: Uuid::new_v4(),
    };
    atomic_json(&root.join("owner.json"), &owner)?;
    for name in ["state", "cache", "webview", "logs", "temp"] {
        fs::create_dir(root.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(owner)
}

/// 每次管理应用目录前确认归属和格式，不依赖调用方传入一个看似可信的路径。
pub fn read_owner(root: &Path) -> Result<Owner, String> {
    validate_local_path(root)?;
    let owner: Owner = read_json(&root.join("owner.json"), 4096)?;
    if owner.format_version != 1 {
        return Err("数据目录版本不受支持，请使用对应版本的应用。".into());
    }
    Ok(owner)
}

pub fn load_state(root: &Path) -> Result<AppState, String> {
    read_owner(root)?;
    let path = root.join("state/preferences.json");
    if path.exists() {
        read_json(&path, 4 * 1024 * 1024)
    } else {
        Ok(AppState::default())
    }
}

/// 保存前限制容量和偏好范围，防止异常界面请求造成无限记录或不可用布局。
pub fn save_state(root: &Path, state: &AppState) -> Result<(), String> {
    read_owner(root)?;
    let preferences = &state.preferences;
    if !(14..=28).contains(&preferences.font_size)
        || !(560..=1200).contains(&preferences.content_width)
        || !["light", "dark", "system"].contains(&preferences.theme.as_str())
        || preferences.cache_mib > 2048
        || state.recent.len() > 1000
        || state.folders.len() > 20
    {
        return Err("设置超出允许范围。".into());
    }
    validate_local_path(&root.join("state"))?;
    atomic_json(&root.join("state/preferences.json"), state)
}

pub fn save_bootstrap(path: &Path, bootstrap: &Bootstrap) -> Result<(), String> {
    if serde_json::to_vec(bootstrap)
        .map_err(|e| e.to_string())?
        .len()
        > 16 * 1024
    {
        return Err("启动定位信息超过 16KiB。".into());
    }
    atomic_json(path, bootstrap)
}
