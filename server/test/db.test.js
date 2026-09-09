import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-db-'));
  return { dir, file: path.join(dir, 'archive.db') };
}

test('sqlite-vec loads and vec0 tables accept 768-dim vectors', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    const v = db.prepare('select vec_version() as v').get();
    assert.match(v.v, /^v\d+\.\d+\.\d+/);

    const embedding = new Float32Array(768).fill(0.1);
    db.prepare('INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)')
      .run(1n, new Uint8Array(embedding.buffer));

    const rows = db.prepare(
      'SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 1'
    ).all(new Uint8Array(embedding.buffer));
    assert.equal(Number(rows[0].chunk_id), 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('items enforces the platform constraint', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    assert.throws(() => db.prepare(
      "INSERT INTO items(platform, kind, url) VALUES ('myspace','post','u')").run());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('items defaults state to pending and url is unique', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO items(platform, kind, url) VALUES ('twitter','tweet','https://x.com/a/status/1')").run();
    const row = db.prepare("SELECT state, action_status FROM items WHERE url = ?")
      .get('https://x.com/a/status/1');
    assert.equal(row.state, 'pending');
    assert.equal(row.action_status, 'pending');
    assert.throws(() => db.prepare(
      "INSERT INTO items(platform, kind, url) VALUES ('twitter','tweet','https://x.com/a/status/1')").run());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting an item cascades to its media rows', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO items(platform, kind, url) VALUES ('instagram','reel','https://instagram.com/p/x/')").run();
    const id = db.prepare("SELECT id FROM items WHERE url = ?").get('https://instagram.com/p/x/').id;
    db.prepare("INSERT INTO media(item_id, kind, path) VALUES (?, 'video', 'a.mp4')").run(id);
    db.prepare("DELETE FROM items WHERE id = ?").run(id);
    assert.equal(db.prepare("SELECT count(*) c FROM media").get().c, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('full-text search finds an item through the FTS triggers', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO items(platform,kind,url,caption) VALUES ('twitter','tweet','u1','vector databases are useful')").run();
    assert.equal(db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'vector'").all().length, 1);

    db.prepare("UPDATE items SET caption = 'something else entirely' WHERE url = 'u1'").run();
    assert.equal(db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'vector'").all().length, 0);

    db.prepare("DELETE FROM items WHERE url = 'u1'").run();
    assert.equal(db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'entirely'").all().length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb is idempotent across reopens', () => {
  const { dir, file } = tmpDb();
  let db = openDb(file);
  db.prepare("INSERT INTO items(platform, kind, url) VALUES ('twitter','tweet','u1')").run();
  db.close();
  db = openDb(file);
  try {
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
