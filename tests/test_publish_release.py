"""用自洽的模拟构建包检查发布与恢复边界；不访问网络、不运行应用。"""

import base64
import copy
from dataclasses import replace
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('publish_release', Path(__file__).resolve().parents[1] / 'scripts/publish_release.py')
p = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = p
spec.loader.exec_module(p)


def zip_bytes(files):
    stream = io.BytesIO()
    with warnings.catch_warnings(), zipfile.ZipFile(stream, 'w') as archive:
        warnings.simplefilter('ignore', UserWarning)
        for name, data in files:
            archive.writestr(name, data)
    return stream.getvalue()


def refresh_manifest(files):
    files['SHA256SUMS.txt'] = ''.join(p.sha(data) + '  ' + name + '\n' for name, data in sorted(files.items())
                                      if name != 'SHA256SUMS.txt').encode()


def bundle(target):
    exe = b'fixture-program-bytes; never executed'
    files = {f'MD_{target.version}_x64-setup.exe': b'fixture-installer; never executed',
             f'MD_{target.version}_x64-standalone.zip': zip_bytes([('md-reader.exe', exe), ('README.txt', b'Acceptance remains pending.')]),
             'RELEASE-NOTES.md': f'{target.commit}\n{target.tree}\n{target.ci_url}\nNative SPEC/private updater unverified.'.encode()}
    info = {'product': 'MD', 'version': target.version, 'platform': 'windows-x64', 'commit': target.commit,
            'tree': target.tree, 'expectedTag': target.tag,
            'workflow': {'url': target.ci_url, 'attempt': str(target.attempt), 'event': 'push', 'ref': 'refs/heads/main'},
            'installerAudit': {'result': 'observed', 'restoredRegistry': True, 'specPassed': False, 'paths': ['a', 'b', 'c', 'd']},
            'nativeAcceptanceEstablished': False, 'privateInAppUpdateValidated': False,
            'executable': {'name': 'md-reader.exe', 'productVersion': target.version, 'bytes': len(exe), 'sha256': p.sha(exe)},
            'payload': [{'name': name, 'bytes': len(data), 'sha256': p.sha(data)} for name, data in files.items()]}
    files['BUILD-INFO.json'] = json.dumps(info).encode()
    refresh_manifest(files)
    return files


class MemoryGitHub:
    def __init__(self, version='0.1.2', run=42):
        target = p.Target('v' + version, version, run, 'f' * 40, 'e' * 40, 1, 88, 1, '0' * 64)
        self.files = bundle(target)
        self.archive = zip_bytes(list(self.files.items()))
        self.target = t = replace(target, archive_bytes=len(self.archive), archive_sha=p.sha(self.archive))
        self.repo = {'full_name': p.REPO, 'id': p.REPO_ID, 'private': True}
        self.tag = {'ref': f'refs/tags/{t.tag}', 'object': {'sha': t.commit, 'type': 'commit'}}
        self.run = {'id': t.run, 'head_sha': t.commit, 'head_branch': 'main', 'event': 'push', 'status': 'completed',
                    'conclusion': 'success', 'path': '.github/workflows/check.yml', 'run_attempt': 1,
                    'repository': {'id': p.REPO_ID}, 'head_repository': {'id': p.REPO_ID}}
        self.git = {'sha': t.commit, 'tree': {'sha': t.tree}}
        self.versions = {'package.json': t.version, 'src-tauri/tauri.conf.json': t.version}
        self.artifacts = {'total_count': 1, 'artifacts': [{'id': t.artifact_id, 'name': f'md-windows-{t.commit}-{t.attempt}',
            'size_in_bytes': t.archive_bytes, 'digest': 'sha256:' + t.archive_sha, 'expired': False,
            'workflow_run': {'id': t.run, 'head_sha': t.commit, 'head_branch': 'main',
                             'repository_id': p.REPO_ID, 'head_repository_id': p.REPO_ID}}]}
        self.releases = [{'id': 1, 'tag_name': 'v0.0.1', 'assets': []}, {'id': 2, 'tag_name': 'v0.0.2', 'assets': []}]
        self.posts = self.patches = self.uploads = 0
        self.fail_create_after = self.fail_patch_after = self.fail_upload_after = False
        self.fail_upload_before = self.corrupt_download = self.delete_old = False

    def current(self):
        return next((item for item in self.releases if item['tag_name'] == self.target.tag), None)

    def api(self, resource, method='GET', body=None):
        root = f'repos/{p.REPO}'
        if resource == root:
            return copy.deepcopy(self.repo)
        if '/git/ref/tags/' in resource:
            return copy.deepcopy(self.tag)
        if '/git/tags/' in resource:
            return {'object': {'sha': self.target.commit, 'type': 'commit'}}
        if '/git/commits/' in resource:
            return copy.deepcopy(self.git)
        if '/contents/' in resource:
            name = resource.split('/contents/', 1)[1].split('?', 1)[0]
            data = json.dumps({'version': self.versions[name]}).encode()
            return {'encoding': 'base64', 'size': len(data), 'content': base64.b64encode(data).decode()}
        if resource.endswith(f'/actions/runs/{self.target.run}'):
            return copy.deepcopy(self.run)
        if '/artifacts?' in resource:
            return copy.deepcopy(self.artifacts)
        if method == 'POST' and resource == root + '/releases':
            self.posts += 1
            release = {**body, 'id': 123, 'html_url': f'https://github.com/{p.REPO}/releases/tag/{self.target.tag}',
                       'published_at': None, 'assets': []}
            self.releases.append(release)
            if self.fail_create_after:
                raise p.ReleaseError('Simulated lost draft response')
            return copy.deepcopy(release)
        if method == 'PATCH':
            self.patches += 1
            self.current().update(body, published_at='2026-10-20T00:00:00Z')
            if self.delete_old:
                self.releases.pop(0)
            if self.fail_patch_after:
                raise p.ReleaseError('Simulated lost publication response')
            return copy.deepcopy(self.current())
        if '/releases?per_page=100&page=' in resource:
            return copy.deepcopy(self.releases)
        raise AssertionError((method, resource))

    def upload(self, target, path):
        self.uploads += 1
        if self.fail_upload_before:
            raise p.ReleaseError('Simulated request not applied')
        self.current()['assets'].append({'id': len(self.current()['assets']) + 1, 'name': path.name,
            'size': len(self.files[path.name]), 'state': 'uploaded', 'digest': 'sha256:' + p.sha(self.files[path.name])})
        if self.fail_upload_after:
            raise p.ReleaseError('Simulated lost upload response')

    def download(self, resource, path, asset=False):
        asset_id = int(resource.rsplit('/', 1)[1])
        name = next(item['name'] for item in self.current()['assets'] if item['id'] == asset_id)
        path.write_bytes(b'corrupt' if self.corrupt_download else self.files[name])


