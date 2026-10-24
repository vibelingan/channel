/**
 * Redacted operations alerting (ARCHITECTURE §8): WeCom group-robot webhook
 * when configured, structured console logging otherwise (silent-no-op rule:
 * the mode is visible, and an unconfigured webhook can never LOOK like a
 * delivered alert). Messages must already be redacted by the caller — this
 * module never receives token material.
 */

export type AlertSender = (message: string) => Promise<void>;

export function createAlertSender(
  webhookUrl: string | undefined,
  fetchImpl: typeof fetch = fetch,
): AlertSender {
  if (!webhookUrl) {
    return async (message) => {
      console.warn('[alibaba-catalog-sync] ALERT (WECOM_WEBHOOK_URL not configured):', message);
    };
  }
  return async (message) => {
    try {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          msgtype: 'text',
          text: { content: `[alibaba-catalog-sync] ${message}` },
        }),
      });
      if (!response.ok) {
        console.error('[alibaba-catalog-sync] WeCom alert delivery failed:', response.status);
      }
    } catch (error) {
      console.error('[alibaba-catalog-sync] WeCom alert delivery failed:', error);
    }
  };
}
