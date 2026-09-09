import { send, readJson } from '../http.js';

const VALID_PLATFORMS = new Set(['twitter', 'instagram']);

export async function postIngest(req, res, { db }) {
  const body = await readJson(req);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items) return send(res, 400, { error: 'no_items' });

  let inserted = 0, updated = 0, skipped = 0, rejected = 0;

  const findByUrl = db.prepare('SELECT id, kind, caption FROM items WHERE url = ?');
  const insertItem = db.prepare(`
    INSERT INTO items (platform, kind, url, external_id, author, author_handle,
                       title, caption, source_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateItem = db.prepare(`
    UPDATE items SET kind = ?, title = ?, author = ?, author_handle = ?,
                     caption = ?, source_date = ?, state = 'pending',
                     updated_at = datetime('now')
    WHERE id = ?`);
  const insertMedia = db.prepare(
    'INSERT INTO media (item_id, kind, path) VALUES (?, ?, ?)');

  for (const it of items) {
    if (!it?.url || !VALID_PLATFORMS.has(it.platform) || !it.kind) { rejected++; continue; }

    const existing = findByUrl.get(it.url);
    const caption = it.caption ?? '';

    if (!existing) {
      insertItem.run(it.platform, it.kind, it.url, it.externalId ?? null,
        it.author ?? '', it.authorHandle ?? '', it.title ?? '', caption, it.sourceDate ?? null);
      const id = findByUrl.get(it.url).id;
      for (const url of it.mediaUrls ?? []) insertMedia.run(id, 'image', url);
      inserted++;
      continue;
    }

    const isUpgrade = it.kind === 'thread' && existing.kind === 'tweet';
    const isLonger = caption.length > (existing.caption ?? '').length;
    if (isUpgrade || isLonger) {
      updateItem.run(it.kind, it.title ?? '', it.author ?? '', it.authorHandle ?? '',
        caption, it.sourceDate ?? null, existing.id);
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
