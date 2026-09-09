import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';
import { send } from './http.js';
import { health } from './routes/health.js';
import { postCookies } from './routes/cookies.js';
import { postIngest, postKnownUrls } from './routes/ingest.js';

export function createServer(deps) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return health(req, res);
      if (req.method === 'POST' && url.pathname === '/cookies') {
        return await postCookies(req, res, deps);
      }
      if (req.method === 'POST' && url.pathname === '/ingest') {
        return await postIngest(req, res, deps);
      }
      if (req.method === 'POST' && url.pathname === '/known-urls') {
        return await postKnownUrls(req, res, deps);
      }
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('[server]', err);
      return send(res, 500, { error: 'internal', detail: String(err.message) });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const db = openDb(CONFIG.DB_PATH);
  createServer({ db, config: CONFIG })
    .listen(CONFIG.PORT, CONFIG.HOST, () =>
      console.log(`[server] listening on http://${CONFIG.HOST}:${CONFIG.PORT}`));
}
