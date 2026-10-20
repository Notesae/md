//! 匿名 HTTPS 更新状态机；网络与文件 IO 在后台执行，安装只由独立确认命令交接。
use crate::update::{self, Asset, Candidate, Channel, Offer, Release, Staging};
use reqwest::{Client, Response};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::watch;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub phase: String,
    pub job: u64,
    pub current_version: String,
    pub channel: Channel,
    pub offer: Option<Offer>,
    pub downloaded: u64,
    pub total: u64,
    pub message: String,
    pub retry_at: Option<u64>,
    pub can_install: bool,
}

struct State {
    view: Snapshot,
    candidate: Option<Candidate>,
    prepared: Option<Staging>,
    cancel: Option<watch::Sender<bool>>,
}

#[derive(Clone)]
pub struct UpdateService {
    state: Arc<Mutex<State>>,
    root: PathBuf,
    maintenance: Arc<Mutex<()>>,
}

#[derive(Debug)]
struct Failure {
    message: String,
    retry_at: Option<u64>,
}
impl From<String> for Failure {
    fn from(message: String) -> Self {
        Self {
            message,
            retry_at: None,
        }
    }
}
impl From<&str> for Failure {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
fn network(error: reqwest::Error) -> Failure {
    if error.is_timeout() {
        "连接超时，请检查网络后重试。".into()
    } else {
        "无法通过安全连接获取公开版本，请检查网络或稍后重试。".into()
    }
}

fn client() -> Result<Client, Failure> {
    Client::builder()
        .user_agent(concat!("MD/", env!("CARGO_PKG_VERSION"), " public-updater"))
        .https_only(true)
        .referer(false)
        .connect_timeout(Duration::from_secs(8))
        .read_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() < 5 && update::allowed_redirect(attempt.url()) {
                attempt.follow()
            } else {
                attempt.error("unsupported update redirect")
            }
        }))
        .build()
        .map_err(network)
}

async fn response(client: &Client, url: &str) -> Result<Response, Failure> {
    let response = client
        .get(url)
        .header("Accept", "application/octet-stream")
        .send()
        .await
        .map_err(network)?;
    checked_status(&response)?;
    Ok(response)
}

