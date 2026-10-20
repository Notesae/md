use md_reader::{
    storage,
    update::{self, Channel, Release, Staging},
};
use serde_json::json;
use std::fs;

fn release(tag: &str, preview: bool) -> Release {
    serde_json::from_value(json!({"id": 1,"tag_name":tag,"prerelease":preview,"draft":false,
        "html_url":format!("https://github.com/Notesae/md/releases/tag/{tag}"),"body":"说明","assets":[]})).unwrap()
}

fn fixture() -> (Release, Vec<u8>, Vec<u8>) {
    let installer = b"MZ isolated installer fixture, never executed";
    let build = serde_json::to_vec(&json!({"product":"MD","version":"0.1.3","platform":"windows-x64","expectedTag":"v0.1.3",
        "commit":"a".repeat(40),"tree":"b".repeat(40),"payload":[{"name":"MD_0.1.3_x64-setup.exe","bytes":installer.len(),"sha256":update::sha(installer)}]})).unwrap();
    let mut lines = vec![
        ("BUILD-INFO.json", update::sha(&build)),
        ("MD_0.1.3_x64-setup.exe", update::sha(installer)),
        ("MD_0.1.3_x64-standalone.zip", "c".repeat(64)),
        ("RELEASE-NOTES.md", "d".repeat(64)),
    ];
    lines.sort_by_key(|item| item.0);
    let manifest = lines
        .iter()
        .map(|(name, digest)| format!("{digest}  {name}\n"))
        .collect::<String>()
        .into_bytes();
    let assets = [("BUILD-INFO.json", build.as_slice()), ("SHA256SUMS.txt", manifest.as_slice()), ("MD_0.1.3_x64-setup.exe", installer.as_slice())].into_iter().map(|(name,data)| json!({"name":name,"size":data.len(),"state":"uploaded","digest":format!("sha256:{}",update::sha(data)),"browser_download_url":format!("https://github.com/Notesae/md/releases/download/v0.1.3/{name}")})).collect::<Vec<_>>();
    let mut release = release("v0.1.3", true);
    release.assets = serde_json::from_value(json!(assets)).unwrap();
    (release, manifest, build)
}

#[test]
fn channel_policy_uses_semver_and_never_downgrades_or_updates_only_build_metadata() {
    let versions = vec![
        release("v0.2.0-beta.1", true),
        release("v0.1.9", false),
        release("v0.1.10", false),
    ];
    assert_eq!(
        update::select_release(versions.clone(), "0.1.2", Channel::Stable)
            .unwrap()
            .unwrap()
            .tag_name,
        "v0.1.10"
    );
    assert_eq!(
        update::select_release(versions, "0.1.2", Channel::Preview)
            .unwrap()
            .unwrap()
            .tag_name,
        "v0.2.0-beta.1"
    );
    assert!(update::select_release(
        vec![release("v0.1.2+new", false), release("v0.1.1", false)],
        "0.1.2",
        Channel::Preview
    )
    .unwrap()
    .is_none());
    assert!(update::select_release(
        vec![release("v0.3.0-beta.1", false)],
        "0.1.2",
        Channel::Stable
    )
    .unwrap()
    .is_none());
}

#[test]
fn only_this_repository_and_known_https_redirect_hosts_are_accepted() {
    let mut other = release("v0.1.3", false);
    other.html_url = "https://github.com/other/md/releases/tag/v0.1.3".into();
    assert!(update::select_release(vec![other], "0.1.2", Channel::Stable).is_err());
    for url in [
        "http://github.com/a",
        "https://github.com.evil.test/a",
        "https://user@github.com/a",
        "https://github.com:444/a",
        "https://raw.githubusercontent.com/other/file",
        "https://127.0.0.1/a",
    ] {
        assert!(!update::allowed_redirect(&url.parse().unwrap()), "{url}");
    }
    assert!(update::allowed_redirect(
        &"https://release-assets.githubusercontent.com/allowed?signed=temporary"
            .parse()
            .unwrap()
    ));
    let (mut release, _, _) = fixture();
    release.assets[0].browser_download_url = "https://github.com/other/md/file".into();
    assert!(update::asset(&release, "BUILD-INFO.json", update::MAX_META).is_err());
}

#[test]
fn source_digest_manifest_and_build_record_must_all_match() {
    let (release, manifest, build) = fixture();
    let candidate = update::validate_candidate(&release, &manifest, &build).unwrap();
    assert_eq!(candidate.offer.version, "0.1.3");
    let mut corrupted = build.clone();
    corrupted.push(b' ');
    assert!(update::validate_candidate(&release, &manifest, &corrupted).is_err());
    let mut wrong = release.clone();
    wrong
        .assets
        .iter_mut()
        .find(|item| item.name.ends_with("setup.exe"))
        .unwrap()
        .digest = Some(format!("sha256:{}", "f".repeat(64)));
    assert!(update::validate_candidate(&wrong, &manifest, &build).is_err());
    let mut duplicate = release.clone();
    duplicate.assets.push(release.assets[0].clone());
    assert!(update::validate_candidate(&duplicate, &manifest, &build).is_err());
    let mut missing = release.clone();
    missing.assets[0].digest = None;
    assert!(update::validate_candidate(&missing, &manifest, &build).is_err());
    let mut huge = release.clone();
    huge.assets
        .iter_mut()
        .find(|item| item.name.ends_with("setup.exe"))
        .unwrap()
        .size = update::MAX_INSTALLER + 1;
    assert!(update::validate_candidate(&huge, &manifest, &build).is_err());
}

#[test]
fn staged_installer_is_rechecked_and_cancel_cleans_only_owned_files() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("MdReader");
    storage::initialize_root(&root).unwrap();
    let (release, manifest, build) = fixture();
    let candidate = update::validate_candidate(&release, &manifest, &build).unwrap();
    let stage = Staging::create(&root, candidate.offer.bytes).unwrap();
    let path = stage.installer();
    fs::write(&path, b"MZ isolated installer fixture, never executed").unwrap();
    assert!(update::verified_installer(&stage, &candidate.offer).is_ok());
    fs::write(&path, b"MZ changed").unwrap();
    assert!(update::verified_installer(&stage, &candidate.offer).is_err());
    let directory = stage.directory.clone();
    drop(stage);
    assert!(!directory.exists());
    assert!(root.join("owner.json").exists());
    assert!(root.join("state").exists());
}

#[test]
fn unknown_staging_content_is_preserved_and_live_stage_is_not_cleaned() {
    let base = tempfile::tempdir().unwrap();
    let root = base.path().join("MdReader");
    storage::initialize_root(&root).unwrap();
    let stage = Staging::create(&root, 16).unwrap();
    let directory = stage.directory.clone();
    fs::write(stage.part(), b"partial").unwrap();
    update::cleanup_stale(&root).unwrap();
    assert!(stage.part().exists());
    fs::write(directory.join("user-document.md"), b"must preserve").unwrap();
    drop(stage);
    assert!(directory.join("user-document.md").exists());
    assert!(directory.join("installer.part").exists());
}
