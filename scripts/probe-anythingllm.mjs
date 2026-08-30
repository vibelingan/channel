import { pathToFileURL } from 'node:url';

function assertSafeBaseUrl(baseUrl, allowInsecure) {
  const url = new URL(baseUrl);
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !isLocal && !allowInsecure) {
    throw new Error(
      'Refusing to send a bearer token over remote HTTP. Use HTTPS or set allowInsecure only for a bounded diagnostic.',
    );
  }
  return url.toString().replace(/\/$/, '');
}

function sanitizedSources(sources) {
  return Array.isArray(sources) ? { count: sources.length } : { count: 0 };
}

function normalizedChat(result) {
  const sources = Array.isArray(result?.sources) ? result.sources : [];
  const error = typeof result?.error === 'string' ? result.error : null;
  const textResponse =
    typeof result?.textResponse === 'string' && result.textResponse.length > 0
      ? result.textResponse
      : null;
  return {
    ok: result?.type !== 'abort' && error === null && textResponse !== null,
    id: result?.id ?? null,
    type: result?.type ?? null,
    close: result?.close === true,
    error,
    textResponse,
    sourceCount: sources.length,
    sources,
  };
}

function failedChat(error) {
  return {
    ok: false,
    id: null,
    type: 'http_error',
    close: true,
    error: error instanceof Error ? error.message : String(error),
    textResponse: null,
    sourceCount: 0,
    sources: [],
  };
}

function parseStreamBody(body) {
  const events = [];
  for (const line of body.split(/\r?\n/)) {
    const candidate = line.replace(/^data:\s*/, '').trim();
    if (!candidate || candidate === '[DONE]') continue;
    try {
      events.push(JSON.parse(candidate));
    } catch {
      // AnythingLLM has shipped both SSE-prefixed and raw newline JSON. Ignore
      // keepalive/comment frames, but fail below if no JSON event exists.
    }
  }
  if (events.length === 0) throw new Error('Stream returned no JSON events');

  const finalEvent = [...events].reverse().find((event) => event?.close === true) ?? events.at(-1);
  const combinedText = events
    .map((event) => (typeof event?.textResponse === 'string' ? event.textResponse : ''))
    .join('');
  return normalizedChat({ ...finalEvent, textResponse: combinedText || finalEvent?.textResponse });
}

