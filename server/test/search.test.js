import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-search-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), MEDIA_DIR: path.join(dir, 'media') };
  return { dir, db, server: createServer({ db, config }) };
}
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
function addItem(db, { platform = 'twitter', url, caption, status = 'pending' }) {
  db.prepare("INSERT INTO items (platform, kind, url, caption, action_status, state) VALUES (?, 'tweet', ?, ?, ?, 'media')")
    .run(platform, url, caption, status);
  return db.prepare('SELECT id FROM items WHERE url = ?').get(url).id;
}
const search = async (base, qs) => {
  const r = await fetch(`${base}/api/search?${qs}`);
  return { status: r.status, body: await r.json() };
};

test('results are ranked by relevance, best first', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const weak = addItem(db, { url: 'https://x.com/a/status/1', caption: 'one mention of agent among many other unrelated words here' });
    const strong = addItem(db, { url: 'https://x.com/a/status/2', caption: 'agent agent agent framework' });
    const { body } = await search(base, 'q=agent');
    assert.deepEqual(body.items.map((i) => i.id), [strong, weak]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the last word matches as a prefix, so results appear while typing', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: 'a new agent framework' });
    assert.deepEqual((await search(base, 'q=agen')).body.items.map((i) => i.id), [id]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('anything typed returns 200, never a 500', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    for (const q of ['"', '-', '(', 'agent "', '🚀', '--', 'NEAR(', 'OR', '*', 'caption:agent', '%', "it's"]) {
      const r = await search(base, `q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, JSON.stringify(q));
      assert.ok(Array.isArray(r.body.items), JSON.stringify(q));
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a blank query returns an empty list', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    for (const qs of ['q=', 'q=%20%20', '']) {
      const r = await search(base, qs);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, []);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('snippets arrive as spans with the hit marked, and contain no markup', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'a new agent framework for everyone' });
    const item = (await search(base, 'q=agent')).body.items[0];
    assert.ok(Array.isArray(item.snippet));
    assert.ok(item.snippet.some((s) => s.hit && s.text.toLowerCase() === 'agent'));
    const joined = item.snippet.map((s) => s.text).join('');
    assert.ok(!joined.includes('<mark>'));
    assert.ok(!joined.includes('') && !joined.includes(''));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('markup in a caption comes back as literal text in excerpt and snippet', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const evil = '<img src=x onerror=alert(1)> agent';
    addItem(db, { url: 'https://x.com/a/status/1', caption: evil });
    const item = (await search(base, 'q=agent')).body.items[0];
    assert.equal(item.excerpt, evil);
    assert.ok(item.snippet.map((s) => s.text).join('').includes('<img src=x onerror=alert(1)>'));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('search includes done items by default, so finished work is still findable', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const done = addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent', status: 'done' });
    assert.deepEqual((await search(base, 'q=agent')).body.items.map((i) => i.id), [done]);
    assert.deepEqual((await search(base, 'q=agent&status=pending')).body.items, []);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('search is scoped to one platform', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const tw = addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    addItem(db, { platform: 'instagram', url: 'https://instagram.com/p/a/', caption: 'agent' });
    assert.deepEqual((await search(base, 'q=agent')).body.items.map((i) => i.id), [tw]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad parameters are 400 with a named error', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    assert.equal((await search(base, 'q=a&platform=myspace')).body.error, 'bad_platform');
    assert.equal((await search(base, 'q=a&status=archived')).body.error, 'bad_status');
    assert.equal((await search(base, 'q=a&limit=0')).body.error, 'bad_limit');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a NUL byte in the query is a normal answer, not a 500', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    for (const qs of ['q=agent%00', 'q=%00', 'q=ag%00ent']) {
      const r = await search(base, qs);
      assert.equal(r.status, 200, qs);
      assert.ok(Array.isArray(r.body.items), qs);
    }
    assert.deepEqual((await search(base, 'q=agent%00')).body.items.map((i) => i.id), [id]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
