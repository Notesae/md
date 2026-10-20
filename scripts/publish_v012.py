"""只发布已经核验的 v0.1.2 原始 CI 资产；不构建程序、不创建凭据、不改标签。"""

import argparse
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
TAG = 'v0.1.2'
COMMIT = 'd9ad8a42c22d58608577f133d2b1732a79295c5f'
TREE = '7bb3cad238d8388525004b812fbae7a6326a5627'
RUN = 39366742331
CI_URL = f'https://github.com/{REPO}/actions/runs/{RUN}'
ARTIFACT_ID = 12240381897
ARTIFACT_NAME = f'md-windows-{COMMIT}-1'
ARCHIVE_BYTES = 7384625
ARCHIVE_SHA = '7d8d4cf52c385dee1096e9ad49be4529b6dfb54b0c29ed75bbb4e6acdc54d7b9'
EXE_SHA = '4427602ef802097b1a20c2ebcf98693de0a35cf064139a1a3058a6b3a3da3031'
EXE_BYTES = 10667008
ASSETS = {
    'BUILD-INFO.json': (3007, '2ea46a70733711bff43e708a3de115955a3fecfe26dc3dae1dcb7b837ba87a79'),
    'MD_0.1.2_x64-setup.exe': (3280856, '2105c438a5e7bdf1963152c2137a85e1c5b53bb8093f8c0eddaad9c375a9ed31'),
    'MD_0.1.2_x64-standalone.zip': (4129957, '174815563c714da6c4096fab40c49577bc88242b851c512440d3f1bc6bcf7348'),
    'RELEASE-NOTES.md': (2576, 'c65cd3334e08513578eba66eeecf021cafd6ae631855634514331768d4631900'),
    'SHA256SUMS.txt': (348, '8f7b989d857fdde7c0d9f6adf9828c892ad65e711343580c615e50d524007101'),
}


class ReleaseError(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def verify_hash(name, data):
    expected_size, expected_sha = ASSETS[name]
    require(len(data) == expected_size and sha(data) == expected_sha,
            f'Asset bytes differ from verified CI: {name}')


def verify_bundle(files):
    """哈希固定全部五个文件，并交叉检查清单、来源及未完成的真实桌面验收边界。"""
    require(set(files) == set(ASSETS), 'Expected exactly the five pinned files')
    for name, data in files.items():
        verify_hash(name, data)
    manifest = {}
    for line in files['SHA256SUMS.txt'].decode('ascii').splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([A-Za-z0-9_.-]+)', line)
        require(match is not None, 'Invalid checksum manifest entry')
        digest, name = match.groups()
        require(name not in manifest, 'Duplicate checksum manifest entry')
        manifest[name] = digest
    require(set(manifest) == set(ASSETS) - {'SHA256SUMS.txt'}, 'Checksum coverage differs')
    require(all(sha(files[name]) == digest for name, digest in manifest.items()), 'Checksum mismatch')
    info = json.loads(files['BUILD-INFO.json'])
    require((info['product'], info['version'], info['platform'], info['commit'], info['tree'], info['expectedTag'])
            == ('MD', '0.1.2', 'windows-x64', COMMIT, TREE, TAG), 'Build provenance mismatch')
    workflow = info['workflow']
    require((workflow['url'], workflow['attempt'], workflow['event'], workflow['ref'])
            == (CI_URL, '1', 'push', 'refs/heads/main'), 'Build workflow mismatch')
    audit = info['installerAudit']
    require(audit['result'] == 'observed' and audit['restoredRegistry'] is True
            and audit['specPassed'] is False and len(audit['paths']) == 4, 'Installer audit boundary changed')
    require(info['nativeAcceptanceEstablished'] is False and info['privateInAppUpdateValidated'] is False,
            'Unverified native/updater acceptance must remain false')
    payload = info['payload']
    require(len(payload) == 3 and {item['name'] for item in payload}
            == set(ASSETS) - {'BUILD-INFO.json', 'SHA256SUMS.txt'}, 'Build payload differs')
    require(all((item['bytes'], item['sha256']) == ASSETS[item['name']] for item in payload), 'Build payload hash differs')
    executable = info['executable']
    require((executable['name'], executable['productVersion'], executable['bytes'], executable['sha256'])
            == ('md-reader.exe', '0.1.2', EXE_BYTES, EXE_SHA), 'Executable provenance differs')
    with zipfile.ZipFile(io.BytesIO(files['MD_0.1.2_x64-standalone.zip'])) as archive:
        entries = archive.infolist()
        require(len(entries) == 2 and {item.filename for item in entries} == {'md-reader.exe', 'README.txt'},
                'Standalone package entries differ')
        for item in entries:
            require(not item.flag_bits & 1 and not stat.S_ISLNK(item.external_attr >> 16), 'Unsafe standalone entry')
        require(archive.getinfo('md-reader.exe').file_size == EXE_BYTES
                and archive.getinfo('README.txt').file_size < 16384, 'Standalone size differs')
        require(sha(archive.read('md-reader.exe')) == EXE_SHA, 'Standalone executable differs')
    return info


def read_archive(path):
    """仅从固定、扁平的文件名读取 ZIP；拒绝重复项、链接、超限或被替换的归档。"""
    require(path.stat().st_size == ARCHIVE_BYTES, 'Original CI archive digest differs')
    data = path.read_bytes()
    require(len(data) == ARCHIVE_BYTES and sha(data) == ARCHIVE_SHA, 'Original CI archive digest differs')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) == len(ASSETS) and {item.filename for item in entries} == set(ASSETS),
                'CI archive entries differ')
        for item in entries:
            require(item.file_size == ASSETS[item.filename][0] and not item.flag_bits & 1
                    and not stat.S_ISLNK(item.external_attr >> 16), 'Unsafe CI archive entry')
        files = {item.filename: archive.read(item) for item in entries}
    verify_bundle(files)
    return files


