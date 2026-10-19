use md_reader::storage::{self, AppState};
use std::fs;

// 预算为零时不产生持久缓存；超大单项同样必须跳过。
#[test]
fn zero_budget_and_oversized_entries_do_not_write() {
    let temp = tempfile::tempdir().unwrap();
    storage::initialize_root(temp.path()).unwrap();
    let key = "a".repeat(64);
    assert!(!storage::write_cache(temp.path(), &key, &"payload", 0).unwrap());
    assert!(!storage::write_cache(temp.path(), &key, &"payload", 2).unwrap());
    assert_eq!(fs::read_dir(temp.path().join("cache")).unwrap().count(), 0);
}

// 写入之前按字节预算淘汰，后续缩减预算也要立即满足约束。
#[test]
fn evicts_oldest_before_new_write_and_budget_shrink() {
    let temp = tempfile::tempdir().unwrap();
    storage::initialize_root(temp.path()).unwrap();
    for letter in ["a", "b", "c"] {
        assert!(
            storage::write_cache(temp.path(), &letter.repeat(64), &"x".repeat(50), 110).unwrap()
        );
    }
    assert!(storage::read_cache::<String>(temp.path(), &"a".repeat(64), 110).is_none());
    assert!(storage::cache_bytes(temp.path()).unwrap() <= 110);
    storage::enforce_cache_budget(temp.path(), 55).unwrap();
    assert!(storage::cache_bytes(temp.path()).unwrap() <= 55);
}

// 清理只能影响应用缓存；必要状态与目录外的文章保持原样。
#[test]
fn cache_cleanup_preserves_preferences_and_originals() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("data");
    storage::initialize_root(&root).unwrap();
    let mut state = AppState::default();
    state.preferences.font_size = 24;
    storage::save_state(&root, &state).unwrap();
    fs::write(temp.path().join("original.md"), "原始文档").unwrap();
    storage::write_cache(&root, &"b".repeat(64), &"cache", 1024).unwrap();
    storage::clear_managed_child(&root, "cache").unwrap();
    assert_eq!(
        storage::load_state(&root).unwrap().preferences.font_size,
        24
    );
    assert_eq!(
        fs::read_to_string(temp.path().join("original.md")).unwrap(),
        "原始文档"
    );
    assert!(storage::clear_managed_child(&root, "state").is_err());
    assert!(storage::clear_managed_child(temp.path(), "cache").is_err());
}

#[test]
fn usage_is_cancellable_and_counts_real_files() {
    let temp = tempfile::tempdir().unwrap();
    storage::initialize_root(temp.path()).unwrap();
    fs::write(temp.path().join("cache/item"), [0u8; 127]).unwrap();
    let usage = storage::storage_usage(temp.path(), || false).unwrap();
    assert_eq!(usage.cache_bytes, 127);
    assert!(usage.total_bytes >= 127);
    assert!(usage.free_bytes > 0);
    assert!(storage::storage_usage(temp.path(), || true).is_err());
}
