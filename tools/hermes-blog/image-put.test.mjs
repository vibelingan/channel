import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { putImage } from './image-put.mjs';
test('actual helper subprocess receives only this file grant and raw bytes; its acknowledgement is checked', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'image-put-'));
  t.after(() => rm(root, { recursive: true }));
  const helper = join(root, 'upload.py');
  await writeFile(
    helper,
    `import sys,json,base64,hashlib\np=json.load(sys.stdin);b=base64.b64decode(p['bodyBase64']);assert hashlib.sha256(b).hexdigest()==p['checksumSha256'];assert set(p)=={'version','url','headers','bodyBase64','byteSize','checksumSha256','timeoutMs'};print(json.dumps({'ok':True,'status':200,'responseBytes':0,'byteSize':len(b),'networkProfile':'linux-bbr-v1','durationMs':1}))`,
  );
  const result = await putImage(
    'https://signed-target.example/owned-file',
    {
      body: Buffer.from('original bytes'),
      headers: { authorization: 'single-object' },
      timeoutMs: 60000,
    },
    { helper },
  );
  assert.equal(result.status, 200);
  assert.equal(result.body.length, 0);
  await writeFile(helper, 'print("{\\"ok\\":true,\\"status\\":503}")');
  await assert.rejects(
    putImage(
      'https://signed-target.example/owned-file',
      { body: Buffer.from('original bytes'), headers: {}, timeoutMs: 60000 },
      { helper },
    ),
  );
});
