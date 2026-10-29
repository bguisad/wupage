"""Submit existing release artifacts to an existing AMO listing (stdlib only).

API: https://mozilla.github.io/addons-server/topics/api/addons.html
Auth: https://mozilla.github.io/addons-server/topics/api/auth.html
"""

import argparse
import base64
import hashlib
import hmac
import io
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID, uuid4
from zipfile import ZipFile


API_ROOT = 'https://addons.mozilla.org/api/v5'
MAX_APPROVAL_NOTES_LENGTH = 3000


def verify_checksum(path):
    path = Path(path)
    checksum = Path(str(path) + '.sha256').read_text(encoding='utf-8').strip()
    match = re.fullmatch(r'([a-fA-F0-9]{64}) [ *]' + re.escape(path.name), checksum)
    if not match or hashlib.sha256(path.read_bytes()).hexdigest() != match[1].lower():
        raise ValueError(f'Invalid SHA-256 checksum for {path.name}.')


def validate_artifacts(package, source, tag, addon_id, commit):
    if not re.fullmatch(r'v[0-9]+\.[0-9]+\.[0-9]+', tag):
        raise ValueError('Only stable v<major>.<minor>.<patch> releases can be submitted.')
    if not addon_id or not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise ValueError('The add-on ID and resolved release commit are required.')
    version = tag[1:]
    with ZipFile(io.BytesIO(package)) as archive:
        manifest = json.loads(archive.read('manifest.json'))
    if manifest.get('version') != version or manifest.get('version_name', version) != version:
        raise ValueError('The Firefox manifest version must match the release tag.')
    if manifest.get('browser_specific_settings', {}).get('gecko', {}).get('id') != addon_id:
        raise ValueError('The Firefox manifest ID must match AMO_ADDON_ID.')
    if not manifest.get('background', {}).get('scripts') or manifest['background'].get('service_worker'):
        raise ValueError('The release must contain the Firefox background scripts manifest.')
    with ZipFile(io.BytesIO(source)) as archive:
        if archive.read('SOURCE_REVISION.txt').decode().strip() != commit:
            raise ValueError('The source archive revision must match the release tag commit.')
        for name in ('package.json', 'package-lock.json', 'public/manifest.json'):
            if json.loads(archive.read(name)).get('version') != version:
                raise ValueError(f'The source archive {name} version must match the release tag.')
        if json.loads(archive.read('package-lock.json')).get('packages', {}).get('', {}).get('version') != version:
            raise ValueError('The source archive root lockfile package version must match the release tag.')
        notes = archive.read('FIREFOX_BUILD.txt').decode('utf-8').strip()
        if not notes:
            raise ValueError('The source archive must include Firefox build and reviewer instructions.')
    return notes


def build_approval_notes(tag, commit, notes):
    prefix = (
        f'WuPage {tag}; Git source revision {commit}.\n\n'
        'Complete build and reviewer instructions are in FIREFOX_BUILD.txt '
        'at the root of the attached source archive.\n\n'
    )
    if len(prefix + notes) <= MAX_APPROVAL_NOTES_LENGTH:
        return prefix + notes
    suffix = '\n\n[Continued in FIREFOX_BUILD.txt.]'
    excerpt = notes[:MAX_APPROVAL_NOTES_LENGTH - len(prefix) - len(suffix)]
    # Keep complete lines where possible, so a command is not cut in half.
    if '\n' in excerpt:
        excerpt = excerpt.rsplit('\n', 1)[0]
    return prefix + excerpt.rstrip() + suffix


def multipart(fields, files):
    boundary = 'wupage-' + uuid4().hex
    chunks = []
    for name, value in fields.items():
        chunks.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode()
        )
    for name, (filename, content) in files.items():
        chunks.extend([
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
            'Content-Type: application/zip\r\n\r\n'.encode(),
            content, b'\r\n',
        ])
    chunks.append(f'--{boundary}--\r\n'.encode())
    return b''.join(chunks), f'multipart/form-data; boundary={boundary}'


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('AMO API returned a redirect; credentials were not forwarded.')


