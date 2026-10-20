"""手动指定 tag 与成功 CI；只发布该 CI 原始资产，不构建、不改标签、不创建凭据。"""

import argparse
import base64
from dataclasses import asdict, dataclass
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import zipfile

REPO = 'Notesae/md'
REPO_ID = 1425132652
LIMIT = 512 * 1024 * 1024
HEX = re.compile(r'[0-9a-f]{40}')
DIGEST = re.compile(r'[0-9a-f]{64}')


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inputs(tag, run_id):
    require(re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)', tag or '') is not None,
            'Tag must be an existing vMAJOR.MINOR.PATCH tag')
    require(re.fullmatch(r'[1-9][0-9]{0,19}', str(run_id or '')) is not None, 'CI run ID must be a positive decimal integer')
    return tag[1:], int(run_id)


@dataclass(frozen=True)
class Target:
    tag: str
    version: str
    run: int
    commit: str
    tree: str
    attempt: int
    artifact_id: int
    archive_bytes: int
    archive_sha: str

    @property
    def ci_url(self):
        return f'https://github.com/{REPO}/actions/runs/{self.run}'

    @property
    def names(self):
        return {'BUILD-INFO.json', 'RELEASE-NOTES.md', 'SHA256SUMS.txt',
                f'MD_{self.version}_x64-setup.exe', f'MD_{self.version}_x64-standalone.zip'}


def resolve_tag(client, tag):
    value = client.api(f'repos/{REPO}/git/ref/tags/{tag}')
    require(value['ref'] == f'refs/tags/{tag}', 'Tag ref differs')
    value = value['object']
    # 同时接受轻量与注解标签，最多解引用五层；不创建或移动标签。
    for _ in range(5):
        require(HEX.fullmatch(value['sha']) is not None, 'Invalid tag SHA')
        if value['type'] == 'commit':
            return value['sha']
        require(value['type'] == 'tag', 'Tag must resolve to a commit')
        value = client.api(f'repos/{REPO}/git/tags/{value["sha"]}')['object']
    raise ReleaseError('Tag nesting exceeds the supported limit')


def source(client, tag, run_id):
    """只接受同仓库 main 的成功 Quality push 构建，精确匹配 tag、版本、树与原始归档。"""
    version, run_id = inputs(tag, run_id)
    repo = client.api(f'repos/{REPO}')
    require(repo['full_name'] == REPO and repo['id'] == REPO_ID and repo['private'] is False, 'Expected the public MD repository')
    commit = resolve_tag(client, tag)
    run = client.api(f'repos/{REPO}/actions/runs/{run_id}')
    require((run['id'], run['head_sha'], run['head_branch'], run['event'], run['status'], run['conclusion'], run['path'])
            == (run_id, commit, 'main', 'push', 'completed', 'success', '.github/workflows/check.yml')
            and run['repository']['id'] == REPO_ID and run['head_repository']['id'] == REPO_ID
            and isinstance(run['run_attempt'], int) and run['run_attempt'] > 0, 'Tag and trusted successful CI do not match')
    git = client.api(f'repos/{REPO}/git/commits/{commit}')
    require(git['sha'] == commit and HEX.fullmatch(git['tree']['sha']) is not None, 'Source commit/tree differs')
    for path in ('package.json', 'src-tauri/tauri.conf.json'):
        content = client.api(f'repos/{REPO}/contents/{path}?ref={commit}')
        require(content['encoding'] == 'base64' and content['size'] < 65536, 'Unexpected source metadata encoding/size')
        data = json.loads(base64.b64decode(content['content']))
        require(data['version'] == version, 'Tag differs from source package/Tauri version')
    listing = client.api(f'repos/{REPO}/actions/runs/{run_id}/artifacts?per_page=100')
    require(listing['total_count'] <= 100 and len(listing['artifacts']) == listing['total_count'], 'Artifact collection requires manual review')
    name = f'md-windows-{commit}-{run["run_attempt"]}'
    matches = [item for item in listing['artifacts'] if item['name'] == name]
    require(len(matches) == 1, 'Expected one exact CI archive')
    item = matches[0]
    require(item['expired'] is False and 0 < item['size_in_bytes'] <= LIMIT
            and re.fullmatch(r'sha256:[0-9a-f]{64}', item['digest'] or '') is not None, 'CI archive expired or digest/size unavailable')
    origin = item['workflow_run']
    require((origin['id'], origin['head_sha'], origin['head_branch'], origin['repository_id'], origin['head_repository_id'])
            == (run_id, commit, 'main', REPO_ID, REPO_ID), 'Artifact does not belong to the exact trusted CI')
    return Target(tag, version, run_id, commit, git['tree']['sha'], run['run_attempt'], item['id'], item['size_in_bytes'], item['digest'][7:])


