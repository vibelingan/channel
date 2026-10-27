"""One-object HTTPS PUT; BBR applies only to this socket, never the system default."""
import base64
import hashlib
import http.client
import json
import socket
import ssl
import sys
import time
from urllib.parse import urlsplit, urlunsplit

MAX_IMAGE = 3 * 1024 * 1024
MAX_INPUT = (MAX_IMAGE // 3) * 4 + 32768
HOST = '6469-diversity-123-d9grnqfux221323bb-1443560658.cos.ap-shanghai.myqcloud.com'
HEADERS = {'Signature', 'authorization', 'x-cos-security-token', 'x-cos-meta-fileid', 'key'}


class NetworkProfileUnavailable(Exception):
    pass


class BbrConnection(http.client.HTTPSConnection):
    def connect(self):
        if sys.platform != 'linux' or not hasattr(socket, 'TCP_CONGESTION'):
            raise NetworkProfileUnavailable()
        last = None
        for family, kind, proto, _, address in socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM):
            raw = socket.socket(family, kind, proto)
            try:
                try:
                    raw.setsockopt(socket.IPPROTO_TCP, socket.TCP_CONGESTION, b'bbr')
                except OSError as error:
                    raise NetworkProfileUnavailable() from error
                if raw.getsockopt(socket.IPPROTO_TCP, socket.TCP_CONGESTION, 16).rstrip(b'\0') != b'bbr':
                    raise NetworkProfileUnavailable()
                raw.settimeout(self.timeout)
                raw.connect(address)
                self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
                return
            except NetworkProfileUnavailable:
                raw.close()
                raise
            except OSError as error:
                raw.close()
                last = error
        if last:
            raise last
        raise OSError('No upload address')


def prepare(value):
    if not isinstance(value, dict) or set(value) != {'version', 'url', 'headers', 'bodyBase64', 'byteSize', 'checksumSha256', 'timeoutMs'} or value['version'] != 1:
        raise ValueError('Invalid upload envelope')
    url = urlsplit(value['url'])
    if url.scheme != 'https' or url.hostname != HOST or url.username or url.password or url.fragment or url.port:
        raise ValueError('Unexpected upload target')
    headers = value['headers']
    if not isinstance(headers, dict) or set(headers) != HEADERS or any(not isinstance(v, str) or not 0 < len(v) <= 8192 or '\r' in v or '\n' in v for v in headers.values()):
        raise ValueError('Invalid upload headers')
    if headers['Signature'] != headers['authorization']:
        raise ValueError('Upload signature differs')
    size, timeout = value['byteSize'], value['timeoutMs']
    if type(size) is not int or not 0 < size <= MAX_IMAGE or type(timeout) is not int or not 1 <= timeout <= 60000:
        raise ValueError('Upload bounds exceeded')
    if not isinstance(value['bodyBase64'], str) or len(value['bodyBase64']) > (MAX_IMAGE // 3) * 4:
        raise ValueError('Upload bytes exceed limit')
    body = base64.b64decode(value['bodyBase64'], validate=True)
    if len(body) != size or hashlib.sha256(body).hexdigest() != value['checksumSha256']:
        raise ValueError('Upload bytes changed')
    return url, headers, body, timeout


def upload(value, connection_factory=BbrConnection):
    url, headers, body, timeout = prepare(value)
    start = time.monotonic()
    connection = connection_factory(url.hostname, timeout=timeout / 1000)
    try:
        connection.request('PUT', urlunsplit(('', '', url.path or '/', url.query, '')), body=body, headers=headers)
        response = connection.getresponse()
        length = response.getheader('Content-Length')
        if length is not None and (not length.isdecimal() or int(length) > 32768):
            raise ValueError('Unexpected upload response')
        received = response.read(32769)
        if response.status != 200 or received or (time.monotonic() - start) * 1000 >= timeout:
            raise ValueError('Upload was not confirmed')
        return {'ok': True, 'status': 200, 'responseBytes': 0, 'byteSize': len(body), 'networkProfile': 'linux-bbr-v1', 'durationMs': round((time.monotonic() - start) * 1000)}
    finally:
        connection.close()


def main():
    data = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(data) > MAX_INPUT:
        raise ValueError('Upload envelope exceeds limit')
    print(json.dumps(upload(json.loads(data))))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'ok': False, 'errorCode': 'NETWORK_PROFILE_UNAVAILABLE' if isinstance(error, NetworkProfileUnavailable) else 'UPLOAD_UNCONFIRMED'}))
        sys.exit(1)
