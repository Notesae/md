use crate::storage::{self, Bootstrap};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::{
    collections::HashSet,
    fs,
    io::Write,
    path::Path,
    time::{Duration, Instant},
};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use uuid::Uuid;

/// 迁移阶段写入小型引导记录，每次启动只恢复一个有效写入位置。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum MigrationPhase {
    Preparing,
    TargetReady,
    AwaitingHealth,
}

/// 记录本应用旧进程及启动时刻，等待退出时避免把复用 PID 的进程当成旧会话。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionProcess {
    pub pid: u32,
    pub started: u64,
}

/// 准备迁移后即冻结旧位置写入；下一进程创建 WebView 前恢复此记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Migration {
    pub source: PathBuf,
    pub target: PathBuf,
    pub instance_id: Uuid,
    pub phase: MigrationPhase,
    pub previous: Vec<SessionProcess>,
}

/// 清理失败只保留一项带归属的残留，处理完成前不接受下一次迁移。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Residual {
    pub path: PathBuf,
    pub instance_id: Uuid,
}

/// 规范化现有父目录并保留新目录名，防止盘符大小写、相对段或链接绕过嵌套检查。
pub fn normalized_path(path: &Path) -> Result<PathBuf, String> {
    storage::validate_local_path(path)?;
    let mut existing = path.to_owned();
    let mut suffix = Vec::new();
    while !existing.exists() {
        suffix.push(existing.file_name().ok_or("目标路径无效")?.to_owned());
        if !existing.pop() {
            return Err("找不到目标的本地父目录。".into());
        }
    }
    let mut normalized = dunce::canonicalize(existing).map_err(|e| e.to_string())?;
    for component in suffix.into_iter().rev() {
        normalized.push(component);
    }
    storage::validate_local_path(&normalized)?;
    Ok(normalized)
}

/// 仅记录当前应用及其子进程，限制数量使引导信息始终保持小型。
pub fn session_processes() -> Result<Vec<SessionProcess>, String> {
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    let mut owned = HashSet::from([std::process::id()]);
    loop {
        let count = owned.len();
        for (pid, process) in system.processes() {
            if process
                .parent()
                .is_some_and(|parent| owned.contains(&parent.as_u32()))
            {
                owned.insert(pid.as_u32());
            }
        }
        if count == owned.len() {
            break;
        }
    }
    if owned.len() > 64 {
        return Err("本应用子进程过多，请关闭后再执行维护。".into());
    }
    Ok(owned
        .into_iter()
        .filter_map(|pid| {
            system
                .process(sysinfo::Pid::from_u32(pid))
                .map(|process| SessionProcess {
                    pid,
                    started: process.start_time(),
                })
        })
        .collect())
}

