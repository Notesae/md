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