def validate_context(env):
    require(env.get('GITHUB_ACTIONS') == 'true' and env.get('GITHUB_REPOSITORY') == REPO
            and env.get('GITHUB_REPOSITORY_ID') == str(REPO_ID)
            and env.get('GITHUB_REF') == 'refs/heads/main'
            and env.get('GITHUB_EVENT_NAME') == 'workflow_dispatch', 'Only manual dispatch on this repository main is allowed')


def validate_source(repo, tag, run, artifacts):
    require(repo['full_name'] == REPO and repo['id'] == REPO_ID and repo['private'] is True, 'Repository/visibility differs')
    require(tag['ref'] == f'refs/tags/{TAG}' and tag['object'] == {
        'sha': COMMIT, 'type': 'commit', 'url': f'https://api.github.com/repos/{REPO}/git/commits/{COMMIT}'
    }, 'Exact lightweight release tag differs; refusing to change it')
    require((run['id'], run['head_sha'], run['head_branch'], run['event'], run['status'], run['conclusion'], run['path'])
            == (RUN, COMMIT, 'main', 'push', 'completed', 'success', '.github/workflows/check.yml')
            and run['repository']['id'] == REPO_ID and run['head_repository']['id'] == REPO_ID
            and run['run_attempt'] == 1, 'Pinned source CI did not succeed at the exact source')
    require(artifacts['total_count'] == 1 and len(artifacts['artifacts']) == 1, 'Source artifact collection changed')
    artifact = artifacts['artifacts'][0]
    require((artifact['id'], artifact['name'], artifact['size_in_bytes'], artifact['digest'], artifact['expired'])
            == (ARTIFACT_ID, ARTIFACT_NAME, ARCHIVE_BYTES, f'sha256:{ARCHIVE_SHA}', False), 'Pinned artifact metadata differs')
    require(artifact['workflow_run']['id'] == RUN and artifact['workflow_run']['head_sha'] == COMMIT
            and artifact['workflow_run']['repository_id'] == REPO_ID
            and artifact['workflow_run']['head_repository_id'] == REPO_ID, 'Artifact source repository differs')


