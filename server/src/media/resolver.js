import fs from 'node:fs';
import path from 'node:path';
import { run as defaultRun } from './ytdlp.js';
import { galleryDlPath } from './gallerydl.js';

const VIDEO_KINDS = new Set(['reel', 'tweet', 'thread', 'article']);
const AUTH_PATTERNS = [/login required/i, /rate.?limit/i, /checkpoint/i, /challenge_required/i];

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

export async function downloadItem(item, { config, run = defaultRun }) {
  const id = item.id;
  if (id === undefined || id === null || String(id).trim() === '') {
    return { ok: false, files: [], error: 'item.id is missing; refusing to resolve a media directory',
             errorKind: 'download_failed' };
  }
  const itemDir = path.join(config.MEDIA_DIR, String(id));

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
  const args = downloader === 'yt-dlp'
    ? ['--cookies', config.COOKIES_PATH, '--no-warnings', '-o', outTemplate, item.url]
    : ['--cookies', config.COOKIES_PATH, '-D', itemDir, item.url];

  const cmd = downloader === 'yt-dlp' ? 'yt-dlp' : galleryDlPath();
  const { code, stderr } = await run(cmd, args);

  if (code !== 0) {
    const errorKind = AUTH_PATTERNS.some((re) => re.test(stderr)) ? 'auth_expired' : 'download_failed';
    return { ok: false, files: [], error: stderr.trim().slice(0, 500), errorKind };
  }

  const files = fs.readdirSync(itemDir).map((name) => {
    const full = path.join(itemDir, name);
    return { kind: classifyKind(name), path: full, bytes: fs.statSync(full).size };
  });

  if (files.length === 0) {
    return { ok: false, files: [], error: 'downloader exited 0 but produced no files',
             errorKind: 'download_failed' };
  }
  return { ok: true, files };
}