async fn bounded(mut response: Response, limit: u64) -> Result<Vec<u8>, Failure> {
    if response
        .content_length()
        .is_some_and(|length| length > limit)
    {
        return Err("公开版本响应超过允许大小，已停止。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(network)? {
        if bytes.len() as u64 + chunk.len() as u64 > limit {
            return Err("公开版本响应超过允许大小，已停止。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn metadata(client: &Client, asset: &Asset) -> Result<Vec<u8>, Failure> {
    let bytes = bounded(
        response(client, &asset.browser_download_url).await?,
        update::MAX_META,
    )
    .await?;
    update::verify_asset(asset, &bytes)?;
    Ok(bytes)
}

async fn check(channel: Channel) -> Result<Option<Candidate>, Failure> {
    let client = client()?;
    let releases = if channel == Channel::Stable {
        let reply = client
            .get("https://api.github.com/repos/Notesae/md/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(network)?;
        if reply.status().as_u16() == 404 {
            return Ok(None);
        }
        // 统一处理限流和状态，避免重复发出 API 请求。
        checked_status(&reply)?;
        vec![
            serde_json::from_slice::<Release>(&bounded(reply, 2 * 1024 * 1024).await?)
                .map_err(|_| Failure::from("公开版本信息格式无效。"))?,
        ]
    } else {
        let reply = client
            .get(update::RELEASES_API)
            .header("Accept", "application/vnd.github+json")
            .send()
            .await
            .map_err(network)?;
        checked_status(&reply)?;
        let values: Vec<Release> = serde_json::from_slice(&bounded(reply, 2 * 1024 * 1024).await?)
            .map_err(|_| Failure::from("公开版本列表格式无效。"))?;
        if values.len() >= 100 {
            return Err("版本列表超过检查范围，请先打开公开发布页确认。".into());
        }
        values
    };
    let Some(release) = update::select_release(releases, env!("CARGO_PKG_VERSION"), channel)?
    else {
        return Ok(None);
    };
    let manifest = metadata(
        &client,
        &update::asset(&release, "SHA256SUMS.txt", update::MAX_META)?,
    )
    .await?;
    let build = metadata(
        &client,
        &update::asset(&release, "BUILD-INFO.json", update::MAX_META)?,
    )
    .await?;
    Ok(Some(update::validate_candidate(
        &release, &manifest, &build,
    )?))
}

fn checked_status(reply: &Response) -> Result<(), Failure> {
    if reply.status().is_success() {
        return Ok(());
    }
    let status = reply.status().as_u16();
    let reset = reply
        .headers()
        .get("x-ratelimit-reset")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    if status == 403 || status == 429 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let retry = reply
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse::<u64>().ok())
            .map(|seconds| now.saturating_add(seconds));
        Err(Failure {
            message: "GitHub 暂时限制了匿名请求，请等待后重试，或打开公开发布页。".into(),
            retry_at: reset.or(retry),
        })
    } else {
        Err(format!("公开版本暂不可用（HTTP {status}），可稍后重试。").into())
    }
}

impl UpdateService {
    pub fn new(root: PathBuf, maintenance: Arc<Mutex<()>>) -> Self {
        Self {
            root,
            maintenance,
            state: Arc::new(Mutex::new(State {
                candidate: None,
                prepared: None,
                cancel: None,
                view: Snapshot {
                    phase: "idle".into(),
                    job: 0,
                    current_version: env!("CARGO_PKG_VERSION").into(),
                    channel: Channel::Stable,
                    offer: None,
                    downloaded: 0,
                    total: 0,
                    message: "尚未检查更新。".into(),
                    retry_at: None,
                    can_install: cfg!(all(windows, target_arch = "x86_64")),
                },
            })),
        }
    }
    pub fn snapshot(&self) -> Result<Snapshot, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "更新状态不可用")?
            .view
            .clone())
    }
    fn busy(state: &State) -> bool {
        matches!(
            state.view.phase.as_str(),
            "checking" | "downloading" | "verifying" | "cancelling" | "installing" | "handoff"
        )
    }

    /// 仅显式请求启动网络检查；任务编号与取消信号阻止过期响应覆盖当前状态。
    pub fn start_check(&self, channel: Channel) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
        if Self::busy(&state) {
            return Err("已有更新操作正在进行，请等待或取消。".into());
        }
        if state.view.retry_at.is_some_and(|time| {
            time > SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        }) {
            return Err("请等待 GitHub 提示的时间后再试。".into());
        }
        state.prepared.take();
        state.candidate = None;
        state.view.offer = None;
        state.view.job += 1;
        state.view.channel = channel;
        state.view.phase = "checking".into();
        state.view.message = "正在检查公开版本…".into();
        state.view.retry_at = None;
        state.view.downloaded = 0;
        state.view.total = 0;
        let job = state.view.job;
        let (cancel, mut receiver) = watch::channel(false);
        state.cancel = Some(cancel);
        let snapshot = state.view.clone();
        drop(state);
        let service = self.clone();
        tauri::async_runtime::spawn(async move {
            let cancelled = *receiver.borrow();
            let result = if cancelled {
                Err(Failure::from("已取消。"))
            } else {
                tokio::select! { biased; _ = receiver.changed() => Err(Failure::from("已取消。")), value = check(channel) => value }
            };
            let Ok(mut state) = service.state.lock() else {
                return;
            };
            if state.view.job != job {
                return;
            }
            state.cancel = None;
            if *receiver.borrow() {
                state.view.phase = "cancelled".into();
                state.view.message = "已取消检查。".into();
                return;
            }
            match result {
                Ok(Some(candidate)) => {
                    state.view.phase = "available".into();
                    state.view.message = "发现可用版本，尚未下载。".into();
                    state.view.total = candidate.offer.bytes;
                    state.view.offer = Some(candidate.offer.clone());
                    state.candidate = Some(candidate);
                }
                Ok(None) => {
                    state.view.phase = "current".into();
                    state.view.message = if channel == Channel::Stable {
                        "没有发现更新的稳定版。可选择预发布通道查看测试版本。"
                    } else {
                        "最近的公开版本中没有比当前更新的版本。"
                    }
                    .into();
                }
                Err(error) => {
                    state.view.phase = "error".into();
                    state.view.message = error.message;
                    state.view.retry_at = error.retry_at;
                }
            }
        });
        Ok(snapshot)
    }

    /// 停止在途请求，或丢弃已准备的受控下载；已交给安装器的任务不能撤回。
    pub fn cancel(&self) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
        if matches!(state.view.phase.as_str(), "installing" | "handoff") {
            return Err("安装交接已开始，请在安装向导中操作。".into());
        }
        if let Some(cancel) = &state.cancel {
            cancel.send_replace(true);
            state.view.phase = "cancelling".into();
            state.view.message = "正在停止，未完成的下载将被清理…".into();
        } else {
            state.prepared.take();
            state.candidate = None;
            state.view.offer = None;
            state.view.downloaded = 0;
            state.view.total = 0;
            state.view.phase = "cancelled".into();
            state.view.message = "已丢弃下载，当前应用未改变。".into();
        }
        Ok(state.view.clone())
    }

    /// 使用后台已核验的候选；持有维护锁直至下载结束，不接受前端 URL 或路径。
    pub fn start_download(&self) -> Result<Snapshot, String> {
        let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
        if !state.view.can_install {
            return Err("应用内安装目前仅支持 Windows x64。".into());
        }
        if Self::busy(&state) || state.prepared.is_some() {
            return Err("已有更新操作或已下载的安装包，请先取消或丢弃。".into());
        }
        let candidate = state.candidate.clone().ok_or("请先检查更新")?;
        state.view.job += 1;
        let job = state.view.job;
        state.view.phase = "downloading".into();
        state.view.downloaded = 0;
        state.view.message = "正在下载安装包，阅读可以继续。".into();
        state.view.retry_at = None;
        let (cancel, mut receiver) = watch::channel(false);
        state.cancel = Some(cancel);
        let snapshot = state.view.clone();
        drop(state);
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let result: Result<Staging, Failure> = (|| {
                let _maintenance = service
                    .maintenance
                    .try_lock()
                    .map_err(|_| Failure::from("正在维护存储，请稍后再下载。"))?;
                tauri::async_runtime::block_on(async {
                    if *receiver.borrow() {
                        return Err("已取消。".into());
                    }
                    tokio::select! { biased; _ = receiver.changed() => Err(Failure::from("已取消。")), value = service.download(&candidate, job) => value }
                })
            })();
            let Ok(mut state) = service.state.lock() else {
                return;
            };
            if state.view.job != job {
                return;
            }
            state.cancel = None;
            if *receiver.borrow() {
                drop(result);
                state.view.phase = "cancelled".into();
                state.view.message = "下载已取消，当前应用未改变。".into();
                return;
            }
            match result {
                Ok(stage) => {
                    state.prepared = Some(stage);
                    state.view.phase = "ready".into();
                    state.view.message = "下载和 SHA-256 校验已完成，尚未安装。".into();
                }
                Err(error) => {
                    state.view.phase = "error".into();
                    state.view.message = error.message;
                    state.view.retry_at = error.retry_at;
                }
            }
        });
        Ok(snapshot)
    }

    async fn download(&self, candidate: &Candidate, job: u64) -> Result<Staging, Failure> {
        let reply = response(&client()?, &candidate.installer.browser_download_url).await?;
        self.receive(candidate, job, reply).await
    }

    /// 流式写入受控暂存，长度和摘要都通过后才改名；取消或失败会丢弃未完成暂存。
    async fn receive(
        &self,
        candidate: &Candidate,
        job: u64,
        mut reply: Response,
    ) -> Result<Staging, Failure> {
        let stage = Staging::create(&self.root, candidate.offer.bytes)?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(stage.part())
            .map_err(|_| Failure::from("无法在应用数据目录创建暂存文件。"))?;
        if reply
            .content_length()
            .is_some_and(|length| length != candidate.offer.bytes)
        {
            return Err("安装包长度已改变，请重新检查版本。".into());
        }
        let mut downloaded = 0u64;
        let mut digest = Sha256::new();
        while let Some(chunk) = reply.chunk().await.map_err(network)? {
            downloaded += chunk.len() as u64;
            if downloaded > candidate.offer.bytes {
                return Err("下载大小超过发布记录，已停止。".into());
            }
            file.write_all(&chunk)
                .map_err(|_| Failure::from("安装包写入失败，请检查数据盘空间。"))?;
            digest.update(&chunk);
            if let Ok(mut state) = self.state.lock() {
                if state.view.job == job {
                    state.view.downloaded = downloaded;
                }
            }
        }
        if let Ok(mut state) = self.state.lock() {
            if state.view.job == job && state.view.phase != "cancelling" {
                state.view.phase = "verifying".into();
                state.view.message = "正在核对下载完整性…".into();
            }
        }
        if downloaded != candidate.offer.bytes
            || format!("{:x}", digest.finalize()) != candidate.offer.sha256
        {
            return Err("安装包不完整或 SHA-256 不一致，未运行安装程序。".into());
        }
        file.sync_all()
            .map_err(|_| Failure::from("安装包同步到磁盘失败，请重试。"))?;
        drop(file);
        fs::rename(stage.part(), stage.installer())
            .map_err(|_| Failure::from("无法提交已校验的安装包。"))?;
        update::verified_installer(&stage, &candidate.offer)?;
        Ok(stage)
    }

    /// 先重验包并保存必要状态；启动失败保留下载，成功才允许桌面层退出应用。
    pub fn install_with(
        &self,
        before: impl FnOnce() -> Result<(), String>,
        launch: impl FnOnce(&Path) -> Result<(), String>,
    ) -> Result<(), String> {
        let _maintenance = self
            .maintenance
            .try_lock()
            .map_err(|_| "正在维护存储，暂不能安装。")?;
        let mut state = self.state.lock().map_err(|_| "更新状态不可用")?;
        if state.view.phase != "ready" {
            return Err("安装包尚未准备好，请重新检查或下载。".into());
        }
        let mut stage = state.prepared.take().ok_or("安装包尚未准备好")?;
        let offer = state.view.offer.clone().ok_or("缺少版本信息")?;
        let verified = match update::verified_installer(&stage, &offer) {
            Ok(file) => file,
            Err(error) => {
                state.view.phase = "error".into();
                state.view.message = error.clone();
                return Err(error);
            }
        };
        if let Err(error) = before().and_then(|_| launch(&stage.installer())) {
            state.prepared = Some(stage);
            state.view.message = "安装程序未启动，当前应用和已下载的包均已保留。".into();
            return Err(error);
        }
        drop(verified);
        stage.keep();
        state.view.phase = "handoff".into();
        state.view.message = "安装程序已打开，MD 即将退出。".into();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{cell::Cell, io::Read, net::TcpListener, sync::mpsc, thread};

    const PACKAGE: &[u8] = b"MZ isolated test package, never executed";

    // HTTP 仅用于测试本机字节流；产品 client() 的 HTTPS、证书和来源限制保持不变。
    async fn fake_reply(
        bytes: &[u8],
        length: Option<usize>,
        hold_open: bool,
    ) -> (Response, mpsc::Sender<()>, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let bytes = bytes.to_vec();
        let (release, wait) = mpsc::channel();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut request = Vec::new();
            while !request.ends_with(b"\r\n\r\n") {
                let mut part = [0u8; 512];
                let count = stream.read(&mut part).unwrap();
                assert!(count > 0 && request.len() + count <= 8192);
                request.extend_from_slice(&part[..count]);
            }
            let length = length
                .map(|value| format!("Content-Length: {value}\r\n"))
                .unwrap_or_default();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\n{length}Connection: close\r\n\r\n"
            )
            .unwrap();
            stream.write_all(&bytes).unwrap();
            stream.flush().unwrap();
            if hold_open {
                let _ = wait.recv_timeout(Duration::from_secs(3));
            }
        });
        let reply = Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(4))
            .build()
            .unwrap()
            .get(format!("http://{address}/isolated-fixture"))
            .send()
            .await
            .unwrap();
        (reply, release, worker)
    }

    fn candidate(service: &UpdateService) -> Candidate {
        let offer = service.snapshot().unwrap().offer.unwrap();
        Candidate {
            installer: Asset {
                name: "MD_0.1.3_x64-setup.exe".into(),
                size: offer.bytes,
                browser_download_url:
                    "https://github.com/Notesae/md/releases/download/v0.1.3/MD_0.1.3_x64-setup.exe"
                        .into(),
                digest: Some(format!("sha256:{}", offer.sha256)),
                state: "uploaded".into(),
            },
            offer,
        }
    }

    fn ready() -> (tempfile::TempDir, UpdateService) {
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("MdReader");
        crate::storage::initialize_root(&root).unwrap();
        let service = UpdateService::new(root.clone(), Arc::new(Mutex::new(())));
        let bytes = PACKAGE;
        let stage = Staging::create(&root, bytes.len() as u64).unwrap();
        fs::write(stage.installer(), bytes).unwrap();
        let mut state = service.state.lock().unwrap();
        state.view.phase = "ready".into();
        state.view.offer = Some(Offer {
            version: "0.1.3".into(),
            tag: "v0.1.3".into(),
            prerelease: true,
            release_url: "https://github.com/Notesae/md/releases/tag/v0.1.3".into(),
            notes: String::new(),
            bytes: bytes.len() as u64,
            sha256: update::sha(bytes),
        });
        state.prepared = Some(stage);
        drop(state);
        (base, service)
    }

    #[test]
    fn streamed_bytes_progress_and_integrity_failures_never_prepare_partial_packages() {
        tauri::async_runtime::block_on(async {
            for kind in ["valid", "corrupt", "truncated", "oversized"] {
                let (_base, service) = ready();
                let candidate = candidate(&service);
                service.state.lock().unwrap().prepared.take();
                let bytes = match kind {
                    "corrupt" => vec![b'x'; PACKAGE.len()],
                    "truncated" => PACKAGE[..PACKAGE.len() / 2].to_vec(),
                    "oversized" => [PACKAGE, b"extra"].concat(),
                    _ => PACKAGE.to_vec(),
                };
                let (reply, release, worker) = fake_reply(
                    &bytes,
                    if kind == "oversized" {
                        None
                    } else {
                        Some(PACKAGE.len())
                    },
                    false,
                )
                .await;
                let result = service.receive(&candidate, 0, reply).await;
                drop(release);
                worker.join().unwrap();
                if kind == "valid" {
                    let stage = result.unwrap();
                    assert_eq!(service.snapshot().unwrap().downloaded, PACKAGE.len() as u64);
                    assert!(update::verified_installer(&stage, &candidate.offer).is_ok());
                    drop(stage);
                } else {
                    assert!(result.is_err(), "{kind}");
                }
                assert_eq!(
                    fs::read_dir(service.root.join("temp")).unwrap().count(),
                    0,
                    "{kind}"
                );
            }
        });
    }

    #[test]
    fn cancelling_a_pending_body_drops_the_partial_file_and_owned_marker() {
        tauri::async_runtime::block_on(async {
            let (_base, service) = ready();
            let candidate = candidate(&service);
            service.state.lock().unwrap().prepared.take();
            let (reply, release, worker) =
                fake_reply(&PACKAGE[..8], Some(PACKAGE.len()), true).await;
            // 与后台取消分支相同，丢弃尚在等待下一段数据的接收 future。
            {
                let receiving = service.receive(&candidate, 0, reply);
                tokio::pin!(receiving);
                tokio::time::timeout(Duration::from_secs(2), async {
                    tokio::select! {
                        _ = &mut receiving => panic!("partial stream completed before cancellation"),
                        _ = async {
                            while service.snapshot().unwrap().downloaded == 0 {
                                tokio::time::sleep(Duration::from_millis(5)).await;
                            }
                        } => {}
                    }
                }).await.unwrap();
                assert_eq!(service.snapshot().unwrap().downloaded, 8);
            }
            drop(release);
            worker.join().unwrap();
            assert_eq!(fs::read_dir(service.root.join("temp")).unwrap().count(), 0);
        });
    }

    #[test]
    fn saving_or_launch_failure_keeps_the_application_and_verified_package_ready() {
        let (_base, service) = ready();
        let launched = Cell::new(0);
        assert!(service
            .install_with(
                || Err("save failed".into()),
                |_| {
                    launched.set(launched.get() + 1);
                    Ok(())
                }
            )
            .is_err());
        assert_eq!(launched.get(), 0);
        assert_eq!(service.snapshot().unwrap().phase, "ready");
        assert!(service
            .install_with(|| Ok(()), |_| Err("fake launch failure".into()))
            .is_err());
        assert_eq!(service.snapshot().unwrap().phase, "ready");
        assert!(service
            .state
            .lock()
            .unwrap()
            .prepared
            .as_ref()
            .unwrap()
            .installer()
            .exists());
    }

    #[test]
    fn altered_package_never_reaches_save_or_launch_and_success_requires_explicit_handoff() {
        let (_base, service) = ready();
        let saved = Cell::new(false);
        let launched = Cell::new(false);
        let path = service
            .state
            .lock()
            .unwrap()
            .prepared
            .as_ref()
            .unwrap()
            .installer();
        fs::write(path, b"changed").unwrap();
        assert!(service
            .install_with(
                || {
                    saved.set(true);
                    Ok(())
                },
                |_| {
                    launched.set(true);
                    Ok(())
                }
            )
            .is_err());
        assert!(!saved.get() && !launched.get());
        assert_eq!(service.snapshot().unwrap().phase, "error");
        let (_base2, other) = ready();
        assert!(other
            .install_with(
                || Ok(()),
                |_| {
                    launched.set(true);
                    Ok(())
                }
            )
            .is_ok());
        assert!(launched.get());
        assert_eq!(other.snapshot().unwrap().phase, "handoff");
        assert!(other.cancel().is_err());
    }
}
