import { createServer } from 'node:http';
import { digest } from './release-fixtures.mjs';
import { fetchFully } from './smoke-http.mjs';
export const target = { envId: 'fixture-env', site: 'https://fixture.example' };
export const errorHtml =
  '<meta name="robots" content="noindex,follow"><main data-not-found-page>Not found</main>';
export function entry(path, body) {
  return { path, bytes: Buffer.byteLength(body), sha256: digest(body) };
}
export function configuration() {
  return {
    website: {
      WebsiteConfiguration: {
        IndexDocument: { Suffix: 'index.html' },
        ErrorDocument: { Key: '404.html', OriginalHttpStatus: 'Enabled' },
      },
      Bucket: 'fixture-bucket',
      CdnDomain: 'fixture.example',
    },
    gateway: {
      Domains: [
        {
          Domain: 'fixture.example',
          AccessType: 'DIRECT',
          Enable: true,
          CertId: 'preserved-cert',
          Routes: [
            ...['/', '/*'].map((Path) => ({
              Path,
              UpstreamResourceType: 'STATIC_STORE',
              UpstreamResourceName: 'staticstore',
              Enable: true,
              Extension: {
                HeadersHandler: {
                  ResponseHeadersToAdd: [
                    { Key: 'X-Existing', Value: 'keep' },
                    {
                      Key: 'Cache-Control',
                      Value: 'no-store',
                      Action: 'OVERWRITE_IF_EXISTS_OR_ADD',
                    },
                  ],
                },
              },
            })),
            {
              Path: '/api/*',
              UpstreamResourceType: 'SCF',
              UpstreamResourceName: 'public-api',
              Enable: true,
            },
          ],
        },
      ],
      OriginDomain: 'fixture-origin',
    },
  };
}
export function domainConfiguration() {
  const result = configuration();
  const domain = result.gateway.Domains[0];
  domain.Routes = domain.Routes.filter((route) => route.UpstreamResourceType === 'STATIC_STORE');
  for (const route of domain.Routes)
    route.Extension.HeadersHandler.ResponseHeadersToAdd =
      route.Extension.HeadersHandler.ResponseHeadersToAdd.filter(
        (header) => header.Key !== 'Cache-Control',
      );
  domain.Extension = {
    HeadersHandler: {
      ResponseHeadersToAdd: [
        { Key: 'X-Domain', Value: 'keep' },
        { Key: 'Cache-Control', Value: 'no-store', Action: 'OVERWRITE_IF_EXISTS_OR_ADD' },
      ],
    },
  };
  return result;
}
export async function httpFixture(t, handler) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    requests,
    origin,
    request: (method, url, options) => fetchFully(method, origin + new URL(url).pathname, options),
  };
}
export function objectResponse(
  req,
  res,
  {
    body = '<h1>Product</h1>',
    status = 200,
    cache = 'no-cache',
    etag = '"v1"',
    mime = 'text/html',
  } = {},
) {
  res.writeHead(req.headers['if-none-match'] === etag ? 304 : status, {
    'content-type': mime,
    'cache-control': cache,
    etag,
  });
  res.end(req.headers['if-none-match'] === etag ? '' : body);
}
