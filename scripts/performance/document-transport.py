"""Time the same public HTML on new and reused connections, without a browser."""
import argparse
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import urlopen

SITE = 'https://supplychainsai.com'
PATHS = (
    '/',
    '/products/p-ffc81bae-b098-4d3d-a7e5-ed539db80a1e/',
    '/blog/oem-headphone-sample-inspection-wecom-20261027/',
)
TIME_FIELDS = ('namelookup', 'connect', 'appconnect', 'pretransfer', 'starttransfer', 'total')
HEADER_FIELDS = (
    'content-type', 'content-encoding', 'x-cloudbase-request-id',
    'x-cloudbase-upstream-type', 'x-channel-blog-version',
)
FORMAT = '\t'.join([
    '%{response_code}', '%{http_version}', '%{num_connects}', '%{size_download}',
    *('%{time_' + field + '}' for field in TIME_FIELDS),
    *('%header{' + field + '}' for field in HEADER_FIELDS),
]) + '\n'


class Canonical(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attributes):
        fields = dict(attributes)
        if tag == 'link' and fields.get('rel') == 'canonical':
            self.urls.append(fields.get('href'))


def measure(directory, path, round_number):
    url = SITE + path
    files = [directory / 'first.html', directory / 'second.html']
    for file in files:
        file.unlink(missing_ok=True)
    try:
        command = subprocess.run([
            'curl', '--disable', '--silent', '--show-error', '--http2', '--compressed',
            '--connect-timeout', '12', '--max-time', '22', '--max-filesize', '2000000',
            '--write-out', FORMAT, '--output', str(files[0]), url,
            '--output', str(files[1]), url,
        ], capture_output=True, text=True, check=False, timeout=47)
        lines = command.stdout.splitlines()
    except subprocess.TimeoutExpired:
        lines = []
    rows = []
    for index, file in enumerate(files):
        row = {'path': path, 'round': round_number, 'position': index + 1}
        try:
            code, protocol, connections, transferred, *fields = lines[index].split('\t')
            times = {key: round(float(value) * 1000, 2)
                     for key, value in zip(TIME_FIELDS, fields[:len(TIME_FIELDS)], strict=True)}
            headers = dict(zip(HEADER_FIELDS, fields[len(TIME_FIELDS):], strict=True))
            data = file.read_bytes()
            page = Canonical()
            page.feed(data.decode())
            assert code == '200' and headers['content-type'].split(';')[0] == 'text/html'
            assert page.urls == [url] and b'</html>' in data[-512:].lower()
            assert times['total'] >= times['starttransfer'] >= times['pretransfer'] >= times['appconnect']
            row.update(protocol=protocol, status=int(code), newConnections=int(connections),
                       bytes=len(data), transferredBytes=int(transferred),
                       sha256=hashlib.sha256(data).hexdigest(), timingsMs=times, headers=headers)
        except (AssertionError, FileNotFoundError, IndexError, UnicodeError, ValueError):
            row['status'] = 'failed'
        rows.append(row)
    return rows


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument('country', choices=['JP', 'US'])
    cli.add_argument('output', type=Path)
    args = cli.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with urlopen('https://www.cloudflare.com/cdn-cgi/trace', timeout=15) as response:
        egress = dict(line.split('=', 1) for line in response.read().decode().splitlines())
    result = {'started': datetime.now(timezone.utc).isoformat(),
              'country': egress.get('loc'), 'colo': egress.get('colo'),
              'requestBudget': 18, 'samples': []}
    assert result['country'] == args.country, 'Egress country did not match the requested region'
    with TemporaryDirectory() as temporary:
        for count in range(1, 4):
            for path in (reversed(PATHS) if count % 2 == 0 else PATHS):
                result['samples'].extend(measure(Path(temporary), path, count))
                args.output.write_text(json.dumps(result, indent=2) + '\n')
    assert all(row['status'] == 200 for row in result['samples'])
    for path in PATHS:
        subset = [row for row in result['samples'] if row['path'] == path]
        assert len({row['sha256'] for row in subset}) == 1, 'HTML changed during measurement'


if __name__ == '__main__':
    main()
