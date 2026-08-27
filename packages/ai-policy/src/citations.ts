/**
 * Citation links, made absolute against the real website and checked.
 *
 * The engine returns `/headphones`. A browser resolves that against whatever
 * origin served the page — which is the ASSISTANT's own hostname, not the
 * website's, because the architecture puts them on separate origins. Every
 * source link therefore pointed at a URL on the BFF that serves nothing.
 *
 * It is also untrusted input. The link text arrives from a document store a
 * person can upload to, so a citation is a place where `javascript:` or a
 * lookalike host can reach a visitor's browser from inside an answer we
 * present as authoritative. Anything that is not an approved first-party page
 * is dropped rather than repaired: a citation whose target we cannot vouch for
 * is not a citation.
 */

import type { EngineCitation } from '@vibelingan-channel/ai-engine';

export interface CitationPolicy {
  /** The public website these documents came from, e.g. `https://example.com`. */
  siteOrigin: string;
}

/**
 * Whether this resolved link may keep its scheme.
 *
 * `https:` always. `http:` ONLY when the configured website is itself
 * http-on-localhost, which is the development stack and nothing else —
 * config.ts permits exactly that origin and no other http one.
 *
 * Hard-coding https alone was wrong in a way that was worse than the bug it
 * replaced: the local site origin IS http://localhost:4321, so every citation
 * lost its link and the visitor saw "Company overview" with nowhere to go. A
 * check that silently disables itself in the only environment anyone runs is
 * not a check, it is an outage.
 */
function protocolAllowed(resolved: URL, site: URL): boolean {
  if (resolved.protocol === 'https:') return true;
  return (
    resolved.protocol === 'http:' && site.protocol === 'http:' && site.hostname === 'localhost'
  );
}

/**
 * Resolve one citation URL, or return null to drop the link.
 *
 * Returning null keeps the citation itself — the visitor still sees which
 * document the answer came from — while removing a destination we cannot
 * vouch for. Silently rewriting a suspicious URL to something plausible would
 * be worse: it would look verified.
 */
export function normalizeCitationUrl(
  raw: string | undefined,
  policy: CitationPolicy,
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const candidate = raw.trim();
  if (candidate.length === 0) return null;

  // A scheme-relative URL ("//evil.example/x") inherits the page's scheme and
  // lands on someone else's host. It is not a path.
  if (candidate.startsWith('//')) return null;

  let resolved: URL;
  try {
    resolved = new URL(candidate, policy.siteOrigin);
  } catch {
    return null;
  }

  // Exact host match against the configured site. A suffix check would accept
  // `example.com.evil.test`, which is the whole point of that trick.
  let site: URL;
  try {
    site = new URL(policy.siteOrigin);
  } catch {
    return null;
  }
  if (resolved.host !== site.host) return null;

  if (!protocolAllowed(resolved, site)) return null;

  // Credentials in a link are never legitimate here and render confusingly.
  if (resolved.username || resolved.password) return null;

  return resolved.toString();
}

/**
 * Apply the policy to every citation in an answer.
 *
 * Citations with an unusable target keep their title and lose their link.
 */
export function normalizeCitations(
  citations: readonly EngineCitation[],
  policy: CitationPolicy,
): EngineCitation[] {
  return citations.map((citation) => {
    const url = normalizeCitationUrl(citation.url, policy);
    const { url: _dropped, ...rest } = citation;
    return url ? { ...rest, url } : rest;
  });
}