class GitHub:
    """通过 runner 自带 gh 使用该 job 的短期令牌；不读取令牌值、不登录或导出认证。"""
    def command(self, args, *, body=None, destination=None):
        kwargs = {'stderr': subprocess.PIPE, 'timeout': 180, 'check': False}
        if destination is None:
            kwargs['stdout'] = subprocess.PIPE
        else:
            kwargs['stdout'] = destination
        try:
            result = subprocess.run(['gh', *args], input=body, **kwargs)
        except subprocess.TimeoutExpired:
            raise ReleaseError('GitHub request timed out; inspect remote state before retry') from None
        # 错误输出可能含重定向地址，故不回显 stderr，也不自动重试写请求。
        require(result.returncode == 0, f'GitHub command failed (exit {result.returncode}); inspect remote state before retry')
        return result.stdout

    def api(self, resource, method='GET', body=None):
        require(resource == f'repos/{REPO}' or resource.startswith(f'repos/{REPO}/'), 'API target outside this repository')
        args = ['api', '--hostname', 'github.com', '--method', method, resource]
        encoded = None
        if body is not None:
            args += ['--input', '-']
            encoded = json.dumps(body).encode('utf-8')
        response = self.command(args, body=encoded)
        try:
            return json.loads(response)
        except (ValueError, UnicodeError):
            raise ReleaseError('GitHub response was incomplete; inspect remote state before retry') from None

    def download(self, resource, path, asset=False):
        require(resource.startswith(f'repos/{REPO}/'), 'Download outside this repository')
        args = ['api', '--hostname', 'github.com', '--method', 'GET', resource]
        if asset:
            args += ['-H', 'Accept: application/octet-stream']
        with path.open('xb') as stream:
            self.command(args, destination=stream)

    def upload(self, path):
        self.command(['release', 'upload', TAG, str(path), '--repo', REPO])


def all_releases(client):
    result = []
    for page in range(1, 101):
        values = client.api(f'repos/{REPO}/releases?per_page=100&page={page}')
        result.extend(values)
        if len(values) < 100:
            return result
    raise ReleaseError('Release collection too large; manual review required')


def find_release(client):
    matches = [item for item in all_releases(client) if item['tag_name'] == TAG]
    require(len(matches) <= 1, 'Duplicate release records require review')
    return matches[0] if matches else None


def previous_releases(client):
    # 只用于前后比对旧版，不调用任何删除、覆盖或仓库设置接口。
    return {item['id']: item for item in all_releases(client) if item['tag_name'] != TAG}


def validate_release(release, notes):
    require(release is not None, 'Expected Release disappeared; inspect remote state')
    require(release['tag_name'] == TAG and release['target_commitish'] == COMMIT
            and release['prerelease'] is True
            and release['body'].replace('\r\n', '\n') == notes.replace('\r\n', '\n'), 'Existing release provenance/body differs; refusing overwrite')
    assets = release['assets']
    names = [item['name'] for item in assets]
    require(len(names) == len(set(names)) and set(names) <= set(ASSETS), 'Existing Release has unexpected or duplicate assets')
    for item in assets:
        size, digest = ASSETS[item['name']]
        require(item['size'] == size and item.get('state') == 'uploaded'
                and item.get('digest') in (None, f'sha256:{digest}'), 'Existing Release asset metadata differs')


def download_assets(client, release, directory):
    directory.mkdir()
    files = {}
    for item in release['assets']:
        path = directory / item['name']
        client.download(f'repos/{REPO}/releases/assets/{item["id"]}', path, asset=True)
        files[item['name']] = path.read_bytes()
        verify_hash(item['name'], files[item['name']])
    return files


