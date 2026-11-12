import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { EngineCitation } from '@vibelingan-channel/ai-engine/port';
import { boundedFetch, endpoint, record } from './http.ts';

/**
 * What is public is decided by the knowledge base, not here.
 *
 * The knowledge base binds a read-only key to one public workspace: a document
 * placed in that workspace is public at once, and one moved out stops being
 * public at once. This service holds only such a key, so it has no list of
 * documents to keep in step and nothing to redeploy when the content changes.
 *
 * Two things are still checked on this side, both against a wrong key rather
 * than against a wrong document: the key must carry the public prefix, and the
 * server it reaches must identify itself as the public read-only server. A
 * management key put here by mistake fails both, before any document is read.
 */
export const PUBLIC_KNOWLEDGE_KEY_PREFIX = 'kbpub_';
export const PUBLIC_KNOWLEDGE_SERVER = 'knowledge-base-public';

export interface KnowledgeConfig {
  url: string;
  /** A read-only key the knowledge base has bound to one public workspace. */
  apiKey: string;
  sourcePrefix: string;
  allowLocalHttp?: boolean;
  fetch?: typeof fetch;
}
export class PublicKnowledge {
  private readonly config: KnowledgeConfig;
  constructor(config: KnowledgeConfig) {
    if (
      !config.apiKey.startsWith(PUBLIC_KNOWLEDGE_KEY_PREFIX) ||
      config.apiKey.length < 32 ||
      !/^[A-Za-z0-9_-]{1,80}$/.test(config.sourcePrefix)
    )
      throw new Error('A public read-only knowledge key is required');
    endpoint(config.url, config.allowLocalHttp ?? false);
    this.config = { ...config };
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
      if (client.getServerVersion()?.name !== PUBLIC_KNOWLEDGE_SERVER)
        throw new Error('Knowledge endpoint is not the public read-only scope');
      // No workspace is sent: the key decides it, and nothing sent from here could widen it.
      const result = await call('search_documents', { query, limit: 10 });
      if (!record(result) || !Array.isArray(result.results))
        throw new Error('Invalid knowledge search');
      let rows: unknown[] = result.results;
      if (!rows.length) {
        // Nothing matched the wording: fall back to the most recently updated public documents.
        const listed = await call('list_documents', { limit: 3, offset: 0 });
        if (!record(listed) || !Array.isArray(listed.documents))
          throw new Error('Invalid knowledge listing');
        rows = listed.documents;
      }
      const candidates = rows.filter(
        (row): row is Record<string, unknown> & { id: number } =>
          record(row) && Number.isSafeInteger(row.id) && Number(row.id) > 0,
      );
      const citations: EngineCitation[] = [];
      let workspace: unknown;
      for (const row of candidates.slice(0, 3)) {
        const doc = await call('get_document', { document_id: row.id });
        if (
          !record(doc) ||
          doc.id !== row.id ||
          typeof doc.title !== 'string' ||
          typeof doc.content !== 'string' ||
          !Number.isSafeInteger(doc.workspace_id)
        )
          throw new Error('Invalid knowledge document');
        // One key is one workspace: documents from two means the scope is not what it claims.
        workspace ??= doc.workspace_id;
        if (doc.workspace_id !== workspace) throw new Error('Knowledge document scope changed');
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
