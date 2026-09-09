import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

// A cross-site <form enctype="text/plain"> POST skips CORS preflight, so the
// only server-side signal is the Origin header. State-changing routes must
// reject a present, non-loopback Origin, while continuing to serve requests
// that carry no Origin at all (the extension service worker's fetch, curl).

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-origin-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const server = createServer({ db, config: { COOKIES_PATH: path.join(dir, 'c.txt') } });
  return { dir, db, server };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('a POST /ingest carrying a cross-site Origin is refused with 403', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ items: [
        { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'x' }]}),
    });
    assert.equal(res.status, 403);
    const out = await res.json();
    assert.ok(out.error);
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 0);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a POST /ingest with no Origin header still succeeds', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: [
        { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'x' }]}),
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.inserted, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a POST /ingest with a loopback Origin still succeeds', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ items: [
        { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'x' }]}),
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.inserted, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a POST /cookies carrying a cross-site Origin is refused with 403', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ cookies: [
        { domain: '.instagram.com', path: '/', secure: true,
          expirationDate: 2000000000, name: 'sessionid', value: 'abc', hostOnly: false }]}),
    });
    assert.equal(res.status, 403);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
