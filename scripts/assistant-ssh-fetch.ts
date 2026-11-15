/** Local acceptance only: the existing server keeps its credentials. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const remote = '/tmp/channel-assistant-real-20261102/relay.py';

export function sshAccess(configFile: string, host: string) {
  if (!configFile || !/^[a-zA-Z0-9_-]+$/.test(host))
    throw new Error('Explicit SSH profile required');
  const socket = join(
    tmpdir(),
    `channel-ssh-${createHash('sha256')
      .update(configFile + host)
      .digest('hex')
      .slice(0, 16)}`,
  );
  let connected: Promise<void> | undefined;
  function connect() {
    connected ??= new Promise<void>((resolve, reject) => {
      const child = spawn(
        'ssh',
        [
          '-MNf',
          '-o',
          'ControlMaster=auto',
          '-o',
          'ControlPersist=120',
          '-o',
          `ControlPath=${socket}`,
          '-F',
          configFile,
          host,
        ],
        { stdio: 'ignore' },
      );
      child.on('error', () => reject(new Error('SSH connection failed')));
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error('SSH connection failed')),
      );
    });
    return connected;
  }
  async function command(command: string, input: string, signal?: AbortSignal) {
    await connect();
    return new Promise<string>((resolve, reject) => {
      const child = spawn(
        'ssh',
        ['-o', 'ControlMaster=no', '-o', `ControlPath=${socket}`, '-F', configFile, host, command],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
      let body = '';
      let bytes = 0;
      let done = false;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(body);
      };
      const abort = () => {
        child.kill('SIGTERM');
        finish(new Error('SSH request aborted'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.on('error', () => finish(new Error('SSH request failed')));
      child.stdout.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 1048576) {
          child.kill('SIGTERM');
          finish(new Error('SSH reply too large'));
        } else body += chunk.toString();
      });
      child.stderr.resume();
      child.on('close', (code) =>
        code === 0 ? finish() : finish(new Error('SSH request failed')),
      );
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
      if (signal?.aborted) abort();
    });
  }
  return {
    async install() {
      await command(
        `umask 077; mkdir -p /tmp/channel-assistant-real-20261102; cat > ${remote}`,
        await readFile(new URL('./assistant-real-relay.py', import.meta.url), 'utf8'),
      );
      return JSON.parse(await command(`python3 ${remote} --describe`, '')) as {
        model: string;
        model_base_url: string;
        mcp: string;
        public_workspace: string;
        knowledge_credential_id: string;
      };
    },
    fetch: (async (url, init) => {
      const target = new URL(
        typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
      );
      const kind =
        target.href === 'https://model.ssh.invalid/v1/chat/completions'
          ? 'model'
          : target.href === 'http://127.0.0.1:9021/mcp'
            ? 'mcp'
            : undefined;
      if (!kind) throw new Error('SSH destination denied');
      const start = Date.now();
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      if (process.env.ASSISTANT_TRACE_IO === '1')
        console.error(JSON.stringify({ event: 'provider_request', kind, method: init?.method }));
      const reply: { status: number; headers: Record<string, string>; body: string } = JSON.parse(
        await command(
          `python3 ${remote}`,
          JSON.stringify({
            kind,
            method: init?.method ?? 'GET',
            headers,
            body: init?.body ? JSON.parse(String(init.body)) : null,
          }),
          init?.signal ?? undefined,
        ),
      );
      if (process.env.ASSISTANT_TRACE_IO === '1')
        console.error(
          JSON.stringify({
            event: 'provider_reply',
            kind,
            status: reply.status,
            duration_ms: Date.now() - start,
          }),
        );
      return new Response([202, 204, 304].includes(reply.status) ? null : reply.body, {
        status: reply.status,
        headers: reply.headers,
      });
    }) as typeof fetch,
  };
}
