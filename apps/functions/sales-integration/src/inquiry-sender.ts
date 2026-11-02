import * as http from 'node:http';
import * as https from 'node:https';
import {
  hashCanonicalJson,
  parseStrictJson,
  validateContract,
  type InquirySubmitted,
} from '@vibelingan-channel/sales-contracts';

export interface IntakeReceipt {
  task_id: number;
  run_id: string;
  state: 'queued';
}
export interface InquirySender {
  send(event: InquirySubmitted): Promise<IntakeReceipt>;
}
export function sourcePayloadHash(event: InquirySubmitted): string {
  const { event_id: _id, ...facts } = event;
  return hashCanonicalJson(facts);
}
export function parseIntakeReceipt(value: unknown): IntakeReceipt {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'run_id,state,task_id' ||
    !('task_id' in value) ||
    typeof value.task_id !== 'number' ||
    !Number.isSafeInteger(value.task_id) ||
    value.task_id < 1 ||
    !('run_id' in value) ||
    typeof value.run_id !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.run_id) ||
    !('state' in value) ||
    value.state !== 'queued'
  )
    throw new Error('Invalid Sales intake receipt');
  return { task_id: value.task_id, run_id: value.run_id, state: 'queued' };
}

/** The host fixes the destination; callers provide only an already scoped event. */
export class HttpInquirySender implements InquirySender {
  private readonly url: URL;
  constructor(
    endpoint: string,
    private readonly token: string,
    environment: 'test' | 'production',
    private readonly timeoutMs = 5000,
  ) {
    this.url = new URL(endpoint);
    const loopback =
      environment === 'test' && this.url.protocol === 'http:' && this.url.hostname === '127.0.0.1';
    if (
      (!loopback && this.url.protocol !== 'https:') ||
      this.url.username ||
      this.url.password ||
      this.url.search ||
      this.url.hash ||
      this.url.pathname !== '/sales/events' ||
      !/^[A-Za-z0-9_-]{32,512}$/.test(token) ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 50 ||
      timeoutMs > 10000
    )
      throw new Error('Invalid fixed Sales intake connection');
  }
  async send(input: InquirySubmitted): Promise<IntakeReceipt> {
    const event = validateContract('inquiry', input);
    const body = Buffer.from(JSON.stringify(event));
    if (body.byteLength > 262144) throw new Error('Sales event too large');
    const digest = sourcePayloadHash(event);
    try {
      return await new Promise<IntakeReceipt>((resolve, reject) => {
        const secure = this.url.protocol === 'https:';
        // Explicit native agents never consult proxy environment variables.
        const agent = secure
          ? new https.Agent({ keepAlive: false })
          : new http.Agent({ keepAlive: false });
        let settled = false;
        const finish = (error?: Error, receipt?: IntakeReceipt) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          agent.destroy();
          if (error) reject(error);
          else if (receipt) resolve(receipt);
        };
        const request = (secure ? https.request : http.request)(
          this.url,
          {
            method: 'POST',
            agent,
            headers: {
              Authorization: `Bearer ${this.token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'Accept-Encoding': 'identity',
              'Content-Length': body.byteLength,
              'X-Sales-Receipt': 'source-v1',
            },
          },
          (reply) => {
            const names = reply.rawHeaders
              .filter((_value, i) => i % 2 === 0)
              .map((name) => name.toLowerCase());
            const unique = [
              'content-type',
              'content-length',
              'content-encoding',
              'x-sales-receipt',
              'x-sales-source-sha256',
            ];
            if (
              reply.statusCode !== 202 ||
              unique.some((name) => names.filter((n) => n === name).length > 1) ||
              reply.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !==
                'application/json' ||
              ![undefined, 'identity'].includes(reply.headers['content-encoding']) ||
              reply.headers['x-sales-receipt'] !== 'source-v1' ||
              reply.headers['x-sales-source-sha256'] !== digest
            ) {
              reply.destroy();
              finish(new Error('Invalid intake headers'));
              return;
            }
            const length = reply.headers['content-length'];
            if (
              length !== undefined &&
              (!/^(0|[1-9][0-9]*)$/.test(length) || Number(length) > 16384)
            ) {
              reply.destroy();
              finish(new Error('Invalid intake length'));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            reply.on('data', (chunk: Buffer) => {
              size += chunk.length;
              if (size > 16384) {
                reply.destroy();
                finish(new Error('Intake response too large'));
              } else chunks.push(chunk);
            });
            reply.on('end', () => {
              try {
                if (length !== undefined && Number(length) !== size)
                  throw new Error('Intake response truncated');
                const text = new TextDecoder('utf-8', { fatal: true }).decode(
                  Buffer.concat(chunks),
                );
                finish(undefined, parseIntakeReceipt(parseStrictJson(text)));
              } catch {
                finish(new Error('Invalid intake body'));
              }
            });
            reply.on('error', () => finish(new Error('Intake response failed')));
            reply.on('aborted', () => finish(new Error('Intake response aborted')));
          },
        );
        const timer = setTimeout(() => {
          request.destroy();
          finish(new Error('Intake deadline exceeded'));
        }, this.timeoutMs);
        request.on('error', () => finish(new Error('Intake request failed')));
        request.end(body);
      });
    } catch {
      throw new Error('Sales intake unavailable');
    }
  }
}