/// 等待旧会话完全退出，绝不终止 Edge 或其他进程；超时保留原目录。
pub fn wait_for_sessions(previous: &[SessionProcess], profile: &Path) -> Result<(), String> {
    if previous
        .iter()
        .any(|process| process.pid == std::process::id())
    {
        return Err("旧会话尚未退出，不能在阅读窗口运行期间迁移。".into());
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut system = System::new();
    let mut ancestry: HashSet<u32> = previous.iter().map(|process| process.pid).collect();
    let profile = profile
        .to_string_lossy()
        .replace('/', "\\")
        .to_ascii_lowercase();
    loop {
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_cmd(UpdateKind::Always),
        );
        let mut busy = false;
        for (pid, process) in system.processes() {
            if pid.as_u32() == std::process::id() {
                continue;
            }
            let recorded = previous
                .iter()
                .any(|old| old.pid == pid.as_u32() && old.started == process.start_time());
            let child = process
                .parent()
                .is_some_and(|parent| ancestry.contains(&parent.as_u32()));
            let owns_profile = process.cmd().iter().any(|arg| {
                arg.to_string_lossy()
                    .replace('/', "\\")
                    .to_ascii_lowercase()
                    .contains(&profile)
            });
            if recorded || child || owns_profile {
                ancestry.insert(pid.as_u32());
                busy = true;
            }
        }
        if !busy {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err("旧浏览器会话尚未释放，已保留旧数据，请稍后重试。".into());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// 准备阶段只记录意图；目标必须是可写本地空目录，尚不关闭或迁移任何文档。
pub fn prepare_migration(
    path: &Path,
    target: &Path,
    previous: Vec<SessionProcess>,
) -> Result<Bootstrap, String> {
    let mut record = storage::load_bootstrap(path)?;
    if record.migration.is_some()
        || record.pending_cleanup.is_some()
        || record.reset_webview.is_some()
    {
        return Err("请先完成当前维护或清理迁移残留。".into());
    }
    let source = normalized_path(&record.root)?;
    let target = normalized_path(target)?;
    let source_text = source.to_string_lossy().to_lowercase();
    let target_text = target.to_string_lossy().to_lowercase();
    let separator = std::path::MAIN_SEPARATOR;
    if source_text == target_text
        || source_text.starts_with(&(target_text.clone() + &separator.to_string()))
        || target_text.starts_with(&(source_text.clone() + &separator.to_string()))
    {
        return Err("迁移目标不能是当前位置、父目录或子目录。".into());
    }
    if target.exists()
        && (!target.is_dir()
            || fs::read_dir(&target)
                .map_err(|e| e.to_string())?
                .next()
                .is_some())
    {
        return Err("迁移目标必须为空，不能覆盖已有应用或用户文件。".into());
    }
    let owner = storage::read_owner(&source)?;
    if owner.instance_id != record.instance_id {
        return Err("源数据目录归属不匹配。".into());
    }
    let parent = if target.exists() {
        target.as_path()
    } else {
        target.parent().ok_or("没有目标父目录")?
    };
    let required =
        storage::tree_bytes(&source.join("state"), &|| false)?.saturating_mul(2) + 8 * 1024 * 1024;
    if fs2::available_space(parent).map_err(|e| e.to_string())? < required {
        return Err("目标盘空间不足，需要必要状态与暂存空间；缓存不参与复制。".into());
    }
    let probe = tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("目标不可写：{e}"))?;
    drop(probe);
    record.root = source.clone();
    record.notice = None;
    record.migration = Some(Migration {
        source,
        target,
        instance_id: owner.instance_id,
        phase: MigrationPhase::Preparing,
        previous,
    });
    storage::save_bootstrap(path, &record)?;
    Ok(record)
}

/// 在目标盘暂存、逐文件校验后提交 state；重复执行可恢复复制或提交阶段的中断。
pub fn stage_target(migration: &Migration) -> Result<(), String> {
    let owner = storage::read_owner(&migration.source)?;
    if owner.instance_id != migration.instance_id {
        return Err("源目录归属发生变化。".into());
    }
    storage::validate_local_path(&migration.target)?;
    if migration.target.join("owner.json").exists() {
        if storage::read_owner(&migration.target)?.instance_id != owner.instance_id {
            return Err("目标已归属其他应用实例。".into());
        }
    } else {
        if migration.target.exists()
            && fs::read_dir(&migration.target)
                .map_err(|e| e.to_string())?
                .next()
                .is_some()
        {
            return Err("目标出现非应用文件，已停止迁移。".into());
        }
        fs::create_dir_all(&migration.target).map_err(|e| e.to_string())?;
        storage::atomic_json(&migration.target.join("owner.json"), &owner)?;
    }
    storage::initialize_root(&migration.target)?;
    storage::clear_managed_child(&migration.target, "temp")?;
    let staging = migration.target.join("temp/migration-state");
    fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let mut pending = vec![(migration.source.join("state"), staging.clone())];
    let mut total = 0u64;
    while let Some((source, destination)) = pending.pop() {
        storage::validate_local_path(&source)?;
        for entry in fs::read_dir(&source).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let source = entry.path();
            storage::validate_local_path(&source)?;
            let destination = destination.join(entry.file_name());
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                fs::create_dir(&destination).map_err(|e| e.to_string())?;
                pending.push((source, destination));
            } else {
                use std::io::Read;
                let mut contents = Vec::new();
                fs::File::open(&source)
                    .map_err(|e| e.to_string())?
                    .take(8 * 1024 * 1024 + 1)
                    .read_to_end(&mut contents)
                    .map_err(|e| e.to_string())?;
                total += contents.len() as u64;
                if total > 8 * 1024 * 1024 {
                    return Err("必要状态超过迁移预算，请先检查数据目录。".into());
                }
                let mut file = fs::File::create(&destination).map_err(|e| e.to_string())?;
                file.write_all(&contents).map_err(|e| e.to_string())?;
                file.sync_all().map_err(|e| e.to_string())?;
                if fs::read(&destination).map_err(|e| e.to_string())? != contents {
                    return Err("目标数据校验失败，源数据未变动。".into());
                }
            }
        }
    }
    if staging.join("preferences.json").exists() {
        let _: storage::AppState =
            storage::read_json(&staging.join("preferences.json"), 4 * 1024 * 1024)?;
    }
    let state = migration.target.join("state");
    storage::tree_bytes(&state, &|| false)?;
    fs::remove_dir_all(&state).map_err(|e| e.to_string())?;
    fs::rename(&staging, &state).map_err(|e| e.to_string())?;
    storage::load_state(&migration.target)?;
    Ok(())
}

