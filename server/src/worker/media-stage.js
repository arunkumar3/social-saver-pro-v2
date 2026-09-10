import { downloadItem, chooseDownloader } from '../media/resolver.js';

const MAX_ATTEMPTS = 3;

export async function runMediaStage(db, { config, run, limit = 25 }) {
  const pending = db.prepare(`
    SELECT id, platform, kind, url FROM items
    WHERE state = 'pending' AND attempts < ?
    ORDER BY id LIMIT ?`).all(MAX_ATTEMPTS, limit);

  const clearMedia = db.prepare('DELETE FROM media WHERE item_id = ?');
  const addMedia = db.prepare(
    'INSERT INTO media (item_id, kind, path, bytes, downloader) VALUES (?, ?, ?, ?, ?)');
  const markOk = db.prepare(
    "UPDATE items SET state = 'media', state_error = NULL, updated_at = datetime('now') WHERE id = ?");
  const markFail = db.prepare(`
    UPDATE items
    SET attempts = attempts + 1,
        state_error = ?,
        state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE 'pending' END,
        updated_at = datetime('now')
    WHERE id = ?`);
  const logRun = db.prepare(
    'INSERT INTO job_runs (item_id, stage, status, error, ms) VALUES (?, ?, ?, ?, ?)');

  let succeeded = 0, failed = 0;

  for (const item of pending) {
    const started = Date.now();
    const result = await downloadItem(item, { config, run });
    const ms = Date.now() - started;

    if (result.ok) {
      clearMedia.run(item.id);
      for (const f of result.files) {
        addMedia.run(item.id, f.kind, f.path, f.bytes, chooseDownloader(item));
      }
      markOk.run(item.id);
      logRun.run(item.id, 'media', 'ok', null, ms);
      succeeded++;
    } else {
      // Persist the same "<errorKind>: <detail>" format used for job_runs.error
      // on the item row too, so an auth_expired failure (fixable by logging
      // back into Instagram) stays distinguishable from a generic
      // download_failed one when looking at the item alone.
      const stateError = `${result.errorKind}: ${result.error ?? 'unknown'}`;
      markFail.run(stateError, MAX_ATTEMPTS, item.id);
      logRun.run(item.id, 'media', 'error', stateError, ms);
      failed++;
    }
  }

  return { processed: pending.length, succeeded, failed };
}