def verify_bundle(target, files):
    """清单覆盖四个文件；第五个清单自身的完整性由原始 CI 归档哈希固定。"""
    require(set(files) == target.names and all(0 < len(value) <= LIMIT for value in files.values()), 'Expected exactly five bounded release files')
    manifest = {}
    for line in files['SHA256SUMS.txt'].decode('ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_.-]+)', line)
        require(match is not None, 'Invalid checksum manifest entry')
        digest, name = match.groups()
        require(name not in manifest, 'Duplicate checksum manifest entry')
        manifest[name] = digest
    require(set(manifest) == target.names - {'SHA256SUMS.txt'}, 'Checksum coverage differs')
    require(all(sha(files[name]) == digest for name, digest in manifest.items()), 'Checksum mismatch')
    info = json.loads(files['BUILD-INFO.json'])
    require((info['product'], info['version'], info['platform'], info['commit'], info['tree'], info['expectedTag'])
            == ('MD', target.version, 'windows-x64', target.commit, target.tree, target.tag), 'Build provenance mismatch')
    workflow = info['workflow']
    require((workflow['url'], str(workflow['attempt']), workflow['event'], workflow['ref'])
            == (target.ci_url, str(target.attempt), 'push', 'refs/heads/main'), 'Build workflow mismatch')
    audit = info['installerAudit']
    require(audit['result'] == 'observed' and audit['restoredRegistry'] is True
            and audit['specPassed'] is False and len(audit['paths']) == 4, 'Installer audit boundary changed')
    require(info['nativeAcceptanceEstablished'] is False and info['privateInAppUpdateValidated'] is False,
            'Unverified native/updater acceptance must remain false')
    payload = info['payload']
    require(len(payload) == 3 and {item['name'] for item in payload}
            == target.names - {'BUILD-INFO.json', 'SHA256SUMS.txt'}, 'Build payload differs')
    require(all((item['bytes'], item['sha256']) == (len(files[item['name']]), sha(files[item['name']])) for item in payload), 'Build payload bytes/hash differ')
    executable = info['executable']
    require(executable['name'] == 'md-reader.exe' and executable['productVersion'] in (target.version, target.version + '.0')
            and 0 < executable['bytes'] <= LIMIT and DIGEST.fullmatch(executable['sha256']) is not None, 'Executable provenance differs')
    with zipfile.ZipFile(io.BytesIO(files[f'MD_{target.version}_x64-standalone.zip'])) as archive:
        entries = archive.infolist()
        require(len(entries) == 2 and {item.filename for item in entries} == {'md-reader.exe', 'README.txt'}, 'Standalone entries differ')
        for item in entries:
            require(not item.flag_bits & 1 and not stat.S_ISLNK(item.external_attr >> 16), 'Unsafe standalone entry')
        require(archive.getinfo('md-reader.exe').file_size == executable['bytes']
                and 0 < archive.getinfo('README.txt').file_size < 16384, 'Standalone size differs')
        require(sha(archive.read('md-reader.exe')) == executable['sha256'], 'Standalone executable differs')
    notes = files['RELEASE-NOTES.md'].decode('utf-8')
    require(all(value in notes for value in (target.commit, target.tree, target.ci_url)), 'Release notes provenance missing')
    return info


def read_archive(target, path):
    require(path.stat().st_size == target.archive_bytes, 'Original CI archive digest differs')
    data = path.read_bytes()
    require(sha(data) == target.archive_sha, 'Original CI archive digest differs')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) == 5 and {item.filename for item in entries} == target.names, 'CI archive entries differ')
        require(sum(item.file_size for item in entries) <= LIMIT, 'Uncompressed CI archive exceeds limit')
        for item in entries:
            require(0 < item.file_size <= LIMIT and not item.flag_bits & 1
                    and not stat.S_ISLNK(item.external_attr >> 16), 'Unsafe CI archive entry')
        files = {item.filename: archive.read(item) for item in entries}
    verify_bundle(target, files)
    return files


def validate_context(env):
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == REPO
            and env.get('GITHUB_REPOSITORY_ID') == str(REPO_ID) and env.get('GITHUB_REF') == 'refs/heads/main'
            and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Only manual dispatch on this repository main is allowed')


