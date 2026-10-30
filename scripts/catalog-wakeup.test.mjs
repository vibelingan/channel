import assert from 'node:assert/strict';
import test from 'node:test';
import { wakeCatalog } from './release/catalog-wakeup.mjs';
const sha = 'a'.repeat(40);
const nonce = '12345678-1234-1234-1234-123456789012';
function fixture() {
  const calls = [];
  return {
    calls,
    store: {
      hasPending: async () => true,
      activeRenderer: async () => ({ executorSha: sha, codeSha: sha }),
      claim: async () => true,
      finish: async (...v) => calls.push(['finish', ...v]),
    },
    github: {
      head: async () => sha,
      passedCI: async () => false,
      runs: async () => [],
      dispatch: async (...v) => calls.push(['dispatch', ...v]),
    },
    now: 1000,
    nonce,
  };
}
for (const [name, setup, status] of [
  [
    'empty queue',
    (x) => {
      x.store.hasPending = async () => false;
    },
    'idle',
  ],
  [
    'missing accepted program',
    (x) => {
      x.store.activeRenderer = async () => null;
    },
    'not-configured',
  ],
  [
    'unaccepted branch head',
    (x) => {
      x.github.head = async () => 'b'.repeat(40);
    },
    'waiting-ci',
  ],
  [
    'previous notification held',
    (x) => {
      x.store.claim = async () => false;
    },
    'held',
  ],
  [
    'existing run',
    (x) => {
      x.github.runs = async () => [
        {
          status: 'queued',
          head_branch: 'feat/seo-foundation',
          repository: { full_name: 'vibelingan/channel' },
          head_repository: { full_name: 'vibelingan/channel' },
        },
      ];
    },
    'busy',
  ],
])
  test(name, async () => {
    const x = fixture();
    setup(x);
    assert.equal((await wakeCatalog(x)).status, status);
    assert.equal(x.calls.length, 0);
  });
test('dispatch uses the existing workflow and only current public content', async () => {
  const x = fixture();
  assert.equal((await wakeCatalog(x)).status, 'sent');
  assert.equal(x.calls[0][2].inputs.renderer_sha, sha);
  assert.equal(x.calls[0][2].inputs.product_source, 'refresh');
  assert.equal(x.calls[1][2].state, 'sent');
});
test('lost dispatch response remains unknown and does not repeat', async () => {
  const x = fixture();
  let n = 0;
  x.github.dispatch = async () => {
    n++;
    throw Error('lost response');
  };
  assert.equal((await wakeCatalog(x)).status, 'unknown');
  assert.equal(n, 1);
  assert.equal(x.calls[0][2].state, 'unknown');
});
test('foreign run inventory stops dispatch', async () => {
  const x = fixture();
  x.github.runs = async () => [{ repository: { full_name: 'other/repo' } }];
  await assert.rejects(wakeCatalog(x), /foreign/);
  assert.equal(x.calls.length, 0);
});
