use crate::storage::{self, AppState, Bootstrap};
use fs2::FileExt;
use serde::Serialize;
use std::{fs, path::PathBuf, sync::Mutex};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 进程持有启动锁和必要状态，窗口尚未建立时也能安全选择数据位置。
struct Runtime {
    root: PathBuf,
    state: AppState,
    _bootstrap_lock: fs::File,
}

/// 主窗口启动快照；必要状态直接来自 Rust，不依赖 WebView 本地存储。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    root: String,
    state: AppState,
    version: &'static str,
}

#[tauri::command]
fn get_session(runtime: tauri::State<'_, Mutex<Runtime>>) -> Result<Session, String> {
    let runtime = runtime.lock().map_err(|_| "应用状态不可用")?;
    Ok(Session {
        root: runtime.root.to_string_lossy().into_owned(),
        state: runtime.state.clone(),
        version: env!("CARGO_PKG_VERSION"),
    })
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
    if path.exists() {
        let restored = (|| -> Result<Runtime, String> {
            let record: Bootstrap = storage::read_json(&path, 16 * 1024)?;
            let owner = storage::read_owner(&record.root)?;
            if record.format_version != 1 || owner.instance_id != record.instance_id {
                return Err("启动记录与数据目录不匹配。".into());
            }
            let state = storage::load_state(&record.root)?;
            Ok(Runtime {
                root: record.root,
                state,
                _bootstrap_lock: lock.try_clone().map_err(|e| e.to_string())?,
            })
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
    storage::save_bootstrap(
        &path,
        &Bootstrap {
            format_version: 1,
            root: root.clone(),
            instance_id: owner.instance_id,
        },
    )?;
    Ok(Some(Runtime {
        root,
        state,
        _bootstrap_lock: lock,
    }))
}

/// 单实例插件先注册，随后完成存储引导，最后用用户目录创建唯一 WebView。
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let runtime = match bootstrap() {
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
            app.manage(Mutex::new(runtime));
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("MD · Markdown 阅读器")
                .inner_size(width, height)
                .min_inner_size(800.0, 580.0)
                .data_directory(data_directory)
                .build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![get_session])
        .run(tauri::generate_context!());
    if let Err(error) = result {
        rfd::MessageDialog::new()
            .set_title("MD 启动失败")
            .set_description(error.to_string())
            .set_level(rfd::MessageLevel::Error)
            .show();
    }
}