/// 摘要同时覆盖相对文件名与内容，用于重启恢复时重新校验必要数据完整性。
fn state_digest(root: &Path) -> Result<Vec<u8>, String> {
    let mut pending = vec![root.to_owned()];
    let mut files = Vec::new();
    while let Some(directory) = pending.pop() {
        storage::validate_local_path(&directory)?;
        for entry in fs::read_dir(&directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            storage::validate_local_path(&path)?;
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                pending.push(path);
            } else {
                files.push(path);
            }
        }
    }
    files.sort();
    let mut digest = Sha256::new();
    let mut total = 0;
    for file in files {
        use std::io::Read;
        let mut bytes = Vec::new();
        fs::File::open(&file)
            .map_err(|e| e.to_string())?
            .take(8 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        total += bytes.len();
        if total > 8 * 1024 * 1024 {
            return Err("必要数据超过校验预算。".into());
        }
        digest.update(
            file.strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .as_bytes(),
        );
        digest.update([0]);
        digest.update((bytes.len() as u64).to_le_bytes());
        digest.update(bytes);
    }
    Ok(digest.finalize().to_vec())
}

/// 任何失败先恢复源指针，目标保留为有界且可见的残留，不删除用户数据。
pub fn rollback(path: &Path, reason: &str) -> Result<Bootstrap, String> {
    let mut record = storage::load_bootstrap(path)?;
    if let Some(migration) = record.migration.take() {
        let owner = storage::read_owner(&migration.source)?;
        if owner.instance_id != migration.instance_id {
            return Err("无法核验源数据归属，已停止自动回滚。".into());
        }
        record.root = migration.source;
        if migration.target.exists() {
            record.pending_cleanup = Some(Residual {
                path: migration.target,
                instance_id: migration.instance_id,
            });
        }
    }
    record.notice = Some(format!(
        "维护未完成，已保留原位置：{}",
        reason.chars().take(350).collect::<String>()
    ));
    storage::save_bootstrap(path, &record)?;
    Ok(record)
}

/// 启动恢复在创建 WebView 前执行；未确认健康的新位置在下一启动时回滚。
pub fn resume_migration(path: &Path) -> Result<Bootstrap, String> {
    let mut record = storage::load_bootstrap(path)?;
    if let Some(migration) = record.migration.clone() {
        if migration.phase == MigrationPhase::AwaitingHealth {
            return rollback(path, "新位置上次启动未通过健康确认。暂停清理源数据。");
        }
        let result = (|| -> Result<(), String> {
            if storage::read_owner(&migration.source)?.instance_id != migration.instance_id {
                return Err("源数据归属不匹配。".into());
            }
            wait_for_sessions(&migration.previous, &migration.source.join("webview"))?;
            if migration.phase == MigrationPhase::Preparing {
                stage_target(&migration)?;
                record.migration.as_mut().unwrap().phase = MigrationPhase::TargetReady;
                storage::save_bootstrap(path, &record)?;
            }
            if storage::read_owner(&migration.target)?.instance_id != migration.instance_id {
                return Err("目标数据归属不匹配。".into());
            }
            if state_digest(&migration.source.join("state"))?
                != state_digest(&migration.target.join("state"))?
            {
                return Err("目标必要数据与源目录不一致，未切换数据位置。".into());
            }
            let state = storage::load_state(&migration.target)?;
            storage::save_state(&migration.target, &state)?;
            record.root = migration.target;
            record.migration.as_mut().unwrap().phase = MigrationPhase::AwaitingHealth;
            storage::save_bootstrap(path, &record)
        })();
        if let Err(error) = result {
            return rollback(path, &error);
        }
    } else if let Some(previous) = record.reset_webview.take() {
        let result = wait_for_sessions(&previous, &record.root.join("webview"))
            .and_then(|_| storage::clear_managed_child(&record.root, "webview"));
        record.notice = Some(match result {
            Ok(()) => "浏览器数据已在旧会话退出后重建，阅读状态已保留。".into(),
            Err(error) => format!("浏览器数据未清理，原目录已保留：{error}"),
        });
        storage::save_bootstrap(path, &record)?;
    }
    Ok(record)
}

