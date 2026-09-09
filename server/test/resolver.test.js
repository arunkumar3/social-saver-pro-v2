import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseDownloader, downloadItem } from '../src/media/resolver.js';

test('reels and video tweets go to yt-dlp', () => {
  assert.equal(chooseDownloader({ platform: 'instagram', kind: 'reel' }), 'yt-dlp');
  assert.equal(chooseDownloader({ platform: 'twitter', kind: 'tweet' }), 'yt-dlp');
});

test('instagram image posts and carousels go to gallery-dl', () => {
  assert.equal(chooseDownloader({ platform: 'instagram', kind: 'post' }), 'gallery-dl');
  assert.equal(chooseDownloader({ platform: 'instagram', kind: 'carousel' }), 'gallery-dl');
});

test('a successful download reports the files that appeared', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async (cmd, args) => {
    const outDir = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(outDir), 'clip.mp4'), 'x'.repeat(100));
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = await downloadItem(
    { id: 7, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].kind, 'video');
  assert.equal(out.files[0].bytes, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-zero exit is reported, not thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'HTTP Error 401: Unauthorized' });
  const out = await downloadItem(
    { id: 8, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/b/' },
    { config, run });
  assert.equal(out.ok, false);
  assert.match(out.error, /401/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired session is reported as a named error, not a generic failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'login required to access this content' });
  const out = await downloadItem(
    { id: 9, platform: 'instagram', kind: 'post', url: 'https://instagram.com/p/c/' },
    { config, run });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'auth_expired');
  fs.rmSync(dir, { recursive: true, force: true });
});
