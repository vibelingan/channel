/**
 * The TencentDB for PostgreSQL CA bundle the AI services trust.
 *
 * DATABASE_URL uses sslmode=verify-full with sslrootcert pointing at this file
 * inside the images. Measured in the node:22.13.0 runtime image: a trust file
 * holding ONLY the intermediate refuses every connection, and one holding only
 * the root refuses whenever the database presents its own certificate alone.
 * Root + intermediate verifies in both cases, so the bundle must stay complete.
 */
import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(repoRoot, 'certs/tencentdb-postgres-ca.crt');
const COPY_LINE = 'COPY certs/tencentdb-postgres-ca.crt ./certs/tencentdb-postgres-ca.crt';

// Pinned from Tencent's TencentDB-PG-SSL-CA.zip (ca.pem and ca.p7b agree).
const INTERMEDIATE = {
  cn: 'TencentDB for PostgreSQL CA',
  fingerprint256:
    '19:B8:45:F6:9A:6D:9A:69:69:8D:FA:FA:75:BB:BD:18:6F:B2:E3:AC:C7:96:FB:D4:2C:8F:D1:1E:C4:13:2F:D0',
};
const ROOT = {
  cn: 'Tencent Root CA',
  fingerprint256:
    '70:E2:E9:FC:C3:06:7F:87:CB:B5:4B:B1:D9:AA:EC:25:47:F1:5F:F4:83:BE:A1:EC:8C:5C:67:40:1F:72:6F:01',
};

function bundle() {
  const text = readFileSync(BUNDLE, 'utf8');
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  return { text, certs: blocks.map((pem) => new X509Certificate(pem)) };
}

const commonName = (cert) => /(?:^|\n)CN=([^\n]+)/.exec(cert.subject)?.[1];

test('the bundle holds exactly the TencentDB intermediate and Tencent Root CA', () => {
  const { certs } = bundle();
  assert.equal(certs.length, 2, 'the bundle must contain both certificates, not one');
  const byName = new Map(certs.map((cert) => [commonName(cert), cert]));
  for (const expected of [INTERMEDIATE, ROOT]) {
    const cert = byName.get(expected.cn);
    assert.ok(cert, `${expected.cn} is missing from the bundle`);
    assert.equal(
      cert.fingerprint256,
      expected.fingerprint256,
      `${expected.cn} is not the pinned certificate`,
    );
    assert.equal(cert.ca, true, `${expected.cn} is not a CA certificate`);
  }
});

test('the intermediate is issued by the bundled root, and the root is self-signed', () => {
  const { certs } = bundle();
  const root = certs.find((cert) => commonName(cert) === ROOT.cn);
  const intermediate = certs.find((cert) => commonName(cert) === INTERMEDIATE.cn);
  assert.ok(root && intermediate);
  assert.ok(intermediate.checkIssued(root), 'the intermediate was not issued by the bundled root');
  assert.ok(
    intermediate.verify(root.publicKey),
    "the intermediate's signature does not verify against the root",
  );
  assert.ok(root.checkIssued(root) && root.verify(root.publicKey), 'the root is not self-signed');
});

test('the bundle contains no private key material', () => {
  assert.doesNotMatch(bundle().text, /PRIVATE KEY/);
});

test('both service images copy the bundle in their RUNTIME stage, under /app', () => {
  // Bound to the runtime stage specifically: a copy step in the build stage
  // would pass a whole-file text search and still ship an image without it.
  for (const service of ['ai-bff', 'ai-worker']) {
    const dockerfile = readFileSync(join(repoRoot, `apps/${service}/Dockerfile`), 'utf8');
    const runtime = dockerfile.slice(dockerfile.indexOf(' AS runtime'));
    assert.ok(runtime.length < dockerfile.length, `${service} has no runtime stage`);
    assert.match(runtime, /^WORKDIR \/app$/m, `${service} runtime stage is not rooted at /app`);
    assert.ok(runtime.includes(COPY_LINE), `${service} runtime image does not copy the CA bundle`);
  }
});