/// 清理前同时核验归属、非嵌套路径与根目录条目，只删除应用自己的固定分类。
pub fn retry_cleanup(path: &Path) -> Result<Bootstrap, String> {
    let mut record = storage::load_bootstrap(path)?;
    let Some(residual) = record.pending_cleanup.clone() else {
        return Ok(record);
    };
    if !residual.path.exists() {
        record.pending_cleanup = None;
        storage::save_bootstrap(path, &record)?;
        return Ok(record);
    }
    let old = normalized_path(&residual.path)?;
    let current = normalized_path(&record.root)?;
    if old == current || old.starts_with(&current) || current.starts_with(&old) {
        return Err("残留路径与当前应用数据重叠，已停止删除。".into());
    }
    if storage::read_owner(&old)?.instance_id != residual.instance_id {
        return Err("无法核验残留归属，已保留目录。".into());
    }
    wait_for_sessions(&[], &old.join("webview"))?;
    for entry in fs::read_dir(&old).map_err(|e| e.to_string())? {
        let name = entry.map_err(|e| e.to_string())?.file_name();
        if name != "owner.json"
            && !storage::MANAGED_DIRECTORIES
                .iter()
                .any(|directory| name == *directory)
        {
            return Err("旧目录包含非应用文件，已保留，请检查后重试。".into());
        }
    }
    storage::tree_bytes(&old, &|| false)?;
    for directory in storage::MANAGED_DIRECTORIES {
        let child = old.join(directory);
        if child.exists() {
            fs::remove_dir_all(child)
                .map_err(|e| format!("旧目录仍被占用，已保留残留记录：{e}"))?;
        }
    }
    fs::remove_file(old.join("owner.json")).map_err(|e| e.to_string())?;
    fs::remove_dir(old).map_err(|e| e.to_string())?;
    record.pending_cleanup = None;
    record.notice = Some("数据迁移已完成，旧应用目录已清理。".into());
    storage::save_bootstrap(path, &record)?;
    Ok(record)
}

/// 窗口呈现并恢复必要状态后才提交健康结果；先保存残留任务，再尝试清理旧目录。
pub fn confirm_health(path: &Path) -> Result<Bootstrap, String> {
    let mut record = storage::load_bootstrap(path)?;
    let Some(migration) = record.migration.clone() else {
        return Ok(record);
    };
    if migration.phase != MigrationPhase::AwaitingHealth || record.root != migration.target {
        return Err("迁移尚未准备好进行健康确认。".into());
    }
    if storage::read_owner(&record.root)?.instance_id != migration.instance_id {
        return Err("新位置归属校验失败。".into());
    }
    let state = storage::load_state(&record.root)?;
    storage::save_state(&record.root, &state)?;
    record.migration = None;
    record.pending_cleanup = Some(Residual {
        path: migration.source,
        instance_id: migration.instance_id,
    });
    storage::save_bootstrap(path, &record)?;
    match retry_cleanup(path) {
        Ok(cleaned) => Ok(cleaned),
        Err(error) => {
            record.notice = Some(format!("新位置已启用，旧目录有待清理残留：{error}"));
            storage::save_bootstrap(path, &record)?;
            Ok(record)
        }
    }
}
