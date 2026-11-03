import { safePublicChatLink } from '../../../components/chat/public-link';
import { InquiryReceipt } from './InquiryCard';
import { ProductThumbnail } from './ProductThumbnail';
import type { ChatMessage, PublicProduct } from './model';

export function AssistantMessages({
  messages,
  compareIds,
  onCompare,
  onInquiry,
  onViewProduct,
  onShowMore,
  showMoreFor,
  currentProducts,
  inquiriesEnabled = true,
}: {
  messages: ChatMessage[];
  compareIds: string[];
  currentProducts?: Map<string, PublicProduct>;
  inquiriesEnabled?: boolean;
  onCompare: (product: PublicProduct) => void;
  onInquiry: (product?: PublicProduct, requirement?: string) => void;
  /** Called before a product link opens in this tab, to remember the card. */
  onViewProduct?: (messageId: string, productId: string) => void;
  /** Asks for the next batch after this answer's cards. */
  onShowMore?: (messageId: string) => void;
  /** The one answer whose batch can be continued now: the latest, when idle. */
  showMoreFor?: string;
}) {
  const origin = typeof window === 'undefined' ? 'https://preview.invalid' : window.location.origin;
  return (
    <>
      {messages.map((message) => (
        <article
          key={message.id}
          data-message-id={message.id}
          data-message-role={message.role}
          className={
            message.role === 'visitor'
              ? 'ml-8 rounded-xl bg-brand-700 px-4 py-3 text-sm text-white'
              : 'mr-2 rounded-xl bg-white p-4 text-sm leading-relaxed text-ink shadow-sm'
          }
        >
          {message.receipt ? (
            <InquiryReceipt receipt={message.receipt} />
          ) : (
            message.text && <p className="whitespace-pre-wrap break-words">{message.text}</p>
          )}
          {message.products?.map((product) => (
            <section
              key={product.id}
              data-product-id={product.id}
              className="mt-3 overflow-hidden rounded-xl border border-slate-200"
              aria-label={product.name}
            >
              <ProductThumbnail url={product.imageUrl} />
              <div className="p-3">
                <h3 className="font-semibold">{product.name}</h3>
                <p className="mt-1 line-clamp-3 text-xs">{product.summary}</p>
                {product.toConfirm && (
                  <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
                    To confirm with our team: {product.toConfirm.join(', ')}. Not shown in the
                    public details.
                  </p>
                )}
                <p className="mt-2 text-xs text-ink-muted">
                  Price, MOQ and lead time: confirm with our team.
                </p>
                {currentProducts &&
                  (!currentProducts.has(product.id) ||
                    currentProducts.get(product.id)?.revision !== product.revision) && (
                    <p className="mt-2 rounded bg-amber-50 p-2 text-xs text-amber-900">
                      {!currentProducts.has(product.id)
                        ? 'This product is no longer available in the public catalog.'
                        : 'Earlier details. See the updated card below.'}
                    </p>
                  )}
                <div className="mt-3 flex flex-wrap gap-2">
                  <a
                    className="flex min-h-11 items-center rounded-lg border border-slate-300 px-3 text-xs font-semibold"
                    href={product.href}
                    onClick={(event) => {
                      // Same tab, so the conversation continues on the product
                      // page. A modified click opens a new tab: a new conversation.
                      if (
                        event.button !== 0 ||
                        event.metaKey ||
                        event.ctrlKey ||
                        event.shiftKey ||
                        event.altKey
                      )
                        return;
                      onViewProduct?.(message.id, product.id);
                    }}
                  >
                    View product
                  </a>
                  <button
                    type="button"
                    disabled={
                      currentProducts &&
                      currentProducts.get(product.id)?.revision !== product.revision
                    }
                    aria-pressed={compareIds.includes(product.id)}
                    onClick={() => onCompare(product)}
                    className="min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-semibold"
                  >
                    {compareIds.includes(product.id) ? 'Selected' : 'Compare'}
                  </button>
                  {inquiriesEnabled && (
                    <button
                      type="button"
                      onClick={() => onInquiry(product)}
                      className="min-h-11 rounded-lg bg-brand-700 px-3 text-xs font-semibold text-white"
                    >
                      Prepare inquiry
                    </button>
                  )}
                </div>
              </div>
            </section>
          ))}
          {message.id === showMoreFor && message.resultSet?.hasMore && onShowMore && (
            <button
              type="button"
              onClick={() => onShowMore(message.id)}
              className="mt-3 min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-semibold"
            >
              Show more options
            </button>
          )}
          {message.citations?.length ? (
            <ul className="mt-3 border-t border-slate-100 pt-2 text-xs text-ink-muted">
              {message.citations.map((citation, index) => {
                const href = safePublicChatLink(citation.url, origin);
                return (
                  <li key={`${citation.title}-${index}`}>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex min-h-11 items-center font-medium text-brand-700 underline"
                      >
                        {citation.title} ↗
                      </a>
                    ) : (
                      citation.title
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {inquiriesEnabled &&
          (message.kind === 'clarification' || message.kind === 'team_followup') ? (
            <button
              type="button"
              className="mt-3 min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-semibold"
              onClick={() =>
                onInquiry(
                  message.inquirySuggestion?.productId
                    ? currentProducts?.get(message.inquirySuggestion.productId)
                    : undefined,
                  message.inquirySuggestion?.requirement,
                )
              }
            >
              Review inquiry
            </button>
          ) : null}
          {message.kind === 'product_updated' && (
            <p className="mt-3 rounded-lg bg-amber-50 p-3 text-xs text-amber-900">
              These details were checked again. Review the latest information before preparing your
              inquiry.
            </p>
          )}
        </article>
      ))}
    </>
  );
}
