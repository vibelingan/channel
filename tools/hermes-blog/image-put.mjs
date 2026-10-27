import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
/** The isolated helper receives only a short-lived one-object grant, never the website key. */
export async function putImage(
  url,
  options,
  { helper = join(dirname(fileURLToPath(import.meta.url)), 'image_put.py') } = {},
) {
  const bytes = options.body;
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > 3 * 1024 * 1024 ||
    options.timeoutMs !== 60000
  )
    throw Error('Bounded image PUT required');
  const result = await new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', [helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      env: Object.fromEntries(
        ['HOME', 'PATH', 'LANG'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]),
      ),
    });
    let output = '';
    child.stderr.resume();
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 8192) child.kill('SIGKILL');
    });
    child.once('error', () => reject(Error('Image uploader could not start')));
    child.once('close', (code) => {
      try {
        if (code !== 0) throw Error('Image upload was not confirmed');
        resolve(JSON.parse(output));
      } catch {
        reject(Error('Image upload was not confirmed'));
      }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(
      JSON.stringify({
        version: 1,
        url,
        headers: options.headers,
        byteSize: bytes.length,
        checksumSha256: createHash('sha256').update(bytes).digest('hex'),
        bodyBase64: bytes.toString('base64'),
        timeoutMs: options.timeoutMs,
      }),
    );
  });
  z.object({
    ok: z.literal(true),
    status: z.literal(200),
    responseBytes: z.literal(0),
    byteSize: z.literal(bytes.length),
    networkProfile: z.literal('linux-bbr-v1'),
    durationMs: z.number().int().nonnegative().max(options.timeoutMs),
  })
    .strict()
    .parse(result);
  return { status: 200, headers: new Headers(), body: Buffer.alloc(0) };
}
