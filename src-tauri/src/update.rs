//! 公开更新的纯校验与受控暂存，不发网络请求，也不运行安装程序。
use crate::storage;
use fs2::FileExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};
use url::Url;
use uuid::Uuid;

pub const RELEASES_PAGE: &str = "https://github.com/Notesae/md/releases";
pub const RELEASES_API: &str = "https://api.github.com/repos/Notesae/md/releases?per_page=100";
pub const MAX_INSTALLER: u64 = 60 * 1024 * 1024;
pub const MAX_META: u64 = 64 * 1024;
pub const TEMP_BUDGET: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Preview,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    pub browser_download_url: String,
    pub digest: Option<String>,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct Release {
    pub id: u64,
    pub tag_name: String,
    pub draft: bool,
    pub prerelease: bool,
    pub html_url: String,
    pub body: Option<String>,
    pub assets: Vec<Asset>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
    pub version: String,
    pub tag: String,
    pub prerelease: bool,
    pub release_url: String,
    pub notes: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Clone)]
pub struct Candidate {
    pub offer: Offer,
    pub installer: Asset,
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.into())
    }
}

pub fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

/// 版本按语义排序，禁止降级；稳定通道同时排除 GitHub 预发布标记和语义预发布版本。
pub fn select_release(
    releases: Vec<Release>,
    current: &str,
    channel: Channel,
) -> Result<Option<Release>, String> {
    let current = Version::parse(current).map_err(|_| "当前应用版本无法识别")?;
    let mut choices = Vec::new();
    for release in releases {
        if release.draft {
            continue;
        }
        let Some(tag) = release.tag_name.strip_prefix('v') else {
            continue;
        };
        let Ok(version) = Version::parse(tag) else {
            continue;
        };
        if !version.cmp_precedence(&current).is_gt()
            || (channel == Channel::Stable && (release.prerelease || !version.pre.is_empty()))
        {
            continue;
        }
        require(
            release.html_url == format!("{RELEASES_PAGE}/tag/{}", release.tag_name),
            "发布页不属于 MD，已停止更新",
        )?;
        choices.push((version, release));
    }
    choices.sort_by(|left, right| left.0.cmp_precedence(&right.0));
    Ok(choices.pop().map(|(_, release)| release))
}

/// 初始地址必须是本仓库该 tag 的固定文件，前端不能指定下载地址或本地路径。
pub fn asset(release: &Release, name: &str, limit: u64) -> Result<Asset, String> {
    let matches: Vec<_> = release
        .assets
        .iter()
        .filter(|item| item.name == name)
        .collect();
    require(matches.len() == 1, "发布附件缺失或重复，暂不能安装此版本")?;
    let item = matches[0];
    require(
        item.state == "uploaded" && item.size > 0 && item.size <= limit,
        "发布附件未完成或超过允许大小",
    )?;
    require(
        item.browser_download_url
            == format!(
                "https://github.com/Notesae/md/releases/download/{}/{name}",
                release.tag_name
            ),
        "附件来源不符合要求",
    )?;
    require(
        item.digest
            .as_deref()
            .and_then(|value| value.strip_prefix("sha256:"))
            .is_some_and(|value| hex(value, 64)),
        "发布附件缺少 SHA-256 校验信息",
    )?;
    Ok(item.clone())
}

/// GitHub 的签名 CDN 重定向只允许已知 HTTPS 主机；不接受任意用户内容域、端口或用户名。
pub fn allowed_redirect(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none_or(|port| port == 443)
        && url.fragment().is_none()
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
                    | "github-releases.githubusercontent.com"
            )
        )
}

pub fn verify_asset(item: &Asset, bytes: &[u8]) -> Result<(), String> {
    require(
        item.size == bytes.len() as u64
            && item.digest.as_deref() == Some(format!("sha256:{}", sha(bytes)).as_str()),
        "附件大小或 SHA-256 校验失败，未运行安装程序",
    )
}

