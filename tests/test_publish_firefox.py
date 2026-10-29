import base64
import contextlib
import hashlib
import hmac
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from zipfile import ZipFile


spec = importlib.util.spec_from_file_location(
    'publish_firefox', Path(__file__).resolve().parents[1] / 'scripts' / 'publish-firefox.py'
)
firefox = importlib.util.module_from_spec(spec)
spec.loader.exec_module(firefox)

ADDON_ID = 'wupage@mr-wuliu.github.io'
COMMIT = 'a' * 40
UPLOAD_ID = '22222222-2222-2222-2222-222222222222'
ADDON = {'guid': ADDON_ID, 'is_disabled': False, 'channels': ['listed']}


def zip_bytes(files):
    buffer = io.BytesIO()
    with ZipFile(buffer, 'w') as archive:
        for name, content in files.items():
            archive.writestr(name, json.dumps(content) if isinstance(content, dict) else content)
    return buffer.getvalue()


def version(number='1.1.0', status='public', source='https://addons.mozilla.org/source.zip'):
    return {'id': 123, 'version': number, 'channel': 'listed', 'file': {'status': status}, 'source': source}


class Response:
    def __init__(self, data):
        self.data = json.dumps(data).encode()

    def read(self):
        return self.data

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class PublishFirefoxTests(unittest.TestCase):
    def setUp(self):
        cache = Path(__file__).resolve().parents[1] / '.npm-cache' / 'publish-tests'
        cache.mkdir(parents=True, exist_ok=True)
        directory = tempfile.TemporaryDirectory(dir=cache)
        self.addCleanup(directory.cleanup)
        self.package = Path(directory.name) / 'wupage-1.2.0-firefox.zip'
        self.source = Path(directory.name) / 'wupage-1.2.0-firefox-source.zip'
        self.manifest = {
            'version': '1.2.0', 'background': {'scripts': ['background.js'], 'type': 'module'},
            'browser_specific_settings': {'gecko': {'id': ADDON_ID}},
        }
        self.source_files = {
            'package.json': {'version': '1.2.0'},
            'package-lock.json': {'version': '1.2.0', 'packages': {'': {'version': '1.2.0'}}},
            'public/manifest.json': {'version': '1.2.0'},
            'SOURCE_REVISION.txt': COMMIT + '\n',
            'FIREFOX_BUILD.txt': 'npm ci\nnpm run build:firefox\nReviewer testing instructions.',
        }
        self.write_artifacts()
        self.client = firefox.AMOClient('test-issuer', 'test-secret')
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def write_artifacts(self):
        self.package.write_bytes(zip_bytes({'manifest.json': self.manifest}))
        self.source.write_bytes(zip_bytes(self.source_files))
        for path in (self.package, self.source):
            Path(str(path) + '.sha256').write_text(
                hashlib.sha256(path.read_bytes()).hexdigest() + '  ' + path.name + '\n', encoding='utf-8'
            )

    def publish(self, client=None, **kwargs):
        return firefox.publish_package(client, self.package, self.source, 'v1.2.0', ADDON_ID, COMMIT, **kwargs)

    def api(self, responses):
        return patch.object(self.client.opener, 'open', side_effect=[Response(data) for data in responses])

    def preflight(self, versions=None):
        return [ADDON, {'results': versions if versions is not None else [version()], 'next': None}]

    def test_submission_keeps_original_bytes_and_attaches_source_in_the_same_request(self):
        responses = self.preflight() + [
            {'uuid': UPLOAD_ID}, {'processed': False},
            {'processed': True, 'valid': True, 'channel': 'listed', 'version': '1.2.0'},
            version('1.2.0', 'unreviewed'),
        ]
        with self.api(responses) as send, patch.object(firefox.time, 'sleep'):
            self.assertEqual(self.publish(self.client), 'submitted')
        requests = [call.args[0] for call in send.call_args_list]
        self.assertEqual([request.get_method() for request in requests], ['GET', 'GET', 'POST', 'GET', 'GET', 'POST'])
        self.assertIn('/wupage%40mr-wuliu.github.io/', requests[0].full_url)
        self.assertIn('all_without_unlisted', requests[1].full_url)
        self.assertEqual(requests[2].full_url, firefox.API_ROOT + '/addons/upload/')
        self.assertIn(b'name="channel"\r\n\r\nlisted\r\n', requests[2].data)
        self.assertIn(self.package.read_bytes(), requests[2].data)
        self.assertTrue(requests[-1].full_url.endswith('/versions/'))
        self.assertIn(self.source.read_bytes(), requests[-1].data)
        self.assertIn(b'name="source"', requests[-1].data)
        self.assertIn(b'name="approval_notes"', requests[-1].data)
        self.assertIn(COMMIT.encode(), requests[-1].data)
        self.assertNotIn(b'name="license"', requests[-1].data)
        nonces = set()
        for request in requests:
            token = request.get_header('Authorization').removeprefix('JWT ')
            header, claims, signature = token.split('.')
            decode = lambda text: base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))
            self.assertEqual(json.loads(decode(header))['alg'], 'HS256')
            payload = json.loads(decode(claims))
            self.assertEqual(payload['iss'], 'test-issuer')
            self.assertEqual(payload['exp'] - payload['iat'], 300)
            self.assertNotIn(payload['jti'], nonces)
            nonces.add(payload['jti'])
            self.assertEqual(decode(signature), hmac.new(b'test-secret', f'{header}.{claims}'.encode(), hashlib.sha256).digest())

    def test_dry_run_without_credentials_does_not_contact_amo(self):
        with patch.object(firefox, 'build_opener') as opener:
            self.assertEqual(self.publish(dry_run=True), 'validated-offline')
        opener.assert_not_called()

    def test_long_review_notes_fit_amo_limit_without_modifying_source(self):
        for details in ('Reviewer details with Unicode 字体.\n' * 200, 'x' * 6000):
            with self.subTest(multiline='\n' in details):
                notes = 'npm ci\nnpm run build:firefox\n\n' + details
                self.source_files['FIREFOX_BUILD.txt'] = notes
                self.write_artifacts()
                original_source = self.source.read_bytes()
                responses = self.preflight() + [
                    {'uuid': UPLOAD_ID},
                    {'processed': True, 'valid': True, 'channel': 'listed', 'version': '1.2.0'},
                    version('1.2.0', 'unreviewed'),
                ]
                with self.api(responses) as send:
                    self.assertEqual(self.publish(self.client), 'submitted')
                request = send.call_args_list[-1].args[0]
                approval_notes = request.data.split(b'name="approval_notes"\r\n\r\n', 1)[1].split(b'\r\n--', 1)[0].decode('utf-8')
                self.assertLessEqual(len(approval_notes), 3000)
                self.assertIn('v1.2.0', approval_notes)
                self.assertIn(COMMIT, approval_notes)
                self.assertIn('npm run build:firefox\n', approval_notes)
                self.assertIn('FIREFOX_BUILD.txt', approval_notes)
                self.assertIn(original_source, request.data)
                self.assertEqual(self.source.read_bytes(), original_source)
                with ZipFile(io.BytesIO(original_source)) as archive:
                    self.assertEqual(archive.read('FIREFOX_BUILD.txt').decode('utf-8'), notes)

    def test_review_notes_exactly_at_limit_are_preserved_in_full(self):
        prefix_length = len(firefox.build_approval_notes('v1.2.0', COMMIT, ''))
        notes = 'x' * (3000 - prefix_length)
        approval_notes = firefox.build_approval_notes('v1.2.0', COMMIT, notes)
        self.assertEqual(len(approval_notes), 3000)
        self.assertTrue(approval_notes.endswith(notes))
        self.assertNotIn('[Continued', approval_notes)

    def test_dry_run_with_credentials_only_reads_listing(self):
        with self.api(self.preflight()) as send:
            self.assertEqual(self.publish(self.client, dry_run=True), 'validated-online')
        self.assertTrue(all(call.args[0].get_method() == 'GET' for call in send.call_args_list))

    def test_existing_pending_or_public_version_is_not_uploaded_or_changed(self):
        for status in ('unreviewed', 'public'):
            with self.subTest(status=status), self.api(self.preflight([version('1.2.0', status)])) as send:
                self.assertEqual(self.publish(self.client), 'already-exists')
                self.assertEqual(send.call_count, 2)

    def test_nominated_listing_without_channels_uses_authenticated_version_history(self):
        addon = {'guid': ADDON_ID, 'status': 'nominated', 'is_disabled': False}
        with self.api([addon, {'results': [version('1.2.0', 'unreviewed')], 'next': None}]) as send:
            self.assertEqual(self.publish(self.client, dry_run=True), 'already-exists')
        self.assertTrue(all(call.args[0].get_method() == 'GET' for call in send.call_args_list))

    def test_unexpected_version_channel_never_starts_upload(self):
        with self.api(self.preflight([{**version('1.2.0'), 'channel': 'unlisted'}])) as send:
            with self.assertRaisesRegex(RuntimeError, 'unexpected channel'):
                self.publish(self.client)
        self.assertEqual(send.call_count, 2)

    def test_unsafe_existing_states_never_start_an_upload(self):
        cases = [
            [version('1.2.0', 'disabled')], [version('1.2.0', source=None)],
            [version('1.1.0', 'unreviewed')], [version('1.3.0')],
            [version('1.2.0.1')], [version('1.3.0beta')], [],
        ]
        for versions in cases:
            with self.subTest(versions=versions), self.api(self.preflight(versions)) as send:
                with self.assertRaises(RuntimeError):
                    self.publish(self.client)
                self.assertEqual(send.call_count, 2)

    def test_wrong_or_disabled_listing_never_starts_an_upload(self):
        for addon in ({**ADDON, 'guid': 'other'}, {**ADDON, 'is_disabled': True}, {**ADDON, 'channels': ['unlisted']}):
            with self.subTest(addon=addon), self.api([addon]) as send:
                with self.assertRaisesRegex(RuntimeError, 'existing, enabled listed add-on'):
                    self.publish(self.client)
                self.assertEqual(send.call_count, 1)

    def test_pagination_does_not_send_credentials_to_response_urls(self):
        with self.api([ADDON,
                       {'results': [version('1.1.0')], 'next': 'https://untrusted.invalid/steal'},
                       {'results': [version('1.2.0', 'unreviewed')], 'next': None}]) as send:
            self.assertEqual(self.publish(self.client), 'already-exists')
        self.assertTrue(all(call.args[0].full_url.startswith(firefox.API_ROOT + '/') for call in send.call_args_list))
        self.assertTrue(send.call_args_list[-1].args[0].full_url.endswith('page=2'))

    def test_failed_or_mismatched_upload_validation_never_creates_a_version(self):
        for result in (
            {'processed': True, 'valid': False, 'validation': {'errors': 1}},
            {'processed': True, 'valid': True, 'channel': 'unlisted', 'version': '1.2.0'},
            {'processed': True, 'valid': True, 'channel': 'listed', 'version': '1.1.0'},
        ):
            with self.subTest(result=result), self.api(self.preflight() + [{'uuid': UPLOAD_ID}, result]) as send:
                with self.assertRaises(RuntimeError):
                    self.publish(self.client)
                self.assertEqual(send.call_count, 4)

    def test_missing_source_in_created_version_is_reported(self):
        with self.api(self.preflight() + [
            {'uuid': UPLOAD_ID}, {'processed': True, 'valid': True, 'channel': 'listed', 'version': '1.2.0'},
            version('1.2.0', source=None),
        ]):
            with self.assertRaisesRegex(RuntimeError, 'Check the Developer Hub'):
                self.publish(self.client)

    def test_invalid_packages_and_source_never_contact_amo(self):
        cases = [
            ('version', lambda: self.manifest.update(version='1.1.0')),
            ('version_name', lambda: self.manifest.update(version_name='1.2.0-beta.1')),
            ('id', lambda: self.manifest.update(browser_specific_settings={'gecko': {'id': 'other'}})),
            ('background', lambda: self.manifest.update(background={'service_worker': 'background.js'})),
            ('commit', lambda: self.source_files.update({'SOURCE_REVISION.txt': 'b' * 40})),
            ('source package', lambda: self.source_files.update({'package.json': {'version': '1.1.0'}})),
            ('source lock', lambda: self.source_files.update({'package-lock.json': {'version': '1.2.0', 'packages': {'': {'version': '1.1.0'}}}})),
            ('source manifest', lambda: self.source_files.update({'public/manifest.json': {'version': '1.1.0'}})),
            ('notes', lambda: self.source_files.update({'FIREFOX_BUILD.txt': ''})),
        ]
        original_manifest = json.dumps(self.manifest)
        original_source = json.dumps(self.source_files)
        for label, mutate in cases:
            with self.subTest(label=label):
                self.manifest = json.loads(original_manifest)
                self.source_files = json.loads(original_source)
                mutate()
                self.write_artifacts()
                with patch.object(self.client, 'request') as send:
                    with self.assertRaises(ValueError):
                        self.publish(self.client)
                    send.assert_not_called()

    def test_checksum_tampering_or_wrong_sidecar_filename_is_rejected(self):
        for path in (self.package, self.source):
            with self.subTest(path=path):
                path.write_bytes(path.read_bytes() + b'tampered')
                with patch.object(self.client, 'request') as send:
                    with self.assertRaisesRegex(ValueError, 'SHA-256'):
                        self.publish(self.client)
                    send.assert_not_called()
                self.write_artifacts()
        sidecar = Path(str(self.source) + '.sha256')
        sidecar.write_text(hashlib.sha256(self.source.read_bytes()).hexdigest() + '  other.zip\n')
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            self.publish(dry_run=True)

    def test_prereleases_are_rejected_before_any_api_calls(self):
        with patch.object(self.client, 'request') as send:
            with self.assertRaisesRegex(ValueError, 'Only stable'):
                firefox.publish_package(self.client, self.package, self.source, 'v1.2.0-beta.1', ADDON_ID, COMMIT)
            send.assert_not_called()

    def test_authentication_failure_is_clear_and_does_not_expose_secrets(self):
        error = HTTPError(firefox.API_ROOT, 401, 'Unauthorized', {}, io.BytesIO(b'test-secret'))
        with patch.object(self.client.opener, 'open', side_effect=error):
            with self.assertRaisesRegex(RuntimeError, 'AMO_JWT_ISSUER / AMO_JWT_SECRET') as raised:
                self.publish(self.client)
        self.assertNotIn('test-secret', str(raised.exception))

    def test_connection_failure_does_not_retry_a_mutating_request(self):
        with patch.object(self.client.opener, 'open', side_effect=URLError('network error')) as send:
            with self.assertRaisesRegex(RuntimeError, 'may have been accepted'):
                self.client.request('POST', '/addons/upload/', {'channel': 'listed'})
        self.assertEqual(send.call_count, 1)

    def test_redirects_cannot_forward_api_credentials(self):
        with self.assertRaisesRegex(RuntimeError, 'not forwarded'):
            firefox.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://untrusted.invalid')

    def test_polling_times_out_without_creating_a_version(self):
        with patch.object(firefox.time, 'monotonic', side_effect=[0, 0, 601]), \
                patch.object(firefox.time, 'sleep'), self.api([{'processed': False}]) as send:
            with self.assertRaisesRegex(TimeoutError, 'Developer Hub'):
                self.client.wait_for_validation(UPLOAD_ID, '1.2.0')
        self.assertEqual(send.call_count, 1)


if __name__ == '__main__':
    unittest.main()
