import fs from 'node:fs';
import path from 'node:path';
import { run as defaultRun } from './ytdlp.js';
import { galleryDlPath } from './gallerydl.js';

const VIDEO_KINDS = new Set(['reel', 'tweet', 'thread', 'article']);
const AUTH_PATTERNS = [/login required/i, /rate.?limit/i, /checkpoint/i, /challenge_required/i];

// Most posts on X are text. yt-dlp reports that by exiting NON-ZERO, which
// naively reads as a failed download — real data had 8 of 17 tweets parked in
// `failed`, half of them ordinary text tweets, making the archive look broken
// when nothing was wrong. These say "there is nothing here to download", which
// is an outcome, not an error.
const NO_MEDIA_PATTERNS = [
  /no video could be found/i,
  /no video formats found/i,
  /there'?s no video/i,
  /no results for/i,          // gallery-dl
  /unable to extract.*media/i,
];

/**
 * When a tweet carries no native video, yt-dlp follows the link inside it and
 * fails on THAT url instead. The tweet still simply has no media of its own.
 * An "Unsupported URL" naming the item's own url is a genuine failure; one
 * naming any other url means the downloader wandered off to a linked site.
 */
function isFollowedLinkMiss(stderr, itemUrl) {
  const m = stderr.match(/Unsupported URL:\s*(\S+)/i);
  if (!m) return false;
  return m[1].replace(/\/+$/, '') !== String(itemUrl).replace(/\/+$/, '');
}

export function chooseDownloader(item) {
  if (item.platform === 'instagram' && !VIDEO_KINDS.has(item.kind)) return 'gallery-dl';
  return 'yt-dlp';
}

function classifyKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.mp4', '.mkv', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.m4a', '.mp3', '.wav', '.opus'].includes(ext)) return 'audio';
  return 'image';
}

// Allow-list: item.id must be a single, simple path segment. This rejects
// '.', '..', '/', '\\' and anything containing a path separator or
// traversal sequence, while still accepting falsy-but-valid ids like 0.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export async function downloadItem(item, { config, run = defaultRun }) {
  const id = item.id;
  if (id === undefined || id === null || String(id).trim() === '' || !SAFE_ID_PATTERN.test(String(id))) {
    return { ok: false, files: [], error: 'item.id is missing or unsafe; refusing to resolve a media directory',
             errorKind: 'download_failed' };
  }
  const itemDir = path.join(config.MEDIA_DIR, String(id));

  // Belt-and-braces containment check: even with the regex above, verify the
  // resolved itemDir is genuinely a direct child of the media root before
  // ever touching the filesystem. Guards against the regex being loosened by
  // accident later, or MEDIA_DIR/id interacting in an unforeseen way.
  const resolvedMediaDir = path.resolve(config.MEDIA_DIR);
  const resolvedItemDir = path.resolve(itemDir);
  if (path.dirname(resolvedItemDir) !== resolvedMediaDir) {
    return { ok: false, files: [], error: 'resolved item directory escapes the media root; refusing to resolve',
             errorKind: 'download_failed' };
  }

  // itemDir is keyed only by item.id and persists across retry attempts, so a
  // stale .part file / half-written image / gallery-dl metadata left behind
  // by a previous failed attempt must not leak into this attempt's readdirSync
  // below. Clear it first. force:true makes the first-ever attempt (no
  // directory yet) a no-op instead of an error.
  fs.rmSync(itemDir, { recursive: true, force: true });
  fs.mkdirSync(itemDir, { recursive: true });

  const downloader = chooseDownloader(item);
  const outTemplate = path.join(itemDir, '%(id)s.%(ext)s');

  // gallery-dl's -o sets a config key=value, not an output template — it only
  // takes -D for the destination directory. yt-dlp's -o genuinely is the
  // output template, so that branch keeps it.
  // A literal '--' terminates option parsing so item.url can never be
  // misread as a flag (e.g. '--exec=...' or '--config-location=...') by the
  // downloader — everything after it is forced to be a positional argument.
  const args = downloader === 'yt-dlp'
    ? ['--cookies', config.COOKIES_PATH, '--no-warnings', '-o', outTemplate, '--', item.url]
    : ['--cookies', config.COOKIES_PATH, '-D', itemDir, '--', item.url];

  const cmd = downloader === 'yt-dlp' ? 'yt-dlp' : galleryDlPath();
  const { code, stderr } = await run(cmd, args);

  if (code !== 0) {
    // Auth first: an expired session can surface alongside other noise, and
    // its fix is specific (log back in), so it must never be masked.
    if (AUTH_PATTERNS.some((re) => re.test(stderr))) {
      return { ok: false, files: [], error: stderr.trim().slice(0, 500), errorKind: 'auth_expired' };
    }
    if (NO_MEDIA_PATTERNS.some((re) => re.test(stderr)) || isFollowedLinkMiss(stderr, item.url)) {
      return { ok: true, files: [], noMedia: true, note: stderr.trim().slice(0, 200) };
    }
    return { ok: false, files: [], error: stderr.trim().slice(0, 500), errorKind: 'download_failed' };
  }

  const files = fs.readdirSync(itemDir).map((name) => {
    const full = path.join(itemDir, name);
    return { kind: classifyKind(name), path: full, bytes: fs.statSync(full).size };
  });

  if (files.length === 0) {
    // A clean exit that produced nothing means there was nothing to fetch.
    return { ok: true, files: [], noMedia: true, note: 'downloader exited 0 with no files' };
  }
  return { ok: true, files };
}
