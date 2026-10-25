import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
test('only an actual restored-document event reloads the server Blog, and normal loading does not loop', () => {
  const source = readFileSync(
    new URL('../../components/BlogRuntimeFreshness.astro', import.meta.url),
    'utf8',
  );
  const script = /<script is:inline>([\s\S]*?)<\/script>/.exec(source)?.[1];
  assert(script);
  let reloads = 0;
  let handler: ((event: { persisted: boolean }) => void) | undefined;
  runInNewContext(script, {
    window: {
      addEventListener: (event: string, callback: typeof handler) => {
        assert.equal(event, 'pageshow');
        handler = callback;
      },
      location: {
        reload: () => {
          reloads++;
        },
      },
    },
  });
  assert(handler);
  handler({ persisted: false });
  assert.equal(reloads, 0);
  handler({ persisted: true });
  assert.equal(reloads, 1);
  handler({ persisted: false });
  assert.equal(reloads, 1);
});
