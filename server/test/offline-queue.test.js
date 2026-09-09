import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeQueue } from '../../api.js';

test('merging appends new items', () => {
  const out = mergeQueue([{ url: 'a' }], [{ url: 'b' }]);
  assert.deepEqual(out.map((i) => i.url), ['a', 'b']);
});

test('a re-queued url replaces the older copy rather than duplicating', () => {
  const out = mergeQueue([{ url: 'a', caption: 'old' }], [{ url: 'a', caption: 'new' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].caption, 'new');
});

test('the queue is capped at 500 items, keeping the newest', () => {
  const existing = Array.from({ length: 500 }, (_, i) => ({ url: `u${i}` }));
  const out = mergeQueue(existing, [{ url: 'newest' }]);
  assert.equal(out.length, 500);
  assert.equal(out.at(-1).url, 'newest');
  assert.equal(out[0].url, 'u1');
});
