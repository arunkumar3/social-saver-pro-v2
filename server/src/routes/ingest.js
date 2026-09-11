import { send, readJson } from '../http.js';

const VALID_PLATFORMS = new Set(['twitter', 'instagram']);

// Relative rank of a "kind" value. Re-ingesting a URL may only ever improve
// its record, never downgrade it — a thread that has already been recognised
// as a thread must not be flipped back to a plain tweet just because a later
// scrape mislabels it and happens to carry a longer caption. Kinds outside
// this map (post, reel, carousel, article, ...) aren't given an ordering
// here since the spec only calls out the tweet/thread relationship; they
// default to the same rank as 'tweet' and so are unaffected by this guard.
const KIND_RANK = { tweet: 0, thread: 1 };
const kindRank = (kind) => KIND_RANK[kind] ?? 0;

// A bare truthiness check on `it.url` lets any non-empty string through,
// which is then passed as the final argv token to a downloader subprocess
// (see media/resolver.js). Require it to parse as an absolute http(s) URL so
// values like "--exec=..." or "file:///etc/passwd" are rejected here, before
// they ever reach a spawn() call.
function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export async function postIngest(req, res, { db }) {
  const body = await readJson(req);
  const items = Array.isArray(body?.items) ? body.items : null;
  // Deferred ingest: store the metadata now, download the media later.
  // Items land in `deferred`, which the media stage does not select, so a
  // large archive becomes searchable immediately without committing to hours
  // of downloading. POST /api/promote moves them into `pending` in batches.
  const initialState = body?.deferMedia === true ? 'deferred' : 'pending';
  if (!items) return send(res, 400, { error: 'no_items' });

  let inserted = 0, updated = 0, skipped = 0, rejected = 0;

  const findByUrl = db.prepare('SELECT id, kind, caption FROM items WHERE url = ?');
  const insertItem = db.prepare(`
    INSERT INTO items (platform, kind, url, external_id, author, author_handle,
                       title, caption, source_date, state)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateItem = db.prepare(`
    UPDATE items SET kind = ?, title = ?, author = ?, author_handle = ?,
                     caption = ?, source_date = ?, state = ?,
                     updated_at = datetime('now')
    WHERE id = ?`);
  const insertMedia = db.prepare(
    'INSERT INTO media (item_id, kind, path) VALUES (?, ?, ?)');

  for (const it of items) {
    if (!isValidHttpUrl(it?.url) || !VALID_PLATFORMS.has(it.platform) || !it.kind) { rejected++; continue; }

    const existing = findByUrl.get(it.url);
    const caption = it.caption ?? '';

    if (!existing) {
      insertItem.run(it.platform, it.kind, it.url, it.externalId ?? null,
        it.author ?? '', it.authorHandle ?? '', it.title ?? '', caption,
        it.sourceDate ?? null, initialState);
      const id = findByUrl.get(it.url).id;
      for (const url of it.mediaUrls ?? []) insertMedia.run(id, 'image', url);
      inserted++;
      continue;
    }

    const isUpgrade = it.kind === 'thread' && existing.kind === 'tweet';
    const isLonger = caption.length > (existing.caption ?? '').length;
    if (isUpgrade || isLonger) {
      // Never write a lesser kind: only adopt the incoming kind when it
      // ranks at or above the stored one, otherwise keep the existing kind
      // while still allowing the other fields (caption, title, ...) to
      // update on this pass.
      const kind = kindRank(it.kind) >= kindRank(existing.kind) ? it.kind : existing.kind;
      updateItem.run(kind, it.title ?? '', it.author ?? '', it.authorHandle ?? '',
        caption, it.sourceDate ?? null, initialState, existing.id);
      updated++;
    } else {
      skipped++;
    }
  }

  return send(res, 200, { ok: true, inserted, updated, skipped, rejected });
}

export async function postKnownUrls(req, res, { db }) {
  const body = await readJson(req);
  const urls = Array.isArray(body?.urls) ? body.urls : null;
  if (!urls) return send(res, 400, { error: 'no_urls' });
  if (urls.length === 0) return send(res, 200, { known: [] });

  const placeholders = urls.map(() => '?').join(',');
  const rows = db.prepare(`SELECT url FROM items WHERE url IN (${placeholders})`).all(...urls);
  return send(res, 200, { known: rows.map((r) => r.url) });
}

/**
 * POST /api/promote — move deferred items into the download queue.
 *
 * A limit is mandatory. Promoting an entire deferred backlog in one call is
 * exactly the thing deferring exists to prevent: 1,440 Instagram items is
 * roughly 24 GB and hours of continuous fetching against the user's account.
 */
export async function postPromote(req, res, { db }) {
  const body = await readJson(req);
  const limit = Number(body?.limit);
  if (!Number.isInteger(limit) || limit <= 0) {
    return send(res, 400, { error: 'limit_required' });
  }
  const platform = body?.platform;
  if (platform !== undefined && !VALID_PLATFORMS.has(platform)) {
    return send(res, 400, { error: 'bad_platform' });
  }

  const where = platform ? "state = 'deferred' AND platform = ?" : "state = 'deferred'";
  const params = platform ? [platform, limit] : [limit];

  const info = db.prepare(`
    UPDATE items SET state = 'pending', updated_at = datetime('now')
    WHERE id IN (SELECT id FROM items WHERE ${where} ORDER BY id LIMIT ?)`).run(...params);

  const remaining = platform
    ? db.prepare("SELECT count(*) c FROM items WHERE state='deferred' AND platform=?").get(platform).c
    : db.prepare("SELECT count(*) c FROM items WHERE state='deferred'").get().c;

  return send(res, 200, { ok: true, promoted: info.changes, remaining });
}
