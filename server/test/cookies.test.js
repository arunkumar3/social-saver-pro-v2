import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('POST /cookies writes a Netscape file and reports the count', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-'));
  const cookiesPath = path.join(dir, 'cookies.txt');
  const server = createServer({ db: null, config: { COOKIES_PATH: cookiesPath } });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookies: [
        { domain: '.instagram.com', path: '/', secure: true,
          expirationDate: 2000000000, name: 'sessionid', value: 'abc', hostOnly: false },
      ]}),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).count, 1);
    const written = fs.readFileSync(cookiesPath, 'utf8');
    assert.ok(written.includes('sessionid\tabc'));
    assert.ok(written.startsWith('# Netscape HTTP Cookie File'));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('POST /cookies rejects an empty cookie list', async () => {
  const server = createServer({ db: null, config: { COOKIES_PATH: '/unused' } });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/cookies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookies: [] }),
    });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'no_cookies');
  } finally {
    server.close();
  }
});
