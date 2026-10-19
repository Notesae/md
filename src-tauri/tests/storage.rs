use md_reader::storage::{
    initialize_root, load_state, save_bootstrap, save_state, validate_local_path, AppState,
    Bootstrap,
};
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

// 单份引导不超过 16KiB；两份记录和两份原子暂存同时存在时也不超过 64KiB。
#[test]
fn bootstrap_payload_stays_within_single_and_total_budget() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    let owner = initialize_root(&data).unwrap();
    let path = temp.path().join("bootstrap.json");
    let mut record = Bootstrap {
        format_version: 1,
        root: data,
        instance_id: owner.instance_id,
        notice: Some("x".repeat(16 * 1024)),
        ..Default::default()
    };
    assert!(save_bootstrap(&path, &record).is_err());
    record.notice = None;
    save_bootstrap(&path, &record).unwrap();
    let names = [
        "bootstrap.json",
        "bootstrap.recovery.json",
        "bootstrap.pending",
        "bootstrap.recovery.pending",
    ];
    let mut total = 0u64;
    for name in names {
        let file = temp.path().join(name);
        if file.exists() {
            let len = fs::metadata(&file).unwrap().len();
            assert!(len <= 16 * 1024, "{name} 超过 16KiB");
            total += len;
        }
    }
    assert!(total <= 64 * 1024);
    assert!(!temp.path().join("bootstrap.pending").exists());
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

// 关闭状态跨重启保留；历史只供重新选择，不能重新授予整个旧目录的访问权。
#[test]
fn folder_close_and_switch_survive_state_reopening() {
    let temp = tempfile::tempdir().unwrap();
    let data = temp.path().join("data");
    initialize_root(&data).unwrap();
    let first = temp.path().join("中文目录");
    let second = temp.path().join("其他目录");
    fs::create_dir(&first).unwrap();
    fs::create_dir(&second).unwrap();
    let original = first.join("保留.md");
    fs::write(&original, "原文保持不变").unwrap();
    let mut state = AppState::default();
    state.open_folder(first.to_string_lossy().into_owned());
    state.open_folder(second.to_string_lossy().into_owned());
    assert!(!state.folder_contains(&original));
    assert!(state.folder_contains(&second.join("子目录/文章.md")));
    state.folder_closed = true;
    save_state(&data, &state).unwrap();
    let mut restored = load_state(&data).unwrap();
    assert!(restored.active_folder().is_none());
    assert_eq!(restored.folders.len(), 2);
    assert!(!restored.folder_contains(&second.join("文章.md")));
    restored.open_folder(first.to_string_lossy().into_owned());
    save_state(&data, &restored).unwrap();
    assert!(load_state(&data).unwrap().folder_contains(&original));
    assert_eq!(fs::read_to_string(original).unwrap(), "原文保持不变");
}

// 升级前缺少关闭字段的记录仍恢复最近目录；同名前缀的相邻目录不属于授权范围。
#[test]
fn legacy_folder_state_keeps_bounded_history_and_path_boundaries() {
    let temp = tempfile::tempdir().unwrap();
    let first = temp.path().join("notes");
    let mut state: AppState =
        serde_json::from_value(serde_json::json!({ "folders": [first] })).unwrap();
    assert!(state.active_folder().is_some());
    assert!(!state.folder_contains(&temp.path().join("notes-other/article.md")));
    for index in 0..30 {
        state.open_folder(
            temp.path()
                .join(format!("目录 {index}"))
                .to_string_lossy()
                .into_owned(),
        );
    }
    let latest = state.folders[0].clone();
    state.open_folder(latest);
    assert_eq!(state.folders.len(), 20);
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
