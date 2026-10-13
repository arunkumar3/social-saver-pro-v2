# Twitter Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A search-first page at `http://127.0.0.1:8787/` for finding saved tweets and working through them, with done/skip triage and in-page video.

**Architecture:** Plain HTML, CSS and ES modules, served by the existing `node:http` server, with no framework, build step or new dependency. Five read endpoints and one write are added behind two request-wide guards: a `Host` check against DNS rebinding, and the existing `Origin` guard extended to every non-GET method. Item text is attacker-controlled, so it reaches the page as text and never as markup, enforced by a test that scans `app.js`.

**Tech Stack:** Node 24 (`node:http`, `node:sqlite`, `node:test`, `node:stream`), SQLite FTS5 (`bm25`, `snippet`), browser DOM APIs.

**Spec:** [`docs/superpowers/specs/2026-10-13-twitter-dashboard-design.md`](../specs/2026-10-13-twitter-dashboard-design.md)

## Global Constraints

- The server binds `127.0.0.1` only. Nothing is reachable from the network.
- No new runtime dependencies. Built-in Node modules only; `sqlite-vec` stays the sole dependency.
- Tests run with bare `node --test` from `server/` (`npm test`). The directory-argument form is broken on Node 24.14.0 here.
- Item text is untrusted. It reaches the page only through `textContent` or text nodes, never `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `createContextualFragment` or `DOMParser`.
- Every request's `Host` hostname must be `127.0.0.1`, `localhost` or `[::1]`, or the response is `403 {"error":"forbidden_host"}`.
- The `Origin` guard covers every method except `GET` and `HEAD`.
- Media is looked up by database id only. No part of a URL is ever used as a filesystem path.
- Every new endpoint answers malformed input with a 4xx and a named error. None may produce a 500.
- `author_handle` is stored **with** its leading `@`. Display it as stored.
- Excerpts are 280 **code points**, so emoji are never split.
- **`fetch` cannot set a `Host` header**: it silently sends the real one. Any test of the Host check must use `http.request`, or it passes with no guard at all.

## Review Focus

The input classes the spec implies but does not spell out, most likely to bite first. Each one's test lives in the task that owns the code:

1. **A malformed JSON body on `PATCH`.** `readJson` throws on bad JSON, which the server's catch-all turns into a 500. Expected: `400 bad_json`. *(Task 3)*
2. **A search made only of emoji or punctuation** (`🚀`, `--`, `"`). The user will type these. Expected: `200` with an empty list, never a 500. *(Tasks 2, 4)*
3. **A malformed or multi-part `Range` header** (`bytes=abc`, `bytes=0-10,20-30`). Expected: the whole file with `200`. RFC 9110 lets a server ignore a Range it cannot satisfy simply. *(Task 5)*
4. **A client disconnecting mid-stream**, which a browser does on every seek. Expected: the file stream is destroyed and its handle released. A 1 GB video scrubbed ten times must not leak ten descriptors. *(Task 5)*
5. **Non-numeric or unknown ids** in `/api/items/:id` and `/media/:id`. Expected: `404`, not a 500. *(Tasks 3, 5)*

## Execution

The user asked to go straight from plan to implementation. Executed natively in this session, followed by one fresh whole-branch review. Per the user's standing preference, any subagent that writes code runs on Sonnet; other subagent work runs on Haiku.

## File structure

```
server/
  public/                  NEW — the page; served, never executed server-side
    index.html
    app.js
    style.css
  src/
    config.js              MODIFY — add PUBLIC_DIR
    server.js              MODIFY — Host check, Origin guard, new routes
    fts.js                 NEW — query sanitising, snippet → spans
    routes/
      items.js             NEW — list, get one, patch; shared summary shape
      search.js            NEW — ranked full-text search
      media.js             NEW — file streaming with Range
      static.js            NEW — the three page files, with CSP
  test/
    host-guard.test.js     NEW
    fts.test.js            NEW
    items.test.js          NEW
    search.test.js         NEW
    media.test.js          NEW
    static.test.js         NEW
    page-safety.test.js    NEW — scans app.js and index.html for unsafe sinks
```

`items.js` owns the `ItemSummary` shape and the shared validation constants, because the search route returns the same shape and must not drift from it.

---

### Task 1: Host check and Origin guard on every write

**Files:**
- Modify: `server/src/server.js`
- Test: `server/test/host-guard.test.js`

**Interfaces:**
- Consumes: `send` from `src/http.js`; existing `isAllowedOrigin`.
- Produces: `isAllowedHost(hostHeader: string | undefined) -> boolean`, exported from `src/server.js`.

- [ ] **Step 1: Write the failing test**