/// GitHub digest、四项校验清单和构建信息必须一致；校验成功不代表代码签名或原生验收已建立。
pub fn validate_candidate(
    release: &Release,
    manifest: &[u8],
    build: &[u8],
) -> Result<Candidate, String> {
    let version = release.tag_name.strip_prefix('v').ok_or("版本 tag 无效")?;
    Version::parse(version).map_err(|_| "版本 tag 无效")?;
    require(
        release.html_url == format!("{RELEASES_PAGE}/tag/{}", release.tag_name),
        "发布页来源不符合要求",
    )?;
    let installer_name = format!("MD_{version}_x64-setup.exe");
    let standalone = format!("MD_{version}_x64-standalone.zip");
    let installer = asset(release, &installer_name, MAX_INSTALLER)?;
    verify_asset(&asset(release, "SHA256SUMS.txt", MAX_META)?, manifest)?;
    verify_asset(&asset(release, "BUILD-INFO.json", MAX_META)?, build)?;
    let mut checksums = BTreeMap::new();
    for line in std::str::from_utf8(manifest)
        .map_err(|_| "校验清单编码无效")?
        .lines()
    {
        let (digest, name) = line.split_once("  ").ok_or("校验清单格式无效")?;
        require(
            hex(digest, 64)
                && checksums
                    .insert(name.to_owned(), digest.to_owned())
                    .is_none(),
            "校验清单无效或重复",
        )?;
    }
    let mut names = vec![
        installer_name.clone(),
        standalone,
        "BUILD-INFO.json".into(),
        "RELEASE-NOTES.md".into(),
    ];
    names.sort();
    require(
        checksums.keys().cloned().collect::<Vec<_>>() == names,
        "校验清单未覆盖预期附件",
    )?;
    require(
        checksums["BUILD-INFO.json"] == sha(build)
            && installer.digest.as_deref()
                == Some(format!("sha256:{}", checksums[&installer_name]).as_str()),
        "发布清单与附件摘要不一致",
    )?;
    let info: serde_json::Value = serde_json::from_slice(build).map_err(|_| "构建信息无效")?;
    require(
        info["product"] == "MD"
            && info["version"] == version
            && info["platform"] == "windows-x64"
            && info["expectedTag"] == release.tag_name
            && info["commit"].as_str().is_some_and(|value| hex(value, 40))
            && info["tree"].as_str().is_some_and(|value| hex(value, 40)),
        "构建信息与版本或平台不一致",
    )?;
    let payload = info["payload"].as_array().ok_or("缺少构建附件信息")?;
    let entries: Vec<_> = payload
        .iter()
        .filter(|item| item["name"] == installer_name)
        .collect();
    require(
        entries.len() == 1
            && entries[0]["bytes"].as_u64() == Some(installer.size)
            && entries[0]["sha256"].as_str() == Some(checksums[&installer_name].as_str()),
        "安装包与构建记录不一致",
    )?;
    Ok(Candidate {
        offer: Offer {
            version: version.into(),
            tag: release.tag_name.clone(),
            prerelease: release.prerelease || !Version::parse(version).unwrap().pre.is_empty(),
            release_url: release.html_url.clone(),
            notes: release
                .body
                .as_deref()
                .unwrap_or("此版本未提供发布说明。")
                .chars()
                .take(4000)
                .collect(),
            bytes: installer.size,
            sha256: checksums[&installer_name].clone(),
        },
        installer,
    })
}

#[derive(Serialize, Deserialize)]
struct Marker {
    app: String,
    instance: Uuid,
    id: Uuid,
}

