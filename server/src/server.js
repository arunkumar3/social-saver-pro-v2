import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { CONFIG } from './config.js';
import { send } from './http.js';
import { health } from './routes/health.js';
import { postCookies } from './routes/cookies.js';
import { postIngest, postKnownUrls, postPromote } from './routes/ingest.js';
import { getStats } from './routes/stats.js';
import { getItems, getItem, patchItem } from './routes/items.js';
import { getSearch } from './routes/search.js';

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

// A Host header is a hostname, optionally followed by a port. Anything else,
// such as userinfo ("evil.com@127.0.0.1") or a path, is refused before it is
// parsed, so URL-parsing quirks cannot launder it into a loopback name.
const HOST_HEADER = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/;

// DNS-rebinding guard. A hostile site can point its own domain at 127.0.0.1;
// the browser then treats this server as same-origin with that site and lets
// it read every response, including the whole archive. The request still
// carries the attacker's domain in Host, so only loopback names are served.
// Only the hostname is compared, not the port, so tests on ephemeral ports
// and the extension's "Host: 127.0.0.1:8787" both pass.
export function isAllowedHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !HOST_HEADER.test(hostHeader)) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}

export function createServer(deps) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (!isAllowedHost(req.headers.host)) {
        return send(res, 403, { error: 'forbidden_host' });
      }
      // Applied once, here, for every state-changing method rather than per
      // route. It covered only POST until the dashboard added PATCH, which
      // would otherwise have been the one write a cross-site page could make.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req.headers.origin)) {
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
      if (req.method === 'POST' && url.pathname === '/api/promote') {
        return await postPromote(req, res, deps);
      }
      if (req.method === 'POST' && url.pathname === '/known-urls') {
        return await postKnownUrls(req, res, deps);
      }
      if (req.method === 'GET' && url.pathname === '/api/items') return getItems(req, res, deps, url);
      const itemMatch = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
      if (itemMatch && req.method === 'GET') return getItem(req, res, deps, itemMatch[1]);
      if (itemMatch && req.method === 'PATCH') return await patchItem(req, res, deps, itemMatch[1]);
      if (req.method === 'GET' && url.pathname === '/api/search') return getSearch(req, res, deps, url);
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
