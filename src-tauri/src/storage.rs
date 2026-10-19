use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

/// 应用拥有的固定分类；不能通过界面参数扩大到 state 或用户文档。
pub const MANAGED_DIRECTORIES: [&str; 5] = ["state", "cache", "webview", "logs", "temp"];

/// 归属标记只标识本应用实例；清理和迁移必须同时校验路径边界及该标记。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Owner {
    pub app_id: String,
    pub format_version: u32,
    pub instance_id: Uuid,
    #[serde(default)]
    pub state_written: bool,
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
    #[serde(default)]
    pub block: Option<usize>,
    #[serde(default)]
    pub offset: f64,
    #[serde(default)]
    pub anchor_hash: Option<String>,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Bootstrap {
    pub format_version: u32,
    pub root: PathBuf,
    pub instance_id: Uuid,
    #[serde(default)]
    pub migration: Option<crate::migration::Migration>,
    #[serde(default)]
    pub pending_cleanup: Option<crate::migration::Residual>,
    #[serde(default)]
    pub reset_webview: Option<Vec<crate::migration::SessionProcess>>,
    #[serde(default)]
    pub notice: Option<String>,
    #[serde(default)]
    pub force_recovery: bool,
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
    if path
        .components()
        .any(|component| component == std::path::Component::ParentDir)
    {
        return Err("数据路径不能包含父目录跳转。".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        if let Some(prefix) = path.components().next() {
            let volume: Vec<u16> = PathBuf::from(prefix.as_os_str())
                .join(r"\")
                .as_os_str()
                .encode_wide()
                .chain(Some(0))
                .collect();
            // 盘符映射的网络共享同样拒绝；0/1 表示盘符已丢失，不静默回落。
            let kind =
                unsafe { windows_sys::Win32::Storage::FileSystem::GetDriveTypeW(volume.as_ptr()) };
            if [0, 1, 4, 5].contains(&kind) {
                return Err("数据位置不是可用的本地可写磁盘。".into());
            }
        }
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
    let pending = path.with_extension("pending");
    validate_local_path(&pending)?;
    let mut temp = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&pending)
        .map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut temp, value).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.sync_all().map_err(|e| e.to_string())?;
    drop(temp);
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::{
            MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
        };
        let source: Vec<u16> = pending.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // 固定暂存名避免异常退出后在标准配置目录积累无限随机文件。
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                target.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            return Err(format!(
                "无法保存状态（请检查空间和权限）：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    #[cfg(not(windows))]
    fs::rename(&pending, path).map_err(|e| e.to_string())?;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 只初始化空目录，已有数据必须有有效归属标记，避免接管用户的文章目录。
pub fn initialize_root(root: &Path) -> Result<Owner, String> {
    validate_local_path(root)?;
    if root.join("owner.json").exists() {
        let owner = read_owner(root)?;
        for name in MANAGED_DIRECTORIES {
            validate_local_path(&root.join(name))?;
            fs::create_dir_all(root.join(name)).map_err(|e| e.to_string())?;
        }
        return Ok(owner);
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
        app_id: "io.notesae.mdreader".into(),
        format_version: 1,
        instance_id: Uuid::new_v4(),
        state_written: false,
    };
    atomic_json(&root.join("owner.json"), &owner)?;
    for name in MANAGED_DIRECTORIES {
        fs::create_dir(root.join(name)).map_err(|e| e.to_string())?;
    }
    Ok(owner)
}

/// 每次管理应用目录前确认归属和格式，不依赖调用方传入一个看似可信的路径。
pub fn read_owner(root: &Path) -> Result<Owner, String> {
    validate_local_path(root)?;
    validate_local_path(&root.join("owner.json"))?;
    let owner: Owner = read_json(&root.join("owner.json"), 4096)?;
    if owner.format_version != 1 || owner.app_id != "io.notesae.mdreader" {
        return Err("数据目录不属于 MD，或格式版本不受支持。".into());
    }
    Ok(owner)
}

pub fn load_state(root: &Path) -> Result<AppState, String> {
    let owner = read_owner(root)?;
    let path = root.join("state/preferences.json");
    validate_local_path(&path)?;
    if path.exists() {
        read_json(&path, 4 * 1024 * 1024)
    } else if owner.state_written {
        Err("已保存的阅读状态丢失，已停止自动重置，请恢复数据目录。".into())
    } else {
        Ok(AppState::default())
    }
}

/// 保存前限制容量和偏好范围，防止异常界面请求造成无限记录或不可用布局。
pub fn save_state(root: &Path, state: &AppState) -> Result<(), String> {
    let mut owner = read_owner(root)?;
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
    if serde_json::to_vec(state).map_err(|e| e.to_string())?.len() > 4 * 1024 * 1024 {
        return Err("必要状态超过 4MiB，未覆盖已有记录。".into());
    }
    atomic_json(&root.join("state/preferences.json"), state)?;
    if !owner.state_written {
        owner.state_written = true;
        atomic_json(&root.join("owner.json"), &owner)?;
    }
    Ok(())
}

pub fn save_bootstrap(path: &Path, bootstrap: &Bootstrap) -> Result<(), String> {
    if serde_json::to_vec(bootstrap)
        .map_err(|e| e.to_string())?
        .len()
        > 16 * 1024
    {
        return Err("启动定位信息超过 16KiB。".into());
    }
    atomic_json(path, bootstrap)?;
    // 两份受限定位记录均落盘后，迁移协议才允许删除旧应用目录。
    atomic_json(&path.with_file_name("bootstrap.recovery.json"), bootstrap)
}

/// 引导损坏或指向丢失目录时使用受限恢复指针，仍不扫描磁盘或回落系统盘。
pub fn load_bootstrap(path: &Path) -> Result<Bootstrap, String> {
    if let Ok(record) = read_json::<Bootstrap>(path, 16 * 1024) {
        if record.migration.is_some()
            || read_owner(&record.root).is_ok_and(|owner| owner.instance_id == record.instance_id)
        {
            return Ok(record);
        }
    }
    read_json(&path.with_file_name("bootstrap.recovery.json"), 16 * 1024)
}

/// 分类使用实际文件长度；WebView 提醒阈值与应用缓存硬预算由界面分别解释。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub state_bytes: u64,
    pub cache_bytes: u64,
    pub webview_bytes: u64,
    pub logs_bytes: u64,
    pub temp_bytes: u64,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

/// 只读遍历拒绝重解析点，统计允许取消；并发缓存淘汰导致文件消失时跳过该项。
pub fn tree_bytes(path: &Path, cancelled: &impl Fn() -> bool) -> Result<u64, String> {
    let mut total = 0u64;
    let mut pending = vec![path.to_owned()];
    while let Some(path) = pending.pop() {
        if cancelled() {
            return Err("占用统计已取消。".into());
        }
        validate_local_path(&path)?;
        let metadata = match fs::symlink_metadata(&path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法统计 {}：{error}", path.display())),
        };
        if metadata.is_dir() {
            for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                pending.push(entry.map_err(|e| e.to_string())?.path());
            }
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

pub fn storage_usage(root: &Path, cancelled: impl Fn() -> bool) -> Result<StorageUsage, String> {
    read_owner(root)?;
    let mut sizes = [0u64; 5];
    for (index, directory) in MANAGED_DIRECTORIES.iter().enumerate() {
        sizes[index] = tree_bytes(&root.join(directory), &cancelled)?;
    }
    let owner_size = fs::metadata(root.join("owner.json"))
        .map_err(|e| e.to_string())?
        .len();
    Ok(StorageUsage {
        state_bytes: sizes[0] + owner_size,
        cache_bytes: sizes[1],
        webview_bytes: sizes[2],
        logs_bytes: sizes[3],
        temp_bytes: sizes[4],
        total_bytes: sizes.iter().sum::<u64>() + owner_size,
        free_bytes: fs2::available_space(root).map_err(|e| e.to_string())?,
    })
}

/// 安全清理仅允许可重建分类；删除前完整核查目录树，避免越过 junction。
pub fn clear_managed_child(root: &Path, category: &str) -> Result<(), String> {
    if !["cache", "webview", "logs", "temp"].contains(&category) {
        return Err("不能清理必要状态或未知目录。".into());
    }
    read_owner(root)?;
    let path = root.join(category);
    tree_bytes(&path, &|| false)?;
    if path.exists() {
        fs::remove_dir_all(&path).map_err(|e| format!("清理失败（文件可能仍被占用）：{e}"))?;
    }
    fs::create_dir_all(path).map_err(|e| e.to_string())
}

pub fn cache_bytes(root: &Path) -> Result<u64, String> {
    read_owner(root)?;
    tree_bytes(&root.join("cache"), &|| false)
}

/// 预算按磁盘字节在写入前执行；缓存只允许平面普通文件，异常目录不自动接管。
pub fn enforce_cache_budget(root: &Path, budget: u64) -> Result<(), String> {
    read_owner(root)?;
    let cache = root.join("cache");
    validate_local_path(&cache)?;
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let mut entries = Vec::new();
    let mut total = 0u64;
    for entry in fs::read_dir(&cache).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        validate_local_path(&path)?;
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !metadata.is_file() {
            return Err("缓存中出现未知子目录，已停止自动淘汰。".into());
        }
        total = total.saturating_add(metadata.len());
        entries.push((
            metadata.modified().unwrap_or(std::time::UNIX_EPOCH),
            path,
            metadata.len(),
        ));
    }
    entries.sort();
    for (_, path, length) in entries {
        if total <= budget {
            break;
        }
        fs::remove_file(path).map_err(|e| e.to_string())?;
        total = total.saturating_sub(length);
    }
    Ok(())
}

/// 只接受固定 SHA-256 文件名；坏缓存可忽略，永远不能当作必要状态恢复来源。
pub fn read_cache<T: DeserializeOwned>(root: &Path, key: &str, budget: u64) -> Option<T> {
    if budget == 0 || key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    read_owner(root).ok()?;
    let path = root.join("cache").join(format!("{key}.json"));
    validate_local_path(&path).ok()?;
    read_json(&path, budget.min(64 * 1024 * 1024)).ok()
}

/// 同盘暂存也计入缓存预算；关闭、超大单项或磁盘紧张时直接跳过可选写入。
pub fn write_cache<T: Serialize>(
    root: &Path,
    key: &str,
    value: &T,
    budget: u64,
) -> Result<bool, String> {
    if budget == 0 {
        return Ok(false);
    }
    if key.len() != 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("缓存标识无效。".into());
    }
    let payload = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let size = payload.len() as u64;
    if size > budget
        || size > 64 * 1024 * 1024
        || fs2::available_space(root).map_err(|e| e.to_string())? < size + 8 * 1024 * 1024
    {
        return Ok(false);
    }
    enforce_cache_budget(root, budget - size)?;
    let cache = root.join("cache");
    let mut temp = tempfile::NamedTempFile::new_in(&cache).map_err(|e| e.to_string())?;
    temp.write_all(&payload).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.persist(cache.join(format!("{key}.json")))
        .map_err(|e| e.to_string())?;
    Ok(true)
}
