/**
 * One-off migration: media/<id>/ -> media/<platform>/<id>/
 *
 * Moves each item's media directory under its platform and rewrites the
 * stored `media.path` values to match. Run with --apply to make changes;
 * without it, reports what it would do and touches nothing.
 *
 *   node bin/migrate-media-layout.mjs           # dry run
 *   node bin/migrate-media-layout.mjs --apply   # perform the move
 *
 * Stop the server first: the media stage writes into these directories.
 *
 * Safe to run more than once — already-migrated items are skipped, so an
 * interrupted run can simply be repeated.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { CONFIG } from '../src/config.js';

const APPLY = process.argv.includes('--apply');
const VALID_PLATFORMS = new Set(['twitter', 'instagram']);

const db = openDb(CONFIG.DB_PATH);
const MEDIA = path.resolve(CONFIG.MEDIA_DIR);

const items = db.prepare('SELECT id, platform FROM items').all();
const byId = new Map(items.map((i) => [String(i.id), i.platform]));

let moved = 0, skipped = 0, missing = 0, rewritten = 0;
const problems = [];

if (!fs.existsSync(MEDIA)) {
  console.log('no media directory yet — nothing to migrate');
  process.exit(0);
}

for (const entry of fs.readdirSync(MEDIA, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  // Already-migrated platform directories are not item directories.
  if (VALID_PLATFORMS.has(entry.name)) { skipped++; continue; }

  const platform = byId.get(entry.name);
  if (!platform) {
    // A directory with no matching item: orphaned by a deleted row. Leave it
    // alone rather than guess — deleting user media on a hunch is not this
    // script's job.
    problems.push(`media/${entry.name}: no matching item row, left in place`);
    missing++;
    continue;
  }

  const from = path.join(MEDIA, entry.name);
  const to = path.join(MEDIA, platform, entry.name);

  if (fs.existsSync(to)) {
    problems.push(`${to} already exists, left ${from} in place`);
    continue;
  }

  console.log(`${APPLY ? 'move' : 'would move'}  media/${entry.name}  ->  media/${platform}/${entry.name}`);
  if (APPLY) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
  }
  moved++;
}

// Rewrite stored paths. Done by matching the OLD directory segment rather
// than by string-replacing the whole path, so a path that happens to contain
// the media root twice cannot be mangled.
const rows = db.prepare('SELECT m.id, m.path, i.platform, i.id AS item_id FROM media m JOIN items i ON i.id = m.item_id').all();
const update = db.prepare('UPDATE media SET path = ? WHERE id = ?');

for (const row of rows) {
  const oldDir = path.join(MEDIA, String(row.item_id));
  const newDir = path.join(MEDIA, row.platform, String(row.item_id));
  const resolved = path.resolve(row.path);
  if (!resolved.startsWith(oldDir + path.sep)) continue; // already migrated
  const next = path.join(newDir, path.basename(resolved));
  console.log(`${APPLY ? 'rewrite' : 'would rewrite'}  media row ${row.id}`);
  if (APPLY) update.run(next, row.id);
  rewritten++;
}

console.log('---');
console.log(`${APPLY ? 'moved' : 'would move'}     : ${moved} directories`);
console.log(`${APPLY ? 'rewrote' : 'would rewrite'} : ${rewritten} media paths`);
console.log(`already done  : ${skipped}`);
console.log(`orphaned      : ${missing}`);
if (problems.length) {
  console.log('problems:');
  for (const p of problems) console.log('  ' + p);
}
if (!APPLY) console.log('\nDRY RUN — nothing changed. Re-run with --apply to perform it.');
db.close();
