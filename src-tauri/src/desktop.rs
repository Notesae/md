use crate::{
    document::{self, Document, Image},
    migration,
    storage::{self, AppState, Bootstrap, Preferences, RecentFile},
};
use fs2::FileExt;
use notify::Watcher;
use serde::Serialize;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

/// 进程持有启动锁和必要状态，窗口尚未建立时也能安全选择数据位置。
struct Runtime {
    root: PathBuf,
    state: AppState,
    _bootstrap_lock: fs::File,
    allowed_files: HashSet<PathBuf>,
    folder_roots: Vec<PathBuf>,
    current: Option<Resources>,
    watcher: Option<notify::RecommendedWatcher>,
    bootstrap_path: PathBuf,
    storage_target: Option<PathBuf>,
    maintenance: bool,
}

impl Runtime {
    /// 仅恢复此前经用户授权的路径；不可用文件保留历史，实际打开时报告原因。
    fn new(root: PathBuf, state: AppState, lock: fs::File, bootstrap_path: PathBuf) -> Self {
        let allowed_files = state
            .recent
            .iter()
            .map(|item| PathBuf::from(&item.path))
            .collect();
        let folder_roots = state.folders.iter().map(PathBuf::from).collect();
        Self {
            root,
            state,
            _bootstrap_lock: lock,
            allowed_files,
            folder_roots,
            current: None,
            watcher: None,
            bootstrap_path,
            storage_target: None,
            maintenance: false,
        }
    }
}

/// IPC 只持有一份必要状态，耗时读盘与解析不持有此锁。
type SharedRuntime = Arc<Mutex<Runtime>>;

/// 桌面只保留当前文章的资源授权，正文 HTML 发送后即可释放。
struct Resources {
    path: PathBuf,
    revision: u64,
    images: Vec<Image>,
    links: Vec<String>,
}

/// 解析串行且可取消，排队任务取得许可后再次确认自己仍是最新请求。
struct Tasks {
    generation: Arc<AtomicU64>,
    parser: Arc<tokio::sync::Semaphore>,
    images: Arc<tokio::sync::Semaphore>,
    storage_generation: Arc<AtomicU64>,
    maintenance: Arc<Mutex<()>>,
}

/// 主窗口启动快照；必要状态直接来自 Rust，不依赖 WebView 本地存储。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    root: String,
    state: AppState,
    version: &'static str,
    storage_notice: Option<String>,
}

