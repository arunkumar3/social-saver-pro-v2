import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { toMatchQuery, toSpans, HIT_OPEN, HIT_CLOSE } from '../src/fts.js';

test('each token is quoted, and the last one gets a prefix star', () => {
  assert.equal(toMatchQuery('agent'), '"agent"*');
  assert.equal(toMatchQuery('ai agent'), '"ai" "agent"*');
  assert.equal(toMatchQuery('  ai   agent  '), '"ai" "agent"*');
});

test('double quotes in input are removed rather than breaking the query', () => {
  assert.equal(toMatchQuery('say "hi"'), '"say" "hi"*');
  assert.equal(toMatchQuery('a"b'), '"ab"*');
});

test('input with nothing searchable yields null', () => {
  for (const v of ['', '   ', '"', '--', '🚀', '🚀 --', '()', null, undefined, 42]) {
    assert.equal(toMatchQuery(v), null, JSON.stringify(v));
  }
});

test('punctuation-only tokens are dropped, not sent to FTS5', () => {
  assert.equal(toMatchQuery('agent -'), '"agent"*');
  assert.equal(toMatchQuery('🚀 rocket'), '"rocket"*');
});

test('every sanitised query is valid FTS5, whatever was typed', () => {
  // The real check: run the output against an actual FTS5 table.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-fts-'));
  const db = openDb(path.join(dir, 'archive.db'));
  try {
    db.prepare("INSERT INTO items(platform,kind,url,caption) VALUES ('twitter','tweet','https://x.com/a/status/1','an agent framework')").run();
    const nasty = ['"', '-', 'a"b', '(', ')', 'NEAR(', 'NEAR(a b)', 'agent OR', 'OR', 'AND', 'NOT x', '*',
      'x:y', 'caption:agent', 'a-b-c', '^agent', 'agent +', '{x}', '[x]', 'agent"', "it's", 'gpt-4o', '🚀agent'];
    for (const input of nasty) {
      const q = toMatchQuery(input);
      if (q === null) continue;
      assert.doesNotThrow(() => db.prepare('SELECT rowid FROM items_fts WHERE items_fts MATCH ?').all(q),
        `input ${JSON.stringify(input)} produced invalid FTS5: ${q}`);
    }
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('toSpans splits snippet markers into hit and non-hit spans', () => {
  const s = `a new ${HIT_OPEN}agent${HIT_CLOSE} framework`;
  assert.deepEqual(toSpans(s), [
    { text: 'a new ', hit: false },
    { text: 'agent', hit: true },
    { text: ' framework', hit: false },
  ]);
});

test('toSpans with no markers is one plain span, and empty input is no spans', () => {
  assert.deepEqual(toSpans('plain text'), [{ text: 'plain text', hit: false }]);
  assert.deepEqual(toSpans(''), []);
  assert.deepEqual(toSpans(null), []);
});

test('markup in a snippet survives as literal text, never as structure', () => {
  const s = `<img src=x onerror=alert(1)> ${HIT_OPEN}agent${HIT_CLOSE}`;
  const spans = toSpans(s);
  assert.equal(spans[0].text, '<img src=x onerror=alert(1)> ');
  assert.equal(spans.map((x) => x.text).join(''), '<img src=x onerror=alert(1)> agent');
});

test('a stray marker character in a caption cannot produce anything but text', () => {
  const spans = toSpans(`x${HIT_CLOSE}y${HIT_OPEN}`);
  assert.ok(spans.every((s) => typeof s.text === 'string' && typeof s.hit === 'boolean'));
  assert.equal(spans.map((s) => s.text).join(''), 'xy');
});
