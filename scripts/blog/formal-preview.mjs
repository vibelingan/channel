import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};
export function formalPreviewHandler(directory) {
  const root = realpathSync(resolve(directory));
  return (req, res) => {
    if (
      !['GET', 'HEAD'].includes(req.method) ||
      !['supplychainsai.com', 'supplychainsai.com:443'].includes(req.headers.host)
    ) {
      res.writeHead(403);
      res.end();
      return;
    }
    let file;
    try {
      const url = new URL(req.url, 'https://supplychainsai.com');
      const path = decodeURIComponent(url.pathname);
      file = resolve(root, `.${path}`);
      if (!file.startsWith(root + sep) && file !== root) throw Error();
      if (statSync(file).isDirectory()) file = resolve(file, 'index.html');
      if (!statSync(file).isFile() || !realpathSync(file).startsWith(root + sep)) throw Error();
    } catch {
      res.writeHead(404, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(readFileSync(resolve(root, '404.html')));
      return;
    }
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file));
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, keyFile, certFile, readyFile] = process.argv.slice(2);
  if (!directory || !keyFile || !certFile || !readyFile || process.env.GITHUB_ACTIONS !== 'true')
    throw Error('Owned CI preview arguments required');
  const root = realpathSync(resolve(directory));
  const server = createServer(
    { key: readFileSync(keyFile), cert: readFileSync(certFile) },
    formalPreviewHandler(root),
  );
  server.listen(443, '127.0.0.1', () =>
    writeFileSync(readyFile, JSON.stringify({ pid: process.pid, port: 443, root }), { flag: 'wx' }),
  );
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
