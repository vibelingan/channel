import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFunctionFixture } from './catalog-native-fixture.mjs';
import { checkFunctionArchive, functionZipLimit } from './release/function-archive.mjs';
import { nativeFunctionZipLimit } from './release/native-function-archive.mjs';

test('the actual pinned Linux decoder ZIP has a separate bounded format; small recovery still refuses it', () => {
  const x = nativeFunctionFixture();
  try {
    const bytes = x.pack();
    assert(bytes.length > functionZipLimit);
    assert.throws(() => checkFunctionArchive(bytes));
    const checked = checkFunctionArchive(bytes, { profile: 'catalog-native-decoder' });
    assert.equal(checked.format, 'channel-native-decoder-zip-v1');
    assert(checked.files.length > 100);
    assert(checked.contentSha256['vendor/image-decoder.mjs']);
    const binary = checked.files.find((path) => path.endsWith('.node'));
    assert(binary);
    if (process.platform === 'linux' && process.arch === 'x64')
      assert.doesNotThrow(() =>
        checkFunctionArchive(bytes, { profile: 'catalog-native-decoder', smoke: true }),
      );
    else
      assert.throws(
        () => checkFunctionArchive(bytes, { profile: 'catalog-native-decoder', smoke: true }),
        /matching Linux|matching.*runtime/,
      );
    const pkg = JSON.parse(x.read('package.json'));
    pkg.dependencies = { unreviewed: '1' };
    const unsafeManifest = JSON.parse(x.read('image-decoder-manifest.json'));
    unsafeManifest.packages[0].name = '../../../../outside';
    for (const edits of [
      { 'image-decoder-manifest.json': JSON.stringify(unsafeManifest) },
      { '../escape.txt': 'unsafe' },
      { 'package.json': JSON.stringify(pkg) },
      { 'vendor/image-decoder.mjs': 'export default "tampered";' },
      {
        'image-decoder-manifest.json': x
          .read('image-decoder-manifest.json')
          .replace('linux-x64', 'darwin-arm64'),
      },
      { [binary]: null },
    ]) {
      const malformed = x.pack(edits);
      assert.throws(
        () => checkFunctionArchive(malformed, { profile: 'catalog-native-decoder' }),
        (error) => error.code === 'NATIVE_ARCHIVE_INVALID',
      );
    }
    assert.throws(() =>
      checkFunctionArchive(Buffer.alloc(nativeFunctionZipLimit + 1), {
        profile: 'catalog-native-decoder',
      }),
    );
  } finally {
    x.cleanup();
  }
});
