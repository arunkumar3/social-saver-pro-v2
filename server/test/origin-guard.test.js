import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

// A cross-site <form enctype="text/plain"> POST skips CORS preflight, so the
// only server-side signal is the Origin header. State-changing routes must
// reject a present, disallowed Origin, while continuing to serve requests
// that carry no Origin at all (curl), a loopback Origin (the dashboard), or a
// chrome-extension: Origin. That last case is not theoretical: an MV3 service
// worker's fetch DOES send Origin: chrome-extension://<id>, and an earlier
// version of this guard assumed it sent none, so every save the extension
// made came back 403 forbidden_origin.

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

test('a POST /ingest from a chrome-extension Origin succeeds', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'chrome-extension://oajbkpfgclkclmhbabnpaefkimjhbpkg',
      },
      body: JSON.stringify({ items: [
        { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/5', caption: 'ok' }]}),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).inserted, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a POST /cookies from a chrome-extension Origin succeeds', async () => {
  // This is the exact request that returned 403 in real use: the extension
  // service worker posting the Instagram cookie jar to the local server.
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/cookies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'chrome-extension://oajbkpfgclkclmhbabnpaefkimjhbpkg',
      },
      body: JSON.stringify({ cookies: [
        { domain: '.instagram.com', path: '/', secure: true, expirationDate: 2000000000,
          name: 'sessionid', value: 'abc', hostOnly: false }]}),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a non-loopback http Origin is still refused after allowing extensions', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    for (const origin of ['https://evil.example', 'http://evil.example', 'http://127.0.0.1.evil.com']) {
      const res = await fetch(`${base}/ingest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ items: [
          { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/9', caption: 'x' }]}),
      });
      assert.equal(res.status, 403, `expected 403 for ${origin}`);
    }
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 0);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
