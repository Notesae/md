use crate::{migration, storage};
use fs2::FileExt;
use std::{fs, path::Path};

/// 只有卸载界面明确勾选清理后才调用；不创建 WebView，也不追随原始文章路径。
pub fn clear_data(path: &Path) -> Result<(), String> {
    let location = path.parent().ok_or("卸载定位路径无效")?;
    if !location.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    storage::validate_local_path(location)?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(location.join("instance.lock"))
        .map_err(|e| e.to_string())?;
    lock.try_lock_exclusive()
        .map_err(|_| "请先关闭 MD，再卸载并清理数据。")?;
    if path.try_exists().map_err(|e| e.to_string())?
        || location
            .join("bootstrap.recovery.json")
            .try_exists()
            .map_err(|e| e.to_string())?
    {
        let record = storage::load_bootstrap(path)?;
        if record.migration.is_some() || record.reset_webview.is_some() {
            return Err("请先启动 MD 完成待处理维护，或取消勾选清理并保留数据。".into());
        }
        storage::validate_owned_root(&record.root, record.instance_id)?;
        migration::wait_for_sessions(&[], &record.root.join("webview"))?;
        // 残留先清理；失败时当前根与引导仍完整，用户可保留数据继续卸载。
        migration::retry_cleanup(path)?;
        storage::remove_owned_root(&record.root, record.instance_id)?;
        for name in [
            "bootstrap.json",
            "bootstrap.recovery.json",
            "bootstrap.pending",
            "bootstrap.recovery.pending",
        ] {
            let file = location.join(name);
            if file.try_exists().map_err(|e| e.to_string())? {
                storage::validate_local_path(&file)?;
                fs::remove_file(file).map_err(|e| e.to_string())?;
            }
        }
    }
    drop(lock);
    fs::remove_file(location.join("instance.lock")).map_err(|e| e.to_string())?;
    // 引导目录如果混入其他文件就保留，不用递归删除扩大清理范围。
    if fs::read_dir(location)
        .map_err(|e| e.to_string())?
        .next()
        .is_none()
    {
        fs::remove_dir(location).map_err(|e| e.to_string())?;
    }
    Ok(())
}
