use md_reader::{
    storage::{self, AppState, Bootstrap},
    uninstall,
};
use std::fs;

/// 原文留在专属数据根之外，卸载只接管有正确实例标记的固定分类。
#[test]
fn removes_owned_data_but_preserves_originals() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let location = temp.path().join("bootstrap");
    fs::create_dir(&location).unwrap();
    let owner = storage::initialize_root(&root).unwrap();
    storage::save_state(&root, &AppState::default()).unwrap();
    fs::write(temp.path().join("original.md"), "原文保留").unwrap();
    let path = location.join("bootstrap.json");
    storage::save_bootstrap(
        &path,
        &Bootstrap {
            format_version: 1,
            root: root.clone(),
            instance_id: owner.instance_id,
            ..Default::default()
        },
    )
    .unwrap();
    uninstall::clear_data(&path).unwrap();
    assert!(!root.exists());
    assert!(!location.exists());
    assert_eq!(
        fs::read_to_string(temp.path().join("original.md")).unwrap(),
        "原文保留"
    );
}

#[test]
fn refuses_foreign_entries_before_deleting_any_category() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    let owner = storage::initialize_root(&root).unwrap();
    storage::save_state(&root, &AppState::default()).unwrap();
    fs::write(root.join("my-note.md"), "保留").unwrap();
    assert!(storage::remove_owned_root(&root, owner.instance_id).is_err());
    assert!(root.join("state/preferences.json").exists());
    assert!(root.join("my-note.md").exists());
}

#[test]
fn cleanup_cannot_acquire_a_running_app_lock() {
    use fs2::FileExt;
    let temp = tempfile::tempdir().unwrap();
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(temp.path().join("instance.lock"))
        .unwrap();
    lock.lock_exclusive().unwrap();
    assert!(uninstall::clear_data(&temp.path().join("bootstrap.json")).is_err());
    assert!(temp.path().join("instance.lock").exists());
}