class SourceGuards(unittest.TestCase):
    def test_parameterized_versions_and_runs_require_no_code_changes(self):
        for version, run in [('0.1.2', 42), ('0.2.0', 987654)]:
            client = MemoryGitHub(version, run)
            self.assertEqual(p.source(client, 'v' + version, run), client.target)
            p.verify_bundle(client.target, client.files)

    def test_resolves_annotated_tag_without_changing_it(self):
        client = MemoryGitHub()
        client.tag['object'] = {'sha': 'a' * 40, 'type': 'tag'}
        self.assertEqual(p.source(client, client.target.tag, client.target.run), client.target)

    def test_invalid_inputs_are_rejected(self):
        for tag, run in [('v0.1.2; echo no', '42'), ('main', '42'), ('v01.2.3', '42'), ('v1.2.3', '-1'), ('v1.2.3', '42;no')]:
            with self.subTest(tag=tag, run=run), self.assertRaises(p.ReleaseError):
                p.inputs(tag, run)

    def test_rejects_other_repository_tag_ci_version_and_artifact(self):
        mutations = [lambda c: c.repo.update(private=False), lambda c: c.repo.update(id=1),
            lambda c: c.tag['object'].update(sha='0' * 40), lambda c: c.run.update(conclusion='failure'),
            lambda c: c.run.update(event='pull_request'), lambda c: c.run.update(head_sha='0' * 40),
            lambda c: c.run['head_repository'].update(id=1), lambda c: c.run.update(path='.github/workflows/other.yml'),
            lambda c: c.versions.update({'package.json': '9.9.9'}),
            lambda c: c.artifacts['artifacts'][0].update(expired=True),
            lambda c: c.artifacts['artifacts'][0].update(digest='sha256:bad'),
            lambda c: c.artifacts['artifacts'][0]['workflow_run'].update(head_sha='0' * 40)]
        for mutate in mutations:
            client = MemoryGitHub()
            mutate(client)
            with self.subTest(mutation=mutate), self.assertRaises(p.ReleaseError):
                p.source(client, client.target.tag, client.target.run)

    def test_only_manual_main_in_exact_repository(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': p.REPO, 'GITHUB_REPOSITORY_ID': str(p.REPO_ID),
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch'}
        p.validate_context(env)
        for key, value in [('GITHUB_REF', 'refs/tags/v0.1.2'), ('GITHUB_EVENT_NAME', 'push'),
                           ('GITHUB_REPOSITORY', 'other/md'), ('GITHUB_REPOSITORY_ID', '1')]:
            with self.subTest(key=key), self.assertRaises(p.ReleaseError):
                p.validate_context({**env, key: value})

    def test_api_is_repository_scoped_and_uncertain_responses_are_sanitized(self):
        with mock.patch.object(p.subprocess, 'run') as process, self.assertRaises(p.ReleaseError):
            p.GitHub().api('repos/Notesae/screenshot/releases', 'POST', {})
        process.assert_not_called()
        with mock.patch.object(p.subprocess, 'run', side_effect=p.subprocess.TimeoutExpired(['gh'], 180)), self.assertRaises(p.ReleaseError):
            p.GitHub().api(f'repos/{p.REPO}/releases', 'POST', {})
        with mock.patch.object(p.GitHub, 'command', return_value=b'{incomplete'), self.assertRaises(p.ReleaseError):
            p.GitHub().api(f'repos/{p.REPO}/releases', 'POST', {})

    def test_original_archive_and_manifest_are_verified(self):
        client = MemoryGitHub()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'source.zip'
            path.write_bytes(client.archive)
            self.assertEqual(p.read_archive(client.target, path), client.files)
            path.write_bytes(client.archive[:-1] + b'x')
            with self.assertRaisesRegex(p.ReleaseError, 'digest'):
                p.read_archive(client.target, path)
        files = copy.deepcopy(client.files)
        files['RELEASE-NOTES.md'] += b'changed'
        with self.assertRaisesRegex(p.ReleaseError, 'Checksum'):
            p.verify_bundle(client.target, files)

    def test_traversal_and_duplicate_zip_entries_are_rejected(self):
        for names in [['../BUILD-INFO.json'], ['BUILD-INFO.json', 'BUILD-INFO.json']]:
            data = zip_bytes([(name, b'x') for name in names])
            target = replace(MemoryGitHub().target, archive_bytes=len(data), archive_sha=p.sha(data))
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / 'unsafe.zip'
                path.write_bytes(data)
                with self.assertRaisesRegex(p.ReleaseError, 'entries'):
                    p.read_archive(target, path)

    def test_no_invented_native_or_updater_acceptance(self):
        for key in ['nativeAcceptanceEstablished', 'privateInAppUpdateValidated']:
            client = MemoryGitHub()
            info = json.loads(client.files['BUILD-INFO.json'])
            info[key] = True
            client.files['BUILD-INFO.json'] = json.dumps(info).encode()
            refresh_manifest(client.files)
            with self.subTest(key=key), self.assertRaisesRegex(p.ReleaseError, 'acceptance'):
                p.verify_bundle(client.target, client.files)


class PublicationRecovery(unittest.TestCase):
    def setUp(self):
        self.client = MemoryGitHub()
        self.target, self.files = self.client.target, self.client.files
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.out = Path(self.directory.name)
        (self.out / 'source-assets').mkdir()
        for name, data in self.files.items():
            (self.out / 'source-assets' / name).write_bytes(data)

    def publish(self, output=None):
        return p.publish(self.client, self.target, self.files, output or self.out)

    def test_draft_roundtrip_precedes_publication_and_fresh_download(self):
        result = self.publish()
        self.assertTrue(result['postPublicationReDownload'] and result['allAssetsMatch'])
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (1, 1, 5))
        self.assertTrue((self.out / 'draft-roundtrip').is_dir())
        self.assertTrue((self.out / 'published-roundtrip').is_dir())

    def test_uncertain_writes_read_back_without_repeating_mutation(self):
        self.client.fail_create_after = self.client.fail_patch_after = self.client.fail_upload_after = True
        self.assertTrue(self.publish()['releasePublished'])
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (1, 1, 5))

    def test_absent_upload_aborts_without_retry_or_publication(self):
        self.client.fail_upload_before = True
        with self.assertRaisesRegex(p.ReleaseError, 'no automatic upload retry'):
            self.publish()
        self.assertEqual((self.client.uploads, self.client.patches), (1, 0))
        self.assertTrue(self.client.current()['draft'])

    def test_second_run_does_not_modify_or_duplicate_published_release(self):
        self.publish()
        with tempfile.TemporaryDirectory() as again:
            self.assertTrue(self.publish(Path(again))['allAssetsMatch'])
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (1, 1, 5))

    def test_changed_remote_asset_stops_before_publication(self):
        self.client.corrupt_download = True
        with self.assertRaisesRegex(p.ReleaseError, 'bytes differ'):
            self.publish()
        self.assertEqual(self.client.patches, 0)

    def test_foreign_existing_release_is_not_overwritten(self):
        self.client.releases.append({'id': 123, 'tag_name': self.target.tag, 'target_commitish': '0' * 40,
            'prerelease': True, 'draft': True, 'body': self.files['RELEASE-NOTES.md'].decode(), 'assets': []})
        with self.assertRaisesRegex(p.ReleaseError, 'refusing overwrite'):
            self.publish()
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (0, 0, 0))

    def test_old_release_changes_never_produce_success_evidence(self):
        self.client.delete_old = True
        with self.assertRaisesRegex(p.ReleaseError, 'Prior Release'):
            self.publish()
        self.assertFalse((self.out / 'published-verification.json').exists())


if __name__ == '__main__':
    unittest.main()
