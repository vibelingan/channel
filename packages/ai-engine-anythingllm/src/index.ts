import { createHash } from 'node:crypto';
import type { EngineCapabilities } from '@vibelingan-channel/ai-engine/capabilities';
import { EngineError } from '@vibelingan-channel/ai-engine/errors';
import type {
  ConversationEngine,
  EngineCancelResult,
  EngineCitation,
  EngineEvent,
  EngineHealth,
  EngineRunHandle,
  EngineRunRequest,
  KnowledgeAttestation,
} from '@vibelingan-channel/ai-engine/port';

export interface AnythingLlmEngineOptions {
  baseUrl: string;
  apiKey: string;
  workspaceSlug: string;
  version: string;
  imageDigest?: string;
  citationsVerified: boolean;
  credentialRotationCounter: number;
  allowInsecureRemoteHttp?: boolean;
  fetchImpl?: typeof fetch;
  now?: () => string;
}

interface PendingRun {
  request: EngineRunRequest;
  handle: EngineRunHandle;
}

export class AnythingLlmEngine implements ConversationEngine {
  readonly capabilities: EngineCapabilities;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #workspaceSlug: string;
  readonly #rotationCounter: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => string;
  readonly #pending = new Map<string, PendingRun>();

  constructor(options: AnythingLlmEngineOptions) {
    this.#baseUrl = safeBaseUrl(options.baseUrl, options.allowInsecureRemoteHttp === true);
    if (options.apiKey.length < 16) throw new Error('AnythingLLM API key is missing or too short');
    if (!options.workspaceSlug) throw new Error('AnythingLLM workspace slug is required');
    this.#apiKey = options.apiKey;
    this.#workspaceSlug = options.workspaceSlug;
    this.#rotationCounter = options.credentialRotationCounter;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.capabilities = {
      engineId: 'anythingllm',
      engineVersion: options.version,
      ...(options.imageDigest ? { imageDigest: options.imageDigest } : {}),
      // The thread/new API creates a new vendor thread and exposes no atomic
      // operation-id contract. The composed worker/store must compensate.
      supportsIdempotentCreate: false,
      supportsRunLookupByOperationId: false,
      supportsStop: true,
      supportsOutOfBandStop: false,
      supportsCitations: options.citationsVerified,
    };
  }

  async createRun(request: EngineRunRequest, signal: AbortSignal): Promise<EngineRunHandle> {
    const response = await this.#requestJson(
      `/api/v1/workspace/${encodeURIComponent(this.#workspaceSlug)}/thread/new`,
      {
        method: 'POST',
        body: JSON.stringify({ name: `channel-${request.operationId}` }),
        signal,
      },
    );
    const slug = nestedString(response, ['thread', 'slug']);
    if (!slug) throw new EngineError('invalid_request');
    const handle = { operationId: request.operationId, engineRunId: slug };
    this.#pending.set(slug, { request, handle });
    return handle;
  }

  async *streamRun(handle: EngineRunHandle, signal: AbortSignal): AsyncIterable<EngineEvent> {
    const pending = this.#pending.get(handle.engineRunId);
    if (!pending || pending.handle.operationId !== handle.operationId) {
      yield engineError('invalid_request', false);
      return;
    }
    const message = [...pending.request.turns]
      .reverse()
      .find((turn) => turn.role === 'visitor')?.text;
    if (!message) {
      yield engineError('invalid_request', false);
      return;
    }
    let response: Response;
    try {
      response = await this.#fetch(
        `${this.#baseUrl}/api/v1/workspace/${encodeURIComponent(this.#workspaceSlug)}/thread/${encodeURIComponent(handle.engineRunId)}/stream-chat`,
        {
          method: 'POST',
          headers: this.#headers({ Accept: 'text/event-stream' }),
          body: JSON.stringify({ message, mode: 'chat' }),
          signal,
        },
      );
    } catch (caught) {
      if (signal.aborted) return;
      yield engineError('transient', true);
      return;
    }
    if (!response.ok || !response.body) {
      yield engineError(response.status === 429 ? 'quota' : 'unavailable', false);
      return;
    }

    let finalText = '';
    let finalCitations: EngineCitation[] = [];
    for await (const frame of jsonFrames(response.body)) {
      if (signal.aborted) return;
      const type = stringField(frame, 'type');
      if (type === 'abort' || stringField(frame, 'error')) {
        yield engineError(classifyAbort(frame), false);
        return;
      }
      const text = stringField(frame, 'textResponse');
      if (text) {
        finalText += text;
        yield { type: 'token', text };
      }
      const citations = mapSources(frame.sources, this.#now());
      for (const citation of citations) yield { type: 'citation', citation };
      if (citations.length > 0) finalCitations = citations;
      if (frame.close === true) {
        if (!finalText.trim()) {
          yield engineError('unavailable', false);
          return;
        }
        yield { type: 'final', text: finalText, citations: finalCitations };
        this.#pending.delete(handle.engineRunId);
        return;
      }
    }
    yield engineError('transient', true);
  }

  cancelRun(_handle: EngineRunHandle): Promise<EngineCancelResult> {
    // Owner cancellation is AbortSignal-driven. Claiming success here would lie
    // about an out-of-band operation this API does not expose.
    return Promise.resolve('unknown_run');
  }

  async health(): Promise<EngineHealth> {
    try {
      const response = await this.#fetch(`${this.#baseUrl}/api/v1/auth`, {
        headers: this.#headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return { status: 'degraded', checkedAt: this.#now() };
      const body = (await response.json()) as unknown;
      return {
        status: nestedBoolean(body, ['authenticated']) === true ? 'live' : 'degraded',
        checkedAt: this.#now(),
      };
    } catch {
      return { status: 'degraded', checkedAt: this.#now() };
    }
  }

  attestKnowledgeCredential(): Promise<KnowledgeAttestation> {
    return Promise.resolve({
      credentialId: createHash('sha256').update(this.#apiKey).digest('hex').slice(0, 16),
      rotationCounter: this.#rotationCounter,
      spaceId: this.#workspaceSlug,
    });
  }

  async #requestJson(path: string, init: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: this.#headers(),
      });
    } catch {
      throw new EngineError('transient');
    }
    if (!response.ok) {
      throw new EngineError(response.status === 429 ? 'quota' : 'unavailable');
    }
    return response.json() as Promise<unknown>;
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.#apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }
}

