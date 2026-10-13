import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { parseRange } from '../src/routes/media.js';

function harness(extraDeps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-media-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), MEDIA_DIR: path.join(dir, 'media') };
  return { dir, db, config, server: createServer({ db, config, ...extraDeps }) };
}
async function listenPort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
function addFile(db, config, rel, body) {
  const file = path.join(config.MEDIA_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  db.prepare("INSERT INTO items (platform, kind, url, state) VALUES ('twitter','tweet',?, 'media')").run(`https://x.com/a/status/${rel.length}${Math.random()}`);
  const itemId = db.prepare('SELECT max(id) id FROM items').get().id;
  db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (?, 'video', ?, ?)").run(itemId, file, body.length);
  return { id: db.prepare('SELECT max(id) id FROM media').get().id, file };
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

test('parseRange handles the forms browsers send', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=950-5000', 1000), { start: 950, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=abc', 1000), null);
  assert.equal(parseRange('bytes=0-10,20-30', 1000), null);
  assert.equal(parseRange('items=0-10', 1000), null);
});

test('no Range header streams the whole file with 200', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    const r = await get(port, `/media/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(Number(r.headers['content-length']), 1000);
    assert.ok(r.body.equals(BODY));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Range request returns 206 with the exact bytes asked for', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    const r = await get(port, `/media/${id}`, { range: 'bytes=100-199' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 100-199/1000');
    assert.equal(Number(r.headers['content-length']), 100);
    assert.ok(r.body.equals(BODY.subarray(100, 200)));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Range starting past the end is 416', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    const r = await get(port, `/media/${id}`, { range: 'bytes=1000-' });
    assert.equal(r.status, 416);
    assert.equal(r.headers['content-range'], 'bytes */1000');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed or multi-part Range is ignored and the whole file is sent', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    for (const range of ['bytes=abc', 'bytes=0-10,20-30', 'nonsense']) {
      const r = await get(port, `/media/${id}`, { range });
      assert.equal(r.status, 200, range);
      assert.ok(r.body.equals(BODY), range);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Content-Type follows the extension', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const cases = [['a.mov', 'video/quicktime'], ['b.mkv', 'video/x-matroska'], ['c.mp3', 'audio/mpeg'],
      ['d.webm', 'video/webm'], ['e.jpg', 'image/jpeg'], ['f.png', 'image/png'], ['g.xyz', 'application/octet-stream']];
    for (const [name, type] of cases) {
      const { id } = addFile(db, config, `twitter/9/${name}`, BODY);
      assert.equal((await get(port, `/media/${id}`)).headers['content-type'], type, name);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown, non-numeric and missing-file ids are 404', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id, file } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    fs.rmSync(file);
    for (const p of [`/media/${id}`, '/media/999', '/media/abc', '/media/..%2F..%2Fserver.js']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a stored path outside MEDIA_DIR is refused even though the file exists', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'not media');
    db.prepare("INSERT INTO items (platform, kind, url) VALUES ('twitter','tweet','https://x.com/a/status/1')").run();
    db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (1, 'video', ?, 9)").run(outside);
    assert.equal((await get(port, '/media/1')).status, 404);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a client that disconnects mid-stream has its file stream destroyed', async () => {
  // Browsers abort the transfer on every seek. Without teardown each seek
  // through a large video leaks a file descriptor.
  const opened = [];
  const openStream = (file, opts) => { const s = fs.createReadStream(file, opts); opened.push(s); return s; };
  const { dir, db, config, server } = harness({ openStream });
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/big.mp4', Buffer.alloc(8 * 1024 * 1024, 7));
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/media/${id}` }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });
    let destroyed = false;
    for (let i = 0; i < 40 && !destroyed; i++) {
      destroyed = opened.length === 1 && opened[0].destroyed;
      if (!destroyed) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(destroyed, 'the read stream was left open after the client went away');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
