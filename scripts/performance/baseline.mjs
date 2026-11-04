import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { performance as nodePerformance } from 'node:perf_hooks';

const require = createRequire(import.meta.url);
const playwrightRequire = createRequire(require.resolve('@playwright/test/package.json'));
const { chromium, devices } = playwrightRequire('playwright');
const outputDirectory = process.argv[2];
if (!outputDirectory) throw Error('Explicit evidence directory required');
await mkdir(outputDirectory, { recursive: true });
const reportPath = `${outputDirectory}/baseline.json`;
const safeUrl = (raw) => {
  try {
    const value = new URL(raw);
    return `${value.origin}${value.pathname}`;
  } catch {
    return 'unavailable';
  }
};
const report = {
  collectorVersion: 3,
  capturedAt: new Date().toISOString(),
  method:
    'Existing headless Chromium; one cold context per page/profile; cache disabled; no CPU/network throttling; 12-second observation after DOMContentLoaded; no interactions or form submissions. This is a local spot measurement, not Lighthouse, CrUX, or field CWV.',
  samples: [],
  phase: 'before',
  location: 'Mac current network egress; not verified US',
  repeats: 3,
  fieldInp: null,
};
const save = () => writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
const browser = await chromium.launch({ headless: true });
report.browser = browser.version();
try {
  for (const profile of [
    { name: 'desktop', options: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 } },
    { name: 'mobile', options: { ...devices['Pixel 7'] } },
  ].flatMap((p) => [1, 2, 3].map((repeat) => ({ ...p, repeat })))) {
    for (const [kind, url] of [
      ['home', 'https://supplychainsai.com/'],
      ['category', 'https://supplychainsai.com/headphones/'],
      ['oem', 'https://supplychainsai.com/oem/'],
      ['portfolio', 'https://supplychainsai.com/portfolio/'],
      ['product-a', 'https://supplychainsai.com/products/p-003a6310-5244-4766-adfa-eb1002ad0fb4/'],
      ['product-b', 'https://supplychainsai.com/products/p-804ee5b9-209c-41b7-ae91-9c854fc8d1b4/'],
      ['product-c', 'https://supplychainsai.com/products/p-ffc81bae-b098-4d3d-a7e5-ed539db80a1e/'],
      ['blog-list', 'https://supplychainsai.com/blog/'],
      [
        'article',
        'https://supplychainsai.com/blog/oem-headphone-sample-inspection-wecom-20261027/',
      ],
    ]) {
      const context = await browser.newContext({
        ...profile.options,
        serviceWorkers: 'block',
        locale: 'en-US',
      });
      const page = await context.newPage();
      const cdp = await context.newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
      const requests = new Map();
      const failed = [];
      let pageErrors = 0;
      cdp.on('Network.requestWillBeSent', (event) => {
        requests.set(event.requestId, {
          url: safeUrl(event.request.url),
          type: event.type,
          started: event.timestamp,
          encodedBytes: 0,
          complete: false,
        });
      });
      cdp.on('Network.responseReceived', (event) => {
        const entry = requests.get(event.requestId);
        if (entry)
          Object.assign(entry, {
            status: event.response.status,
            mimeType: event.response.mimeType,
            cache: Boolean(event.response.fromDiskCache || event.response.fromServiceWorker),
            responseAt: event.timestamp,
          });
      });
      cdp.on('Network.dataReceived', (event) => {
        const entry = requests.get(event.requestId);
        if (entry) entry.encodedBytes += event.encodedDataLength;
      });
      cdp.on('Network.loadingFinished', (event) => {
        const entry = requests.get(event.requestId);
        if (entry)
          Object.assign(entry, {
            encodedBytes: event.encodedDataLength,
            durationMs: (event.timestamp - entry.started) * 1000,
            complete: true,
          });
      });
      cdp.on('Network.loadingFailed', (event) => {
        const entry = requests.get(event.requestId);
        failed.push({
          url: entry?.url ?? 'unknown',
          error: event.errorText,
          canceled: Boolean(event.canceled),
        });
      });
      page.on('pageerror', () => {
        pageErrors++;
      });
      await page.route('**/*', async (route) => {
        if (!['GET', 'HEAD'].includes(route.request().method())) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      await page.addInitScript(() => {
        window.__localPerf = {
          lcp: null,
          cls: 0,
          clsSessionValue: 0,
          clsSessionFirst: 0,
          clsSessionLast: 0,
          shifts: [],
          longTasks: [],
        };
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            window.__localPerf.longTasks.push({ startTime: e.startTime, duration: e.duration });
        }).observe({ type: 'longtask', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            const element = entry.element;
            window.__localPerf.lcp = {
              startTime: entry.startTime,
              renderTime: entry.renderTime,
              loadTime: entry.loadTime,
              size: entry.size,
              url: entry.url ? `${new URL(entry.url).origin}${new URL(entry.url).pathname}` : null,
              element: element
                ? `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`
                : null,
            };
          }
        }).observe({ type: 'largest-contentful-paint', buffered: true });
        new PerformanceObserver((list) => {
          const value = window.__localPerf;
          for (const entry of list.getEntries()) {
            if (entry.hadRecentInput) continue;
            if (
              !value.clsSessionFirst ||
              entry.startTime - value.clsSessionLast > 1000 ||
              entry.startTime - value.clsSessionFirst > 5000
            ) {
              value.clsSessionFirst = entry.startTime;
              value.clsSessionValue = entry.value;
            } else value.clsSessionValue += entry.value;
            value.clsSessionLast = entry.startTime;
            value.cls = Math.max(value.cls, value.clsSessionValue);
            value.shifts.push({ time: entry.startTime, value: entry.value });
          }
        }).observe({ type: 'layout-shift', buffered: true });
      });
      const started = nodePerformance.now();
      let status = null;
      let navigationError = null;
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        status = response?.status() ?? null;
        await page.waitForTimeout(12000);
      } catch (error) {
        navigationError =
          error.name === 'TimeoutError'
            ? 'navigation timeout after 45 seconds'
            : 'navigation failed';
      }
      let metrics = null;
      try {
        metrics = await page.evaluate(() => {
          const nav = performance.getEntriesByType('navigation')[0];
          const resource = performance.getEntriesByType('resource');
          const url = (raw) => {
            try {
              const u = new URL(raw);
              return `${u.origin}${u.pathname}`;
            } catch {
              return 'unavailable';
            }
          };
          return {
            title: document.title,
            currentUrl: url(location.href),
            viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
            navigation: nav
              ? {
                  requestToFirstByteMs: nav.responseStart - nav.requestStart,
                  responseStartMs: nav.responseStart,
                  domContentLoadedMs: nav.domContentLoadedEventEnd,
                  loadMs: nav.loadEventEnd,
                  transferSize: nav.transferSize,
                  encodedBodySize: nav.encodedBodySize,
                  decodedBodySize: nav.decodedBodySize,
                  raw: { ...nav.toJSON(), name: url(nav.name) },
                }
              : null,
            paints: performance
              .getEntriesByType('paint')
              .map((e) => ({ name: e.name, startTime: e.startTime })),
            observedLcp: window.__localPerf?.lcp ?? null,
            observedCls: window.__localPerf?.cls ?? null,
            longTasks: window.__localPerf?.longTasks ?? [],
            inp: null,
            inpNote: 'No real user interaction sample; not zero and not a field INP pass',
            shifts: window.__localPerf?.shifts ?? [],
            resourceCount: resource.length,
            resourceTimings: resource.map((e) => ({ ...e.toJSON(), name: url(e.name) })),
            resourceTimingEncodedBytes: resource.reduce((sum, e) => sum + e.encodedBodySize, 0),
            largestCompletedResources: [...resource]
              .sort((a, b) => b.encodedBodySize - a.encodedBodySize)
              .slice(0, 12)
              .map((e) => ({
                url: url(e.name),
                type: e.initiatorType,
                durationMs: e.duration,
                encodedBodySize: e.encodedBodySize,
                transferSize: e.transferSize,
              })),
            slowestCompletedResources: [...resource]
              .sort((a, b) => b.duration - a.duration)
              .slice(0, 12)
              .map((e) => ({
                url: url(e.name),
                type: e.initiatorType,
                durationMs: e.duration,
                encodedBodySize: e.encodedBodySize,
              })),
          };
        });
      } catch {}
      const network = [...requests.values()].filter((entry) => entry.url.startsWith('http'));
      const sample = {
        repeat: profile.repeat,
        profile: profile.name,
        page: kind,
        url,
        status,
        navigationError,
        totalObservedMs: nodePerformance.now() - started,
        metrics,
        pageErrors,
        failedRequests: failed,
        cdp: {
          requestCount: network.length,
          receivedEncodedBytes: network.reduce((sum, entry) => sum + entry.encodedBytes, 0),
          bytesNote:
            'CDP encoded bytes observed so far; completed requests include protocol overhead; incomplete media may continue later. Cross-origin ResourceTiming may hide byte sizes.',
          largestObserved: [...network]
            .sort((a, b) => b.encodedBytes - a.encodedBytes)
            .slice(0, 12),
          incomplete: network
            .filter((entry) => !entry.complete)
            .map(({ url, type, status, encodedBytes }) => ({ url, type, status, encodedBytes })),
        },
      };
      report.samples.push(sample);
      await save();
      console.log(
        JSON.stringify({
          repeat: profile.repeat,
          profile: profile.name,
          page: kind,
          status,
          navigationError,
          navigationResponseStartMs: metrics?.navigation?.responseStartMs,
          requestToFirstByteMs: metrics?.navigation?.requestToFirstByteMs,
          lcpMs: metrics?.observedLcp?.startTime,
          cls: metrics?.observedCls,
          receivedBytes: sample.cdp.receivedEncodedBytes,
          errors: failed.length,
        }),
      );
      await context.close();
    }
  }
} finally {
  await browser.close();
  await save();
}
console.log(JSON.stringify({ reportPath, samples: report.samples.length }));
