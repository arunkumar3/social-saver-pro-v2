import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { runMediaStage } from '../src/worker/media-stage.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ws-'));
  const db = openDb(path.join(dir, 'archive.db'));
  return { dir, db, config: { MEDIA_DIR: path.join(dir, 'media'),
                              COOKIES_PATH: path.join(dir, 'c.txt') } };
}

const okRun = (dir) => async (cmd, args) => {
  const out = args[args.indexOf('-o') + 1];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(out), 'a.mp4'), 'xyz');
  return { code: 0, stdout: '', stderr: '' };
};

test('pending items advance to media and record their files', async () => {
  const { dir, db, config } = harness();
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    const out = await runMediaStage(db, { config, run: okRun(dir), limit: 10 });
    assert.equal(out.succeeded, 1);
    assert.equal(db.prepare('SELECT state FROM items WHERE id = 1').get().state, 'media');
    assert.equal(db.prepare("SELECT count(*) c FROM media WHERE kind='video'").get().c, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('already-processed items are not reprocessed', async () => {
  const { dir, db, config } = harness();
  try {
    db.prepare("INSERT INTO items(platform,kind,url,state) VALUES ('instagram','reel','https://ig/r/1','media')").run();
    const out = await runMediaStage(db, { config, run: okRun(dir), limit: 10 });
    assert.equal(out.processed, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failure increments attempts and records the error', async () => {
  const { dir, db, config } = harness();
  const failRun = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    await runMediaStage(db, { config, run: failRun, limit: 10 });
    const row = db.prepare('SELECT state, attempts, state_error FROM items WHERE id = 1').get();
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.state_error, /boom/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an item parks in failed after three attempts', async () => {
  const { dir, db, config } = harness();
  const failRun = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    for (let i = 0; i < 3; i++) await runMediaStage(db, { config, run: failRun, limit: 10 });
    const row = db.prepare('SELECT state, attempts FROM items WHERE id = 1').get();
    assert.equal(row.state, 'failed');
    assert.equal(row.attempts, 3);
    const again = await runMediaStage(db, { config, run: failRun, limit: 10 });
    assert.equal(again.processed, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an auth_expired failure is identifiable from the items row alone, not just job_runs', async () => {
  const { dir, db, config } = harness();
  const authFailRun = async () => ({ code: 1, stdout: '', stderr: 'login required to access this content' });
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','post','https://ig/p/1')").run();
    await runMediaStage(db, { config, run: authFailRun, limit: 10 });
    const row = db.prepare('SELECT state_error FROM items WHERE id = 1').get();
    assert.match(row.state_error, /auth_expired/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every attempt is logged to job_runs', async () => {
  const { dir, db, config } = harness();
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    await runMediaStage(db, { config, run: okRun(dir), limit: 10 });
    const row = db.prepare("SELECT stage, status FROM job_runs WHERE item_id = 1").get();
    assert.equal(row.stage, 'media');
    assert.equal(row.status, 'ok');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
