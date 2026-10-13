import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { CSP } from '../src/routes/static.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-static-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(pub, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside public');
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), PUBLIC_DIR: pub };
  return { dir, db, server: createServer({ db, config }) };
}
async function listenPort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
// http.get rather than fetch, so traversal paths reach the server unnormalised.
function get(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the three page files are served with the right type and the CSP', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const cases = [['/', 'text/html; charset=utf-8', '<!doctype html><title>t</title>'],
      ['/app.js', 'text/javascript; charset=utf-8', 'export {};'],
      ['/style.css', 'text/css; charset=utf-8', 'body{}']];
    for (const [p, type, body] of cases) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.equal(r.headers['content-security-policy'], CSP, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(r.body, body, p);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CSP refuses inline script and anything off-origin', () => {
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.ok(!CSP.includes('unsafe-inline'));
  assert.ok(!CSP.includes('unsafe-eval'));
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /frame-ancestors 'none'/);
});

test('any other path is 404, including traversal attempts', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    for (const p of ['/index.html', '/secret.txt', '/../secret.txt', '/%2e%2e/secret.txt',
      '/public/app.js', '/..%2fsecret.txt', '/app.js/', '/APP.JS']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('page files are GET-only', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    assert.equal((await get(port, '/', 'POST')).status, 404);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