#[tauri::command]
async fn get_session(runtime: tauri::State<'_, SharedRuntime>) -> Result<Session, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = runtime.lock().map_err(|_| "应用状态不可用")?;
        Ok(Session {
            root: runtime.root.to_string_lossy().into_owned(),
            state: runtime.state.clone(),
            version: env!("CARGO_PKG_VERSION"),
            storage_notice: storage::load_bootstrap(&runtime.bootstrap_path)
                .ok()
                .and_then(|record| record.notice),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 原生选择结果才会进入授权表，前端不能用任意路径读取其他文件。
#[tauri::command]
async fn pick_file(runtime: tauri::State<'_, SharedRuntime>) -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("打开 Markdown")
        .add_filter("Markdown", &["md", "markdown", "mdown"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = fs::canonicalize(file.path()).map_err(|e| e.to_string())?;
    let text = path.to_string_lossy().into_owned();
    let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
    if runtime.maintenance {
        return Err("正在准备维护，请等待重新启动。".into());
    }
    if runtime.allowed_files.len() >= 2000 {
        let recent: HashSet<PathBuf> = runtime
            .state
            .recent
            .iter()
            .map(|item| PathBuf::from(&item.path))
            .collect();
        runtime.allowed_files.retain(|path| recent.contains(path));
    }
    runtime.allowed_files.insert(path);
    Ok(Some(text))
}

/// 目录选择只授权选中目录的真实子路径，不跟随指向外部的 junction。
#[tauri::command]
async fn pick_directory(
    runtime: tauri::State<'_, SharedRuntime>,
) -> Result<Option<String>, String> {
    let Some(folder) = rfd::AsyncFileDialog::new()
        .set_title("打开 Markdown 文件夹")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let path = fs::canonicalize(folder.path()).map_err(|e| e.to_string())?;
    let text = path.to_string_lossy().into_owned();
    let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
    if runtime.maintenance {
        return Err("正在准备维护，请等待重新启动。".into());
    }
    runtime.folder_roots.retain(|p| p != &path);
    runtime.folder_roots.insert(0, path);
    runtime.folder_roots.truncate(20);
    let mut next = runtime.state.clone();
    next.folders.retain(|p| p != &text);
    next.folders.insert(0, text.clone());
    next.folders.truncate(20);
    storage::save_state(&runtime.root, &next)?;
    runtime.state = next;
    Ok(Some(text))
}

/// 目录查询仅列一层并在后台排序，不读取文章正文。
#[derive(Serialize)]
struct DirectoryEntry {
    path: String,
    name: String,
    directory: bool,
}

#[tauri::command]
async fn read_directory(
    path: String,
    runtime: tauri::State<'_, SharedRuntime>,
) -> Result<Vec<DirectoryEntry>, String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let path = fs::canonicalize(path).map_err(|e| e.to_string())?;
        let roots = runtime
            .lock()
            .map_err(|_| "状态不可用")?
            .folder_roots
            .clone();
        if !roots.iter().any(|root| path.starts_with(root)) {
            return Err("目录未获得授权，请先通过打开文件夹选择。".into());
        }
        let mut entries = Vec::new();
        for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || (!kind.is_dir() && !document::is_markdown(&entry.path())) {
                continue;
            }
            let Ok(real) = fs::canonicalize(entry.path()) else {
                continue;
            };
            if !roots.iter().any(|root| real.starts_with(root)) {
                continue;
            }
            entries.push(DirectoryEntry {
                path: real.to_string_lossy().into_owned(),
                name: entry.file_name().to_string_lossy().into_owned(),
                directory: kind.is_dir(),
            });
        }
        entries.sort_by(|a, b| {
            b.directory
                .cmp(&a.directory)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取、解析与旧任务取消在后台进行；只有最新请求可以替换资源授权和历史。
#[tauri::command]
async fn open_document(
    path: String,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<Document, String> {
    let path = fs::canonicalize(path).map_err(|e| format!("文件不可用：{e}"))?;
    {
        let runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        if !runtime.allowed_files.contains(&path)
            && !runtime
                .folder_roots
                .iter()
                .any(|root| path.starts_with(root))
        {
            return Err("文件未获得授权，请先通过选择器、拖放或命令行打开。".into());
        }
    }
    let revision = tasks.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let request = tasks.generation.clone();
    let permit = tasks
        .parser
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let cache = {
        let runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        runtime.state.preferences.persistent_cache.then(|| {
            (
                runtime.root.clone(),
                runtime.state.preferences.cache_mib as u64 * 1024 * 1024,
            )
        })
    };
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let document = document::read_document(
            &path,
            &request,
            revision,
            cache
                .as_ref()
                .map(|(root, budget)| (root.as_path(), *budget)),
        )?;
        if request.load(Ordering::SeqCst) != revision {
            return Err("打开请求已取消。".into());
        }
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        let text = path.to_string_lossy().into_owned();
        let saved = runtime
            .state
            .recent
            .iter()
            .find(|item| item.path == text)
            .cloned();
        runtime.state.recent.retain(|item| item.path != text);
        let mut recent = saved.unwrap_or(RecentFile {
            path: text.clone(),
            position: 0.0,
            opened_at: 0,
            block: None,
            offset: 0.0,
            anchor_hash: None,
        });
        recent.opened_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        runtime.state.recent.insert(0, recent);
        runtime.state.recent.truncate(1000);
        runtime.state.last_file = Some(text);
        if let Err(error) = storage::save_state(&runtime.root, &runtime.state) {
            let _ = app.emit("state-error", error);
        }
        runtime.current = Some(Resources {
            path: path.clone(),
            revision,
            images: document.content.images.clone(),
            links: document.content.links.clone(),
        });
        // 监听父目录以兼容编辑器原子替换；忽略读取访问，前端对连续变更合并刷新。
        let event_app = app.clone();
        let watched = path.clone();
        runtime.watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    if !event.kind.is_access()
                        && event
                            .paths
                            .iter()
                            .any(|p| p.file_name() == watched.file_name())
                    {
                        let _ =
                            event_app.emit("document-changed", watched.to_string_lossy().as_ref());
                    }
                }
            })
            .ok()
            .and_then(|mut watcher| {
                watcher
                    .watch(path.parent()?, notify::RecursiveMode::NonRecursive)
                    .ok()?;
                Some(watcher)
            });
        Ok(document)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 图片按当前文档修订号读取；切换文章后，旧图片请求无法取得新目录的权限。
#[tauri::command]
async fn read_image(
    revision: u64,
    index: usize,
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<tauri::ipc::Response, String> {
    let permit = tasks
        .images
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let (directory, url) = {
        let runtime = runtime.lock().map_err(|_| "状态不可用")?;
        let current = runtime
            .current
            .as_ref()
            .filter(|current| current.revision == revision)
            .ok_or("图片所属文章已关闭。")?;
        let image = current.images.get(index).ok_or("图片不存在。")?;
        if image.remote {
            return Err("远程图片需要由用户明确加载。".into());
        }
        (
            current.path.parent().ok_or("文章没有父目录")?.to_owned(),
            image.url.clone(),
        )
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let path = document::resolve_local_image(&directory, &url)?;
        let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
        use std::io::Read;
        let mut data = Vec::new();
        file.by_ref()
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() > 64 * 1024 * 1024 {
            return Err("图片超过 64MiB，请缩小后重试。".into());
        }
        Ok(tauri::ipc::Response::new(data))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 仅系统浏览器可打开 HTTP(S)/邮件链接；相对 Markdown 链接授权后仍由阅读器打开。
#[tauri::command]
async fn follow_link(
    revision: u64,
    index: usize,
    runtime: tauri::State<'_, SharedRuntime>,
) -> Result<Option<String>, String> {
    let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
    let current = runtime
        .current
        .as_ref()
        .filter(|current| current.revision == revision)
        .ok_or("文章已关闭。")?;
    let url = current.links.get(index).ok_or("链接不存在。")?.clone();
    if ["https://", "http://", "mailto:"]
        .iter()
        .any(|scheme| url.starts_with(scheme))
    {
        open::that_detached(url).map_err(|e| e.to_string())?;
        return Ok(None);
    }
    let relative = url.split('#').next().unwrap_or("");
    let relative = percent_encoding::percent_decode_str(relative)
        .decode_utf8()
        .map_err(|e| e.to_string())?;
    if relative.contains(':') || relative.starts_with('/') || relative.starts_with('\\') {
        return Err("不允许打开此链接协议。".into());
    }
    let path = fs::canonicalize(
        current
            .path
            .parent()
            .ok_or("缺少文章目录")?
            .join(relative.as_ref()),
    )
    .map_err(|e| e.to_string())?;
    if !document::is_markdown(&path) {
        return Err("本地链接只打开 Markdown 文件，不执行程序或其他附件。".into());
    }
    runtime.allowed_files.insert(path.clone());
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
async fn save_preferences(
    preferences: Preferences,
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<(), String> {
    let permit = tasks
        .parser
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        let mut next = runtime.state.clone();
        next.preferences = preferences;
        storage::enforce_cache_budget(
            &runtime.root,
            if next.preferences.persistent_cache {
                next.preferences.cache_mib as u64 * 1024 * 1024
            } else {
                0
            },
        )?;
        storage::save_state(&runtime.root, &next)?;
        runtime.state = next;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
/// 校验有界定位元数据，落盘成功后才更新会话，失败仍可用原状态重试。
async fn save_position(
    path: String,
    position: f64,
    block: Option<usize>,
    offset: Option<f64>,
    anchor_hash: Option<String>,
    runtime: tauri::State<'_, SharedRuntime>,
) -> Result<(), String> {
    if !position.is_finite() || !(0.0..=1.0).contains(&position) {
        return Err("阅读进度无效。".into());
    }
    let offset = offset.unwrap_or(0.0);
    if !offset.is_finite()
        || offset.abs() > 1_000_000_000.0
        || anchor_hash
            .as_ref()
            .is_some_and(|hash| hash.len() != 16 || !hash.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err("阅读定位信息无效。".into());
    }
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        let mut next = runtime.state.clone();
        if let Some(item) = next.recent.iter_mut().find(|item| item.path == path) {
            item.position = position;
            item.block = block;
            item.offset = offset;
            item.anchor_hash = anchor_hash;
        }
        storage::save_state(&runtime.root, &next)?;
        runtime.state = next;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_open(tasks: tauri::State<'_, Tasks>) {
    tasks.generation.fetch_add(1, Ordering::SeqCst);
}

/// 设置页所需的分类占用和迁移残留，均来自受管目录的实际扫描。
#[derive(Serialize)]
struct StorageInfo {
    usage: storage::StorageUsage,
    residual: Option<ResidualUsage>,
    notice: Option<String>,
}

#[derive(Serialize)]
struct ResidualUsage {
    path: String,
    bytes: u64,
}

#[tauri::command]
async fn get_storage_info(
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<StorageInfo, String> {
    let (root, path) = {
        let runtime = runtime.lock().map_err(|_| "状态不可用")?;
        (runtime.root.clone(), runtime.bootstrap_path.clone())
    };
    let generation = tasks.storage_generation.clone();
    let request = generation.fetch_add(1, Ordering::SeqCst) + 1;
    tauri::async_runtime::spawn_blocking(move || {
        let cancelled = || generation.load(Ordering::Relaxed) != request;
        let usage = storage::storage_usage(&root, cancelled)?;
        let record = storage::load_bootstrap(&path)?;
        let residual = match record.pending_cleanup {
            Some(residual) => Some(ResidualUsage {
                bytes: if residual.path.try_exists().map_err(|e| e.to_string())? {
                    storage::tree_bytes(&residual.path, &cancelled)?
                } else {
                    0
                },
                path: residual.path.to_string_lossy().into_owned(),
            }),
            None => None,
        };
        Ok(StorageInfo {
            usage,
            residual,
            notice: record.notice,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn cancel_storage_stats(tasks: tauri::State<'_, Tasks>) {
    tasks.storage_generation.fetch_add(1, Ordering::SeqCst);
}

#[tauri::command]
async fn reveal_data_directory(runtime: tauri::State<'_, SharedRuntime>) -> Result<(), String> {
    let root = runtime.lock().map_err(|_| "状态不可用")?.root.clone();
    open::that_detached(root).map_err(|e| e.to_string())
}

/// 此命令只清应用缓存，和解析任务串行；WebView 清理使用另一个重启命令。
#[tauri::command]
async fn clear_cache(
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<(), String> {
    let permit = tasks
        .parser
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        storage::clear_managed_child(&runtime.root, "cache")
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 原生选择器授权目标，真正的路径/容量检查在确认提交时再次执行。
#[tauri::command]
async fn choose_storage_target(
    runtime: tauri::State<'_, SharedRuntime>,
) -> Result<Option<String>, String> {
    let Some(selected) = rfd::AsyncFileDialog::new()
        .set_title("选择数据新位置的父目录（将在其中建立 MdReader）")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let selected = selected.path();
    let target = migration::normalized_path(&if selected.join("owner.json").exists() {
        selected.to_owned()
    } else {
        selected.join("MdReader")
    })?;
    let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
    if runtime.maintenance {
        return Err("正在准备维护，请等待重新启动。".into());
    }
    runtime.storage_target = Some(target.clone());
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[tauri::command]
fn cancel_storage_target(runtime: tauri::State<'_, SharedRuntime>) {
    if let Ok(mut runtime) = runtime.lock() {
        runtime.storage_target = None;
    }
}

/// 保存最新状态、持久化意图后冻结写入并请求重启；本进程不复制或删除 WebView。
#[tauri::command]
async fn migrate_storage(
    target: String,
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<(), String> {
    tasks.generation.fetch_add(1, Ordering::SeqCst);
    let permit = tasks
        .parser
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let runtime = runtime.inner().clone();
    let maintenance = tasks.maintenance.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let _maintenance = maintenance.lock().map_err(|_| "维护锁不可用")?;
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("已经在准备维护。".into());
        }
        let selected = runtime
            .storage_target
            .as_ref()
            .filter(|selected| selected.to_string_lossy() == target)
            .ok_or("目标已改变或尚未选择，请重新选择迁移位置。")?
            .clone();
        storage::save_state(&runtime.root, &runtime.state)?;
        migration::prepare_migration(
            &runtime.bootstrap_path,
            &selected,
            migration::session_processes()?,
        )?;
        runtime.maintenance = true;
        runtime.storage_target = None;
        runtime.watcher = None;
        app.request_restart();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 只安排下一启动重建浏览器目录，禁止对当前活动会话直接递归删除。
#[tauri::command]
async fn reset_webview(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<(), String> {
    tasks.generation.fetch_add(1, Ordering::SeqCst);
    let permit = tasks
        .parser
        .clone()
        .acquire_owned()
        .await
        .map_err(|e| e.to_string())?;
    let runtime = runtime.inner().clone();
    let maintenance = tasks.maintenance.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let _maintenance = maintenance.lock().map_err(|_| "维护锁不可用")?;
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("已经在准备维护。".into());
        }
        let mut record = storage::load_bootstrap(&runtime.bootstrap_path)?;
        if record.migration.is_some() {
            return Err("请先完成数据迁移。".into());
        }
        storage::save_state(&runtime.root, &runtime.state)?;
        record.reset_webview = Some(migration::session_processes()?);
        record.notice = None;
        storage::save_bootstrap(&runtime.bootstrap_path, &record)?;
        runtime.maintenance = true;
        runtime.watcher = None;
        app.request_restart();
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 首屏与必要状态恢复后提交健康结果；旧目录清理在释放运行状态锁之后执行。
#[tauri::command]
async fn app_ready(
    app: tauri::AppHandle,
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<Option<String>, String> {
    let runtime = runtime.inner().clone();
    let maintenance = tasks.maintenance.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _maintenance = maintenance.lock().map_err(|_| "维护锁不可用")?;
        let (path, migrated) = {
            let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
            let path = runtime.bootstrap_path.clone();
            let record = storage::load_bootstrap(&path)?;
            let migrated = record.migration.is_some();
            if migrated {
                if let Err(error) = migration::commit_health(&path) {
                    runtime.maintenance = true;
                    runtime.watcher = None;
                    migration::rollback(&path, &error)?;
                    app.request_restart();
                    return Err(error);
                }
            }
            (path, migrated)
        };
        if migrated {
            if let Err(error) = migration::retry_cleanup(&path) {
                let mut record = storage::load_bootstrap(&path)?;
                record.notice = Some(format!(
                    "新位置已启用，旧目录残留可在设置中重试清理：{error}"
                ));
                storage::save_bootstrap(&path, &record)?;
            }
        }
        Ok(storage::load_bootstrap(&path)?.notice)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn retry_storage_cleanup(
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<(), String> {
    let path = runtime
        .lock()
        .map_err(|_| "状态不可用")?
        .bootstrap_path
        .clone();
    let maintenance = tasks.maintenance.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _maintenance = maintenance.lock().map_err(|_| "维护锁不可用")?;
        migration::retry_cleanup(&path).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 清除历史不删除原文或偏好，并移除上次打开入口。
#[tauri::command]
async fn clear_history(runtime: tauri::State<'_, SharedRuntime>) -> Result<(), String> {
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        let mut next = runtime.state.clone();
        next.recent.clear();
        next.folders.clear();
        next.last_file = None;
        storage::save_state(&runtime.root, &next)?;
        runtime.state = next;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 关闭正文同时取消解析和文件监听，避免后台继续持有旧文章资源。
#[tauri::command]
async fn close_document(
    runtime: tauri::State<'_, SharedRuntime>,
    tasks: tauri::State<'_, Tasks>,
) -> Result<(), String> {
    tasks.generation.fetch_add(1, Ordering::SeqCst);
    let runtime = runtime.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let mut runtime = runtime.lock().map_err(|_| "状态不可用")?;
        if runtime.maintenance {
            return Err("正在准备维护，请等待重新启动。".into());
        }
        runtime.current = None;
        runtime.watcher = None;
        runtime.state.last_file = None;
        storage::save_state(&runtime.root, &runtime.state)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 由原生入口收集参数或拖放路径并授权，再通知主窗口；不从文章内容推导权限。
fn accept_paths(app: &tauri::AppHandle, paths: impl Iterator<Item = PathBuf>) {
    let Some(runtime) = app.try_state::<SharedRuntime>() else {
        return;
    };
    let Ok(mut runtime) = runtime.lock() else {
        return;
    };
    for path in paths {
        if let Ok(path) = fs::canonicalize(path) {
            if path.is_file() && document::is_markdown(&path) {
                runtime.allowed_files.insert(path.clone());
                let _ = app.emit("open-path", path.to_string_lossy().as_ref());
                break;
            }
        }
    }
}

/// 以原生对话框选择或恢复应用目录；取消退出，绝不静默回退系统盘。
fn bootstrap() -> Result<Option<Runtime>, String> {
    let location = std::env::var_os("MD_BOOTSTRAP_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("MdReader")))
        .ok_or("无法确定启动定位目录。")?;
    fs::create_dir_all(&location).map_err(|e| e.to_string())?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(location.join("instance.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "MD 已经运行，请先关闭其他实例。")?;
    let path = location.join("bootstrap.json");
    if path.exists() || path.with_file_name("bootstrap.recovery.json").exists() {
        let restored = (|| -> Result<Runtime, String> {
            let record = migration::resume_migration(&path)?;
            if record.force_recovery {
                return Err("上次浏览器启动失败。可重新选择数据位置；选回原目录时可只重建浏览器数据并保留阅读状态。".into());
            }
            let owner = storage::initialize_root(&record.root)?;
            if record.format_version != 1 || owner.instance_id != record.instance_id {
                return Err("启动记录与数据目录不匹配。".into());
            }
            let state = storage::load_state(&record.root)?;
            for category in ["state", "webview"] {
                drop(
                    tempfile::NamedTempFile::new_in(record.root.join(category))
                        .map_err(|e| format!("数据位置不可写，未回落到其他磁盘：{e}"))?,
                );
            }
            Ok(Runtime::new(
                record.root,
                state,
                lock.try_clone().map_err(|e| e.to_string())?,
                path.clone(),
            ))
        })();
        match restored {
            Ok(runtime) => return Ok(Some(runtime)),
            Err(error) => {
                let result = rfd::MessageDialog::new().set_title("MD · 需要恢复数据位置")
                    .set_description(format!("{error}\n\n选择“是”重新选择已有数据目录或新建；选择“否”退出。原目录不会被删除。"))
                    .set_buttons(rfd::MessageButtons::YesNo).show();
                if result != rfd::MessageDialogResult::Yes {
                    return Ok(None);
                }
            }
        }
    }
    let Some(selected) = rfd::FileDialog::new()
        .set_title("选择 MD 数据位置（已有 MD 目录，或新位置的父目录）")
        .pick_folder()
    else {
        return Ok(None);
    };
    let root = if selected.join("owner.json").exists() {
        selected
    } else {
        selected.join("MdReader")
    };
    let owner = storage::initialize_root(&root)?;
    let state = storage::load_state(&root)?;
    let previous = storage::load_bootstrap(&path)
        .ok()
        .filter(|record| record.instance_id == owner.instance_id && record.root == root);
    if previous
        .as_ref()
        .is_some_and(|record| record.force_recovery)
    {
        let choice = rfd::MessageDialog::new().set_title("MD · 重建浏览器数据")
            .set_description("只清理此 MD 数据目录的浏览器数据并重新创建阅读窗口。偏好、历史和原始文章保持原位。是否继续？")
            .set_buttons(rfd::MessageButtons::YesNo).show();
        if choice != rfd::MessageDialogResult::Yes {
            return Ok(None);
        }
        migration::wait_for_sessions(&[], &root.join("webview"))?;
        storage::clear_managed_child(&root, "webview")?;
    }
    let mut record = previous.unwrap_or(Bootstrap {
        format_version: 1,
        root: root.clone(),
        instance_id: owner.instance_id,
        ..Default::default()
    });
    record.force_recovery = false;
    storage::save_bootstrap(&path, &record)?;
    Ok(Some(Runtime::new(root, state, lock, path)))
}

/// 单实例插件先注册，随后完成存储引导，最后用用户目录创建唯一 WebView。
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            accept_paths(
                app,
                args.into_iter().skip(1).map(|arg| {
                    let path = PathBuf::from(arg);
                    if path.is_absolute() {
                        path
                    } else {
                        Path::new(&cwd).join(path)
                    }
                }),
            );
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let mut runtime = match bootstrap() {
                Ok(Some(runtime)) => runtime,
                Ok(None) => {
                    app.handle().exit(0);
                    return Ok(());
                }
                Err(error) => {
                    rfd::MessageDialog::new()
                        .set_title("MD 无法启动")
                        .set_description(error)
                        .set_level(rfd::MessageLevel::Error)
                        .show();
                    app.handle().exit(1);
                    return Ok(());
                }
            };
            let data_directory = runtime.root.join("webview");
            let width = runtime.state.window.width.clamp(800, 3840) as f64;
            let height = runtime.state.window.height.clamp(580, 2160) as f64;
            let maximized = runtime.state.window.maximized;
            let bootstrap_path = runtime.bootstrap_path.clone();
            for argument in std::env::args().skip(1) {
                if let Ok(path) = fs::canonicalize(argument) {
                    if document::is_markdown(&path) {
                        runtime.state.last_file = Some(path.to_string_lossy().into_owned());
                        runtime.allowed_files.insert(path);
                        break;
                    }
                }
            }
            app.manage(Arc::new(Mutex::new(runtime)));
            app.manage(Tasks {
                generation: Arc::new(AtomicU64::new(0)),
                parser: Arc::new(tokio::sync::Semaphore::new(1)),
                images: Arc::new(tokio::sync::Semaphore::new(2)),
                storage_generation: Arc::new(AtomicU64::new(0)),
                maintenance: Arc::new(Mutex::new(())),
            });
            let window =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                    .title("MD · Markdown 阅读器")
                    .inner_size(width, height)
                    .min_inner_size(800.0, 580.0)
                    .maximized(maximized)
                    .on_navigation(|url| {
                        (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                            || (url.scheme() == "http"
                                && (url.host_str() == Some("tauri.localhost")
                                    || (url.host_str() == Some("127.0.0.1")
                                        && url.port() == Some(1420))))
                    })
                    .data_directory(data_directory)
                    .build();
            if let Err(error) = window {
                if let Ok(mut record) = storage::load_bootstrap(&bootstrap_path) {
                    if record.migration.is_some() {
                        let _ = migration::rollback(&bootstrap_path, &error.to_string());
                    } else {
                        record.force_recovery = true;
                        let _ = storage::save_bootstrap(&bootstrap_path, &record);
                    }
                }
                return Err(error.into());
            }
            Ok(())
        })
        .on_webview_event(|webview, event| {
            if let tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
                accept_paths(webview.app_handle(), paths.iter().cloned());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if let Some(runtime) = window.app_handle().try_state::<SharedRuntime>() {
                    if let Ok(mut runtime) = runtime.lock() {
                        runtime.state.window.maximized = window.is_maximized().unwrap_or(false);
                        if !runtime.state.window.maximized {
                            if let Ok(size) = window.inner_size() {
                                let logical =
                                    size.to_logical::<u32>(window.scale_factor().unwrap_or(1.0));
                                runtime.state.window.width = logical.width;
                                runtime.state.window.height = logical.height;
                            }
                        }
                        if let Err(error) = storage::save_state(&runtime.root, &runtime.state) {
                            rfd::MessageDialog::new()
                                .set_title("MD · 状态保存失败")
                                .set_description(error)
                                .show();
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_session,
            pick_file,
            pick_directory,
            read_directory,
            open_document,
            read_image,
            follow_link,
            save_preferences,
            save_position,
            cancel_open,
            clear_history,
            close_document,
            get_storage_info,
            cancel_storage_stats,
            reveal_data_directory,
            clear_cache,
            choose_storage_target,
            cancel_storage_target,
            migrate_storage,
            reset_webview,
            app_ready,
            retry_storage_cleanup
        ])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        rfd::MessageDialog::new()
            .set_title("MD 启动失败")
            .set_description(error.to_string())
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
}
