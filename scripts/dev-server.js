/**
 * Local dev server - serves the static files and runs the /api handlers the
 * same way Vercel does, so `npm run dev` needs no Vercel CLI.
 *
 *   npm run dev            # http://localhost:3000
 *   PORT=4000 npm run dev
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimal .env loader (same rules as scripts/init-db.js).
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    if (!(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

/** Adds the response helpers Vercel's Node runtime provides. */
function shim(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (value) => {
    if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(value));
    return res;
  };
  return res;
}

const handlers = new Map();
async function apiHandler(name) {
  if (!handlers.has(name)) {
    const file = path.join(root, 'api', `${name}.js`);
    if (!fs.existsSync(file)) return null;
    // Cache-bust so edits are picked up without restarting.
    const mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
    handlers.set(name, mod.default);
  }
  return handlers.get(name);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const started = Date.now();
  res.on('finish', () => {
    console.log(`${res.statusCode} ${req.method} ${url.pathname}${url.search} ${Date.now() - started}ms`);
  });

  if (url.pathname.startsWith('/api/')) {
    const name = url.pathname.slice('/api/'.length).replace(/\/+$/, '');
    handlers.delete(name); // always reload in dev
    const fn = await apiHandler(name);
    if (!fn) {
      shim(res).status(404).json({ error: `No API route /api/${name}` });
      return;
    }
    try {
      await fn(req, shim(res));
    } catch (err) {
      console.error(err);
      if (!res.headersSent) shim(res).status(500).json({ error: String(err?.message || err) });
    }
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const file = path.join(root, rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

const port = Number(process.env.PORT || 3000);
server.listen(port, () => console.log(`\n  Rehearsals dev server → http://localhost:${port}\n`));
