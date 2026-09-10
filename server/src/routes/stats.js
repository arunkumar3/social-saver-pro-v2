import { send } from '../http.js';

/**
 * GET /api/stats — archive summary for the extension popup.
 *
 * Serves two jobs: the "what do I already have" line shown when the popup
 * opens, and the progress figures it polls while a sync drains. Both need to
 * work against an empty archive, so every aggregate is coalesced to 0 — a null
 * reaching the popup would render as "null MB".
 */
export function getStats(req, res, { db }) {
  const totals = db.prepare('SELECT count(*) AS total FROM items').get();

  const byPlatform = {};
  for (const row of db.prepare(
    'SELECT platform, count(*) AS c FROM items GROUP BY platform').all()) {
    byPlatform[row.platform] = row.c;
  }

  const byState = {};
  for (const row of db.prepare(
    'SELECT state, count(*) AS c FROM items GROUP BY state').all()) {
    byState[row.state] = row.c;
  }

  // `bytes` is nullable: the media stage can record a file before its size is
  // known. COALESCE keeps the sum numeric, and the mean deliberately divides
  // by the count of rows that HAVE a size rather than all rows, so unmeasured
  // files do not drag the per-item download estimate downwards.
  const media = db.prepare(`
    SELECT count(*)                       AS files,
           coalesce(sum(bytes), 0)        AS bytes,
           count(bytes)                   AS sized
    FROM media`).get();

  const meanBytes = media.sized > 0 ? Math.round(media.bytes / media.sized) : 0;

  // Per-platform means, because a global mean is misleading here: real data
  // had a 603 MB tweet video sitting alongside 18 MB reels, which would have
  // estimated an Instagram download at seven times its true size. Platforms
  // with no sized media are omitted rather than reported as 0, so a caller can
  // tell "no data yet" apart from "genuinely tiny".
  const meanBytesByPlatform = {};
  for (const row of db.prepare(`
    SELECT i.platform                AS platform,
           coalesce(sum(m.bytes), 0) AS bytes,
           count(m.bytes)            AS sized
    FROM media m JOIN items i ON i.id = m.item_id
    GROUP BY i.platform`).all()) {
    if (row.sized > 0) {
      meanBytesByPlatform[row.platform] = Math.round(row.bytes / row.sized);
    }
  }

  return send(res, 200, {
    items: {
      total: totals.total,
      byPlatform,
      byState,
    },
    media: {
      files: media.files,
      bytes: media.bytes,
      meanBytes,
      meanBytesByPlatform,
    },
    queue: {
      pending: byState.pending ?? 0,
      done: (byState.media ?? 0) + (byState.transcribed ?? 0) +
            (byState.described ?? 0) + (byState.enriched ?? 0) +
            (byState.embedded ?? 0),
      failed: byState.failed ?? 0,
    },
  });
}
