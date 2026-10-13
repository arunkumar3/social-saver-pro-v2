import fs from 'node:fs';
import path from 'node:path';

// A fixed table. The request path is only ever a key into it and is never
// joined onto a directory, so no form of traversal can reach another file.
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

// Item text is written by strangers. The page renders it only as text, and
// this policy is the second line: even if markup slipped into the DOM, inline
// script and inline handlers would not run, and nothing could load from or
// send to another origin.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Returns true if it handled the request, false to let routing continue. */
export function serveStatic(req, res, { config }, pathname) {
  const entry = FILES.get(pathname);
  if (!entry) return false;
  const [name, type] = entry;
  let body;
  try {
    body = fs.readFileSync(path.join(config.PUBLIC_DIR, name));
  } catch {
    return false;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Read on every request and never cached, so an edit to the page shows
    // up on reload without restarting the server.
    'cache-control': 'no-store',
  });
  res.end(body);
  return true;
}
