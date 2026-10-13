import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-items-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), MEDIA_DIR: path.join(dir, 'media') };
  return { dir, db, server: createServer({ db, config }) };
}
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
function addItem(db, { platform = 'twitter', kind = 'tweet', url, caption = 'x', status = 'pending', handle = '@someone' }) {
  db.prepare('INSERT INTO items (platform, kind, url, caption, action_status, author_handle, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(platform, kind, url, caption, status, handle, 'media');
  return db.prepare('SELECT id FROM items WHERE url = ?').get(url).id;
}
const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const patch = async (base, id, body, headers = {}) => {
  const r = await fetch(`${base}/api/items/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('the feed is newest-saved first and defaults to to-do items', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const a = addItem(db, { url: 'https://x.com/a/status/1' });
    const b = addItem(db, { url: 'https://x.com/a/status/2', status: 'done' });
    const c = addItem(db, { url: 'https://x.com/a/status/3' });
    const { status, body } = await get(base, '/api/items');
    assert.equal(status, 200);
    assert.deepEqual(body.items.map((i) => i.id), [c, a]);
    assert.ok(!body.items.some((i) => i.id === b));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('status filters: all, done, skipped', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1' });
    const d = addItem(db, { url: 'https://x.com/a/status/2', status: 'done' });
    const s = addItem(db, { url: 'https://x.com/a/status/3', status: 'skipped' });
    assert.equal((await get(base, '/api/items?status=all')).body.items.length, 3);
    assert.deepEqual((await get(base, '/api/items?status=done')).body.items.map((i) => i.id), [d]);
    assert.deepEqual((await get(base, '/api/items?status=skipped')).body.items.map((i) => i.id), [s]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kind and platform filters', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', kind: 'tweet' });
    const t = addItem(db, { url: 'https://x.com/a/status/2', kind: 'thread' });
    addItem(db, { platform: 'instagram', kind: 'reel', url: 'https://instagram.com/p/a/' });
    assert.deepEqual((await get(base, '/api/items?kind=thread')).body.items.map((i) => i.id), [t]);
    assert.ok((await get(base, '/api/items')).body.items.every((i) => i.platform === 'twitter'));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hasVideo counts downloaded video only, not ingest-time placeholders', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const v = addItem(db, { url: 'https://x.com/a/status/1' });
    const p = addItem(db, { url: 'https://x.com/a/status/2' });
    db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (?, 'video', 'C:/m/a.mp4', 100)").run(v);
    db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (?, 'image', 'https://pbs.twimg.com/x.jpg', NULL)").run(p);
    const { body } = await get(base, '/api/items?hasVideo=1');
    assert.deepEqual(body.items.map((i) => i.id), [v]);
    const all = (await get(base, '/api/items')).body.items;
    assert.deepEqual(all.find((i) => i.id === p).media, [], 'placeholder rows are not reported as media');
    assert.deepEqual(all.find((i) => i.id === v).media, [{ id: 1, kind: 'video', bytes: 100, ext: '.mp4' }]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pagination by id: nextBefore, and null on the last page', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const ids = [1, 2, 3, 4, 5].map((n) => addItem(db, { url: `https://x.com/a/status/${n}` }));
    const p1 = (await get(base, '/api/items?limit=2')).body;
    assert.deepEqual(p1.items.map((i) => i.id), [ids[4], ids[3]]);
    assert.equal(p1.nextBefore, ids[3]);
    const p3 = (await get(base, `/api/items?limit=2&before=${ids[1]}`)).body;
    assert.deepEqual(p3.items.map((i) => i.id), [ids[0]]);
    assert.equal(p3.nextBefore, null);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('marking an item done between pages neither skips nor repeats items', async () => {
  // The reason for keyset pagination: with offsets, removing an item from the
  // to-do set shifts every later item up and the next page skips one.
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const ids = [1, 2, 3, 4, 5].map((n) => addItem(db, { url: `https://x.com/a/status/${n}` }));
    const p1 = (await get(base, '/api/items?limit=2')).body;
    await patch(base, ids[4], { actionStatus: 'done' });
    const p2 = (await get(base, `/api/items?limit=2&before=${p1.nextBefore}`)).body;
    assert.deepEqual(p2.items.map((i) => i.id), [ids[2], ids[1]]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('excerpt is 280 code points, so an emoji is never split', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'a'.repeat(279) + '🚀' + 'tail' });
    const item = (await get(base, '/api/items')).body.items[0];
    assert.equal(item.excerpt, 'a'.repeat(279) + '🚀');
    assert.equal(item.textLength, 284);
    assert.equal(Array.from(item.excerpt).length, 280);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the summary carries the handle exactly as stored', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', handle: '@oneviske' });
    assert.equal((await get(base, '/api/items')).body.items[0].authorHandle, '@oneviske');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad feed parameters are 400 with a named error', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const cases = [
      ['platform=myspace', 'bad_platform'], ['status=archived', 'bad_status'], ['kind=story', 'bad_kind'],
      ['limit=0', 'bad_limit'], ['limit=101', 'bad_limit'], ['limit=abc', 'bad_limit'], ['before=abc', 'bad_before'],
    ];
    for (const [qs, error] of cases) {
      const r = await get(base, `/api/items?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.equal(r.body.error, error, qs);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/items/:id returns full text instead of an excerpt', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const long = 'word '.repeat(3000);
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: long });
    const { status, body } = await get(base, `/api/items/${id}`);
    assert.equal(status, 200);
    assert.equal(body.text, long);
    assert.equal(body.excerpt, undefined);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown and non-numeric item ids are 404, not 500', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    for (const id of ['999', 'abc', '1.5', '-1', '%20']) {
      const r = await get(base, `/api/items/${id}`);
      assert.equal(r.status, 404, id);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH sets each status and changes nothing else', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: 'keep me' });
    for (const s of ['done', 'skipped', 'pending']) {
      const r = await patch(base, id, { actionStatus: s });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, id, actionStatus: s });
      const row = db.prepare('SELECT action_status, caption, state FROM items WHERE id = ?').get(id);
      assert.equal(row.action_status, s);
      assert.equal(row.caption, 'keep me');
      assert.equal(row.state, 'media');
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH rejects bad values, extra fields and malformed JSON with 400', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1' });
    assert.equal((await patch(base, id, { actionStatus: 'archived' })).body.error, 'bad_action_status');
    assert.equal((await patch(base, id, { actionStatus: 'done', caption: 'pwned' })).body.error, 'bad_action_status');
    assert.equal((await patch(base, id, {})).body.error, 'bad_action_status');
    assert.equal((await patch(base, id, [])).body.error, 'bad_action_status');
    const bad = await patch(base, id, '{not json');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_json');
    assert.equal(db.prepare('SELECT action_status FROM items WHERE id = ?').get(id).action_status, 'pending');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH on an unknown id is 404', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    assert.equal((await patch(base, 999, { actionStatus: 'done' })).status, 404);
    assert.equal((await patch(base, 'abc', { actionStatus: 'done' })).status, 404);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH from a cross-site origin is refused; from the extension it is allowed', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1' });
    assert.equal((await patch(base, id, { actionStatus: 'done' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(db.prepare('SELECT action_status FROM items WHERE id = ?').get(id).action_status, 'pending');
    assert.equal((await patch(base, id, { actionStatus: 'done' }, { origin: 'chrome-extension://abc' })).status, 200);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