function safeBaseUrl(value: string, allowInsecure: boolean): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || allowInsecure))) {
    throw new Error('AnythingLLM requires HTTPS for remote endpoints');
  }
  return url.toString().replace(/\/$/, '');
}

async function* jsonFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Record<string, unknown>> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const frame = parseFrame(line);
        if (frame) yield frame;
      }
    }
    const frame = parseFrame(buffer + decoder.decode());
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(line: string): Record<string, unknown> | null {
  const candidate = line.replace(/^data:\s*/, '').trim();
  if (!candidate || candidate === '[DONE]' || candidate.startsWith(':')) return null;
  try {
    const value = JSON.parse(candidate) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function mapSources(value: unknown, retrievedAt: string): EngineCitation[] {
  if (!Array.isArray(value)) return [];
  const citations: EngineCitation[] = [];
  for (const source of value) {
    if (!isRecord(source)) continue;
    const metadata = isRecord(source.metadata) ? source.metadata : {};
    const title = stringField(source, 'title') || stringField(metadata, 'title');
    if (!title) continue;
    const rawId =
      stringField(source, 'id') ||
      stringField(metadata, 'sourceId') ||
      stringField(metadata, 'chunkSource') ||
      title;
    const url = stringField(source, 'url') || stringField(metadata, 'url');
    citations.push({
      sourceId: createHash('sha256').update(rawId).digest('hex').slice(0, 24),
      title,
      ...(url ? { url } : {}),
      retrievedAt,
    });
  }
  return citations;
}

function classifyAbort(
  frame: Record<string, unknown>,
): 'quota' | 'unavailable' | 'content_filtered' {
  const detail = stringField(frame, 'error').toLowerCase();
  if (detail.includes('quota') || detail.includes('balance') || detail.includes('rate'))
    return 'quota';
  if (detail.includes('filter') || detail.includes('safety')) return 'content_filtered';
  return 'unavailable';
}

function engineError(
  category: 'transient' | 'quota' | 'unavailable' | 'invalid_request' | 'content_filtered',
  retriable: boolean,
): EngineEvent {
  return { type: 'error', category, retriable };
}

function nestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function nestedBoolean(value: unknown, path: string[]): boolean | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'boolean' ? current : undefined;
}

function stringField(value: Record<string, unknown>, key: string): string {
  return typeof value[key] === 'string' ? value[key] : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
