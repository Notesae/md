use md_reader::{
    migration::{self, MigrationPhase},
    storage::{self, AppState, Bootstrap},
};
use std::fs;

/// 每个迁移场景使用独立应用根和引导记录，原文放在受管目录之外。
fn setup() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let temp = tempfile::tempdir().unwrap();
    let source = temp.path().join("source");
    let owner = storage::initialize_root(&source).unwrap();
    let mut state = AppState::default();
    state.preferences.font_size = 26;
    storage::save_state(&source, &state).unwrap();
    fs::write(source.join("cache/stale"), "cache").unwrap();
    fs::write(temp.path().join("original.md"), "原文不动").unwrap();
    let record = temp.path().join("bootstrap.json");
    storage::save_bootstrap(
        &record,
        &Bootstrap {
            format_version: 1,
            root: source.clone(),
            instance_id: owner.instance_id,
            ..Default::default()
        },
    )
    .unwrap();
    (temp, source, record)
}

// 复制、切换与健康提交分开，健康确认前绝不删除源数据。
#[test]
fn migrates_required_state_then_removes_old_data_after_health() {
    let (temp, source, record) = setup();
    let target = temp.path().join("新位置");
    migration::prepare_migration(&record, &target, vec![]).unwrap();
    let switched = migration::resume_migration(&record).unwrap();
    assert_eq!(switched.root, target);
    assert_eq!(
        switched.migration.as_ref().unwrap().phase,
        MigrationPhase::AwaitingHealth
    );
    assert!(source.exists());
    assert_eq!(
        storage::load_state(&target).unwrap().preferences.font_size,
        26
    );
    assert_eq!(fs::read_dir(target.join("cache")).unwrap().count(), 0);
    migration::confirm_health(&record).unwrap();
    assert!(!source.exists());
    assert_eq!(
        fs::read_to_string(temp.path().join("original.md")).unwrap(),
        "原文不动"
    );
}

#[test]
fn rejects_same_nested_parent_and_foreign_target() {
    let (temp, source, record) = setup();
    assert!(migration::prepare_migration(&record, &source, vec![]).is_err());
    assert!(migration::prepare_migration(&record, &source.join("nested"), vec![]).is_err());
    assert!(migration::prepare_migration(&record, temp.path(), vec![]).is_err());
    let foreign = temp.path().join("foreign");
    storage::initialize_root(&foreign).unwrap();
    assert!(migration::prepare_migration(&record, &foreign, vec![]).is_err());
}

// 模拟目标提交后、阶段记录更新前断电，恢复必须幂等且不能产生第二写入根。
#[test]
fn recovers_after_target_commit_before_bootstrap_update() {
    let (temp, source, record) = setup();
    let target = temp.path().join("target");
    let prepared = migration::prepare_migration(&record, &target, vec![]).unwrap();
    migration::stage_target(prepared.migration.as_ref().unwrap()).unwrap();
    let resumed = migration::resume_migration(&record).unwrap();
    assert_eq!(resumed.root, target);
    assert!(source.exists());
    migration::confirm_health(&record).unwrap();
}

// 复制期间的残缺暂存不能被当作有效状态，必须从保留的源重新复制校验。
#[test]
fn recovers_partial_copy_in_target_temp() {
    let (temp, source, record) = setup();
    let target = temp.path().join("target");
    migration::prepare_migration(&record, &target, vec![]).unwrap();
    fs::create_dir(&target).unwrap();
    storage::atomic_json(
        &target.join("owner.json"),
        &storage::read_owner(&source).unwrap(),
    )
    .unwrap();
    storage::initialize_root(&target).unwrap();
    fs::create_dir(target.join("temp/migration-state")).unwrap();
    fs::write(
        target.join("temp/migration-state/preferences.json"),
        "partial",
    )
    .unwrap();
    let resumed = migration::resume_migration(&record).unwrap();
    assert_eq!(resumed.root, target);
    assert_eq!(
        storage::load_state(&target).unwrap().preferences.font_size,
        26
    );
}

// 新位置启动未确认健康时再次启动应回滚，不能无限重试一个失败的新位置。
#[test]
fn unconfirmed_new_start_rolls_back_and_tracks_residual() {
    let (temp, source, record) = setup();
    let target = temp.path().join("target");
    migration::prepare_migration(&record, &target, vec![]).unwrap();
    migration::resume_migration(&record).unwrap();
    let rollback = migration::resume_migration(&record).unwrap();
    assert_eq!(rollback.root, source);
    assert!(rollback.migration.is_none());
    assert_eq!(rollback.pending_cleanup.as_ref().unwrap().path, target);
    assert_eq!(
        storage::load_state(&source).unwrap().preferences.font_size,
        26
    );
}

// 遇到用户误放的文章，旧目录清理应保留并可重试，不把文章当作应用垃圾删除。
#[test]
fn cleanup_failure_is_visible_and_retryable() {
    let (temp, source, record) = setup();
    let target = temp.path().join("target");
    migration::prepare_migration(&record, &target, vec![]).unwrap();
    migration::resume_migration(&record).unwrap();
    fs::write(source.join("keep.md"), "不要删").unwrap();
    let healthy = migration::confirm_health(&record).unwrap();
    assert!(healthy.pending_cleanup.is_some());
    assert!(source.join("keep.md").exists());
    fs::remove_file(source.join("keep.md")).unwrap();
    assert!(migration::retry_cleanup(&record)
        .unwrap()
        .pending_cleanup
        .is_none());
    assert!(!source.exists());
}

// 引导记录已到目标就绪阶段时，仍需重新验证数据摘要，不能只看 JSON 能否解析。
#[test]
fn target_ready_with_changed_state_rolls_back() {
    let (temp, source, record) = setup();
    let target = temp.path().join("target");
    let mut prepared = migration::prepare_migration(&record, &target, vec![]).unwrap();
    migration::stage_target(prepared.migration.as_ref().unwrap()).unwrap();
    prepared.migration.as_mut().unwrap().phase = MigrationPhase::TargetReady;
    storage::save_bootstrap(&record, &prepared).unwrap();
    fs::write(target.join("state/preferences.json"), "{}").unwrap();
    let resumed = migration::resume_migration(&record).unwrap();
    assert_eq!(resumed.root, source);
    assert!(resumed.pending_cleanup.is_some());
    assert_eq!(
        storage::load_state(&source).unwrap().preferences.font_size,
        26
    );
}