class AMOClient:
    def __init__(self, issuer, secret):
        self.issuer = issuer
        self.secret = secret
        self.opener = build_opener(NoRedirect())

    def token(self):
        def encode(value):
            return base64.urlsafe_b64encode(value).rstrip(b'=')

        now = int(time.time())
        header = encode(json.dumps({'alg': 'HS256', 'typ': 'JWT'}).encode())
        claims = encode(json.dumps({
            'iss': self.issuer, 'jti': uuid4().hex, 'iat': now, 'exp': now + 300,
        }).encode())
        message = header + b'.' + claims
        signature = encode(hmac.new(self.secret.encode(), message, hashlib.sha256).digest())
        return (message + b'.' + signature).decode()

    def request(self, method, path, fields=None, files=None):
        # Paths are constructed locally, never taken from API-provided URLs.
        if not path.startswith('/addons/') or '://' in path or '..' in path:
            raise ValueError('Invalid AMO API path.')
        headers = {'Authorization': 'JWT ' + self.token(), 'Accept': 'application/json'}
        body = None
        if fields is not None:
            body, headers['Content-Type'] = multipart(fields, files or {})
        request = Request(API_ROOT + path, data=body, headers=headers, method=method)
        try:
            with self.opener.open(request, timeout=120) as response:
                return json.loads(response.read())
        except HTTPError as error:
            if error.code in (401, 403):
                detail = 'Check AMO_JWT_ISSUER / AMO_JWT_SECRET and that this account owns the add-on.'
            else:
                detail = error.read().decode('utf-8', errors='replace')[:4000]
                for value in (self.issuer, self.secret, headers['Authorization']):
                    detail = detail.replace(value, '[redacted]')
            error.close()
            raise RuntimeError(f'AMO API {method} {path}: HTTP {error.code}. {detail}') from None
        except (URLError, TimeoutError) as error:
            raise RuntimeError(
                f'AMO API {method} {path}: connection failed ({type(error).__name__}). '
                'Check the Developer Hub before retrying; the request may have been accepted.'
            ) from None

    def versions(self, addon_path):
        versions = []
        page = 1
        while True:
            result = self.request(
                'GET', f'{addon_path}versions/?filter=all_without_unlisted&page_size=50&page={page}'
            )
            versions.extend(result['results'])
            if not result.get('next'):
                return versions
            page += 1

    def wait_for_validation(self, upload_id, version, timeout=600, interval=10):
        path = f'/addons/upload/{UUID(upload_id)}/'
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            upload = self.request('GET', path)
            if upload.get('processed'):
                if not upload.get('valid'):
                    raise RuntimeError('AMO validation failed: ' + json.dumps(upload.get('validation'), ensure_ascii=False))
                if upload.get('channel') != 'listed' or upload.get('version') != version:
                    raise RuntimeError('The validated AMO upload channel/version does not match this release.')
                print('AMO package validation passed.')
                return
            time.sleep(interval)
        raise TimeoutError('AMO upload validation timed out. Check the Developer Hub before retrying.')


def check_existing(versions, version):
    def key(value):
        parts = tuple(int(part) for part in value.split('.'))
        return parts + (0,) * (4 - len(parts))

    if any(item.get('channel') != 'listed' for item in versions):
        raise RuntimeError('AMO listed version history contains an unexpected channel. Check the Developer Hub.')

    for existing in versions:
        if existing['version'] == version:
            status = existing.get('file', {}).get('status')
            if existing.get('channel') != 'listed' or status not in ('public', 'unreviewed') or not existing.get('source'):
                raise RuntimeError(
                    f'AMO version {version} already exists but needs manual attention '
                    '(check its status and source attachment). It was not changed.'
                )
            return existing
    for existing in versions:
        if existing.get('file', {}).get('status') == 'unreviewed':
            raise RuntimeError('Another listed AMO version is awaiting review. Complete that review before submitting a new version.')
        number = existing['version']
        if not re.fullmatch(r'[0-9]+(?:\.[0-9]+){0,3}', number):
            raise RuntimeError(f'Check the existing AMO version {number} manually before submitting a stable release.')
        if key(number) >= key(version):
            raise RuntimeError('The release version must be newer than every previously submitted listed version.')
    if not any(item.get('file', {}).get('status') == 'public' for item in versions):
        raise RuntimeError('The first AMO version must finish approval before automatic updates are enabled.')
    return None


