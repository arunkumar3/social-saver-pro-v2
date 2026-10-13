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
  assert.ok(fs.existsSync(path.join(dir, 'instagram', '0')),
    'the "0" item directory should have been created under its platform');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── "no media" is an outcome, not a failure ──────────────────────────
//
// Most tweets are text. yt-dlp reports that by exiting non-zero with "No
// video could be found in this tweet", which the resolver used to classify
// as download_failed. Real data had 8 of 17 tweets parked in `failed` that
// way, four of them perfectly good text tweets — an archive that looked 44%
// broken when nothing was wrong.

test('a tweet with no video reports no_media, not a failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-nm-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({
    code: 1, stdout: '',
    stderr: 'ERROR: [twitter] 2096983157832847566: No video could be found in this tweet',
  });
  const out = await downloadItem(
    { id: 40, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1' },
    { config, run });
  assert.equal(out.ok, true, 'no media is a successful outcome');
  assert.equal(out.noMedia, true);
  assert.deepEqual(out.files, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('"No video formats found" is also no_media', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-nm-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: [twitter] 209: No video formats found!' });
  const out = await downloadItem(
    { id: 41, platform: 'twitter', kind: 'thread', url: 'https://x.com/a/status/2' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.noMedia, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an Unsupported URL naming a DIFFERENT url means yt-dlp followed an outbound link', async () => {
  // The tweet had no native video, so yt-dlp followed the link in it.
  // That is still "this tweet has no media", not a broken download.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-nm-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: Unsupported URL: https://inhobot.com/' });
  const out = await downloadItem(
    { id: 42, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/3' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.noMedia, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an Unsupported URL naming the ITEM url is a real failure', async () => {
  // Here the downloader genuinely cannot handle the thing we asked for.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-nm-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const url = 'https://x.com/a/status/4';
  const run = async () => ({ code: 1, stdout: '', stderr: `ERROR: Unsupported URL: ${url}` });
  const out = await downloadItem({ id: 43, platform: 'twitter', kind: 'tweet', url }, { config, run });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'download_failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired session is still auth_expired, never no_media', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-nm-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: login required to access this content' });
  const out = await downloadItem(
    { id: 44, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/x/' },
    { config, run });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'auth_expired');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exit 0 with no files produced is no_media, not a failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-nm-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 0, stdout: '', stderr: '' });
  const out = await downloadItem(
    { id: 45, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/5' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.noMedia, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── the cookie jar must survive the downloader ───────────────────────
//
// yt-dlp does not merely read the file given to --cookies; it writes its
// whole jar back afterwards. Pointed at the extension's export that meant
// every tweet download rewrote Instagram's cookie file, mixing in cookies
// from x.com (and, observed in practice, github.com), replacing the header
// with "generated by yt-dlp" and switching the file to CRLF endings.

test('the canonical cookie file is untouched even when the downloader rewrites it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ck-'));
  const cookies = path.join(dir, 'cookies.txt');
  const ORIGINAL = '# Netscape HTTP Cookie File\n.instagram.com\tTRUE\t/\tTRUE\t2000000000\tsessionid\tREAL\n';
  fs.writeFileSync(cookies, ORIGINAL);
  const config = { MEDIA_DIR: path.join(dir, 'media'), COOKIES_PATH: cookies };

  // Simulates yt-dlp: clobbers whatever cookie file it was handed.
  const run = async (cmd, args) => {
    const given = args[args.indexOf('--cookies') + 1];
    fs.writeFileSync(given, '# This file is generated by yt-dlp.  Do not edit.\r\n.x.com\tTRUE\t/\tTRUE\t1\tguest_id\tJUNK\r\n');
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };

  const res = await downloadItem(
    { id: 60, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' },
    { config, run });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(cookies, 'utf8'), ORIGINAL,
    'the extension export must be byte-identical after a download');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the downloader is handed a copy, not the canonical path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ck-'));
  const cookies = path.join(dir, 'cookies.txt');
  fs.writeFileSync(cookies, '# Netscape HTTP Cookie File\n');
  const config = { MEDIA_DIR: path.join(dir, 'media'), COOKIES_PATH: cookies };

  let handed = null;
  const run = async (cmd, args) => {
    handed = args[args.indexOf('--cookies') + 1];
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };

  await downloadItem({ id: 61, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/b/' },
    { config, run });
  assert.notEqual(handed, cookies);
  assert.ok(handed && handed.length > 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the temporary cookie copy is removed afterwards', async () => {
  // It holds a live session token; leaving copies scattered in temp is the
  // kind of thing that is easy to never notice.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ck-'));
  const cookies = path.join(dir, 'cookies.txt');
  fs.writeFileSync(cookies, '# Netscape HTTP Cookie File\n');
  const config = { MEDIA_DIR: path.join(dir, 'media'), COOKIES_PATH: cookies };

  let handed = null;
  const run = async (cmd, args) => {
    handed = args[args.indexOf('--cookies') + 1];
    return { code: 1, stdout: '', stderr: 'ERROR: HTTP Error 500: Server Error' };
  };

  await downloadItem({ id: 62, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/c/' },
    { config, run });
  assert.equal(fs.existsSync(handed), false, 'cleaned up even when the download failed');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the cookie copy is not mistaken for downloaded media', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ck-'));
  const cookies = path.join(dir, 'cookies.txt');
  fs.writeFileSync(cookies, '# Netscape HTTP Cookie File\n');
  const config = { MEDIA_DIR: path.join(dir, 'media'), COOKIES_PATH: cookies };
  const run = async (cmd, args) => {
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await downloadItem(
    { id: 63, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/d/' },
    { config, run });
  assert.equal(res.files.length, 1);
  assert.match(res.files[0].path, /clip\.mp4$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing cookie file does not crash the download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ck-'));
  const config = { MEDIA_DIR: path.join(dir, 'media'), COOKIES_PATH: path.join(dir, 'nope.txt') };
  const run = async (cmd, args) => {
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await downloadItem(
    { id: 64, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/e/' },
    { config, run });
  assert.equal(res.ok, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── media is laid out by platform ────────────────────────────────────
//
// media/<platform>/<item id>/ rather than media/<item id>/. Without the
// platform segment the folder tree says nothing about where a file came
// from — recoverable only by recognising that Twitter ids are numeric and
// Instagram's are alphanumeric, which is a coincidence of their id schemes
// rather than anything the design guarantees.

test('downloads land under media/<platform>/<id>/', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-lay-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async (cmd, args) => {
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await downloadItem(
    { id: 7, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' },
    { config, run });
  assert.equal(res.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'instagram', '7')), 'expected media/instagram/7');
  assert.ok(res.files[0].path.includes(path.join('instagram', '7')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the two platforms do not collide even on the same item id', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-lay-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async (cmd, args) => {
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  await downloadItem({ id: 9, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' }, { config, run });
  await downloadItem({ id: 9, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1' }, { config, run });
  assert.ok(fs.existsSync(path.join(dir, 'instagram', '9', 'clip.mp4')));
  assert.ok(fs.existsSync(path.join(dir, 'twitter', '9', 'clip.mp4')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an unknown platform is refused rather than becoming a directory name', async () => {
  // platform is now part of a filesystem path, so it needs the same
  // allow-list treatment item.id already gets.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-lay-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => { throw new Error('run() must not be called for a bad platform'); };
  for (const platform of ['..', 'myspace', '', undefined, 'inst/agram']) {
    const res = await downloadItem({ id: 5, platform, kind: 'reel', url: 'https://x.com/a/status/1' },
      { config, run });
    assert.equal(res.ok, false, `platform ${JSON.stringify(platform)} should be refused`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('clearing a retry only wipes that platform-and-item folder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-lay-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  fs.mkdirSync(path.join(dir, 'twitter', '9'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'twitter', '9', 'keep.mp4'), 'PRECIOUS');
  const run = async (cmd, args) => {
    const out = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(out), 'clip.mp4'), 'x');
    return { code: 0, stdout: '', stderr: '' };
  };
  await downloadItem({ id: 9, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' }, { config, run });
  assert.equal(fs.readFileSync(path.join(dir, 'twitter', '9', 'keep.mp4'), 'utf8'), 'PRECIOUS');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── a retry must never destroy a good download ───────────────────────
//
// The resolver used to clear the item folder BEFORE downloading, so a
// failed retry left nothing. Downloads now go to a staging folder that only
// replaces the real one on success.

function seed(dir, platform, id, name, body) {
  const d = path.join(dir, platform, String(id));
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), body);
  return d;
}
const writesClip = (name = 'new.mp4') => async (cmd, args) => {
  const out = args.includes('-o') ? path.dirname(args[args.indexOf('-o') + 1]) : args[args.indexOf('-D') + 1];
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, name), 'NEW');
  return { code: 0, stdout: '', stderr: '' };
};

test('a failed retry leaves the previous good download intact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-at-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const itemDir = seed(dir, 'twitter', 2, 'good.mp4', 'PRECIOUS 409 MB');
  const run = async () => ({ code: 1, stdout: '',
    stderr: "ERROR: [twitter] 2097202883662106972: Unable to download JSON metadata: ('Connection aborted.')" });
  const res = await downloadItem(
    { id: 2, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/2097202883662106972' },
    { config, run });
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(path.join(itemDir, 'good.mp4'), 'utf8'), 'PRECIOUS 409 MB');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a successful retry replaces the previous download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-at-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const itemDir = seed(dir, 'instagram', 5, 'old.mp4', 'OLD');
  const res = await downloadItem(
    { id: 5, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' },
    { config, run: writesClip() });
  assert.equal(res.ok, true);
  assert.deepEqual(fs.readdirSync(itemDir), ['new.mp4']);
  assert.ok(res.files[0].path.startsWith(itemDir), 'reported paths must be the final location, not staging');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('no staging folders are left behind, on success or failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-at-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  await downloadItem({ id: 6, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/b/' },
    { config, run: writesClip() });
  await downloadItem({ id: 7, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/c/' },
    { config, run: async () => ({ code: 1, stdout: '', stderr: 'ERROR: [Instagram] c: HTTP Error 500' }) });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'instagram')).sort(), ['6']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a no-media result keeps media an item already has', async () => {
  // If a source later loses its video, the archive should not follow it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-at-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const itemDir = seed(dir, 'twitter', 8, 'kept.mp4', 'KEEP');
  const run = async () => ({ code: 1, stdout: '', stderr: 'ERROR: [twitter] 8: No video could be found in this tweet' });
  const res = await downloadItem({ id: 8, platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/8' },
    { config, run });
  assert.equal(res.ok, true);
  assert.equal(fs.readFileSync(path.join(itemDir, 'kept.mp4'), 'utf8'), 'KEEP');
  assert.equal(res.files.length, 1, 'existing media should be reported so its row survives');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── failures on a LINK inside a post are not failures of the post ────
//
// When a tweet has no native video, yt-dlp follows what it links to and
// fails there instead: a deleted quoted tweet (404), a t.co shortener, a
// TikTok page (401), an external site rate-limiting (429). The tweet itself
// archived fine. The tell is that the failing extractor or id is not the
// post's own.

const failWith = (stderr) => async () => ({ code: 1, stdout: '', stderr });
async function classify(stderr, item) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-cl-'));
  try {
    return await downloadItem(item, { config: { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') }, run: failWith(stderr) });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const TWEET = { id: 1466, platform: 'twitter', kind: 'tweet', url: 'https://x.com/oneviske/status/2097612432072167859' };

test('a generic-extractor 404 on another id is a followed link: no media', async () => {
  const r = await classify('ERROR: [generic] 2097508727767351296: Unable to download webpage: HTTP Error 404: Not Found', TWEET);
  assert.equal(r.ok, true); assert.equal(r.noMedia, true);
});

test('a t.co shortener failure is a followed link: no media', async () => {
  const r = await classify('ERROR: [twitter:shortener] ot1t7L8ZBF: Unable to download webpage: HTTP Error 405', TWEET);
  assert.equal(r.noMedia, true);
});

test('a quoted tweet that was deleted is a followed link: no media', async () => {
  const r = await classify('ERROR: [twitter] 2097508727767351296: Unable to download JSON metadata: HTTP Error 404', TWEET);
  assert.equal(r.noMedia, true);
});

test('an external site rate-limiting is not our failure', async () => {
  const r = await classify('ERROR: [generic] rareui: Unable to download webpage: HTTP Error 429: Too Many Requests', TWEET);
  assert.equal(r.noMedia, true);
});

test('a failure on the post own id is still a genuine, retryable failure', async () => {
  // Item 2's real error. Transient, and about the tweet itself — must retry.
  const r = await classify("ERROR: [twitter] 2097202883662106972: Unable to download JSON metadata: ('Connection aborted.')",
    { id: 2, platform: 'twitter', kind: 'tweet', url: 'https://x.com/Blackmagic_News/status/2097202883662106972' });
  assert.equal(r.ok, false); assert.equal(r.errorKind, 'download_failed');
});

test('an Instagram failure on the post own shortcode is genuine', async () => {
  const r = await classify('ERROR: [Instagram] Dcn38GltCvu: Unable to download webpage: HTTP Error 500',
    { id: 21, platform: 'instagram', kind: 'reel', url: 'https://www.instagram.com/p/Dcn38GltCvu/' });
  assert.equal(r.ok, false); assert.equal(r.errorKind, 'download_failed');
});

test('an expired session still wins over link classification', async () => {
  const r = await classify('ERROR: [generic] something: login required to access this content', TWEET);
  assert.equal(r.errorKind, 'auth_expired');
});