Create `server/test/host-guard.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer, isAllowedHost } from '../src/server.js';

// DNS rebinding: a hostile site points its own domain at 127.0.0.1, and the
// browser then treats this server as same-origin with that site. The tell is
// the Host header, which still carries the attacker's domain.
//
// These tests use http.request, NOT fetch. fetch silently replaces any Host
// header with the real one, so a fetch-based test passes with no guard at all.

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-host-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const server = createServer({ db, config: { COOKIES_PATH: path.join(dir, 'c.txt') } });
  return { dir, db, server };
}

async function listenPort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

function raw(port, { method = 'GET', path: p = '/health', headers = {}, setHost = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, setHost }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('loopback Host headers are accepted', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`, `[::1]:${port}`, '127.0.0.1']) {
      const r = await raw(port, { headers: { host } });
      assert.equal(r.status, 200, `${host} should be accepted`);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a rebinding Host is refused on every route', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const hosts = ['evil.example', `evil.example:${port}`, '127.0.0.1.evil.example', 'evil.com@127.0.0.1', '127.0.0.1/evil'];
    for (const host of hosts) {
      for (const p of ['/health', '/api/stats', '/']) {
        const r = await raw(port, { path: p, headers: { host } });
        assert.equal(r.status, 403, `${host} on ${p}`);
        assert.equal(JSON.parse(r.body).error, 'forbidden_host');
      }
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a request with no Host header is refused', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const r = await raw(port, { setHost: false });
    assert.equal(r.status, 403);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the Origin guard covers PATCH, PUT and DELETE, not only POST', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    for (const method of ['PATCH', 'PUT', 'DELETE', 'POST']) {
      const r = await raw(port, { method, path: '/api/items/1', headers: { origin: 'https://evil.example' } });
      assert.equal(r.status, 403, method);
      assert.equal(JSON.parse(r.body).error, 'forbidden_origin');
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a PATCH with no Origin is not refused by the guard', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const r = await raw(port, { method: 'PATCH', path: '/api/items/1' });
    assert.notEqual(r.status, 403);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('isAllowedHost rejects anything that is not a plain loopback host', () => {
  assert.equal(isAllowedHost(undefined), false);
  assert.equal(isAllowedHost(''), false);
  assert.equal(isAllowedHost('evil.com@127.0.0.1'), false);
  assert.equal(isAllowedHost('127.0.0.1:8787'), true);
  assert.equal(isAllowedHost('[::1]:8787'), true);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/host-guard.test.js`
Expected: FAIL. `isAllowedHost` is not exported, and rebinding hosts return 200.

- [ ] **Step 3: Implement**

In `server/src/server.js`, add below `isAllowedOrigin`:

```js
// A Host header is a hostname, optionally followed by a port. Anything else,
// such as userinfo ("evil.com@127.0.0.1") or a path, is refused before it is
// parsed, so URL-parsing quirks cannot launder it into a loopback name.
const HOST_HEADER = /^(?:[A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?$/;

// DNS-rebinding guard. A hostile site can point its own domain at 127.0.0.1;
// the browser then treats this server as same-origin with that site and lets
// it read every response, including the whole archive. The request still
// carries the attacker's domain in Host, so only loopback names are served.
// Only the hostname is compared, not the port, so tests on ephemeral ports
// and the extension's "Host: 127.0.0.1:8787" both pass.
export function isAllowedHost(hostHeader) {
  if (typeof hostHeader !== 'string' || !HOST_HEADER.test(hostHeader)) return false;
  const hostname = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : hostHeader.split(':')[0];
  return LOOPBACK_HOSTNAMES.has(hostname.toLowerCase());
}
```

Replace the guard block at the top of the request handler:

```js
      // Applied once, here, for every state-changing (POST) route rather
      // than copy-pasted into each handler.
      if (req.method === 'POST' && !isAllowedOrigin(req.headers.origin)) {
        return send(res, 403, { error: 'forbidden_origin' });
      }
```

with:

```js
      if (!isAllowedHost(req.headers.host)) {
        return send(res, 403, { error: 'forbidden_host' });
      }
      // Applied once, here, for every state-changing method rather than per
      // route. It covered only POST until the dashboard added PATCH, which
      // would otherwise have been the one write a cross-site page could make.
      if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(req.headers.origin)) {
        return send(res, 403, { error: 'forbidden_origin' });
      }
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS, every test including the existing 113.

- [ ] **Step 5: Commit**

```bash
git add server/src/server.js server/test/host-guard.test.js
git commit -m "Refuse rebinding Host headers and guard every write method"
```

---

### Task 2: FTS query sanitising and snippet spans

**Files:**
- Create: `server/src/fts.js`
- Test: `server/test/fts.test.js`

**Interfaces:**
- Produces:
  - `toMatchQuery(raw: unknown) -> string | null`. Returns a valid FTS5 MATCH expression, or `null` when nothing searchable remains.
  - `toSpans(snippet: string) -> Array<{ text: string, hit: boolean }>`
  - `HIT_OPEN = '\uE000'`, `HIT_CLOSE = '\uE001'`. These are the snippet markers that Task 4 passes to SQLite's `snippet()`.

- [ ] **Step 1: Write the failing test**

Create `server/test/fts.test.js`:

```js
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
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/fts.test.js`
Expected: FAIL with `Cannot find module '../src/fts.js'`.

- [ ] **Step 3: Implement**

Create `server/src/fts.js`:

```js
/**
 * FTS5 query building and snippet parsing for the dashboard's search.
 *
 * MATCH has its own syntax, and raw user input breaks it: a stray `"` is a
 * syntax error, a leading `-` is an operator, `NEAR(` opens a group. Quoting
 * every token turns operators and punctuation into literal text, which is
 * what a person typing into a search box means.
 */

// Private-use code points as snippet() markers. They cannot be typed into a
// search box and are vanishingly rare in captions. The server turns them into
// span data, so no markup ever travels inside a string.
export const HIT_OPEN = '\uE000';
export const HIT_CLOSE = '\uE001';

// A token is only worth searching if it contains a letter or digit. An emoji
// or punctuation-only token tokenizes to nothing, which FTS5 rejects inside a
// phrase, so it is dropped rather than passed through.
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

export function toMatchQuery(raw) {
  if (typeof raw !== 'string') return null;
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => HAS_WORD_CHAR.test(t));
  if (tokens.length === 0) return null;
  // The last token gets a prefix star, so results appear while a word is
  // still being typed.
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}

export function toSpans(snippet) {
  const spans = [];
  let hit = false;
  let buf = '';
  const flush = () => {
    if (buf) spans.push({ text: buf, hit });
    buf = '';
  };
  for (const ch of String(snippet ?? '')) {
    if (ch === HIT_OPEN) { flush(); hit = true; }
    else if (ch === HIT_CLOSE) { flush(); hit = false; }
    else buf += ch;
  }
  flush();
  return spans;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test test/fts.test.js`
Expected: PASS, 9 tests.

If the "every sanitised query is valid FTS5" test fails on an input, extend the token filter so that input's output becomes valid. Do **not** delete the input from the list.

- [ ] **Step 5: Commit**

```bash
git add server/src/fts.js server/test/fts.test.js
git commit -m "Sanitise search input into valid FTS5 and parse snippets into spans"
```

---

### Task 3: Items — feed, single item, and done/skip

**Files:**
- Create: `server/src/routes/items.js`
- Modify: `server/src/server.js`
- Test: `server/test/items.test.js`

**Interfaces:**
- Consumes: `send`, `readJson` from `src/http.js`.
- Produces, exported from `src/routes/items.js`:
  - `PLATFORMS: Set<string>`, `STATUSES: Set<string>` (`pending`, `done`, `skipped`)
  - `parseLimit(v: string | null) -> number | null`. Defaults to 50 and accepts 1–100; anything else is `null`.
  - `mediaByItem(db, ids: number[]) -> Map<number, MediaSummary[]>`
  - `toSummary(row, media: MediaSummary[]) -> ItemSummary`
  - `getItems(req, res, deps, url)`, `getItem(req, res, deps, idText)`, `patchItem(req, res, deps, idText)`
  - `MediaSummary = { id, kind, bytes, ext }`. `ItemSummary` is exactly as the spec defines it.

- [ ] **Step 1: Write the failing test**

Create `server/test/items.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-items-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), MEDIA_DIR: path.join(dir, 'media') };
  return { dir, db, server: createServer({ db, config }) };
}
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
function addItem(db, { platform = 'twitter', kind = 'tweet', url, caption = 'x', status = 'pending', handle = '@someone' }) {
  db.prepare('INSERT INTO items (platform, kind, url, caption, action_status, author_handle, state) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(platform, kind, url, caption, status, handle, 'media');
  return db.prepare('SELECT id FROM items WHERE url = ?').get(url).id;
}
const get = async (base, p) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
const patch = async (base, id, body, headers = {}) => {
  const r = await fetch(`${base}/api/items/${id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

test('the feed is newest-saved first and defaults to to-do items', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const a = addItem(db, { url: 'https://x.com/a/status/1' });
    const b = addItem(db, { url: 'https://x.com/a/status/2', status: 'done' });
    const c = addItem(db, { url: 'https://x.com/a/status/3' });
    const { status, body } = await get(base, '/api/items');
    assert.equal(status, 200);
    assert.deepEqual(body.items.map((i) => i.id), [c, a]);
    assert.ok(!body.items.some((i) => i.id === b));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('status filters: all, done, skipped', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1' });
    const d = addItem(db, { url: 'https://x.com/a/status/2', status: 'done' });
    const s = addItem(db, { url: 'https://x.com/a/status/3', status: 'skipped' });
    assert.equal((await get(base, '/api/items?status=all')).body.items.length, 3);
    assert.deepEqual((await get(base, '/api/items?status=done')).body.items.map((i) => i.id), [d]);
    assert.deepEqual((await get(base, '/api/items?status=skipped')).body.items.map((i) => i.id), [s]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('kind and platform filters', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', kind: 'tweet' });
    const t = addItem(db, { url: 'https://x.com/a/status/2', kind: 'thread' });
    addItem(db, { platform: 'instagram', kind: 'reel', url: 'https://instagram.com/p/a/' });
    assert.deepEqual((await get(base, '/api/items?kind=thread')).body.items.map((i) => i.id), [t]);
    assert.ok((await get(base, '/api/items')).body.items.every((i) => i.platform === 'twitter'));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('hasVideo counts downloaded video only, not ingest-time placeholders', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const v = addItem(db, { url: 'https://x.com/a/status/1' });
    const p = addItem(db, { url: 'https://x.com/a/status/2' });
    db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (?, 'video', 'C:/m/a.mp4', 100)").run(v);
    db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (?, 'image', 'https://pbs.twimg.com/x.jpg', NULL)").run(p);
    const { body } = await get(base, '/api/items?hasVideo=1');
    assert.deepEqual(body.items.map((i) => i.id), [v]);
    const all = (await get(base, '/api/items')).body.items;
    assert.deepEqual(all.find((i) => i.id === p).media, [], 'placeholder rows are not reported as media');
    assert.deepEqual(all.find((i) => i.id === v).media, [{ id: 1, kind: 'video', bytes: 100, ext: '.mp4' }]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('pagination by id: nextBefore, and null on the last page', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const ids = [1, 2, 3, 4, 5].map((n) => addItem(db, { url: `https://x.com/a/status/${n}` }));
    const p1 = (await get(base, '/api/items?limit=2')).body;
    assert.deepEqual(p1.items.map((i) => i.id), [ids[4], ids[3]]);
    assert.equal(p1.nextBefore, ids[3]);
    const p3 = (await get(base, `/api/items?limit=2&before=${ids[1]}`)).body;
    assert.deepEqual(p3.items.map((i) => i.id), [ids[0]]);
    assert.equal(p3.nextBefore, null);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('marking an item done between pages neither skips nor repeats items', async () => {
  // The reason for keyset pagination: with offsets, removing an item from the
  // to-do set shifts every later item up and the next page skips one.
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const ids = [1, 2, 3, 4, 5].map((n) => addItem(db, { url: `https://x.com/a/status/${n}` }));
    const p1 = (await get(base, '/api/items?limit=2')).body;
    await patch(base, ids[4], { actionStatus: 'done' });
    const p2 = (await get(base, `/api/items?limit=2&before=${p1.nextBefore}`)).body;
    assert.deepEqual(p2.items.map((i) => i.id), [ids[2], ids[1]]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('excerpt is 280 code points, so an emoji is never split', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'a'.repeat(279) + '🚀' + 'tail' });
    const item = (await get(base, '/api/items')).body.items[0];
    assert.equal(item.excerpt, 'a'.repeat(279) + '🚀');
    assert.equal(item.textLength, 284);
    assert.equal(Array.from(item.excerpt).length, 280);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the summary carries the handle exactly as stored', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', handle: '@oneviske' });
    assert.equal((await get(base, '/api/items')).body.items[0].authorHandle, '@oneviske');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad feed parameters are 400 with a named error', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const cases = [
      ['platform=myspace', 'bad_platform'], ['status=archived', 'bad_status'], ['kind=story', 'bad_kind'],
      ['limit=0', 'bad_limit'], ['limit=101', 'bad_limit'], ['limit=abc', 'bad_limit'], ['before=abc', 'bad_before'],
    ];
    for (const [qs, error] of cases) {
      const r = await get(base, `/api/items?${qs}`);
      assert.equal(r.status, 400, qs);
      assert.equal(r.body.error, error, qs);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/items/:id returns full text instead of an excerpt', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const long = 'word '.repeat(3000);
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: long });
    const { status, body } = await get(base, `/api/items/${id}`);
    assert.equal(status, 200);
    assert.equal(body.text, long);
    assert.equal(body.excerpt, undefined);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown and non-numeric item ids are 404, not 500', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    for (const id of ['999', 'abc', '1.5', '-1', '%20']) {
      const r = await get(base, `/api/items/${id}`);
      assert.equal(r.status, 404, id);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH sets each status and changes nothing else', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: 'keep me' });
    for (const s of ['done', 'skipped', 'pending']) {
      const r = await patch(base, id, { actionStatus: s });
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, { ok: true, id, actionStatus: s });
      const row = db.prepare('SELECT action_status, caption, state FROM items WHERE id = ?').get(id);
      assert.equal(row.action_status, s);
      assert.equal(row.caption, 'keep me');
      assert.equal(row.state, 'media');
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH rejects bad values, extra fields and malformed JSON with 400', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1' });
    assert.equal((await patch(base, id, { actionStatus: 'archived' })).body.error, 'bad_action_status');
    assert.equal((await patch(base, id, { actionStatus: 'done', caption: 'pwned' })).body.error, 'bad_action_status');
    assert.equal((await patch(base, id, {})).body.error, 'bad_action_status');
    assert.equal((await patch(base, id, [])).body.error, 'bad_action_status');
    const bad = await patch(base, id, '{not json');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, 'bad_json');
    assert.equal(db.prepare('SELECT action_status FROM items WHERE id = ?').get(id).action_status, 'pending');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH on an unknown id is 404', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    assert.equal((await patch(base, 999, { actionStatus: 'done' })).status, 404);
    assert.equal((await patch(base, 'abc', { actionStatus: 'done' })).status, 404);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PATCH from a cross-site origin is refused; from the extension it is allowed', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1' });
    assert.equal((await patch(base, id, { actionStatus: 'done' }, { origin: 'https://evil.example' })).status, 403);
    assert.equal(db.prepare('SELECT action_status FROM items WHERE id = ?').get(id).action_status, 'pending');
    assert.equal((await patch(base, id, { actionStatus: 'done' }, { origin: 'chrome-extension://abc' })).status, 200);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/items.test.js`
Expected: FAIL. `/api/items` returns 404.

- [ ] **Step 3: Implement**

Create `server/src/routes/items.js`:

```js
import path from 'node:path';
import { send, readJson } from '../http.js';

