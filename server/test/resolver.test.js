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

test("a literal '--' precedes the url in the yt-dlp argv, so a malicious url can't be read as a flag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  let capturedArgs;
  const run = async (cmd, args) => {
    capturedArgs = args;
    const outDir = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(outDir), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  await downloadItem(
    { id: 20, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1' },
    { config, run });
  const dashIndex = capturedArgs.indexOf('--');
  assert.ok(dashIndex !== -1, "'--' must be present in the yt-dlp argv");
  assert.equal(capturedArgs[dashIndex + 1], 'https://x.com/a/status/1');
  assert.equal(capturedArgs[capturedArgs.length - 1], 'https://x.com/a/status/1');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a literal '--' precedes the url in the gallery-dl argv, so a malicious url can't be read as a flag", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  let capturedArgs;
  const run = async (cmd, args) => {
    capturedArgs = args;
    const outDir = args[args.indexOf('-D') + 1];
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'photo.jpg'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  await downloadItem(
    { id: 21, platform: 'instagram', kind: 'post', url: 'https://instagram.com/p/z/' },
    { config, run });
  const dashIndex = capturedArgs.indexOf('--');
  assert.ok(dashIndex !== -1, "'--' must be present in the gallery-dl argv");
  assert.equal(capturedArgs[dashIndex + 1], 'https://instagram.com/p/z/');
  assert.equal(capturedArgs[capturedArgs.length - 1], 'https://instagram.com/p/z/');
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

test('a retry does not report stale files left behind by a previous failed attempt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const itemDir = path.join(dir, '10');
  fs.mkdirSync(itemDir, { recursive: true });
  fs.writeFileSync(path.join(itemDir, 'old.part'), 'stale');

  const run = async (cmd, args) => {
    const outDir = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(outDir), 'clip.mp4'), 'x'.repeat(100));
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = await downloadItem(
    { id: 10, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/d/' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.files.length, 1);
  assert.equal(path.basename(out.files[0].path), 'clip.mp4');
  assert.ok(!out.files.some((f) => path.basename(f.path) === 'old.part'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing item id is refused instead of clearing the whole media directory', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const sentinel = path.join(dir, 'other-item', 'keep.mp4');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'x');

  const run = async () => { throw new Error('run should never be called'); };
  const out = await downloadItem(
    { id: '', platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/e/' },
    { config, run });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'download_failed');
  assert.ok(fs.existsSync(sentinel), 'unrelated media must survive a missing-id call');
  fs.rmSync(dir, { recursive: true, force: true });
});

for (const dangerousId of ['.', '..', '/', '\\', '../../etc']) {
  test(`a dangerous item id (${JSON.stringify(dangerousId)}) is refused and the media root survives intact`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
    const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
    const sentinel = path.join(dir, 'other-item', 'keep.mp4');
    fs.mkdirSync(path.dirname(sentinel), { recursive: true });
    fs.writeFileSync(sentinel, 'x');

    const run = async () => { throw new Error('run should never be called'); };
    const out = await downloadItem(
      { id: dangerousId, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/f/' },
      { config, run });

    assert.equal(out.ok, false);
    assert.equal(out.errorKind, 'download_failed');
    // The whole point of this test: assert the filesystem was left alone,
    // not just that the return value looks right. A regex-only guard that
    // still let rmSync run against MEDIA_DIR itself would pass a
    // return-value-only assertion while wiping everything.
    assert.ok(fs.existsSync(dir), 'media root must still exist');
    assert.ok(fs.existsSync(sentinel), 'unrelated media must survive a dangerous-id call');
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

test('item.id === 0 is a legitimate falsy id and still works normally', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async (cmd, args) => {
    const outDir = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(outDir), 'clip.mp4'), 'x'.repeat(100));
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = await downloadItem(
    { id: 0, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/g/' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.files.length, 1);
  assert.ok(fs.existsSync(path.join(dir, '0')), 'the "0" item directory should have been created');
  fs.rmSync(dir, { recursive: true, force: true });
});
