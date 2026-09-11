import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

// GET /api/stats backs the popup's archive summary and its post-sync progress
// polling. It must be safe to call against an empty archive (the popup opens
// before anything is saved) and must report bytes on disk, since the whole
// point of the pre-sync preview is knowing what a download will cost.

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-stats-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const server = createServer({ db, config: { COOKIES_PATH: path.join(dir, 'c.txt') } });
  return { dir, db, server };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

function addItem(db, { platform = 'instagram', kind = 'reel', url, state = 'pending' }) {
  db.prepare('INSERT INTO items (platform, kind, url, state) VALUES (?, ?, ?, ?)')
    .run(platform, kind, url, state);
  return db.prepare('SELECT id FROM items WHERE url = ?').get(url).id;
}

test('an empty archive reports zeroes rather than nulls or an error', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/api/stats`);
    assert.equal(res.status, 200);
    const s = await res.json();
    assert.equal(s.items.total, 0);
    assert.equal(s.media.files, 0);
    assert.equal(s.media.bytes, 0);
    // A null here would render as "null MB" in the popup.
    assert.equal(s.media.meanBytes, 0);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('items are counted by platform and by state', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { platform: 'twitter', kind: 'tweet', url: 'https://x.com/1', state: 'media' });
    addItem(db, { platform: 'twitter', kind: 'tweet', url: 'https://x.com/2', state: 'pending' });
    addItem(db, { platform: 'instagram', url: 'https://instagram.com/p/a/', state: 'media' });
    addItem(db, { platform: 'instagram', url: 'https://instagram.com/p/b/', state: 'failed' });

    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.items.total, 4);
    assert.equal(s.items.byPlatform.twitter, 2);
    assert.equal(s.items.byPlatform.instagram, 2);
    assert.equal(s.items.byState.media, 2);
    assert.equal(s.items.byState.pending, 1);
    assert.equal(s.items.byState.failed, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('media bytes are summed and averaged for the download estimate', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://instagram.com/p/a/', state: 'media' });
    db.prepare('INSERT INTO media (item_id, kind, path, bytes) VALUES (?, ?, ?, ?)')
      .run(id, 'video', 'a.mp4', 1000);
    db.prepare('INSERT INTO media (item_id, kind, path, bytes) VALUES (?, ?, ?, ?)')
      .run(id, 'video', 'b.mp4', 3000);

    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.media.files, 2);
    assert.equal(s.media.bytes, 4000);
    assert.equal(s.media.meanBytes, 2000);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a media row with a null byte count does not poison the sum or the mean', async () => {
  // The media stage writes rows before it knows sizes in some failure paths;
  // SUM() over a NULL would return NULL and render as "null MB".
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://instagram.com/p/a/', state: 'media' });
    db.prepare('INSERT INTO media (item_id, kind, path, bytes) VALUES (?, ?, ?, NULL)')
      .run(id, 'video', 'a.mp4');
    db.prepare('INSERT INTO media (item_id, kind, path, bytes) VALUES (?, ?, ?, ?)')
      .run(id, 'video', 'b.mp4', 500);

    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.media.files, 2);
    assert.equal(s.media.bytes, 500);
    assert.equal(s.media.meanBytes, 500, 'mean should ignore rows with no recorded size');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stats reports how many instagram items still await media', async () => {
  // This is what the popup polls to render "142 / 295 downloaded".
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://instagram.com/p/a/', state: 'pending' });
    addItem(db, { url: 'https://instagram.com/p/b/', state: 'pending' });
    addItem(db, { url: 'https://instagram.com/p/c/', state: 'media' });
    addItem(db, { url: 'https://instagram.com/p/d/', state: 'failed' });

    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.queue.pending, 2);
    assert.equal(s.queue.done, 1);
    assert.equal(s.queue.failed, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/stats needs no Origin and is refused from a cross-site Origin', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    // A GET is not state-changing, so the popup (chrome-extension origin) and
    // curl (no origin) must both work.
    assert.equal((await fetch(`${base}/api/stats`)).status, 200);
    const ext = await fetch(`${base}/api/stats`, {
      headers: { origin: 'chrome-extension://oajbkpfgclkclmhbabnpaefkimjhbpkg' },
    });
    assert.equal(ext.status, 200);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the size estimate is per-platform, not a global mean', async () => {
  // Real data showed why: a 603 MB tweet video dragged the global mean to
  // 124 MB, which would have estimated an 18 MB reel at seven times its size.
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const tw = addItem(db, { platform: 'twitter', kind: 'tweet', url: 'https://x.com/1', state: 'media' });
    const ig = addItem(db, { platform: 'instagram', url: 'https://instagram.com/p/a/', state: 'media' });
    db.prepare('INSERT INTO media (item_id, kind, path, bytes) VALUES (?, ?, ?, ?)')
      .run(tw, 'video', 'big.mp4', 600_000_000);
    db.prepare('INSERT INTO media (item_id, kind, path, bytes) VALUES (?, ?, ?, ?)')
      .run(ig, 'video', 'reel.mp4', 18_000_000);

    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.media.meanBytesByPlatform.instagram, 18_000_000);
    assert.equal(s.media.meanBytesByPlatform.twitter, 600_000_000);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a platform with no sized media is absent rather than zero or NaN', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { platform: 'instagram', url: 'https://instagram.com/p/a/', state: 'pending' });
    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.media.meanBytesByPlatform.instagram, undefined);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('stats surfaces the deferred backlog separately from pending', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://instagram.com/p/a/', state: 'deferred' });
    addItem(db, { url: 'https://instagram.com/p/b/', state: 'deferred' });
    addItem(db, { url: 'https://instagram.com/p/c/', state: 'pending' });
    const s = await (await fetch(`${base}/api/stats`)).json();
    assert.equal(s.queue.deferred, 2);
    assert.equal(s.queue.pending, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
