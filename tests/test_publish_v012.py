"""发布边界与中断恢复回归；只使用内存远端和临时文件，不访问 GitHub。"""

import copy
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('publish_v012', Path(__file__).resolve().parents[1] / 'scripts/publish_v012.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def source():
    return (
        {'full_name': p.REPO, 'id': p.REPO_ID, 'private': True},
        {'ref': f'refs/tags/{p.TAG}', 'object': {'sha': p.COMMIT, 'type': 'commit',
         'url': f'https://api.github.com/repos/{p.REPO}/git/commits/{p.COMMIT}'}},
        {'id': p.RUN, 'head_sha': p.COMMIT, 'head_branch': 'main', 'event': 'push', 'status': 'completed',
         'conclusion': 'success', 'path': '.github/workflows/check.yml', 'run_attempt': 1,
         'repository': {'id': p.REPO_ID}, 'head_repository': {'id': p.REPO_ID}},
        {'total_count': 1, 'artifacts': [{'id': p.ARTIFACT_ID, 'name': p.ARTIFACT_NAME,
         'size_in_bytes': p.ARCHIVE_BYTES, 'digest': f'sha256:{p.ARCHIVE_SHA}', 'expired': False,
         'workflow_run': {'id': p.RUN, 'head_sha': p.COMMIT, 'repository_id': p.REPO_ID,
                          'head_repository_id': p.REPO_ID}}]},
    )


class SourceGuards(unittest.TestCase):
    def test_accepts_exact_successful_source(self):
        p.validate_source(*source())

    def test_rejects_other_repository_visibility_tag_run_and_artifact(self):
        mutations = [
            (0, lambda value: value.update(private=False)),
            (0, lambda value: value.update(id=1)),
            (1, lambda value: value['object'].update(sha='0' * 40)),
            (1, lambda value: value['object'].update(type='tag')),
            (2, lambda value: value.update(conclusion='failure')),
            (2, lambda value: value.update(head_sha='0' * 40)),
            (2, lambda value: value.update(event='pull_request')),
            (2, lambda value: value.update(run_attempt=2)),
            (2, lambda value: value['head_repository'].update(id=1)),
            (3, lambda value: value['artifacts'][0].update(expired=True)),
            (3, lambda value: value['artifacts'][0].update(digest='sha256:' + '0' * 64)),
            (3, lambda value: value['artifacts'][0].update(id=1)),
        ]
        for index, mutate in mutations:
            with self.subTest(index=index, mutation=mutate):
                values = source()
                mutate(values[index])
                with self.assertRaises(p.ReleaseError):
                    p.validate_source(*values)

    def test_only_manual_main_in_exact_repository(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': p.REPO, 'GITHUB_REPOSITORY_ID': str(p.REPO_ID),
               'GITHUB_REF': 'refs/heads/main', 'GITHUB_EVENT_NAME': 'workflow_dispatch'}
        p.validate_context(env)
        for key, value in [('GITHUB_REF', f'refs/tags/{p.TAG}'), ('GITHUB_EVENT_NAME', 'push'),
                           ('GITHUB_REPOSITORY', 'other/md'), ('GITHUB_REPOSITORY_ID', '1'), ('GITHUB_ACTIONS', 'false')]:
            with self.subTest(key=key), self.assertRaises(p.ReleaseError):
                p.validate_context({**env, key: value})

    def test_api_rejects_other_repository_before_subprocess(self):
        with mock.patch.object(p.subprocess, 'run') as process, self.assertRaises(p.ReleaseError):
            p.GitHub().api('repos/Notesae/screenshot/releases', 'POST', {})
        process.assert_not_called()

    def test_timeout_and_incomplete_response_enter_state_read_recovery(self):
        with mock.patch.object(p.subprocess, 'run', side_effect=p.subprocess.TimeoutExpired(['gh'], 180)), self.assertRaises(p.ReleaseError):
            p.GitHub().api(f'repos/{p.REPO}/releases', 'POST', {})
        with mock.patch.object(p.GitHub, 'command', return_value=b'{incomplete'), self.assertRaises(p.ReleaseError):
            p.GitHub().api(f'repos/{p.REPO}/releases', 'POST', {})

    def test_rejects_corrupted_original_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wrong.zip'
            path.write_bytes(b'not the pinned CI artifact')
            with self.assertRaisesRegex(p.ReleaseError, 'digest'):
                p.read_archive(path)

    def test_rejects_archive_traversal_and_duplicate_entries(self):
        for names in [['../BUILD-INFO.json'], ['BUILD-INFO.json', 'BUILD-INFO.json']]:
            with self.subTest(names=names), tempfile.TemporaryDirectory() as directory:
                stream = io.BytesIO()
                with warnings.catch_warnings(), zipfile.ZipFile(stream, 'w') as archive:
                    warnings.simplefilter('ignore', UserWarning)
                    for name in names:
                        archive.writestr(name, b'x')
                data = stream.getvalue()
                path = Path(directory) / 'unsafe.zip'
                path.write_bytes(data)
                with mock.patch.object(p, 'ARCHIVE_BYTES', len(data)), mock.patch.object(p, 'ARCHIVE_SHA', p.sha(data)), self.assertRaisesRegex(p.ReleaseError, 'entries'):
                    p.read_archive(path)

    def test_bundle_requires_exact_file_set_and_fixed_bytes(self):
        with self.assertRaises(p.ReleaseError):
            p.verify_bundle({})
        with self.assertRaises(p.ReleaseError):
            p.verify_bundle({name: b'changed' for name in p.ASSETS})


class MemoryGitHub:
    def __init__(self, files):
        self.files = files
        self.releases = [{'id': 417894962, 'tag_name': 'v0.1.1', 'assets': []},
                         {'id': 417334084, 'tag_name': 'v0.1.0', 'assets': []}]
        self.posts = self.patches = self.uploads = 0
        self.fail_create_after = self.fail_patch_after = self.fail_upload_after = False
        self.fail_upload_before = self.corrupt_download = self.delete_old = False

    def current(self):
        return next((item for item in self.releases if item['tag_name'] == p.TAG), None)

    def api(self, resource, method='GET', body=None):
        root = f'repos/{p.REPO}'
        metadata = source()
        if resource == root:
            return metadata[0]
        if '/git/ref/' in resource:
            return metadata[1]
        if resource.endswith(f'/actions/runs/{p.RUN}'):
            return metadata[2]
        if resource.endswith('/artifacts'):
            return metadata[3]
        if method == 'POST' and resource == root + '/releases':
            self.posts += 1
            release = {**body, 'id': 123, 'html_url': f'https://github.com/{p.REPO}/releases/tag/{p.TAG}',
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

    def upload(self, path):
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


class PublicationRecovery(unittest.TestCase):
    def setUp(self):
        self.files = {name: ('fixture-' + name).encode() for name in p.ASSETS}
        self.client = MemoryGitHub(self.files)
        self.hashes = mock.patch.object(p, 'ASSETS', {name: (len(data), p.sha(data)) for name, data in self.files.items()})
        self.hashes.start()
        self.addCleanup(self.hashes.stop)
        # 此组仅检验远端状态机；真实字节/ZIP 来源在 SourceGuards 与离线原始归档检查中另验。
        self.bundle = mock.patch.object(p, 'verify_bundle')
        self.bundle.start()
        self.addCleanup(self.bundle.stop)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.out = Path(self.directory.name)
        (self.out / 'source-assets').mkdir()
        for name, data in self.files.items():
            (self.out / 'source-assets' / name).write_bytes(data)

    def test_creates_draft_verifies_then_publishes_and_downloads_again(self):
        result = p.publish(self.client, self.files, self.out)
        self.assertTrue(result['postPublicationReDownload'] and result['allAssetsMatch'])
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (1, 1, 5))
        self.assertTrue((self.out / 'draft-roundtrip').is_dir())
        self.assertTrue((self.out / 'published-roundtrip').is_dir())

    def test_uncertain_writes_are_read_back_without_repeating_mutation(self):
        self.client.fail_create_after = self.client.fail_patch_after = self.client.fail_upload_after = True
        result = p.publish(self.client, self.files, self.out)
        self.assertTrue(result['releasePublished'])
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (1, 1, 5))

    def test_absent_upload_aborts_without_retry_or_publication(self):
        self.client.fail_upload_before = True
        with self.assertRaisesRegex(p.ReleaseError, 'no automatic upload retry'):
            p.publish(self.client, self.files, self.out)
        self.assertEqual((self.client.uploads, self.client.patches), (1, 0))
        self.assertTrue(self.client.current()['draft'])

    def test_repeated_run_does_not_duplicate_or_modify_published_release(self):
        p.publish(self.client, self.files, self.out)
        with tempfile.TemporaryDirectory() as again:
            result = p.publish(self.client, self.files, Path(again))
        self.assertTrue(result['allAssetsMatch'])
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (1, 1, 5))

    def test_corrupt_assets_never_publish(self):
        self.client.corrupt_download = True
        with self.assertRaisesRegex(p.ReleaseError, 'Asset bytes'):
            p.publish(self.client, self.files, self.out)
        self.assertEqual(self.client.patches, 0)

    def test_foreign_existing_release_is_never_overwritten(self):
        self.client.releases.append({'id': 123, 'tag_name': p.TAG, 'target_commitish': '0' * 40,
            'prerelease': True, 'draft': True, 'body': self.files['RELEASE-NOTES.md'].decode(), 'assets': []})
        with self.assertRaisesRegex(p.ReleaseError, 'refusing overwrite'):
            p.publish(self.client, self.files, self.out)
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (0, 0, 0))

    def test_missing_old_release_stops_before_any_write(self):
        self.client.releases.pop(0)
        with self.assertRaisesRegex(p.ReleaseError, 'Prior v0.1.1/v0.1.0'):
            p.publish(self.client, self.files, self.out)
        self.assertEqual((self.client.posts, self.client.patches, self.client.uploads), (0, 0, 0))

    def test_detects_any_old_release_change(self):
        self.client.delete_old = True
        with self.assertRaisesRegex(p.ReleaseError, 'Prior Release'):
            p.publish(self.client, self.files, self.out)
        self.assertFalse((self.out / 'published-verification.json').exists())


if __name__ == '__main__':
    unittest.main()
