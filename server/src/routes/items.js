import path from 'node:path';
import { send, readJson } from '../http.js';

export const PLATFORMS = new Set(['twitter', 'instagram']);
export const STATUSES = new Set(['pending', 'done', 'skipped']);
const KINDS = new Set(['tweet', 'thread', 'article', 'post', 'reel', 'carousel']);
const EXCERPT_CODE_POINTS = 280;

const SUMMARY_COLS =
  'id, platform, kind, url, author, author_handle, source_date, saved_at, action_status, caption';

export function parseLimit(v) {
  if (v === null || v === undefined) return 50;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 100 ? n : null;
}

function parseId(v) {
  return /^\d+$/.test(String(v)) ? Number(v) : null;
}

/**
 * Downloaded media for a page of items, in one query rather than one per item.
 * Rows with no byte count are skipped: those are placeholders written at
 * ingest time that hold a source URL, not a file on disk.
 */
export function mediaByItem(db, ids) {
  const out = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = db.prepare(`
    SELECT id, item_id, kind, bytes, path FROM media
    WHERE bytes IS NOT NULL AND item_id IN (${ids.map(() => '?').join(',')})
    ORDER BY id`).all(...ids);
  for (const r of rows) {
    out.get(r.item_id)?.push({ id: r.id, kind: r.kind, bytes: r.bytes, ext: path.extname(r.path).toLowerCase() });
  }
  return out;
}

/**
 * The one item shape the dashboard sees, shared by the feed and search so the
 * two can never drift apart. Text is cut by code point, not UTF-16 unit:
 * String#slice would split an emoji's surrogate pair and leave a broken glyph.
 */
export function toSummary(row, media) {
  const chars = Array.from(row.caption ?? '');
  return {
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    url: row.url,
    author: row.author ?? '',
    authorHandle: row.author_handle ?? '',
    sourceDate: row.source_date ?? null,
    savedAt: row.saved_at ?? null,
    actionStatus: row.action_status,
    excerpt: chars.slice(0, EXCERPT_CODE_POINTS).join(''),
    textLength: chars.length,
    media: media ?? [],
  };
}

export function getItems(req, res, { db }, url) {
  const q = url.searchParams;
  const platform = q.get('platform') ?? 'twitter';
  const status = q.get('status') ?? 'pending';
  const kind = q.get('kind');
  const hasVideo = q.get('hasVideo') === '1';
  const limit = parseLimit(q.get('limit'));
  const before = q.has('before') ? parseId(q.get('before')) : undefined;

  if (!PLATFORMS.has(platform)) return send(res, 400, { error: 'bad_platform' });
  if (status !== 'all' && !STATUSES.has(status)) return send(res, 400, { error: 'bad_status' });
  if (kind !== null && !KINDS.has(kind)) return send(res, 400, { error: 'bad_kind' });
  if (limit === null) return send(res, 400, { error: 'bad_limit' });
  if (before === null) return send(res, 400, { error: 'bad_before' });

  const where = ['platform = ?'];
  const params = [platform];
  if (status !== 'all') { where.push('action_status = ?'); params.push(status); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (hasVideo) {
    where.push("EXISTS (SELECT 1 FROM media m WHERE m.item_id = items.id AND m.kind = 'video' AND m.bytes IS NOT NULL)");
  }
  // Keyset, not offset: marking items done while paging must not shift later
  // items up and make the next page skip one.
  if (before !== undefined) { where.push('id < ?'); params.push(before); }

  const rows = db.prepare(
    `SELECT ${SUMMARY_COLS} FROM items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
  ).all(...params, limit + 1);

  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const media = mediaByItem(db, page.map((r) => r.id));
  return send(res, 200, {
    items: page.map((r) => toSummary(r, media.get(r.id))),
    nextBefore: more ? page[page.length - 1].id : null,
  });
}

export function getItem(req, res, { db }, idText) {
  const id = parseId(idText);
  if (id === null) return send(res, 404, { error: 'not_found' });
  const row = db.prepare(`SELECT ${SUMMARY_COLS} FROM items WHERE id = ?`).get(id);
  if (!row) return send(res, 404, { error: 'not_found' });
  const { excerpt, ...summary } = toSummary(row, mediaByItem(db, [id]).get(id));
  return send(res, 200, { ...summary, text: row.caption ?? '' });
}

export async function patchItem(req, res, { db }, idText) {
  const id = parseId(idText);
  if (id === null) return send(res, 404, { error: 'not_found' });

  // readJson throws on malformed JSON, and the server's catch-all would turn
  // that into a 500. A bad body is the client's error.
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: 'bad_json' });
  }

  // Exactly one field, with a known value. Anything else is refused outright
  // rather than partly applied: this is the dashboard's only write.
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  const keys = isObject ? Object.keys(body) : [];
  if (keys.length !== 1 || keys[0] !== 'actionStatus' || !STATUSES.has(body.actionStatus)) {
    return send(res, 400, { error: 'bad_action_status' });
  }

  const info = db.prepare(
    "UPDATE items SET action_status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(body.actionStatus, id);
  if (info.changes === 0) return send(res, 404, { error: 'not_found' });
  return send(res, 200, { ok: true, id, actionStatus: body.actionStatus });
}