export const PLATFORMS = new Set(['twitter', 'instagram']);
export const STATUSES = new Set(['pending', 'done', 'skipped']);
const KINDS = new Set(['tweet', 'thread', 'article', 'post', 'reel', 'carousel']);
const EXCERPT_CODE_POINTS = 280;

const SUMMARY_COLS =
  'id, platform, kind, url, author, author_handle, source_date, saved_at, action_status, caption';

export function parseLimit(v) {
  if (v === null || v === undefined) return 50;
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return n >= 1 && n <= 100 ? n : null;
}

function parseId(v) {
  return /^\d+$/.test(String(v)) ? Number(v) : null;
}

/**
 * Downloaded media for a page of items, in one query rather than one per item.
 * Rows with no byte count are skipped: those are placeholders written at
 * ingest time that hold a source URL, not a file on disk.
 */
export function mediaByItem(db, ids) {
  const out = new Map(ids.map((id) => [id, []]));
  if (ids.length === 0) return out;
  const rows = db.prepare(`
    SELECT id, item_id, kind, bytes, path FROM media
    WHERE bytes IS NOT NULL AND item_id IN (${ids.map(() => '?').join(',')})
    ORDER BY id`).all(...ids);
  for (const r of rows) {
    out.get(r.item_id)?.push({ id: r.id, kind: r.kind, bytes: r.bytes, ext: path.extname(r.path).toLowerCase() });
  }
  return out;
}

/**
 * The one item shape the dashboard sees, shared by the feed and search so the
 * two can never drift apart. Text is cut by code point, not UTF-16 unit:
 * String#slice would split an emoji's surrogate pair and leave a broken glyph.
 */
export function toSummary(row, media) {
  const chars = Array.from(row.caption ?? '');
  return {
    id: row.id,
    platform: row.platform,
    kind: row.kind,
    url: row.url,
    author: row.author ?? '',
    authorHandle: row.author_handle ?? '',
    sourceDate: row.source_date ?? null,
    savedAt: row.saved_at ?? null,
    actionStatus: row.action_status,
    excerpt: chars.slice(0, EXCERPT_CODE_POINTS).join(''),
    textLength: chars.length,
    media: media ?? [],
  };
}

