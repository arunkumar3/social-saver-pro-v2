import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { send } from '../http.js';

const TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Parse a single-range `Range` header.
 *
 * Returns { start, end } to send part of the file, 'unsatisfiable' for a range
 * that starts past the end, or null to ignore the header and send everything.
 * Malformed and multi-part ranges are ignored rather than refused: RFC 9110
 * lets a server do that, and the browser still gets a playable file.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export function getMedia(req, res, deps, idText) {
  const { db, config } = deps;
  if (!/^\d+$/.test(idText)) return send(res, 404, { error: 'not_found' });
  const row = db.prepare('SELECT path FROM media WHERE id = ?').get(Number(idText));
  if (!row) return send(res, 404, { error: 'not_found' });

  // The path comes from our own database, not the request, but this is the
  // one place the server hands a file to a browser. One more check is cheap.
  const root = path.resolve(config.MEDIA_DIR);
  const file = path.resolve(row.path);
  if (!file.startsWith(root + path.sep)) return send(res, 404, { error: 'not_found' });

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, { error: 'not_found' });
  }
  if (!stat.isFile()) return send(res, 404, { error: 'not_found' });

  const range = parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    return res.end();
  }

  const headers = {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const openStream = deps.openStream ?? fs.createReadStream;
  let stream;
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': range.end - range.start + 1,
    });
    stream = openStream(file, { start: range.start, end: range.end });
  } else {
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    stream = openStream(file);
  }

  // pipeline, not pipe: when the client goes away mid-transfer, which a
  // browser does on every seek, pipeline destroys the read stream and closes
  // its file handle. pipe() leaves the source paused and open, leaking one
  // descriptor per seek.
  pipeline(stream, res, () => {});
}