async function requestJson(url, apiKey, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
    signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body?.error ?? response.statusText}`);
  }
  return body;
}

export async function probeAnythingLlm({
  baseUrl,
  apiKey,
  workspaceSlug,
  retrievalQuery,
  chatQuery,
  allowInsecure = false,
  threadName = `channel-probe-${new Date().toISOString()}`,
}) {
  if (!apiKey) throw new Error('apiKey is required');
  if (!workspaceSlug) throw new Error('workspaceSlug is required');
  const safeBaseUrl = assertSafeBaseUrl(baseUrl, allowInsecure);
  const apiRoot = `${safeBaseUrl}/api/v1`;

  const auth = await requestJson(`${apiRoot}/auth`, apiKey);
  const workspaceResponse = await requestJson(
    `${apiRoot}/workspace/${encodeURIComponent(workspaceSlug)}`,
    apiKey,
  );
  const workspace = Array.isArray(workspaceResponse?.workspace)
    ? workspaceResponse.workspace[0]
    : workspaceResponse?.workspace;
  if (!workspace) throw new Error('Workspace response did not contain a workspace');

  const retrievalResponse = await requestJson(
    `${apiRoot}/workspace/${encodeURIComponent(workspaceSlug)}/vector-search`,
    apiKey,
    {
      method: 'POST',
      body: JSON.stringify({ query: retrievalQuery, topN: 4, scoreThreshold: 0 }),
    },
  );
  const retrievalResults = Array.isArray(retrievalResponse?.results)
    ? retrievalResponse.results.map((result) => ({
        title: result?.metadata?.title ?? null,
        chunkSource: result?.metadata?.chunkSource ?? null,
        score: typeof result?.score === 'number' ? result.score : null,
      }))
    : [];

  const newThread = await requestJson(
    `${apiRoot}/workspace/${encodeURIComponent(workspaceSlug)}/thread/new`,
    apiKey,
    { method: 'POST', body: JSON.stringify({ name: threadName }) },
  );
  const threadSlug = newThread?.thread?.slug;
  if (!threadSlug) throw new Error('Thread creation response did not contain thread.slug');
  const threadRoot = `${apiRoot}/workspace/${encodeURIComponent(workspaceSlug)}/thread/${encodeURIComponent(threadSlug)}`;

  let syncChat;
  try {
    const syncResponse = await requestJson(`${threadRoot}/chat`, apiKey, {
      method: 'POST',
      body: JSON.stringify({ message: chatQuery, mode: 'chat' }),
    });
    syncChat = normalizedChat(syncResponse);
  } catch (error) {
    syncChat = failedChat(error);
  }

  const streamResponse = await fetch(`${threadRoot}/stream-chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ message: chatQuery, mode: 'chat' }),
    signal: AbortSignal.timeout(60_000),
  });
  const streamBody = await streamResponse.text();
  let streamChat;
  if (streamResponse.ok) {
    streamChat = parseStreamBody(streamBody);
  } else {
    let detail = streamResponse.statusText;
    try {
      detail = JSON.parse(streamBody)?.error ?? detail;
    } catch {
      // Preserve the status text when the error body is not JSON.
    }
    streamChat = failedChat(new Error(`HTTP ${streamResponse.status}: ${detail}`));
  }

  return {
    transport: {
      baseUrl: safeBaseUrl,
      https: safeBaseUrl.startsWith('https://'),
      insecureOverride: allowInsecure,
    },
    auth: { ok: auth?.authenticated === true },
    workspace: {
      name: workspace.name ?? null,
      slug: workspace.slug ?? workspaceSlug,
      similarityThreshold: workspace.similarityThreshold ?? null,
      topN: workspace.topN ?? null,
    },
    retrieval: {
      ok: retrievalResults.length > 0,
      resultCount: retrievalResults.length,
      results: retrievalResults,
    },
    thread: { slug: threadSlug, name: newThread?.thread?.name ?? threadName },
    syncChat,
    streamChat,
  };
}

export function sanitizedProbeReport(report) {
  const sanitizeChat = (chat) => ({
    ok: chat?.ok === true,
    type: typeof chat?.type === 'string' ? chat.type : null,
    close: chat?.close === true,
    errorPresent: typeof chat?.error === 'string' && chat.error.length > 0,
    sourceCount:
      typeof chat?.sourceCount === 'number'
        ? chat.sourceCount
        : sanitizedSources(chat?.sources).count,
  });
  return {
    transport: {
      https: report?.transport?.https === true,
      insecureOverride: report?.transport?.insecureOverride === true,
    },
    auth: { ok: report?.auth?.ok === true },
    workspace: { found: report?.workspace != null },
    retrieval: {
      ok: report?.retrieval?.ok === true,
      resultCount:
        typeof report?.retrieval?.resultCount === 'number' ? report.retrieval.resultCount : 0,
    },
    thread: { created: report?.thread != null },
    syncChat: sanitizeChat(report.syncChat),
    streamChat: sanitizeChat(report.streamChat),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const required = ['ANYTHINGLLM_BASE_URL', 'ANYTHINGLLM_API_KEY', 'ANYTHINGLLM_WORKSPACE_SLUG'];
  const missing = required.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exitCode = 2;
  } else {
    probeAnythingLlm({
      baseUrl: process.env.ANYTHINGLLM_BASE_URL,
      apiKey: process.env.ANYTHINGLLM_API_KEY,
      workspaceSlug: process.env.ANYTHINGLLM_WORKSPACE_SLUG,
      retrievalQuery: process.env.ANYTHINGLLM_RETRIEVAL_QUERY ?? 'What does the company do?',
      chatQuery: process.env.ANYTHINGLLM_CHAT_QUERY ?? 'What does the company do?',
      allowInsecure: process.env.ALLOW_INSECURE_ANYTHINGLLM === 'true',
    })
      .then((report) => console.log(JSON.stringify(sanitizedProbeReport(report), null, 2)))
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