class GitHub:
    """使用 runner 标准 gh 与该 job 短期令牌；不读取令牌值、不登录或导出认证。"""
    def command(self, args, *, body=None, destination=None):
        try:
            result = subprocess.run(['gh', *args], input=body, stdout=destination if destination else subprocess.PIPE,
                                    stderr=subprocess.PIPE, timeout=180, check=False)
        except subprocess.TimeoutExpired:
            raise ReleaseError('GitHub request timed out; inspect remote state before retry') from None
        # stderr 可能含临时重定向 URL，禁止回显，也不自动重试写请求。
        require(result.returncode == 0, f'GitHub command failed (exit {result.returncode}); inspect state before retry')
        return result.stdout

    def api(self, resource, method='GET', body=None):
        require(resource == f'repos/{REPO}' or resource.startswith(f'repos/{REPO}/'), 'API outside this repository')
        args = ['api', '--hostname', 'github.com', '--method', method, resource]
        if body is not None:
            args += ['--input', '-']
        response = self.command(args, body=json.dumps(body).encode('utf-8') if body is not None else None)
        try:
            return json.loads(response)
        except (ValueError, UnicodeError):
            raise ReleaseError('GitHub response incomplete; inspect state before retry') from None

    def download(self, resource, path, asset=False):
        require(resource.startswith(f'repos/{REPO}/'), 'Download outside this repository')
        args = ['api', '--hostname', 'github.com', '--method', 'GET', resource]
        if asset:
            args += ['-H', 'Accept: application/octet-stream']
        with path.open('xb') as stream:
            self.command(args, destination=stream)

    def upload(self, target, path):
        self.command(['release', 'upload', target.tag, str(path), '--repo', REPO])


def all_releases(client):
    result = []
    for page in range(1, 101):
        values = client.api(f'repos/{REPO}/releases?per_page=100&page={page}')
        result.extend(values)
        if len(values) < 100:
            return result
    raise ReleaseError('Release collection requires manual review')


def find_release(client, target):
    matches = [item for item in all_releases(client) if item['tag_name'] == target.tag]
    require(len(matches) <= 1, 'Duplicate Release records require review')
    return matches[0] if matches else None


def previous_releases(client, target):
    return {item['id']: item for item in all_releases(client) if item['tag_name'] != target.tag}


def validate_release(target, release, files):
    require(release is not None, 'Expected Release disappeared; inspect state')
    require(release['tag_name'] == target.tag and release['target_commitish'] == target.commit and release['prerelease'] is True
            and release['body'].replace('\r\n', '\n') == files['RELEASE-NOTES.md'].decode('utf-8').replace('\r\n', '\n'),
            'Existing Release provenance/body differs; refusing overwrite')
    names = [item['name'] for item in release['assets']]
    require(len(names) == len(set(names)) and set(names) <= target.names, 'Unexpected or duplicate Release assets')
    for item in release['assets']:
        data = files[item['name']]
        require(item['size'] == len(data) and item['state'] == 'uploaded'
                and item.get('digest') in (None, f'sha256:{sha(data)}'), 'Existing Release asset metadata differs')


def download_assets(client, release, directory, expected):
    directory.mkdir()
    files = {}
    for item in release['assets']:
        path = directory / item['name']
        client.download(f'repos/{REPO}/releases/assets/{item["id"]}', path, asset=True)
        require(path.stat().st_size == len(expected[item['name']]), 'Release asset bytes differ from CI')
        files[item['name']] = path.read_bytes()
        require(sha(files[item['name']]) == sha(expected[item['name']]), 'Release asset bytes differ from CI')
    return files