export function getItems(req, res, { db }, url) {
  const q = url.searchParams;
  const platform = q.get('platform') ?? 'twitter';
  const status = q.get('status') ?? 'pending';
  const kind = q.get('kind');
  const hasVideo = q.get('hasVideo') === '1';
  const limit = parseLimit(q.get('limit'));
  const before = q.has('before') ? parseId(q.get('before')) : undefined;

  if (!PLATFORMS.has(platform)) return send(res, 400, { error: 'bad_platform' });
  if (status !== 'all' && !STATUSES.has(status)) return send(res, 400, { error: 'bad_status' });
  if (kind !== null && !KINDS.has(kind)) return send(res, 400, { error: 'bad_kind' });
  if (limit === null) return send(res, 400, { error: 'bad_limit' });
  if (before === null) return send(res, 400, { error: 'bad_before' });

  const where = ['platform = ?'];
  const params = [platform];
  if (status !== 'all') { where.push('action_status = ?'); params.push(status); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (hasVideo) {
    where.push("EXISTS (SELECT 1 FROM media m WHERE m.item_id = items.id AND m.kind = 'video' AND m.bytes IS NOT NULL)");
  }
  // Keyset, not offset: marking items done while paging must not shift later
  // items up and make the next page skip one.
  if (before !== undefined) { where.push('id < ?'); params.push(before); }

  const rows = db.prepare(
    `SELECT ${SUMMARY_COLS} FROM items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`,
  ).all(...params, limit + 1);

  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const media = mediaByItem(db, page.map((r) => r.id));
  return send(res, 200, {
    items: page.map((r) => toSummary(r, media.get(r.id))),
    nextBefore: more ? page[page.length - 1].id : null,
  });
}

export function getItem(req, res, { db }, idText) {
  const id = parseId(idText);
  if (id === null) return send(res, 404, { error: 'not_found' });
  const row = db.prepare(`SELECT ${SUMMARY_COLS} FROM items WHERE id = ?`).get(id);
  if (!row) return send(res, 404, { error: 'not_found' });
  const { excerpt, ...summary } = toSummary(row, mediaByItem(db, [id]).get(id));
  return send(res, 200, { ...summary, text: row.caption ?? '' });
}

export async function patchItem(req, res, { db }, idText) {
  const id = parseId(idText);
  if (id === null) return send(res, 404, { error: 'not_found' });

  // readJson throws on malformed JSON, and the server's catch-all would turn
  // that into a 500. A bad body is the client's error.
  let body;
  try {
    body = await readJson(req);
  } catch {
    return send(res, 400, { error: 'bad_json' });
  }

  // Exactly one field, with a known value. Anything else is refused outright
  // rather than partly applied: this is the dashboard's only write.
  const isObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  const keys = isObject ? Object.keys(body) : [];
  if (keys.length !== 1 || keys[0] !== 'actionStatus' || !STATUSES.has(body.actionStatus)) {
    return send(res, 400, { error: 'bad_action_status' });
  }

  const info = db.prepare(
    "UPDATE items SET action_status = ?, updated_at = datetime('now') WHERE id = ?",
  ).run(body.actionStatus, id);
  if (info.changes === 0) return send(res, 404, { error: 'not_found' });
  return send(res, 200, { ok: true, id, actionStatus: body.actionStatus });
}
```

In `server/src/server.js`, add the import:

```js
import { getItems, getItem, patchItem } from './routes/items.js';
```

and add before `return send(res, 404, { error: 'not_found' });`:

```js
      if (req.method === 'GET' && url.pathname === '/api/items') return getItems(req, res, deps, url);
      const itemMatch = /^\/api\/items\/([^/]+)$/.exec(url.pathname);
      if (itemMatch && req.method === 'GET') return getItem(req, res, deps, itemMatch[1]);
      if (itemMatch && req.method === 'PATCH') return await patchItem(req, res, deps, itemMatch[1]);
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/items.js server/src/server.js server/test/items.test.js
git commit -m "Add the dashboard feed, single-item view and done/skip write"
```

---

### Task 4: Ranked search

**Files:**
- Create: `server/src/routes/search.js`
- Modify: `server/src/server.js`
- Test: `server/test/search.test.js`

**Interfaces:**
- Consumes: `toMatchQuery`, `toSpans`, `HIT_OPEN`, `HIT_CLOSE` (Task 2); `PLATFORMS`, `STATUSES`, `parseLimit`, `mediaByItem`, `toSummary` (Task 3).
- Produces: `getSearch(req, res, deps, url)`. Responds `{ items: Array<ItemSummary & { snippet: Span[] }> }`.

- [ ] **Step 1: Write the failing test**

Create `server/test/search.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-search-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), MEDIA_DIR: path.join(dir, 'media') };
  return { dir, db, server: createServer({ db, config }) };
}
async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}
function addItem(db, { platform = 'twitter', url, caption, status = 'pending' }) {
  db.prepare("INSERT INTO items (platform, kind, url, caption, action_status, state) VALUES (?, 'tweet', ?, ?, ?, 'media')")
    .run(platform, url, caption, status);
  return db.prepare('SELECT id FROM items WHERE url = ?').get(url).id;
}
const search = async (base, qs) => {
  const r = await fetch(`${base}/api/search?${qs}`);
  return { status: r.status, body: await r.json() };
};