def publish_package(client, package_path, source_path, tag, addon_id, commit, dry_run=False):
    for path in (package_path, source_path):
        verify_checksum(path)
    package = Path(package_path).read_bytes()
    source = Path(source_path).read_bytes()
    notes = validate_artifacts(package, source, tag, addon_id, commit)
    approval_notes = build_approval_notes(tag, commit, notes)
    print(f'{tag}: Firefox package, source, SHA-256 checksums, add-on ID and source revision verified.')
    if client is None:
        if not dry_run:
            raise ValueError('AMO credentials are required for submission.')
        print('Dry run complete. AMO credentials are absent; account checks were skipped. No API requests were made.')
        return 'validated-offline'

    addon_path = f'/addons/addon/{quote(addon_id, safe="")}/'
    addon = client.request('GET', addon_path)
    print('AMO listing: ' + json.dumps({
        name: addon.get(name) for name in ('guid', 'status', 'channels', 'is_disabled')
    }, ensure_ascii=False))
    channels = addon.get('channels')
    # AMO can omit channels on a nominated listing, even for its author.
    # The authenticated all_without_unlisted history below confirms the channel.
    if addon.get('guid') != addon_id or addon.get('is_disabled') or (channels is not None and 'listed' not in channels):
        raise RuntimeError('AMO_ADDON_ID must identify the existing, enabled listed add-on owned by this account.')
    versions = client.versions(addon_path)
    print('AMO version check: ' + json.dumps({
        'listed_versions': len(versions),
        'target': [{
            'version': item.get('version'), 'channel': item.get('channel'),
            'status': item.get('file', {}).get('status'), 'source_attached': bool(item.get('source')),
        } for item in versions if item.get('version') == tag[1:]],
    }, ensure_ascii=False))
    existing = check_existing(versions, tag[1:])
    if existing:
        print(f'{tag} already exists on AMO with source attached. No upload or changes were made.')
        return 'already-exists'
    if dry_run:
        print('Dry run complete. AMO authentication and existing listing checks passed. No upload or changes were made.')
        return 'validated-online'

    upload = client.request('POST', '/addons/upload/', {'channel': 'listed'}, {
        'upload': (f'wupage-{tag[1:]}-firefox.zip', package),
    })
    upload_id = str(UUID(upload['uuid']))
    print(f'Package uploaded for validation: {upload_id}.')
    client.wait_for_validation(upload_id, tag[1:])
    # Attach source in the version-create request itself, so a submitted version
    # is never left without source by a failed follow-up upload. Inherit the
    # license from the existing listing; do not overwrite store metadata.
    created = client.request('POST', f'{addon_path}versions/', {
        'upload': upload_id,
        'approval_notes': approval_notes,
    }, {'source': (f'wupage-{tag[1:]}-firefox-source.zip', source)})
    if created.get('version') != tag[1:] or created.get('channel') != 'listed' or not created.get('source'):
        raise RuntimeError('AMO accepted the version request but returned unexpected version/source data. Check the Developer Hub before retrying.')
    print(f'{tag} submitted to AMO with source attached. Mozilla review, signing and store availability are still separate steps.')
    return 'submitted'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', type=Path)
    parser.add_argument('source', type=Path)
    parser.add_argument('--dry-run', action='store_true', help='Validate artifacts; only make read-only AMO checks when credentials are present.')
    args = parser.parse_args()
    config = {name: os.environ.get(name, '').strip() for name in (
        'AMO_ADDON_ID', 'AMO_JWT_ISSUER', 'AMO_JWT_SECRET', 'RELEASE_TAG', 'RELEASE_COMMIT',
    )}
    required = ['AMO_ADDON_ID', 'RELEASE_TAG', 'RELEASE_COMMIT']
    if not args.dry_run or config['AMO_JWT_ISSUER'] or config['AMO_JWT_SECRET']:
        required.extend(['AMO_JWT_ISSUER', 'AMO_JWT_SECRET'])
    missing = [name for name in required if not config[name]]
    if missing:
        raise ValueError('Configure these GitHub Actions variables/secrets first: ' + ', '.join(missing))
    client = AMOClient(config['AMO_JWT_ISSUER'], config['AMO_JWT_SECRET']) if config['AMO_JWT_ISSUER'] else None
    outcome = publish_package(client, args.package, args.source, config['RELEASE_TAG'],
                              config['AMO_ADDON_ID'], config['RELEASE_COMMIT'], args.dry_run)
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        messages = {
            'validated-offline': 'Dry run passed: release artifacts verified. AMO account checks skipped (credentials absent). No AMO requests made.',
            'validated-online': 'Dry run passed: artifacts, AMO authentication and existing listing verified. No uploads or changes made.',
            'already-exists': 'This version already exists on AMO with source attached. No uploads or changes made; artifact equality was not checked against AMO.',
            'submitted': 'Firefox package and source submitted to AMO. Mozilla review, signing and store rollout are still pending.',
        }
        with open(summary, 'a', encoding='utf-8') as output:
            output.write(f"Firefox AMO — **{config['RELEASE_TAG']}**\n\n{messages[outcome]}\n")


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