def publish(client, target, files, output):
    verify_bundle(target, files)
    notes = files['RELEASE-NOTES.md'].decode('utf-8')
    old = previous_releases(client, target)

    def record(stage, release=None):
        state = {'stage': stage, **asdict(target), 'releaseId': release['id'] if release else None,
                 'releasePublished': bool(release and not release['draft'])}
        (output / 'publication-state.json').write_text(json.dumps(state, indent=2), encoding='utf-8')

    def guard():
        require(source(client, target.tag, target.run) == target, 'Source/tag/artifact changed before mutation')

    guard()
    release = find_release(client, target)
    if release is None:
        record('creating draft; inspect state if interrupted')
        try:
            release = client.api(f'repos/{REPO}/releases', 'POST', {
                'tag_name': target.tag, 'target_commitish': target.commit, 'name': f'MD {target.version} prerelease',
                'body': notes, 'draft': True, 'prerelease': True, 'make_latest': 'false'})
        except ReleaseError:
            release = find_release(client, target)
            require(release is not None, 'Draft absent or uncertain after state read; no automatic POST retry')
    validate_release(target, release, files)
    record('draft found or created', release)
    if release['assets']:
        download_assets(client, release, output / 'existing-assets', files)
    if not release['draft']:
        require(len(release['assets']) == 5, 'Published Release incomplete; refusing to mutate it')
    else:
        for name in sorted(target.names):
            guard()
            release = find_release(client, target)
            validate_release(target, release, files)
            require(release['draft'], 'Draft state changed before upload')
            if name in {item['name'] for item in release['assets']}:
                continue
            record(f'uploading {name}; inspect state if interrupted', release)
            try:
                client.upload(target, output / 'source-assets' / name)
            except ReleaseError:
                release = find_release(client, target)
                validate_release(target, release, files)
                require(name in {item['name'] for item in release['assets']}, 'Upload absent or uncertain after state read; no automatic upload retry')
        release = find_release(client, target)
        validate_release(target, release, files)
        require(release['draft'] and len(release['assets']) == 5, 'Expected draft with exactly five assets')
        verify_bundle(target, download_assets(client, release, output / 'draft-roundtrip', files))
        guard()
        record('publishing verified draft; inspect state if interrupted', release)
        try:
            client.api(f'repos/{REPO}/releases/{release["id"]}', 'PATCH', {'draft': False, 'prerelease': True, 'make_latest': 'false'})
        except ReleaseError:
            release = find_release(client, target)
            require(release is not None and not release['draft'], 'Publication absent or uncertain after state read; no automatic PATCH retry')
    release = find_release(client, target)
    require(release is not None and not release['draft'] and release['published_at'], 'Publication not confirmed')
    validate_release(target, release, files)
    verify_bundle(target, download_assets(client, release, output / 'published-roundtrip', files))
    guard()
    require(previous_releases(client, target) == old, 'Prior Release metadata changed; review required')
    record('published; five fresh downloads verified; old releases unchanged', release)
    result = {**asdict(target), 'repository': REPO, 'private': False, 'sourceCi': target.ci_url,
              'releaseId': release['id'], 'url': release['html_url'], 'prerelease': True,
              'releasePublished': True, 'postPublicationReDownload': True, 'allAssetsMatch': True,
              'previousReleaseIdsPreserved': sorted(old), 'nativeAcceptanceEstablished': False,
              'privateInAppUpdateValidated': False,
              'assets': [{'name': name, 'bytes': len(data), 'sha256': sha(data)} for name, data in sorted(files.items())]}
    (output / 'published-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tag', default=os.environ.get('RELEASE_TAG'))
    parser.add_argument('--run-id', default=os.environ.get('RELEASE_RUN_ID'))
    parser.add_argument('--verify-archive', type=Path, help='Read-only local archive check; never calls GitHub')
    parser.add_argument('--source-metadata', type=Path, help='Target JSON for the read-only local check only')
    args = parser.parse_args()
    version, run = inputs(args.tag, args.run_id)
    if args.verify_archive:
        require(args.source_metadata is not None, 'Local check requires a source metadata record')
        target = Target(**json.loads(args.source_metadata.read_text(encoding='utf-8')))
        require((target.tag, target.version, target.run) == (args.tag, version, run), 'Local source metadata does not match inputs')
        read_archive(target, args.verify_archive)
        print(json.dumps({'originalCiArchiveVerified': True, **asdict(target)}))
        return
    require(args.source_metadata is None, 'External source metadata is forbidden for publication')
    validate_context(os.environ)
    output = Path('.runtime/publish-release')
    output.mkdir(parents=True, exist_ok=False)
    client = GitHub()
    target = source(client, args.tag, run)
    (output / 'source-target.json').write_text(json.dumps(asdict(target), indent=2), encoding='utf-8')
    archive = output / 'original-ci.zip'
    client.download(f'repos/{REPO}/actions/artifacts/{target.artifact_id}/zip', archive)
    files = read_archive(target, archive)
    (output / 'source-assets').mkdir()
    for name, data in files.items():
        (output / 'source-assets' / name).write_bytes(data)
    print(json.dumps(publish(client, target, files, output), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ReleaseError, KeyError, ValueError, zipfile.BadZipFile, OSError, subprocess.TimeoutExpired) as error:
        print(f'Publication stopped: {error}' if isinstance(error, ReleaseError) else f'Publication stopped: {type(error).__name__}')
        raise SystemExit(1)