test('results are ranked by relevance, best first', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const weak = addItem(db, { url: 'https://x.com/a/status/1', caption: 'one mention of agent among many other unrelated words here' });
    const strong = addItem(db, { url: 'https://x.com/a/status/2', caption: 'agent agent agent framework' });
    const { body } = await search(base, 'q=agent');
    assert.deepEqual(body.items.map((i) => i.id), [strong, weak]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the last word matches as a prefix, so results appear while typing', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const id = addItem(db, { url: 'https://x.com/a/status/1', caption: 'a new agent framework' });
    assert.deepEqual((await search(base, 'q=agen')).body.items.map((i) => i.id), [id]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('anything typed returns 200, never a 500', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    for (const q of ['"', '-', '(', 'agent "', '🚀', '--', 'NEAR(', 'OR', '*', 'caption:agent', '%', "it's"]) {
      const r = await search(base, `q=${encodeURIComponent(q)}`);
      assert.equal(r.status, 200, JSON.stringify(q));
      assert.ok(Array.isArray(r.body.items), JSON.stringify(q));
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a blank query returns an empty list', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    for (const qs of ['q=', 'q=%20%20', '']) {
      const r = await search(base, qs);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.items, []);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('snippets arrive as spans with the hit marked, and contain no markup', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    addItem(db, { url: 'https://x.com/a/status/1', caption: 'a new agent framework for everyone' });
    const item = (await search(base, 'q=agent')).body.items[0];
    assert.ok(Array.isArray(item.snippet));
    assert.ok(item.snippet.some((s) => s.hit && s.text.toLowerCase() === 'agent'));
    const joined = item.snippet.map((s) => s.text).join('');
    assert.ok(!joined.includes('<mark>'));
    assert.ok(!joined.includes('\uE000') && !joined.includes('\uE001'));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('markup in a caption comes back as literal text in excerpt and snippet', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const evil = '<img src=x onerror=alert(1)> agent';
    addItem(db, { url: 'https://x.com/a/status/1', caption: evil });
    const item = (await search(base, 'q=agent')).body.items[0];
    assert.equal(item.excerpt, evil);
    assert.ok(item.snippet.map((s) => s.text).join('').includes('<img src=x onerror=alert(1)>'));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('search includes done items by default, so finished work is still findable', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const done = addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent', status: 'done' });
    assert.deepEqual((await search(base, 'q=agent')).body.items.map((i) => i.id), [done]);
    assert.deepEqual((await search(base, 'q=agent&status=pending')).body.items, []);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('search is scoped to one platform', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const tw = addItem(db, { url: 'https://x.com/a/status/1', caption: 'agent' });
    addItem(db, { platform: 'instagram', url: 'https://instagram.com/p/a/', caption: 'agent' });
    assert.deepEqual((await search(base, 'q=agent')).body.items.map((i) => i.id), [tw]);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('bad parameters are 400 with a named error', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    assert.equal((await search(base, 'q=a&platform=myspace')).body.error, 'bad_platform');
    assert.equal((await search(base, 'q=a&status=archived')).body.error, 'bad_status');
    assert.equal((await search(base, 'q=a&limit=0')).body.error, 'bad_limit');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/search.test.js`
Expected: FAIL. `/api/search` returns 404.

- [ ] **Step 3: Implement**

Create `server/src/routes/search.js`:

```js
import { send } from '../http.js';
import { toMatchQuery, toSpans, HIT_OPEN, HIT_CLOSE } from '../fts.js';
import { PLATFORMS, STATUSES, parseLimit, mediaByItem, toSummary } from './items.js';

export function getSearch(req, res, { db }, url) {
  const q = url.searchParams;
  const platform = q.get('platform') ?? 'twitter';
  // `all`, not `pending`: someone searching for a specific saved item should
  // find it whether or not they already marked it done.
  const status = q.get('status') ?? 'all';
  const limit = parseLimit(q.get('limit'));

  if (!PLATFORMS.has(platform)) return send(res, 400, { error: 'bad_platform' });
  if (status !== 'all' && !STATUSES.has(status)) return send(res, 400, { error: 'bad_status' });
  if (limit === null) return send(res, 400, { error: 'bad_limit' });

  // The page calls this on every keystroke, so "nothing to search" is an
  // empty answer, not an error.
  const match = toMatchQuery(q.get('q'));
  if (match === null) return send(res, 200, { items: [] });

  const where = ['items_fts MATCH ?', 'i.platform = ?'];
  const params = [match, platform];
  if (status !== 'all') { where.push('i.action_status = ?'); params.push(status); }

  let rows;
  try {
    rows = db.prepare(`
      SELECT i.id, i.platform, i.kind, i.url, i.author, i.author_handle, i.source_date,
             i.saved_at, i.action_status, i.caption,
             snippet(items_fts, -1, ?, ?, '…', 24) AS snip
      FROM items_fts JOIN items i ON i.id = items_fts.rowid
      WHERE ${where.join(' AND ')}
      ORDER BY bm25(items_fts)
      LIMIT ?`).all(HIT_OPEN, HIT_CLOSE, ...params, limit);
  } catch (err) {
    // toMatchQuery should always produce valid FTS5. If something still slips
    // through, a search box must not show a server error, so an FTS syntax
    // failure becomes an empty result. Any other error is a real bug and
    // propagates.
    if (/fts5|syntax/i.test(String(err?.message))) return send(res, 200, { items: [] });
    throw err;
  }

  const media = mediaByItem(db, rows.map((r) => r.id));
  return send(res, 200, {
    items: rows.map((r) => ({ ...toSummary(r, media.get(r.id)), snippet: toSpans(r.snip) })),
  });
}
```

In `server/src/server.js`, add:

```js
import { getSearch } from './routes/search.js';
```

and, before the 404:

```js
      if (req.method === 'GET' && url.pathname === '/api/search') return getSearch(req, res, deps, url);
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/search.js server/src/server.js server/test/search.test.js
git commit -m "Add ranked full-text search returning snippets as span data"
```

---

### Task 5: Media streaming with Range

**Files:**
- Create: `server/src/routes/media.js`
- Modify: `server/src/server.js`
- Test: `server/test/media.test.js`

**Interfaces:**
- Consumes: `send`; `config.MEDIA_DIR`; optional `deps.openStream(file, opts)`, defaulting to `fs.createReadStream`, so tests can observe stream teardown.
- Produces: `parseRange(header, size) -> { start, end } | 'unsatisfiable' | null`; `getMedia(req, res, deps, idText)`.

- [ ] **Step 1: Write the failing test**

Create `server/test/media.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { parseRange } from '../src/routes/media.js';

function harness(extraDeps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-media-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), MEDIA_DIR: path.join(dir, 'media') };
  return { dir, db, config, server: createServer({ db, config, ...extraDeps }) };
}
async function listenPort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
function addFile(db, config, rel, body) {
  const file = path.join(config.MEDIA_DIR, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  db.prepare("INSERT INTO items (platform, kind, url, state) VALUES ('twitter','tweet',?, 'media')").run(`https://x.com/a/status/${rel.length}${Math.random()}`);
  const itemId = db.prepare('SELECT max(id) id FROM items').get().id;
  db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (?, 'video', ?, ?)").run(itemId, file, body.length);
  return { id: db.prepare('SELECT max(id) id FROM media').get().id, file };
}
function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}
const BODY = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

test('parseRange handles the forms browsers send', () => {
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=950-5000', 1000), { start: 950, end: 999 });
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=abc', 1000), null);
  assert.equal(parseRange('bytes=0-10,20-30', 1000), null);
  assert.equal(parseRange('items=0-10', 1000), null);
});

test('no Range header streams the whole file with 200', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    const r = await get(port, `/media/${id}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'video/mp4');
    assert.equal(r.headers['accept-ranges'], 'bytes');
    assert.equal(Number(r.headers['content-length']), 1000);
    assert.ok(r.body.equals(BODY));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Range request returns 206 with the exact bytes asked for', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    const r = await get(port, `/media/${id}`, { range: 'bytes=100-199' });
    assert.equal(r.status, 206);
    assert.equal(r.headers['content-range'], 'bytes 100-199/1000');
    assert.equal(Number(r.headers['content-length']), 100);
    assert.ok(r.body.equals(BODY.subarray(100, 200)));
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a Range starting past the end is 416', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    const r = await get(port, `/media/${id}`, { range: 'bytes=1000-' });
    assert.equal(r.status, 416);
    assert.equal(r.headers['content-range'], 'bytes */1000');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a malformed or multi-part Range is ignored and the whole file is sent', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    for (const range of ['bytes=abc', 'bytes=0-10,20-30', 'nonsense']) {
      const r = await get(port, `/media/${id}`, { range });
      assert.equal(r.status, 200, range);
      assert.ok(r.body.equals(BODY), range);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Content-Type follows the extension', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const cases = [['a.mov', 'video/quicktime'], ['b.mkv', 'video/x-matroska'], ['c.mp3', 'audio/mpeg'],
      ['d.webm', 'video/webm'], ['e.jpg', 'image/jpeg'], ['f.png', 'image/png'], ['g.xyz', 'application/octet-stream']];
    for (const [name, type] of cases) {
      const { id } = addFile(db, config, `twitter/9/${name}`, BODY);
      assert.equal((await get(port, `/media/${id}`)).headers['content-type'], type, name);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('unknown, non-numeric and missing-file ids are 404', async () => {
  const { dir, db, config, server } = harness();
  const port = await listenPort(server);
  try {
    const { id, file } = addFile(db, config, 'twitter/1/clip.mp4', BODY);
    fs.rmSync(file);
    for (const p of [`/media/${id}`, '/media/999', '/media/abc', '/media/..%2F..%2Fserver.js']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a stored path outside MEDIA_DIR is refused even though the file exists', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const outside = path.join(dir, 'secret.txt');
    fs.writeFileSync(outside, 'not media');
    db.prepare("INSERT INTO items (platform, kind, url) VALUES ('twitter','tweet','https://x.com/a/status/1')").run();
    db.prepare("INSERT INTO media (item_id, kind, path, bytes) VALUES (1, 'video', ?, 9)").run(outside);
    assert.equal((await get(port, '/media/1')).status, 404);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a client that disconnects mid-stream has its file stream destroyed', async () => {
  // Browsers abort the transfer on every seek. Without teardown each seek
  // through a large video leaks a file descriptor.
  const opened = [];
  const openStream = (file, opts) => { const s = fs.createReadStream(file, opts); opened.push(s); return s; };
  const { dir, db, config, server } = harness({ openStream });
  const port = await listenPort(server);
  try {
    const { id } = addFile(db, config, 'twitter/1/big.mp4', Buffer.alloc(8 * 1024 * 1024, 7));
    await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: `/media/${id}` }, (res) => {
        res.once('data', () => { req.destroy(); resolve(); });
      });
      req.on('error', () => {});
    });
    let destroyed = false;
    for (let i = 0; i < 40 && !destroyed; i++) {
      destroyed = opened.length === 1 && opened[0].destroyed;
      if (!destroyed) await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(destroyed, 'the read stream was left open after the client went away');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/media.test.js`
Expected: FAIL with `Cannot find module '../src/routes/media.js'`.

- [ ] **Step 3: Implement**

Create `server/src/routes/media.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { send } from '../http.js';

const TYPES = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Parse a single-range `Range` header.
 *
 * Returns { start, end } to send part of the file, 'unsatisfiable' for a range
 * that starts past the end, or null to ignore the header and send everything.
 * Malformed and multi-part ranges are ignored rather than refused: RFC 9110
 * lets a server do that, and the browser still gets a playable file.
 */
export function parseRange(header, size) {
  if (typeof header !== 'string') return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

export function getMedia(req, res, deps, idText) {
  const { db, config } = deps;
  if (!/^\d+$/.test(idText)) return send(res, 404, { error: 'not_found' });
  const row = db.prepare('SELECT path FROM media WHERE id = ?').get(Number(idText));
  if (!row) return send(res, 404, { error: 'not_found' });

  // The path comes from our own database, not the request, but this is the
  // one place the server hands a file to a browser. One more check is cheap.
  const root = path.resolve(config.MEDIA_DIR);
  const file = path.resolve(row.path);
  if (!file.startsWith(root + path.sep)) return send(res, 404, { error: 'not_found' });

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, { error: 'not_found' });
  }
  if (!stat.isFile()) return send(res, 404, { error: 'not_found' });

  const range = parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'content-range': `bytes */${stat.size}` });
    return res.end();
  }

  const headers = {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  const openStream = deps.openStream ?? fs.createReadStream;
  let stream;
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': range.end - range.start + 1,
    });
    stream = openStream(file, { start: range.start, end: range.end });
  } else {
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    stream = openStream(file);
  }

  // pipeline, not pipe: when the client goes away mid-transfer, which a
  // browser does on every seek, pipeline destroys the read stream and closes
  // its file handle. pipe() leaves the source paused and open, leaking one
  // descriptor per seek.
  pipeline(stream, res, () => {});
}
```

In `server/src/server.js`, add:

```js
import { getMedia } from './routes/media.js';
```

and, before the 404:

```js
      const mediaMatch = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (mediaMatch && req.method === 'GET') return getMedia(req, res, deps, mediaMatch[1]);
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

Then confirm the stream test has teeth. Temporarily replace `pipeline(stream, res, () => {});` with `stream.pipe(res);`, run `node --test test/media.test.js`, and check that the disconnect test FAILS. Then restore `pipeline`.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/media.js server/src/server.js server/test/media.test.js
git commit -m "Stream media by id with Range support and teardown on disconnect"
```

---

### Task 6: Serve the page files with a Content-Security-Policy

**Files:**
- Create: `server/src/routes/static.js`
- Modify: `server/src/config.js`, `server/src/server.js`
- Test: `server/test/static.test.js`

**Interfaces:**
- Consumes: `config.PUBLIC_DIR`.
- Produces: `serveStatic(req, res, deps, pathname) -> boolean`, true if it handled the request; `CSP: string`.

- [ ] **Step 1: Write the failing test**

Create `server/test/static.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { CSP } from '../src/routes/static.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-static-'));
  const pub = path.join(dir, 'public');
  fs.mkdirSync(pub);
  fs.writeFileSync(path.join(pub, 'index.html'), '<!doctype html><title>t</title>');
  fs.writeFileSync(path.join(pub, 'app.js'), 'export {};');
  fs.writeFileSync(path.join(pub, 'style.css'), 'body{}');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'outside public');
  const db = openDb(path.join(dir, 'archive.db'));
  const config = { COOKIES_PATH: path.join(dir, 'c.txt'), PUBLIC_DIR: pub };
  return { dir, db, server: createServer({ db, config }) };
}
async function listenPort(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}
// http.get rather than fetch, so traversal paths reach the server unnormalised.
function get(port, p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the three page files are served with the right type and the CSP', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    const cases = [['/', 'text/html; charset=utf-8', '<!doctype html><title>t</title>'],
      ['/app.js', 'text/javascript; charset=utf-8', 'export {};'],
      ['/style.css', 'text/css; charset=utf-8', 'body{}']];
    for (const [p, type, body] of cases) {
      const r = await get(port, p);
      assert.equal(r.status, 200, p);
      assert.equal(r.headers['content-type'], type, p);
      assert.equal(r.headers['content-security-policy'], CSP, p);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', p);
      assert.equal(r.body, body, p);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the CSP refuses inline script and anything off-origin', () => {
  assert.match(CSP, /script-src 'self'(;|$)/);
  assert.ok(!CSP.includes('unsafe-inline'));
  assert.ok(!CSP.includes('unsafe-eval'));
  assert.match(CSP, /object-src 'none'/);
  assert.match(CSP, /frame-ancestors 'none'/);
});

test('any other path is 404, including traversal attempts', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    for (const p of ['/index.html', '/secret.txt', '/../secret.txt', '/%2e%2e/secret.txt',
      '/public/app.js', '/..%2fsecret.txt', '/app.js/', '/APP.JS']) {
      assert.equal((await get(port, p)).status, 404, p);
    }
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('page files are GET-only', async () => {
  const { dir, db, server } = harness();
  const port = await listenPort(server);
  try {
    assert.equal((await get(port, '/', 'POST')).status, 404);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/static.test.js`
Expected: FAIL with `Cannot find module '../src/routes/static.js'`.

- [ ] **Step 3: Implement**

Create `server/src/routes/static.js`:

```js
import fs from 'node:fs';
import path from 'node:path';

// A fixed table. The request path is only ever a key into it and is never
// joined onto a directory, so no form of traversal can reach another file.
const FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

// Item text is written by strangers. The page renders it only as text, and
// this policy is the second line: even if markup slipped into the DOM, inline
// script and inline handlers would not run, and nothing could load from or
// send to another origin.
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

/** Returns true if it handled the request, false to let routing continue. */
export function serveStatic(req, res, { config }, pathname) {
  const entry = FILES.get(pathname);
  if (!entry) return false;
  const [name, type] = entry;
  let body;
  try {
    body = fs.readFileSync(path.join(config.PUBLIC_DIR, name));
  } catch {
    return false;
  }
  res.writeHead(200, {
    'content-type': type,
    'content-length': body.length,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    // Read on every request and never cached, so an edit to the page shows
    // up on reload without restarting the server.
    'cache-control': 'no-store',
  });
  res.end(body);
  return true;
}
```

In `server/src/config.js`, add to `CONFIG`:

```js
  PUBLIC_DIR: path.join(root, 'public'),
```

In `server/src/server.js`, add:

```js
import { serveStatic } from './routes/static.js';
```

and, as the last check before the 404:

```js
      if (req.method === 'GET' && serveStatic(req, res, deps, url.pathname)) return;
```

- [ ] **Step 4: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/static.js server/src/config.js server/src/server.js server/test/static.test.js
git commit -m "Serve the dashboard page files from a fixed table with a strict CSP"
```

---

### Task 7: The page

**Files:**
- Create: `server/public/index.html`, `server/public/app.js`, `server/public/style.css`
- Test: `server/test/page-safety.test.js`

**Interfaces:**
- Consumes: `GET /api/stats`, `GET /api/items`, `GET /api/items/:id`, `PATCH /api/items/:id`, `GET /api/search`, `GET /media/:id`.

- [ ] **Step 1: Write the failing test**

Create `server/test/page-safety.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Item text is written by strangers, and four captions in the real archive
// already contain angle-bracket text. These checks make "render item data
// only as text" a rule the build enforces, not a habit.

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

// Strip comments first, so the file can explain the rule without tripping it.
const code = app
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('app.js never turns strings into markup', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write',
    'createContextualFragment', 'DOMParser', 'srcdoc']) {
    assert.ok(!code.includes(sink), `app.js must not use ${sink}`);
  }
});

test('app.js never evaluates strings as code', () => {
  assert.ok(!/\beval\s*\(/.test(code), 'eval');
  assert.ok(!/new\s+Function\s*\(/.test(code), 'new Function');
  assert.ok(!/set(?:Timeout|Interval)\s*\(\s*['"`]/.test(code), 'string timer');
});

test('app.js never sets a style attribute, which the CSP would refuse', () => {
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(code));
});

test('index.html has no inline script, style or handlers', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/<style/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline on* handler');
});

test('index.html loads app.js as a module and style.css as a stylesheet', () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd server && node --test test/page-safety.test.js`
Expected: FAIL with `ENOENT` for `public/app.js`.

- [ ] **Step 3: Write `server/public/index.html`**

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Social Saver — Twitter</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <header class="top">
    <h1>Twitter archive</h1>
    <p class="counts" id="counts">Loading…</p>
  </header>
  <div class="banner" id="banner" role="alert" hidden></div>
  <main class="wrap">
    <input class="search" id="search" type="search" placeholder="Search your saved tweets"
           autocomplete="off" spellcheck="false" aria-label="Search saved tweets">
    <nav class="filters" aria-label="Filters">
      <div class="chips" id="status-chips" role="group" aria-label="Status"></div>
      <div class="chips" id="kind-chips" role="group" aria-label="Kind"></div>
      <label class="toggle"><input type="checkbox" id="has-video"> Has video</label>
    </nav>
    <p class="result-note" id="result-note" aria-live="polite"></p>
    <ol class="feed" id="feed"></ol>
    <button class="more" id="more" type="button" hidden>Load more</button>
  </main>
  <script type="module" src="/app.js"></script>
</body>
</html>
```

- [ ] **Step 4: Write `server/public/app.js`**

```js
// Social Saver dashboard.
//
// SECURITY RULE FOR THIS FILE: item data comes from third parties and reaches
// the page only as text, via el() and textContent. Never use the string-to-
// markup APIs. test/page-safety.test.js fails the build if one appears here.

const PLATFORM = 'twitter';
const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;

const STATUS_CHIPS = [['pending', 'To do'], ['done', 'Done'], ['skipped', 'Skipped'], ['all', 'All']];
const KIND_CHIPS = [['tweet', 'Tweet'], ['thread', 'Thread'], ['article', 'Article']];
const KIND_LABEL = { tweet: 'Tweet', thread: 'Thread', article: 'Article', reel: 'Reel', post: 'Post', carousel: 'Carousel' };

const state = {
  q: '',
  status: 'pending',
  statusBeforeSearch: 'pending',
  kind: null,
  hasVideo: false,
  nextBefore: null,
};

// Every reload bumps this. A response that arrives after a newer reload
// started is discarded, so fast typing cannot paint stale results.
let generation = 0;

const $ = (id) => document.getElementById(id);

/** Build an element. Strings among the children become text nodes, never markup. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Only http(s) links leave the page. A javascript: URL would run in it. */
function safeHref(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function banner(message) {
  const b = $('banner');
  b.textContent = message ?? '';
  b.hidden = !message;
}

function note(text) {
  $('result-note').textContent = text;
}

async function api(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    banner('Cannot reach the archive server at 127.0.0.1:8787. Is it running?');
    throw new Error('server unreachable');
  }
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error ?? ''; } catch { /* not JSON */ }
    throw new Error(`HTTP ${res.status}${detail ? ` (${detail})` : ''}`);
  }
  banner(null);
  return res.json();
}

function fmtDate(value) {
  if (!value) return '';
  // saved_at is SQLite's "YYYY-MM-DD HH:MM:SS" in UTC; source dates are ISO.
  const d = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtBytes(n) {
  if (!n) return '';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(n / 1048576))} MB`;
}

async function loadCounts() {
  try {
    const s = await api('/api/stats');
    const n = s.items.byPlatform?.[PLATFORM] ?? 0;
    $('counts').textContent = `${n} saved`;
  } catch {
    $('counts').textContent = '';
  }
}

function renderChips() {
  $('status-chips').replaceChildren(...STATUS_CHIPS.map(([value, label]) =>
    el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(state.status === value),
      onclick: () => { state.status = value; renderChips(); reload(); },
    }, label)));
  $('kind-chips').replaceChildren(...KIND_CHIPS.map(([value, label]) =>
    el('button', {
      type: 'button',
      class: 'chip',
      'aria-pressed': String(state.kind === value),
      onclick: () => { state.kind = state.kind === value ? null : value; renderChips(); reload(); },
    }, label)));
}

function emptyMessage() {
  return state.status === 'pending'
    ? 'Nothing to do. Every saved tweet here is done or skipped.'
    : 'No saved tweets match these filters.';
}

function excerptText(item) {
  return item.textLength > Array.from(item.excerpt).length ? `${item.excerpt}…` : item.excerpt;
}

function snippetNode(spans) {
  return el('p', { class: 'excerpt' }, ...spans.map((s) => (s.hit ? el('mark', { text: s.text }) : s.text)));
}

function card(item) {
  const li = el('li', { class: 'card', 'data-id': item.id });
  const hasVideo = item.media.some((m) => m.kind === 'video');

  const head = el('div', { class: 'card-head' },
    el('span', { class: 'handle', text: item.authorHandle || item.author || 'unknown' }),
    el('span', { class: 'meta', text: [KIND_LABEL[item.kind] ?? item.kind, fmtDate(item.savedAt)].filter(Boolean).join(' · ') }),
    hasVideo ? el('span', { class: 'badge', text: 'video' }) : null,
    item.actionStatus !== 'pending' ? el('span', { class: `status status-${item.actionStatus}`, text: item.actionStatus }) : null);

  const body = item.snippet ? snippetNode(item.snippet) : el('p', { class: 'excerpt', text: excerptText(item) });

  const main = el('div', { class: 'card-main', role: 'button', tabindex: '0', 'aria-expanded': 'false' }, head, body);
  const toggle = () => toggleDetail(item, li, main);
  main.addEventListener('click', toggle);
  main.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  const actions = el('div', { class: 'actions' },
    item.actionStatus !== 'done' ? statusButton(item, li, 'done', 'Done') : null,
    item.actionStatus !== 'skipped' ? statusButton(item, li, 'skipped', 'Skip') : null,
    item.actionStatus !== 'pending' ? statusButton(item, li, 'pending', 'Back to to-do') : null);

  li.append(main, actions);
  return li;
}

function statusButton(item, li, to, label) {
  return el('button', {
    type: 'button',
    class: `act act-${to}`,
    onclick: (e) => { e.stopPropagation(); setStatus(item, li, to); },
  }, label);
}

async function setStatus(item, li, to) {
  // In a filtered feed the card leaves at once. If the server refuses, it
  // comes back, so the screen never shows a change the server did not make.
  const leaves = !state.q.trim() && state.status !== 'all' && state.status !== to;
  const marker = document.createComment('');
  if (leaves) li.replaceWith(marker);
  try {
    await api(`/api/items/${item.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ actionStatus: to }),
    });
    item.actionStatus = to;
    if (leaves) {
      marker.remove();
      if (!$('feed').querySelector('.card')) {
        if (state.nextBefore !== null) loadPage(generation);
        else note(emptyMessage());
      }
    } else {
      li.replaceWith(card(item));
    }
  } catch (err) {
    if (leaves) marker.replaceWith(li);
    banner(`Could not update that item: ${err.message}`);
  }
}

async function toggleDetail(item, li, main) {
  const open = li.querySelector('.detail');
  if (open) {
    open.remove();
    li.classList.remove('open');
    main.setAttribute('aria-expanded', 'false');
    return;
  }
  li.classList.add('open');
  main.setAttribute('aria-expanded', 'true');
  const detail = el('div', { class: 'detail' }, el('p', { class: 'loading', text: 'Loading…' }));
  li.append(detail);

  let full;
  try {
    full = await api(`/api/items/${item.id}`);
  } catch (err) {
    detail.replaceChildren(el('p', { class: 'error', text: `Could not load: ${err.message}` }));
    return;
  }
  if (!detail.isConnected) return;

  const parts = [el('div', { class: 'full-text', text: full.text || '(no text)' })];
  for (const m of full.media) {
    const src = `/media/${m.id}`;
    if (m.kind === 'video') parts.push(el('video', { class: 'player', controls: true, preload: 'metadata', src }));
    else if (m.kind === 'audio') parts.push(el('audio', { class: 'player', controls: true, preload: 'metadata', src }));
    else if (m.kind === 'image') parts.push(el('img', { class: 'still', src, alt: '', loading: 'lazy' }));
    // A direct link for every file: .mkv will not play inline in most browsers.
    parts.push(el('a', { class: 'file-link', href: src, download: '' },
      `Download ${m.ext.replace('.', '')} · ${fmtBytes(m.bytes)}`));
  }
  const href = safeHref(full.url);
  if (href) parts.push(el('a', { class: 'out-link', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open on X ↗'));
  detail.replaceChildren(...parts);
}

async function loadPage(gen) {
  const p = new URLSearchParams({ platform: PLATFORM, status: state.status, limit: String(PAGE_SIZE) });
  if (state.kind) p.set('kind', state.kind);
  if (state.hasVideo) p.set('hasVideo', '1');
  if (state.nextBefore !== null) p.set('before', String(state.nextBefore));

  // Disabled while a page is in flight: a double click would otherwise fetch
  // the same page twice and duplicate every card on it.
  const more = $('more');
  more.disabled = true;
  let data;
  try {
    data = await api(`/api/items?${p}`);
  } catch (err) {
    if (gen === generation) note(`Could not load: ${err.message}`);
    return;
  } finally {
    more.disabled = false;
  }
  if (gen !== generation) return;

  const feed = $('feed');
  for (const item of data.items) feed.append(card(item));
  state.nextBefore = data.nextBefore;
  $('more').hidden = data.nextBefore === null;
  note(feed.children.length === 0 ? emptyMessage() : '');
}

async function runSearch(gen) {
  const p = new URLSearchParams({ q: state.q, platform: PLATFORM, status: state.status, limit: '50' });
  let data;
  try {
    data = await api(`/api/search?${p}`);
  } catch (err) {
    if (gen === generation) note(`Search failed: ${err.message}`);
    return;
  }
  if (gen !== generation) return;

  // Search ranks across all kinds. The kind and video filters narrow the
  // ranked list here rather than server-side.
  const items = data.items.filter((it) =>
    (!state.kind || it.kind === state.kind) &&
    (!state.hasVideo || it.media.some((m) => m.kind === 'video')));
  $('feed').replaceChildren(...items.map(card));
  note(items.length ? `${items.length} match${items.length === 1 ? '' : 'es'}` : 'No matches.');
}

function reload() {
  const gen = ++generation;
  state.nextBefore = null;
  $('feed').replaceChildren();
  $('more').hidden = true;
  note('');
  return state.q.trim() ? runSearch(gen) : loadPage(gen);
}

let searchTimer;
$('search').addEventListener('input', (e) => {
  const value = e.target.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const wasSearching = Boolean(state.q.trim());
    const isSearching = Boolean(value.trim());
    state.q = value;
    // Search looks across done items too, so a finished tweet is still
    // findable. The status chip moves to All while searching, so the pressed
    // chip always matches what is shown, and returns afterwards.
    if (isSearching && !wasSearching) { state.statusBeforeSearch = state.status; state.status = 'all'; renderChips(); }
    if (!isSearching && wasSearching) { state.status = state.statusBeforeSearch; renderChips(); }
    reload();
  }, SEARCH_DELAY_MS);
});
$('has-video').addEventListener('change', (e) => { state.hasVideo = e.target.checked; reload(); });
$('more').addEventListener('click', () => loadPage(generation));

renderChips();
loadCounts();
reload();
```

- [ ] **Step 5: Write `server/public/style.css`**

```css
:root {
  --bg: #0b0b0c;
  --panel: #151517;
  --line: #26262a;
  --text: #e7e7ea;
  --muted: #8b8b94;
  --accent: #3b82f6;
  --hit: #3b2f0a;
  --hit-text: #fcd34d;
  --done: #22c55e;
  --skip: #a1a1aa;
  color-scheme: dark;
}

[hidden] { display: none !important; }

* { box-sizing: border-box; }

body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}

.top {
  display: flex;
  align-items: baseline;
  gap: 16px;
  padding: 18px 24px;
  border-bottom: 1px solid var(--line);
}
.top h1 { margin: 0; font-size: 18px; font-weight: 600; }
.counts { margin: 0; color: var(--muted); font-size: 13px; }

.banner {
  margin: 12px 24px 0;
  padding: 10px 14px;
  border-radius: 8px;
  background: #3a1414;
  border: 1px solid #7f1d1d;
  color: #fecaca;
}

.wrap { max-width: 860px; margin: 0 auto; padding: 20px 24px 60px; }

.search {
  width: 100%;
  padding: 12px 14px;
  border-radius: 10px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font-size: 16px;
}
.search:focus { outline: 2px solid var(--accent); outline-offset: 1px; }

.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 18px; margin: 14px 0 6px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip {
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
.toggle { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 13px; cursor: pointer; }

.result-note { color: var(--muted); font-size: 13px; min-height: 20px; margin: 6px 0; }

.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }

.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; overflow: hidden; }
.card.open { border-color: #3a3a42; }
.card-main { padding: 14px 16px 6px; cursor: pointer; }
.card-main:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

.card-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.handle { font-weight: 600; color: var(--text); }
.meta { color: var(--muted); }
.badge {
  padding: 1px 8px;
  border-radius: 999px;
  background: #172554;
  color: #93c5fd;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.status-done { color: var(--done); }
.status-skipped { color: var(--skip); }

.excerpt { margin: 8px 0 4px; white-space: pre-wrap; overflow-wrap: anywhere; }
mark { background: var(--hit); color: var(--hit-text); border-radius: 3px; padding: 0 2px; }

.actions { display: flex; gap: 8px; padding: 6px 16px 14px; }
.act {
  padding: 5px 14px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.act:hover { border-color: #3f3f46; }
.act-done:hover { border-color: var(--done); color: var(--done); }

.detail { border-top: 1px solid var(--line); padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 12px; }
.full-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.player { width: 100%; max-height: 70vh; background: #000; border-radius: 8px; }
.still { max-width: 100%; border-radius: 8px; }
.file-link, .out-link { color: var(--accent); font-size: 13px; text-decoration: none; }
.file-link:hover, .out-link:hover { text-decoration: underline; }
.loading { color: var(--muted); margin: 0; }
.error { color: #fca5a5; margin: 0; }

.more {
  display: block;
  margin: 18px auto 0;
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  font: inherit;
  cursor: pointer;
}

@media (max-width: 600px) {
  .top, .wrap { padding-left: 14px; padding-right: 14px; }
}
```

- [ ] **Step 6: Run the whole suite**

Run: `cd server && npm test`
Expected: PASS, including all five page-safety tests.

- [ ] **Step 7: Commit**

```bash
git add server/public server/test/page-safety.test.js
git commit -m "Add the dashboard page, rendering item data only as text"
```

---

### Task 8: Verify in a real browser, then document

**Files:**
- Modify: `README.md`

Automated tests cannot show that the page works in a browser. This task checks it against the real archive.

- [ ] **Step 1: Restart the server on the new code**

Stop whatever is listening on 8787, then run `cd server && node src/server.js`.

- [ ] **Step 2: Rebinding check against the live server**

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Host: evil.example" http://127.0.0.1:8787/api/items
```

Expected: `403`.

- [ ] **Step 3: Load the page in the in-app browser**

Open `http://127.0.0.1:8787/`. Screenshot it. Confirm the header count matches `/api/stats`, the To-do feed shows cards, and the console shows no CSP violations.

- [ ] **Step 4: Search**

Type `agent`. Confirm results appear ranked with highlighted words, and the status chip has moved to All. Clear the box and confirm the feed and To do return. Screenshot it.

- [ ] **Step 5: Open a card and play video**

Open item 2 (the 409 MB video). Play it, then seek to the middle. In the network log, confirm `/media/` responses are `206` with a `Content-Range`, and that the whole file was not downloaded first.

- [ ] **Step 6: Triage**

Mark an item Done in the To-do view and confirm its card disappears. Switch to Done and confirm it is there. Press "Back to to-do" to restore it.

- [ ] **Step 7: Injection check against the real page**

Insert a probe item:

```bash
curl -s -X POST -H "content-type: application/json" -d '{"items":[{"platform":"twitter","kind":"tweet","url":"https://x.com/probe/status/1","caption":"<img src=x onerror=\"window.__pwned=1\"> injectionprobe"}]}' http://127.0.0.1:8787/ingest
```

In the page: find it in the To-do feed, search `injectionprobe`, and open its card. Each time, evaluate `window.__pwned` in the page. It must be `undefined`, and the literal text `<img src=x …>` must be visible on screen. Then remove the probe:

```bash
cd server && node -e "import('./src/db.js').then(m=>{const d=m.openDb('./data/archive.db');console.log(d.prepare(\"DELETE FROM items WHERE url='https://x.com/probe/status/1'\").run().changes,'removed')})"
```

- [ ] **Step 8: Document it**

In `README.md`, add after the `### 2. Install and Start the Server` section:

```markdown
### Dashboard

With the server running, open <http://127.0.0.1:8787/>.

- **Search** across everything saved, ranked by relevance. Done items are included, so finished work is still findable.
- **Work through saves** in the To-do feed: mark each one Done or Skip and it leaves the list.
- **Open a card** for the full text, inline video with seeking, and a link back to X.

The dashboard is served only on `127.0.0.1` and refuses requests addressed to any other host name, which blocks DNS-rebinding attacks. Tweet text is shown strictly as text, never as markup, because it is written by accounts you don't control.
```

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "Document the dashboard"
```
