import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer, isAllowedHost } from '../src/server.js';

// DNS rebinding: a hostile site points its own domain at 127.0.0.1, and the
// browser then treats this server as same-origin with that site. The tell is
// the Host header, which still carries the attacker's domain.
//
// These tests use http.request, NOT fetch. fetch silently replaces any Host
// header with the real one, so a fetch-based test passes with no guard at all.

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-host-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const server = createServer({ db, config: { COOKIES_PATH: path.join(dir, 'c.txt') } });
  return { dir, db, server };
}

async function listenPort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function raw(port, { method = 'GET', path: p = '/health', headers = {}, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, setHost }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('loopback Host headers are accepted', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, '127.0.0.1']) {
      const r = await raw(port, { headers: { host } });
      assert.equal(r.status, 200, `${host} should be accepted`);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a rebinding Host is refused on every route', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const hosts = ['evil.example', `evil.example:${port}`, '127.0.0.1.evil.example', 'evil.com@127.0.0.1', '127.0.0.1/evil'];
    for (const host of hosts) {
      for (const p of ['/health', '/api/stats', '/']) {
        const r = await raw(port, { path: p, headers: { host } });
        assert.equal(r.status, 403, `${host} on ${p}`);
        assert.equal(JSON.parse(r.body).error, 'forbidden_host');
      }
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a request with no Host header is refused', async () => {
  // Node's HTTP server rejects a Host-less HTTP/1.1 request itself, with 400,
  // before the handler runs (requireHostHeader defaults to true). If that
  // default ever changed, isAllowedHost would still refuse it with 403. Either
  // way it must not be served.
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const r = await raw(port, { setHost: false });
    assert.ok([400, 403].includes(r.status), `expected refusal, got ${r.status}`);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Origin guard covers PATCH, PUT and DELETE, not only POST', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    for (const method of ['PATCH', 'PUT', 'DELETE', 'POST']) {
      const r = await raw(port, { method, path: '/api/items/1', headers: { origin: 'https://evil.example' } });
      assert.equal(r.status, 403, method);
      assert.equal(JSON.parse(r.body).error, 'forbidden_origin');
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a PATCH with no Origin is not refused by the guard', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const r = await raw(port, { method: 'PATCH', path: '/api/items/1' });
    assert.notEqual(r.status, 403);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isAllowedHost rejects anything that is not a plain loopback host', () => {
  assert.equal(isAllowedHost(undefined), false);
  assert.equal(isAllowedHost(''), false);
  assert.equal(isAllowedHost('evil.com@127.0.0.1'), false);
  assert.equal(isAllowedHost('127.0.0.1:8787'), true);
  assert.equal(isAllowedHost('[::1]:8787'), true);
});