/// 只拥有 root/temp 内随机子目录的三个固定文件；不使用递归删除，也不跟随重解析点。
pub struct Staging {
    pub directory: PathBuf,
    root: PathBuf,
    lock: Option<fs::File>,
    keep: bool,
}
impl Staging {
    pub fn create(root: &Path, bytes: u64) -> Result<Self, String> {
        let owner = storage::read_owner(root)?;
        storage::validate_local_path(&root.join("temp"))?;
        cleanup_stale(root)?;
        let used = storage::tree_bytes(&root.join("temp"), &|| false)?;
        require(
            bytes <= MAX_INSTALLER && used.saturating_add(bytes + MAX_META) <= TEMP_BUDGET,
            "应用临时空间不足，请先清理或迁移数据位置",
        )?;
        require(
            fs2::available_space(root).map_err(|e| e.to_string())? > bytes + 2 * 1024 * 1024,
            "数据所在磁盘空间不足",
        )?;
        let id = Uuid::new_v4();
        let directory = root.join("temp").join(format!("md-update-{id}"));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        let mut lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(directory.join("owner.json"))
            .map_err(|e| e.to_string())?;
        FileExt::try_lock_exclusive(&lock).map_err(|e| e.to_string())?;
        lock.write_all(
            &serde_json::to_vec(&Marker {
                app: "io.notesae.mdreader.update".into(),
                instance: owner.instance_id,
                id,
            })
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        lock.sync_all().map_err(|e| e.to_string())?;
        Ok(Self {
            directory,
            root: root.into(),
            lock: Some(lock),
            keep: false,
        })
    }
    pub fn part(&self) -> PathBuf {
        self.directory.join("installer.part")
    }
    pub fn installer(&self) -> PathBuf {
        self.directory.join("installer.exe")
    }
    pub fn keep(&mut self) {
        self.keep = true;
    }
}
impl Drop for Staging {
    fn drop(&mut self) {
        self.lock.take();
        if !self.keep {
            let _ = cleanup_directory(&self.root, &self.directory);
        }
    }
}

fn cleanup_directory(root: &Path, directory: &Path) -> Result<(), String> {
    storage::validate_local_path(directory)?;
    require(
        directory.parent() == Some(root.join("temp").as_path()),
        "更新暂存目录越界",
    )?;
    let name = directory
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("暂存名称无效")?;
    let id = Uuid::parse_str(name.strip_prefix("md-update-").ok_or("暂存名称无效")?)
        .map_err(|_| "暂存名称无效")?;
    let owner = storage::read_owner(root)?;
    storage::validate_local_path(&directory.join("owner.json"))?;
    let marker: Marker = storage::read_json(&directory.join("owner.json"), 4096)?;
    require(
        marker.app == "io.notesae.mdreader.update"
            && marker.instance == owner.instance_id
            && marker.id == id,
        "更新暂存归属不符",
    )?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(directory.join("owner.json"))
        .map_err(|e| e.to_string())?;
    FileExt::try_lock_exclusive(&lock).map_err(|_| "更新暂存仍被使用")?;
    let mut files = Vec::new();
    for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        storage::validate_local_path(&entry.path())?;
        require(
            entry.file_type().map_err(|e| e.to_string())?.is_file()
                && ["owner.json", "installer.part", "installer.exe"]
                    .iter()
                    .any(|name| entry.file_name() == *name),
            "更新暂存包含陌生内容，已保留",
        )?;
        if entry.file_name() != "owner.json" {
            files.push(entry.path());
        }
    }
    // 先删安装包；若仍被 Windows 安装程序占用，保留标记供下次识别，不扩大删除范围。
    for path in files {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    drop(lock);
    fs::remove_file(directory.join("owner.json")).map_err(|e| e.to_string())?;
    fs::remove_dir(directory).map_err(|e| e.to_string())
}

pub fn cleanup_stale(root: &Path) -> Result<(), String> {
    storage::validate_local_path(&root.join("temp"))?;
    for entry in fs::read_dir(root.join("temp")).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("md-update-"))
        {
            let _ = cleanup_directory(root, &entry.path());
        }
    }
    Ok(())
}

/// 安装前再验路径、长度和摘要；Windows 持有拒绝写入/删除的句柄直到进程成功启动。
pub fn verified_installer(stage: &Staging, offer: &Offer) -> Result<fs::File, String> {
    let path = stage.installer();
    storage::validate_local_path(&path)?;
    require(
        fs::symlink_metadata(&path)
            .map_err(|e| e.to_string())?
            .is_file(),
        "安装包不是普通文件",
    )?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    require(
        file.metadata().map_err(|e| e.to_string())?.len() == offer.bytes,
        "安装包大小已改变，请重新下载",
    )?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let count = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    require(
        format!("{:x}", digest.finalize()) == offer.sha256,
        "安装包校验失败，未运行，请重新下载",
    )?;
    file.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut header = [0; 2];
    file.read_exact(&mut header).map_err(|e| e.to_string())?;
    require(header == *b"MZ", "下载内容不是 Windows 安装包")?;
    Ok(file)
}
