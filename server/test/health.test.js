import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

test('GET /health reports ok and a version', async () => {
  const server = createServer({ db: null, config: null });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(typeof body.version, 'string');
  } finally {
    server.close();
  }
});

test('unknown routes return 404 JSON', async () => {
  const server = createServer({ db: null, config: null });
  const base = await listen(server);
  try {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, 'not_found');
  } finally {
    server.close();
  }
});
