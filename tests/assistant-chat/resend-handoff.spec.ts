import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { decryptHandoff, handoffPage } from '../../scripts/resend-secret-handoff.mjs';

test('owner can encrypt locally without network requests and receiver recovers only the fake key', async ({
  page,
}) => {
  const keys = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const dir = resolve('output/resend-setup/test');
  await mkdir(dir, { recursive: true });
  const file = resolve(dir, `owner-${test.info().project.name}.html`);
  await writeFile(file, handoffPage(keys.publicKey));
  const network: string[] = [];
  page.on('request', (r) => {
    if (r.url().startsWith('http')) network.push(r.url());
  });
  await page.goto(pathToFileURL(file).href);
  await page.getByLabel('粘贴密钥').fill('re_SYNTHETIC_BROWSER_TEST_ONLY');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '生成加密交接文件' }).click();
  const result = await download;
  expect(result.suggestedFilename()).toBe('RESEND_API_KEY-encrypted.json');
  const target = resolve(dir, `browser-${test.info().project.name}.json`);
  await result.saveAs(target);
  const content = await readFile(target, 'utf8');
  expect(content).not.toContain('SYNTHETIC_BROWSER');
  expect(decryptHandoff(JSON.parse(content), keys.privateKey)).toEqual({
    purpose: 'RESEND_API_KEY',
    secret: 're_SYNTHETIC_BROWSER_TEST_ONLY',
  });
  await expect(page.getByLabel('粘贴密钥')).toHaveValue('');
  await expect(page.locator('output')).toContainText('已生成加密文件');
  expect(network).toEqual([]);
});
