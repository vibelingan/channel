import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EngineCitation } from '@vibelingan-channel/ai-engine/port';
import { boundedFetch, endpoint, record } from './http.ts';

export interface KnowledgeConfig {
  url: string;
  apiKey: string;
  workspaceId: number;
  publicDocumentIds: number[];
  publicTag: string;
  sourcePrefix: string;
  allowLocalHttp?: boolean;
  fetch?: typeof fetch;
}
export class PublicKnowledge {
  private readonly config: KnowledgeConfig;
  constructor(config: KnowledgeConfig) {
    if (
      !config.apiKey ||
      !Number.isSafeInteger(config.workspaceId) ||
      config.workspaceId < 1 ||
      !config.publicDocumentIds.length ||
      config.publicDocumentIds.length > 100 ||
      new Set(config.publicDocumentIds).size !== config.publicDocumentIds.length ||
      config.publicDocumentIds.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      !config.publicTag.trim() ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(config.sourcePrefix)
    )
      throw new Error('An explicit public knowledge scope is required');
    endpoint(config.url, config.allowLocalHttp ?? false);
    this.config = { ...config, publicDocumentIds: [...config.publicDocumentIds] };
  }
  async search(
    query: string,
    signal: AbortSignal,
    budget: { remaining: number },
  ): Promise<EngineCitation[]> {
    if (!query.trim() || query.length > 200) throw new Error('Invalid knowledge query');
    const config = this.config;
    const target = endpoint(config.url, config.allowLocalHttp ?? false);
    const controller = AbortSignal.any([signal, AbortSignal.timeout(45000)]);
    const client = new Client(
      { name: 'channel-public-assistant', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(target, {
      requestInit: { headers: { Authorization: `Bearer ${config.apiKey}` }, signal: controller },
      fetch: boundedFetch(target, config.fetch ?? fetch),
      reconnectionOptions: {
        maxRetries: 0,
        maxReconnectionDelay: 1000,
        initialReconnectionDelay: 100,
        reconnectionDelayGrowFactor: 1,
      },
    });
    const abort = () => {
      void transport.close().catch(() => undefined);
    };
    controller.addEventListener('abort', abort, { once: true });
    const call = async (
      name: 'search_documents' | 'list_documents' | 'get_document',
      args: Record<string, unknown>,
    ) => {
      controller.throwIfAborted();
      if (--budget.remaining < 0) throw new Error('Knowledge tool budget exceeded');
      const reply = await client.callTool({ name, arguments: args }, undefined, {
        signal: controller,
        timeout: 15000,
      });
      if (
        reply.isError ||
        !Array.isArray(reply.content) ||
        reply.content.length !== 1 ||
        !record(reply.content[0]) ||
        reply.content[0].type !== 'text' ||
        typeof reply.content[0].text !== 'string'
      )
        throw new Error('Invalid knowledge tool result');
      const body = reply.content[0].text;
      if (name === 'search_documents' && body.startsWith('（无命中）')) return { results: [] };
      return JSON.parse(body) as unknown;
    };
    try {
      await client.connect(transport, { signal: controller, timeout: 15000 });
      const result = await call('search_documents', {
        query,
        limit: 10,
        workspace: String(config.workspaceId),
      });
      if (!record(result) || !Array.isArray(result.results))
        throw new Error('Invalid knowledge search');
      let rows: unknown[] = result.results;
      if (!rows.some((row) => record(row) && config.publicDocumentIds.includes(Number(row.id)))) {
        const listed = await call('list_documents', {
          workspace: String(config.workspaceId),
          tag: config.publicTag,
          limit: 200,
          offset: 0,
        });
        if (!record(listed) || !Array.isArray(listed.documents))
          throw new Error('Invalid knowledge listing');
        rows = listed.documents;
      }
      const candidates = rows.filter(
        (row): row is Record<string, unknown> =>
          record(row) &&
          typeof row.id === 'number' &&
          config.publicDocumentIds.includes(row.id) &&
          Array.isArray(row.tags) &&
          row.tags.includes(config.publicTag) &&
          !row.tags.some((tag) =>
            ['内部', 'internal', 'private', 'channel-blog-private-draft'].includes(String(tag)),
          ),
      );
      const citations: EngineCitation[] = [];
      for (const row of candidates.slice(0, 3)) {
        const doc = await call('get_document', { document_id: row.id });
        // get_document has no workspace parameter: verify the returned owner again.
        if (
          !record(doc) ||
          doc.id !== row.id ||
          doc.workspace_id !== config.workspaceId ||
          typeof doc.title !== 'string' ||
          typeof doc.content !== 'string' ||
          doc.content.length > 64000 ||
          !hasPublicTag(doc.tags, config.publicTag)
        )
          throw new Error('Knowledge document scope changed');
        citations.push({
          sourceId: `${config.sourcePrefix}/vibekb/${doc.id}`,
          title: doc.title.slice(0, 1000),
          snippet: doc.content.slice(0, 10000),
          retrievedAt: new Date().toISOString(),
        });
      }
      return citations;
    } finally {
      controller.removeEventListener('abort', abort);
      await client.close().catch(() => undefined);
    }
  }
}
function hasPublicTag(value: unknown, tag: string): boolean {
  let tags = value;
  if (typeof tags === 'string') {
    try {
      tags = JSON.parse(tags);
    } catch {
      return false;
    }
  }
  return (
    Array.isArray(tags) &&
    tags.includes(tag) &&
    !tags.some((t) =>
      ['内部', 'internal', 'private', 'channel-blog-private-draft'].includes(String(t)),
    )
  );
}
