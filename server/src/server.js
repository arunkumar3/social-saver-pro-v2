import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';
import { send } from './http.js';
import { health } from './routes/health.js';
import { postCookies } from './routes/cookies.js';
import { postIngest, postKnownUrls } from './routes/ingest.js';
import { getStats } from './routes/stats.js';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Cross-site guard for state-changing requests: a plain `<form
// enctype="text/plain">` POST from an attacker-controlled page skips CORS
// preflight entirely, so the only signal available server-side is the
// Origin header the browser attaches to it. A present-but-disallowed Origin
// is a reliable sign of a cross-site request and gets rejected.
//
// Three cases are allowed:
//
//   1. No Origin at all — curl and other non-browser clients. Not a
//      browser-originated cross-site request.
//   2. A loopback origin — the dashboard served from this same server.
//   3. A `chrome-extension:` origin — OUR extension's service worker.
//      An MV3 service worker's `fetch` DOES send `Origin:
//      chrome-extension://<id>`; an earlier version of this guard assumed it
//      sent none and rejected every save the extension made with 403
//      forbidden_origin. Origin is set by the browser and cannot be forged
//      by page script, so this scheme genuinely identifies an extension.
//
//      Any installed extension is accepted rather than one pinned id,
//      because an unpacked extension's id changes with its load path. That
//      is an accepted trade: reaching this server from another extension
//      would require the user to have installed a hostile extension AND
//      granted it localhost host permissions, which is a deeper compromise
//      than this guard is meant to address. The threat model here is a
//      drive-by web page, and http(s) origins stay blocked.
export function isAllowedOrigin(originHeader) {
  if (!originHeader) return true;
  let origin;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol === 'chrome-extension:') return true;
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
      if (req.method === 'GET' && url.pathname === '/api/stats') return getStats(req, res, deps);
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
