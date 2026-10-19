use md_reader::storage::{initialize_root, load_state, save_state, validate_local_path, AppState};
use std::fs;

// 验证首次数据根只接管空目录，拒绝把原文目录误认为应用数据。
#[test]
fn refuses_nonempty_unowned_directory() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("article.md"), "保留原文").unwrap();
    assert!(initialize_root(temp.path()).is_err());
    assert_eq!(
        fs::read_to_string(temp.path().join("article.md")).unwrap(),
        "保留原文"
    );
}

// 覆盖重复初始化、状态原子替换和中文路径；缓存不承载唯一阅读状态。
#[test]
fn owned_root_and_preferences_survive_reopening() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("中文阅读数据");
    let owner = initialize_root(&root).unwrap();
    assert_eq!(
        initialize_root(&root).unwrap().instance_id,
        owner.instance_id
    );
    let mut state = AppState::default();
    state.preferences.font_size = 20;
    save_state(&root, &state).unwrap();
    state.preferences.font_size = 21;
    save_state(&root, &state).unwrap();
    assert_eq!(load_state(&root).unwrap().preferences.font_size, 21);
    assert!(!root.join("state/preferences.json.tmp").exists());
}

// 损坏必要数据不能静默替换为空历史，保留原件供恢复。
#[test]
fn corrupt_state_is_reported_without_overwriting() {
    let temp = tempfile::tempdir().unwrap();
    initialize_root(temp.path()).unwrap();
    let state = temp.path().join("state/preferences.json");
    fs::write(&state, "invalid state").unwrap();
    assert!(load_state(temp.path()).is_err());
    assert_eq!(fs::read_to_string(&state).unwrap(), "invalid state");
}

#[test]
fn rejects_network_paths_and_volume_roots() {
    assert!(validate_local_path(std::path::Path::new(r"\\server\share\MD")).is_err());
    #[cfg(windows)]
    assert!(validate_local_path(std::path::Path::new(r"F:\")).is_err());
}

// 其他软件的归属标记不能触发本应用的目录接管或清理。
#[test]
fn refuses_foreign_owner_and_parent_components() {
    let temp = tempfile::tempdir().unwrap();
    fs::write(temp.path().join("owner.json"), serde_json::json!({ "format_version": 1, "instance_id": uuid::Uuid::new_v4(), "app_id": "another.application" }).to_string()).unwrap();
    assert!(initialize_root(temp.path()).is_err());
    assert!(validate_local_path(&temp.path().join("nested/../escape")).is_err());
}

// 两份受限引导记录支持损坏恢复，重复保存不积累随机暂存文件。
#[test]
fn bootstrap_recovers_without_unbounded_temp_files() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let owner = initialize_root(&data).unwrap();
    let path = temp.path().join("bootstrap.json");
    let record = md_reader::storage::Bootstrap {
        format_version: 1,
        root: data.clone(),
        instance_id: owner.instance_id,
        ..Default::default()
    };
    for _ in 0..5 {
        md_reader::storage::save_bootstrap(&path, &record).unwrap();
    }
    fs::write(&path, "broken").unwrap();
    assert_eq!(
        md_reader::storage::load_bootstrap(&path).unwrap().root,
        data
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 3);
}

// 曾经保存过的必要状态丢失时必须报错，不能默默生成一份空历史。
#[test]
fn missing_saved_state_is_not_silently_reset() {
    let temp = tempfile::tempdir().unwrap();
    initialize_root(temp.path()).unwrap();
    save_state(temp.path(), &AppState::default()).unwrap();
    fs::remove_file(temp.path().join("state/preferences.json")).unwrap();
    assert!(load_state(temp.path()).is_err());
}

// Windows junction 不得使缓存清理走到文章目录，即使根目录标记有效。
#[cfg(windows)]
#[test]
fn refuses_junction_before_cache_cleanup() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let original = temp.path().join("articles");
    fs::create_dir(&original).unwrap();
    fs::write(original.join("note.md"), "保留").unwrap();
    initialize_root(&root).unwrap();
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(root.join("cache").join("unsafe"))
        .arg(&original)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(md_reader::storage::clear_managed_child(&root, "cache").is_err());
    assert_eq!(
        fs::read_to_string(original.join("note.md")).unwrap(),
        "保留"
    );
}
