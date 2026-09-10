import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';
import { send } from './http.js';
import { health } from './routes/health.js';
import { postCookies } from './routes/cookies.js';
import { postIngest, postKnownUrls } from './routes/ingest.js';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Cross-site guard for state-changing requests: a plain `<form
// enctype="text/plain">` POST from an attacker-controlled page skips CORS
// preflight entirely, so the only signal available server-side is the
// Origin header the browser attaches to it. Browsers always send Origin on
// cross-origin (and same-origin) POSTs, so a present-but-non-loopback Origin
// is a reliable sign of a cross-site request and gets rejected. Requests
// with no Origin header at all (the extension service worker's fetch, and
// tools like curl) are not browser-originated cross-site requests and must
// keep working.
export function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(origin.hostname);
}

export function createServer(deps) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      // Applied once, here, for every state-changing (POST) route rather
      // than copy-pasted into each handler.
      if (req.method === 'POST' && !isAllowedOrigin(req.headers.origin)) {
        return send(res, 403, { error: 'forbidden_origin' });
      }
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

  const { runMediaStage } = await import('./worker/media-stage.js');
  let draining = false;
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      const out = await runMediaStage(db, { config: CONFIG, limit: 5 });
      if (out.processed) console.log('[media]', out);
    } catch (err) {
      console.error('[media] stage error', err);
    } finally {
      draining = false;
    }
  }, 30000).unref();
}
