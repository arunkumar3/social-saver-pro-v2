import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ing-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const server = createServer({ db, config: { COOKIES_PATH: path.join(dir, 'c.txt') } });
  return { dir, db, server };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('ingest inserts new items', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'hello' },
      { platform: 'instagram', kind: 'reel', url: 'https://instagram.com/p/z/', caption: 'reel' },
    ]});
    assert.equal(out.inserted, 2);
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 2);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-ingesting identical content is skipped, not duplicated', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const item = { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'hello' };
    await post(base, '/ingest', { items: [item] });
    const out = await post(base, '/ingest', { items: [item] });
    assert.equal(out.skipped, 1);
    assert.equal(out.updated, 0);
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a thread upgrade overwrites a tweet', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'short' }]});
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'thread', url: 'https://x.com/a/status/1', caption: 'hi' }]});
    assert.equal(out.updated, 1);
    assert.equal(db.prepare('SELECT kind FROM items WHERE url = ?')
      .get('https://x.com/a/status/1').kind, 'thread');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('longer caption wins for the same kind', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'short' }]});
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'a much longer caption' }]});
    assert.equal(db.prepare('SELECT caption FROM items WHERE url = ?')
      .get('https://x.com/a/status/1').caption, 'a much longer caption');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('media urls are recorded as pending media rows', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [{
      platform: 'instagram', kind: 'post', url: 'https://instagram.com/p/q/',
      caption: 'x', mediaUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] }]});
    assert.equal(db.prepare('SELECT count(*) c FROM media').get().c, 2);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an item missing a url is rejected without aborting the batch', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet' },
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/2', caption: 'ok' },
    ]});
    assert.equal(out.inserted, 1);
    assert.equal(out.rejected, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an item whose url is actually a downloader flag is rejected, not passed through', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: '--exec=calc.exe', caption: 'evil' },
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/2', caption: 'ok' },
    ]});
    assert.equal(out.rejected, 1);
    assert.equal(out.inserted, 1);
    assert.equal(db.prepare('SELECT count(*) c FROM items WHERE url = ?').get('--exec=calc.exe').c, 0);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an item with a non-http(s) scheme is rejected', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'file:///etc/passwd', caption: 'evil' },
    ]});
    assert.equal(out.rejected, 1);
    assert.equal(out.inserted, 0);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a valid https item still succeeds', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/3', caption: 'fine' },
    ]});
    assert.equal(out.inserted, 1);
    assert.equal(out.rejected, 0);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-saving a thread as a tweet with a longer caption updates the caption but never downgrades kind', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'thread', url: 'https://x.com/a/status/1', caption: 'short thread' }]});
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1',
        caption: 'a much, much longer caption than before' }]});
    assert.equal(out.updated, 1);
    const row = db.prepare('SELECT kind, caption FROM items WHERE url = ?').get('https://x.com/a/status/1');
    assert.equal(row.kind, 'thread');
    assert.equal(row.caption, 'a much, much longer caption than before');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('known-urls returns only urls already stored', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'x' }]});
    const out = await post(base, '/known-urls', {
      urls: ['https://x.com/a/status/1', 'https://x.com/a/status/999'] });
    assert.deepEqual(out.known, ['https://x.com/a/status/1']);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
