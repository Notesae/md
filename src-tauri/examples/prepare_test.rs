use md_reader::storage::{self, AppState, Bootstrap};
use std::fs;

/// 为桌面自动化创建独立的工作盘数据区，复用真实存储代码，不修改标准用户记录。
fn main() -> Result<(), String> {
    let workspace = std::env::current_dir().map_err(|e| e.to_string())?;
    let base = workspace.join(".runtime/desktop-smoke");
    let location = base.join("bootstrap");
    fs::create_dir_all(&location).map_err(|e| e.to_string())?;
    let root = base.join("data");
    let owner = storage::initialize_root(&root)?;
    let article =
        fs::canonicalize(workspace.join("fixtures/welcome.md")).map_err(|e| e.to_string())?;
    let mut state = AppState::default();
    state.last_file = Some(article.to_string_lossy().into_owned());
    state
        .folders
        .push(article.parent().unwrap().to_string_lossy().into_owned());
    storage::save_state(&root, &state)?;
    storage::save_bootstrap(
        &location.join("bootstrap.json"),
        &Bootstrap {
            format_version: 1,
            root: root.clone(),
            instance_id: owner.instance_id,
        },
    )?;
    println!(
        "{}",
        serde_json::json!({ "bootstrap": location, "root": root, "article": article })
    );
    Ok(())
}