def publish(client, files, output):
    notes = files['RELEASE-NOTES.md'].decode('utf-8')
    old = previous_releases(client)
    require({417894962, 417334084} <= set(old), 'Prior v0.1.1/v0.1.0 releases are missing; manual review required')
    state_path = output / 'publication-state.json'

    def record(stage, release=None):
        state_path.write_text(json.dumps({'stage': stage, 'tag': TAG, 'commit': COMMIT, 'sourceCi': CI_URL,
                                         'releaseId': release['id'] if release else None,
                                         'releasePublished': bool(release and not release['draft'])}, indent=2), encoding='utf-8')

    def source_guard():
        validate_source(client.api(f'repos/{REPO}'), client.api(f'repos/{REPO}/git/ref/tags/{TAG}'),
                        client.api(f'repos/{REPO}/actions/runs/{RUN}'),
                        client.api(f'repos/{REPO}/actions/runs/{RUN}/artifacts'))

    source_guard()
    release = find_release(client)
    if release is None:
        record('creating draft; outcome must be inspected if interrupted')
        try:
            release = client.api(f'repos/{REPO}/releases', 'POST', {
                'tag_name': TAG, 'target_commitish': COMMIT, 'name': 'MD 0.1.2 prerelease',
                'body': notes, 'draft': True, 'prerelease': True, 'make_latest': 'false'})
        except ReleaseError:
            release = find_release(client)
            require(release is not None, 'Draft creation failed or is uncertain; inspected state has no matching Release; no automatic POST retry')
    validate_release(release, notes)
    record('draft found or created', release)
    if release['assets']:
        download_assets(client, release, output / 'existing-assets')
    if not release['draft']:
        require(len(release['assets']) == 5, 'Published release incomplete; refusing to mutate it')
    else:
        for name in ASSETS:
            # 每次写操作前重读状态；已存在的附件只校验，不使用 --clobber。
            source_guard()
            release = find_release(client)
            require(release is not None and release['draft'], 'Draft state changed before upload')
            validate_release(release, notes)
            if name in {item['name'] for item in release['assets']}:
                continue
            record(f'uploading {name}; inspect state if interrupted', release)
            try:
                client.upload(output / 'source-assets' / name)
            except ReleaseError:
                release = find_release(client)
                require(release is not None, 'Release disappeared during upload')
                validate_release(release, notes)
                require(name in {item['name'] for item in release['assets']}, 'Upload absent or uncertain after state read; no automatic upload retry')
        release = find_release(client)
        validate_release(release, notes)
        require(len(release['assets']) == 5, 'Draft must contain exactly five uploaded assets')
        verify_bundle(download_assets(client, release, output / 'draft-roundtrip'))
        source_guard()
        record('publishing verified draft; inspect state if interrupted', release)
        try:
            client.api(f'repos/{REPO}/releases/{release["id"]}', 'PATCH', {
                'draft': False, 'prerelease': True, 'make_latest': 'false'})
        except ReleaseError:
            release = find_release(client)
            require(release is not None and not release['draft'], 'Publication absent or uncertain after state read; no automatic PATCH retry')
    release = find_release(client)
    require(release is not None and not release['draft'] and release['published_at'], 'Publication not confirmed')
    validate_release(release, notes)
    verify_bundle(download_assets(client, release, output / 'published-roundtrip'))
    source_guard()
    require(previous_releases(client) == old, 'Prior Release metadata changed during publication; review required')
    record('published; all five fresh downloads verified; prior releases unchanged', release)
    result = {'repository': REPO, 'private': True, 'tag': TAG, 'sourceCommit': COMMIT, 'sourceTree': TREE,
              'sourceCi': CI_URL, 'artifactId': ARTIFACT_ID, 'artifactSha256': ARCHIVE_SHA,
              'releaseId': release['id'], 'url': release['html_url'], 'prerelease': True,
              'releasePublished': True, 'postPublicationReDownload': True, 'allAssetsMatch': True,
              'previousReleaseIdsPreserved': sorted(old), 'nativeAcceptanceEstablished': False,
              'privateInAppUpdateValidated': False,
              'assets': [{'name': name, 'bytes': size, 'sha256': digest} for name, (size, digest) in ASSETS.items()]}
    (output / 'published-verification.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-archive', type=Path, help='Read-only local verification; never calls GitHub')
    args = parser.parse_args()
    if args.verify_archive:
        read_archive(args.verify_archive)
        print(json.dumps({'originalCiArchiveVerified': True, 'assets': 5, 'commit': COMMIT}))
        return
    validate_context(os.environ)
    output = Path('.runtime/publish-v0.1.2')
    output.mkdir(parents=True, exist_ok=False)
    client = GitHub()
    validate_source(client.api(f'repos/{REPO}'), client.api(f'repos/{REPO}/git/ref/tags/{TAG}'),
                    client.api(f'repos/{REPO}/actions/runs/{RUN}'),
                    client.api(f'repos/{REPO}/actions/runs/{RUN}/artifacts'))
    archive = output / 'original-ci.zip'
    client.download(f'repos/{REPO}/actions/artifacts/{ARTIFACT_ID}/zip', archive)
    files = read_archive(archive)
    source = output / 'source-assets'
    source.mkdir()
    for name, data in files.items():
        (source / name).write_bytes(data)
    print(json.dumps(publish(client, files, output), indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ReleaseError, KeyError, ValueError, zipfile.BadZipFile, OSError, subprocess.TimeoutExpired) as error:
        # 仅输出无认证信息的已知错误类型；子进程完整错误及临时下载地址不进入日志。
        print(f'Publication stopped: {error}' if isinstance(error, ReleaseError) else f'Publication stopped: {type(error).__name__}')
        raise SystemExit(1)
