import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function extractGeneratedApiKey(body) {
  const candidates = [body?.apiKey, body?.apiKey?.key, body?.apiKey?.token, body?.key, body?.token];
  const key = candidates.find(
    (candidate) => typeof candidate === 'string' && candidate.trim().length >= 20,
  );
  if (!key) throw new Error('generate-api-key response did not contain a usable key');
  return key.trim();
}

export function updateEnvText(source, key, allowRotate = false) {
  const existing = source.match(/^ANYTHINGLLM_API_KEY=(.*)$/m)?.[1]?.trim();
  if (existing && !allowRotate) {
    throw new Error('ANYTHINGLLM_API_KEY already exists; pass --rotate to replace it deliberately');
  }
  const credentialId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const replace = (text, name, value) => {
    const line = `${name}=${value}`;
    return new RegExp(`^${name}=.*$`, 'm').test(text)
      ? text.replace(new RegExp(`^${name}=.*$`, 'm'), line)
      : `${text.replace(/\n?$/, '\n')}${line}\n`;
  };
  return replace(
    replace(source, 'ANYTHINGLLM_API_KEY', key),
    'AI_KNOWLEDGE_CREDENTIAL_ID',
    credentialId,
  );
}

async function main() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env.ai');
  const source = readFileSync(envPath, 'utf8');
  // The worker uses http://anythingllm:3001 inside Docker. This helper runs on
  // the host and deliberately uses a separate loopback-only admin URL.
  const baseUrl = (process.env.ANYTHINGLLM_LOCAL_ADMIN_URL ?? 'http://127.0.0.1:53001').replace(
    /\/$/,
    '',
  );
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1'].includes(url.hostname)) {
    throw new Error('local key generation requires a loopback HTTP AnythingLLM URL');
  }
  const response = await fetch(`${baseUrl}/api/system/generate-api-key`, {
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`generate-api-key returned HTTP ${response.status}`);
  const key = extractGeneratedApiKey(body);
  const next = updateEnvText(source, key, process.argv.includes('--rotate'));
  const temporary = `${envPath}.tmp-${process.pid}`;
  writeFileSync(temporary, next, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  chmodSync(temporary, 0o600);
  renameSync(temporary, envPath);
  chmodSync(envPath, 0o600);
  console.log('Stored the local API key and its non-secret attestation in .env.ai (mode 0600).');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : 'local key generation failed');
    process.exitCode = 1;
  });
}
