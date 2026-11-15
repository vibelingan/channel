const http = require('node:http');
const origin = 'https://supplychainsai.com';
function createRedirectServer() {
  return http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    const path = req.url ?? '/';
    if (
      !path.startsWith('/') ||
      path.length > 8192 ||
      path.includes('\\') ||
      path.includes('#') ||
      [...path].some((c) => c.charCodeAt(0) <= 32 || c.charCodeAt(0) === 127)
    ) {
      res.writeHead(400).end();
      return;
    }
    // The target host is constant; never derive it from Host or forwarded headers.
    res.writeHead(301, { Location: origin + path }).end();
  });
}
module.exports = { createRedirectServer };
if (require.main === module) createRedirectServer().listen(9000, '0.0.0.0');
