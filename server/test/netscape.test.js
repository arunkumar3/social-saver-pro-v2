import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNetscape } from '../src/cookies/netscape.js';

const cookie = {
  domain: '.instagram.com', path: '/', secure: true,
  expirationDate: 2000000000.5, name: 'sessionid', value: 'abc123', hostOnly: false,
};

test('emits the Netscape header first', () => {
  assert.ok(toNetscape([cookie]).startsWith('# Netscape HTTP Cookie File\n'));
});

test('emits seven tab-separated fields in order', () => {
  const line = toNetscape([cookie]).trim().split('\n')[1];
  assert.deepEqual(line.split('\t'),
    ['.instagram.com', 'TRUE', '/', 'TRUE', '2000000000', 'sessionid', 'abc123']);
});

test('host-only cookies are not marked as include-subdomains', () => {
  const line = toNetscape([{ ...cookie, domain: 'instagram.com', hostOnly: true }])
    .trim().split('\n')[1].split('\t');
  assert.equal(line[0], 'instagram.com');
  assert.equal(line[1], 'FALSE');
});

test('session cookies without an expiry get 0', () => {
  const line = toNetscape([{ ...cookie, expirationDate: undefined }])
    .trim().split('\n')[1].split('\t');
  assert.equal(line[4], '0');
});

test('a value containing a tab is rejected rather than silently corrupting the file', () => {
  assert.throws(() => toNetscape([{ ...cookie, value: 'a\tb' }]), /tab/i);
});

test('file ends with a newline', () => {
  assert.ok(toNetscape([cookie]).endsWith('\n'));
});
