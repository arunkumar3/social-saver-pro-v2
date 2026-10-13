import { send } from '../http.js';
import { toMatchQuery, toSpans, HIT_OPEN, HIT_CLOSE } from '../fts.js';
import { PLATFORMS, STATUSES, parseLimit, mediaByItem, toSummary } from './items.js';

export function getSearch(req, res, { db }, url) {
  const q = url.searchParams;
  const platform = q.get('platform') ?? 'twitter';
  // `all`, not `pending`: someone searching for a specific saved item should
  // find it whether or not they already marked it done.
  const status = q.get('status') ?? 'all';
  const limit = parseLimit(q.get('limit'));

  if (!PLATFORMS.has(platform)) return send(res, 400, { error: 'bad_platform' });
  if (status !== 'all' && !STATUSES.has(status)) return send(res, 400, { error: 'bad_status' });
  if (limit === null) return send(res, 400, { error: 'bad_limit' });

  // The page calls this on every keystroke, so "nothing to search" is an
  // empty answer, not an error.
  const match = toMatchQuery(q.get('q'));
  if (match === null) return send(res, 200, { items: [] });

  const where = ['items_fts MATCH ?', 'i.platform = ?'];
  const params = [match, platform];
  if (status !== 'all') { where.push('i.action_status = ?'); params.push(status); }

  let rows;
  try {
    rows = db.prepare(`
      SELECT i.id, i.platform, i.kind, i.url, i.author, i.author_handle, i.source_date,
             i.saved_at, i.action_status, i.caption,
             snippet(items_fts, -1, ?, ?, '…', 24) AS snip
      FROM items_fts JOIN items i ON i.id = items_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY bm25(items_fts)
      LIMIT ?`).all(HIT_OPEN, HIT_CLOSE, ...params, limit);
  } catch (err) {
    // toMatchQuery should always produce valid FTS5. If something still slips
    // through, a search box must not show a server error, so an FTS syntax
    // failure becomes an empty result. Any other error is a real bug and
    // propagates.
    if (/fts5|syntax/i.test(String(err?.message))) return send(res, 200, { items: [] });
    throw err;
  }

  const media = mediaByItem(db, rows.map((r) => r.id));
  return send(res, 200, {
    items: rows.map((r) => ({ ...toSummary(r, media.get(r.id)), snippet: toSpans(r.snip) })),
  });
}
