import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const mime = {
  '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png', '.svg':'image/svg+xml', '.ico':'image/x-icon', '.pjs':'text/plain; charset=utf-8'
};

http.createServer((req,res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, {'content-type':'text/plain; charset=utf-8','allow':'GET, HEAD'});
    return res.end('Method not allowed');
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad request'); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(root, `.${pathname}`);
  if (!file.startsWith(root + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type':mime[path.extname(file)] || 'application/octet-stream',
    'cache-control':path.basename(file)==='index.html' ? 'no-cache' : 'public, max-age=300',
    'x-content-type-options':'nosniff'
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}).listen(port,'0.0.0.0',() => console.log(`Surgexity listening on 0.0.0.0:${port}`));
