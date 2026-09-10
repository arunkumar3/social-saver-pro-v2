import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from '../src/server.js';
import { postCookies } from '../src/routes/cookies.js';

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

function mockReq(body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  return { async *[Symbol.asyncIterator]() { yield payload; } };
}

function mockRes() {
  return {
    statusCode: null,
    body: null,
    writeHead(status) { this.statusCode = status; },
    end(payload) { this.body = payload; },
  };
}

if (process.platform === 'win32') {
  test('POST /cookies locks the file ACL down to the current user on Windows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-acl-'));
    const cookiesPath = path.join(dir, 'cookies.txt');
    const req = mockReq({ cookies: [
      { domain: '.instagram.com', path: '/', secure: true,
        expirationDate: 2000000000, name: 'sessionid', value: 'abc', hostOnly: false },
    ]});
    const res = mockRes();
    try {
      await postCookies(req, res, { config: { COOKIES_PATH: cookiesPath } });
      assert.equal(res.statusCode, 200);
      const listing = execFileSync('icacls', [cookiesPath], { encoding: 'utf8' });
      // A freshly-written file under a user's own temp dir inherits ACEs for
      // NT AUTHORITY\SYSTEM and BUILTIN\Administrators from its parent by
      // default (verified directly: a plain fs.writeFileSync with mode:
      // 0o600 and no ACL call leaves both present). Those are exactly the
      // broad, inherited grants '/inheritance:r' is meant to strip, so their
      // absence is the real signal that the lockdown actually ran — not
      // just an assumption about what "restricted" looks like.
      assert.ok(!/NT AUTHORITY\\SYSTEM/i.test(listing), `ACL must not retain the inherited SYSTEM grant: ${listing}`);
      assert.ok(!/BUILTIN\\Administrators/i.test(listing), `ACL must not retain the inherited Administrators grant: ${listing}`);
      const user = process.env.USERNAME || process.env.USER;
      assert.ok(listing.includes(user), `ACL must grant the current user (${user}) access: ${listing}`);
      // Guards against the ambiguous bare-username bug: if the ACE names
      // the trustee but resolves to an empty/wrong account (e.g. the
      // computer account on a machine whose name matches the username),
      // icacls prints "DOMAIN\\:(F)" with nothing between the backslash and
      // the colon.
      assert.ok(!/\\:/.test(listing), `ACL entry must not resolve to an empty account name: ${listing}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('a failure to lock the ACL is logged and does not break cookie export', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-acl-fail-'));
  const cookiesPath = path.join(dir, 'cookies.txt');
  const req = mockReq({ cookies: [
    { domain: '.instagram.com', path: '/', secure: true,
      expirationDate: 2000000000, name: 'sessionid', value: 'abc', hostOnly: false },
  ]});
  const res = mockRes();
  let called = false;
  const throwingRestrictAcl = (p) => { called = true; assert.equal(p, cookiesPath); throw new Error('icacls exploded'); };
  try {
    await postCookies(req, res, { config: { COOKIES_PATH: cookiesPath }, restrictAcl: throwingRestrictAcl });
    // If postCookies never wired the restrictAcl dependency through at all,
    // this whole test would pass vacuously (the throwing fn simply never
    // runs). Assert it was actually invoked so the test can't pass for the
    // wrong reason.
    assert.equal(called, true, 'restrictAcl must actually be called with the cookies path');
    assert.equal(res.statusCode, 200);
    assert.ok(fs.existsSync(cookiesPath), 'the cookie file must still have been written');
  } finally {
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
