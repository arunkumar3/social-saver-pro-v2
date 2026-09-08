# Local Social Archive — Phase 0–1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Supabase backend with a fully local archive — a Node ingest server on `127.0.0.1:8787` backed by SQLite + sqlite-vec — and extend capture from X alone to X plus Instagram, with media downloaded out-of-browser.

**Architecture:** The browser does only what a browser uniquely can — read a logged-in page's DOM — and posts plain JSON to a local server. The server owns the database, the media directory, and every long-running task. Instagram is captured URL-only in the page; media is resolved afterward by yt-dlp and gallery-dl using cookies the extension exports through `chrome.cookies`, because Chrome 152's app-bound encryption blocks external tools from reading the cookie store.

**Tech Stack:** Node 24 (built-in `node:sqlite`, built-in `node:test`, built-in `node:http` — no runtime framework), `sqlite-vec` 0.1.9, Chrome MV3, yt-dlp, gallery-dl, ffmpeg, Python 3.12 venv on torch 2.10.0+cu130.

**Spec:** [`docs/superpowers/specs/2026-09-08-local-archive-dashboard-design.md`](../specs/2026-09-08-local-archive-dashboard-design.md)

## Global Constraints

- Server binds `127.0.0.1:8787` only. Never `0.0.0.0`, never a LAN interface.
- Embeddings are **768 dimensions** (`nomic-embed-text-v1.5`).
- `nomic` task prefixes are mandatory: `search_document: ` when embedding stored text, `search_query: ` when embedding a query. (Phase 2, but the schema is built for it.)
- Item states, in order: `pending → media → transcribed → described → enriched → embedded`, plus terminal `failed`.
- `node:sqlite` requires `BigInt` for `INTEGER PRIMARY KEY` values on `vec0` tables. A plain number raises `Only integers are allowed for primary key values`.
- No native compiled dependencies. `node:sqlite` is built in; `sqlite-vec` ships a prebuilt `.dll`.
- Python work uses the project venv only. **Never modify** global Python, `recipe-app\venv`, or `ComfyUI\.venv`.
- Every install or uninstall is logged in `C:\Users\arunk\INSTALLED.md` (date, manager, package, why) per the user's root `CLAUDE.md`.
- Ingest must never fail because an optional stage failed. Media, transcription, description, and enrichment are all best-effort.
- Test runner is `node --test`. No test framework is added.

## Model routing

Per the user's instruction for this plan's execution:

- **Sonnet** — every task that writes or modifies code (Tasks 1–3, 5–13).
- **Haiku** — environment setup, manual verification, scheduling, and documentation (Tasks 0, 4, 14, 15).

Each task states its model in a **Model:** line. Dispatch accordingly.

## File structure

```
server/                          NEW — the local service
  package.json
  bin/start.cmd                  Task Scheduler entry point
  src/
    config.js                    paths, port, tunables
    db.js                        open, load sqlite-vec, migrate
    schema.sql                   DDL
    server.js                    node:http router + listen
    routes/
      health.js                  GET  /health
      ingest.js                  POST /ingest, POST /known-urls
      cookies.js                 POST /cookies
    cookies/netscape.js          chrome cookie objects -> cookies.txt
    media/
      resolver.js                picks a downloader per item
      ytdlp.js                   yt-dlp child process wrapper
      gallerydl.js               gallery-dl child process wrapper
    worker/media-stage.js        drains pending -> media
  test/
    netscape.test.js
    db.test.js
    ingest.test.js
    resolver.test.js
    offline-queue.test.js

extension/                       EXISTING — files at repo root
  manifest.json                  MODIFY  permissions, content scripts
  background.js                  MODIFY  Supabase -> localhost, sync fix
  content.js                     MODIFY  unchanged extraction, new transport
  instagram.js                   NEW     Instagram saved-grid URL collection
  api.js                         NEW     localhost client + offline queue
  offscreen.html                 DELETE
  offscreen.js                   DELETE
  libs/jspdf.umd.min.js          DELETE
```

`content.js` stays X-specific. Instagram gets its own content script rather than growing `content.js` past 31 KB — the two platforms share no extraction logic, and a single file would have to be re-read in full to change either one.

---

## Task 0: Project Python environment

**Model:** Haiku

**Files:**
- Create: `.venv/` (git-ignored)
- Modify: `C:\Users\arunk\INSTALLED.md`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing.
- Produces: `.venv\Scripts\python.exe` with `faster_whisper` importable on CUDA; `gallery-dl` on PATH within the venv.

Phase 2 consumes this venv. Phase 1 needs only `gallery-dl` from it, but the whole environment is built once here so the GPU claim is verified before anything depends on it.

- [ ] **Step 1: Create the venv**

```bash
cd /c/Users/arunk/MyProjects/social-saver-pro-v2
"/c/Users/arunk/AppData/Local/Programs/Python/Python312/python.exe" -m venv .venv
```

- [ ] **Step 2: Install torch on the known-good CUDA build**

`2.10.0+cu130` is the exact version ComfyUI already runs on this RTX 5070. Do not substitute a different build — `cu121` has no `sm_120` kernels and fails at runtime.

```bash
.venv/Scripts/python.exe -m pip install --upgrade pip
.venv/Scripts/python.exe -m pip install torch==2.10.0+cu130 --index-url https://download.pytorch.org/whl/cu130
```

- [ ] **Step 3: Verify the GPU actually computes**

This is the whole point of the task. `torch.cuda.is_available()` returning `True` is not sufficient evidence — the broken global install returns `True` as well.

```bash
.venv/Scripts/python.exe -c "import torch; x=torch.randn(64,64,device='cuda'); print('GPU OK', (x@x).sum().item())"
```

Expected: `GPU OK <number>`.
If it raises `no kernel image is available for execution on the device`, **stop** — the torch build is wrong. Do not proceed to Step 4.

- [ ] **Step 4: Install faster-whisper and gallery-dl**

```bash
.venv/Scripts/python.exe -m pip install faster-whisper gallery-dl
.venv/Scripts/python.exe -c "import faster_whisper; print('faster-whisper', faster_whisper.__version__)"
.venv/Scripts/gallery-dl.exe --version
```

- [ ] **Step 5: Ignore the venv**

Append to `.gitignore`:

```
.venv/
server/node_modules/
server/data/
```

- [ ] **Step 6: Log the installs**

Append to `C:\Users\arunk\INSTALLED.md`:

```markdown
## 2026-09-08 — social-saver-pro-v2 local archive

Project venv at `MyProjects\social-saver-pro-v2\.venv` (pip):
- `torch==2.10.0+cu130` — global torch is cu121 and has no sm_120 kernels, so it
  cannot run on the RTX 5070. Installed per-project rather than upgrading global
  to avoid disturbing recipe-app (torch cpu build) and ComfyUI (already cu130).
- `faster-whisper` — GPU transcription of saved Reels and video tweets.
- `gallery-dl` — Instagram image posts and carousels; yt-dlp handles these poorly.
```

- [ ] **Step 7: Commit**

```bash
git add .gitignore
git commit -m "chore: ignore project venv and server working directories"
```

---

## Task 1: Server scaffold and health endpoint

**Model:** Sonnet

**Files:**
- Create: `server/package.json`, `server/src/config.js`, `server/src/server.js`, `server/src/routes/health.js`
- Test: `server/test/health.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `createServer(deps) -> http.Server` from `src/server.js`. `deps` is `{ db, config }`; both may be `null` for tests that only exercise routing.
  - `CONFIG` object from `src/config.js` with keys `PORT` (number, 8787), `HOST` (string, `127.0.0.1`), `DATA_DIR`, `MEDIA_DIR`, `DB_PATH`, `COOKIES_PATH`.

- [ ] **Step 1: Initialise the package**

```bash
mkdir -p server/src/routes server/test
cd server && npm init -y && npm install sqlite-vec
```

Then set `"type": "module"` in `server/package.json` and replace the `scripts` block:

```json
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  }
```

- [ ] **Step 2: Write the failing test**

Create `server/test/health.test.js`:

```js
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
```

- [ ] **Step 3: Run it and watch it fail**

Run: `cd server && node --test test/health.test.js`
Expected: FAIL — `Cannot find module '../src/server.js'`.

- [ ] **Step 4: Write the config module**

Create `server/src/config.js`:

```js
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const CONFIG = {
  HOST: '127.0.0.1',
  PORT: 8787,
  DATA_DIR: path.join(root, 'data'),
  MEDIA_DIR: path.join(root, 'data', 'media'),
  DB_PATH: path.join(root, 'data', 'archive.db'),
  COOKIES_PATH: path.join(root, 'data', 'cookies.txt'),
};
```

- [ ] **Step 5: Write the health route**

Create `server/src/routes/health.js`:

```js
export function health(req, res) {
  send(res, 200, { ok: true, version: '1.0.0' });
}

export function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return null;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
```

- [ ] **Step 6: Write the server**

Create `server/src/server.js`:

```js
import http from 'node:http';
import { CONFIG } from './config.js';
import { health, send } from './routes/health.js';

export function createServer(deps) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') return health(req, res);
      return send(res, 404, { error: 'not_found' });
    } catch (err) {
      console.error('[server]', err);
      return send(res, 500, { error: 'internal', detail: String(err.message) });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer({ db: null, config: CONFIG })
    .listen(CONFIG.PORT, CONFIG.HOST, () =>
      console.log(`[server] listening on http://${CONFIG.HOST}:${CONFIG.PORT}`));
}
```

- [ ] **Step 7: Run the tests**

Run: `cd server && node --test test/health.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 8: Commit**

```bash
git add server/package.json server/package-lock.json server/src server/test
git commit -m "feat(server): scaffold local ingest server with health endpoint"
```

---

## Task 2: Netscape cookie serializer

**Model:** Sonnet

**Files:**
- Create: `server/src/cookies/netscape.js`
- Test: `server/test/netscape.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `toNetscape(cookies) -> string`, where `cookies` is an array of Chrome `chrome.cookies.Cookie` objects: `{ domain, path, secure, expirationDate, name, value, hostOnly }`.

A pure function, tested in isolation, because it is the piece most likely to be subtly wrong — yt-dlp rejects a malformed cookie file with an unhelpful error.

- [ ] **Step 1: Write the failing test**

Create `server/test/netscape.test.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/netscape.test.js`
Expected: FAIL — `Cannot find module '../src/cookies/netscape.js'`.

- [ ] **Step 3: Implement**

Create `server/src/cookies/netscape.js`:

```js
/**
 * Serialize chrome.cookies.Cookie objects into a Netscape cookie file.
 * yt-dlp and gallery-dl both read this format via --cookies.
 */
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    for (const field of [c.domain, c.path, c.name, c.value]) {
      if (typeof field === 'string' && field.includes('\t')) {
        throw new Error(`Cookie field contains a tab, which would corrupt the file: ${c.name}`);
      }
    }
    const includeSubdomains = c.hostOnly ? 'FALSE' : 'TRUE';
    const domain = c.hostOnly || c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    lines.push([
      domain,
      includeSubdomains,
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate ?? 0),
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test test/netscape.test.js`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/cookies/netscape.js server/test/netscape.test.js
git commit -m "feat(server): serialize Chrome cookies to Netscape format"
```

---

## Task 3: Cookie endpoint and extension cookie export

**Model:** Sonnet

**Files:**
- Create: `server/src/routes/cookies.js`
- Modify: `server/src/server.js`
- Modify: `manifest.json`
- Modify: `background.js` (add handler near the listener at `background.js:568`)
- Test: `server/test/cookies.test.js`

**Interfaces:**
- Consumes: `toNetscape` (Task 2); `send`, `readJson` (Task 1).
- Produces:
  - `POST /cookies` accepting `{ cookies: [...] }`, writing `CONFIG.COOKIES_PATH`, returning `{ ok: true, count: <number>, path: <string> }`.
  - `exportInstagramCookies() -> Promise<{ok: boolean, count?: number, error?: string}>` in `background.js`.

This is deliberately the **first** capability built, because it is the project's largest unproven assumption. Task 4 gates on it.

- [ ] **Step 1: Write the failing test**

Create `server/test/cookies.test.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/cookies.test.js`
Expected: FAIL — 404 returned instead of 200, because the route does not exist.

- [ ] **Step 3: Implement the route**

Create `server/src/routes/cookies.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { send, readJson } from './health.js';
import { toNetscape } from '../cookies/netscape.js';

export async function postCookies(req, res, { config }) {
  const body = await readJson(req);
  const cookies = body?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return send(res, 400, { error: 'no_cookies' });
  }
  fs.mkdirSync(path.dirname(config.COOKIES_PATH), { recursive: true });
  fs.writeFileSync(config.COOKIES_PATH, toNetscape(cookies), { encoding: 'utf8', mode: 0o600 });
  return send(res, 200, { ok: true, count: cookies.length, path: config.COOKIES_PATH });
}
```

The `0o600` mode matters: this file holds a live session token.

- [ ] **Step 4: Register the route**

In `server/src/server.js`, add the import and the branch before the 404:

```js
import { postCookies } from './routes/cookies.js';
```

```js
      if (req.method === 'POST' && url.pathname === '/cookies') {
        return await postCookies(req, res, deps);
      }
```

- [ ] **Step 5: Run the tests**

Run: `cd server && node --test test/cookies.test.js`
Expected: PASS, 2 tests.

- [ ] **Step 6: Grant the extension cookie and localhost access**

In `manifest.json`, add `"cookies"` to `permissions`, and add two entries to `host_permissions`:

```json
  "permissions": [
    "activeTab", "scripting", "storage", "alarms",
    "notifications", "tabs", "downloads", "offscreen", "cookies"
  ],
  "host_permissions": [
    "https://x.com/*",
    "https://twitter.com/*",
    "https://pbs.twimg.com/*",
    "https://*.instagram.com/*",
    "http://127.0.0.1:8787/*"
  ],
```

The `http://127.0.0.1:8787/*` entry is required — an MV3 service worker cannot `fetch` localhost without it. `downloads` and `offscreen` are removed later, in Task 10.

- [ ] **Step 7: Export cookies from the extension**

In `background.js`, add above the `chrome.runtime.onMessage.addListener` block at line 568:

```js
const SERVER_BASE = "http://127.0.0.1:8787";

async function exportInstagramCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "instagram.com" });
    if (!cookies.length) {
      return { ok: false, error: "No Instagram cookies found — log in to Instagram in Chrome first." };
    }
    const res = await fetch(`${SERVER_BASE}/cookies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies }),
    });
    if (!res.ok) return { ok: false, error: `Server returned ${res.status}` };
    const body = await res.json();
    console.log(`[SSP] exported ${body.count} Instagram cookies`);
    return { ok: true, count: body.count };
  } catch (err) {
    return { ok: false, error: `Server unreachable: ${err.message}` };
  }
}
```

Then register it inside the existing listener, alongside the `manualSync` branch:

```js
  if (msg.action === "exportCookies") {
    exportInstagramCookies().then(sendResponse);
    return true;
  }
```

- [ ] **Step 8: Commit**

```bash
git add server/src/routes/cookies.js server/src/server.js server/test/cookies.test.js manifest.json background.js
git commit -m "feat: export Instagram cookies from extension to local server"
```

---

## Task 4: Verification gate — real Instagram retrieval

**Model:** Haiku

**Files:** none. This task writes no code.

**Interfaces:**
- Consumes: `POST /cookies` and `exportInstagramCookies` (Task 3).
- Produces: a yes/no answer that the rest of the Instagram path depends on.

Spike B proved yt-dlp parses a cookie file and reaches Instagram's API. It did **not** prove that a real exported session retrieves a real saved post. Everything downstream assumes it does. Find out now, while the only sunk cost is three tasks.

- [ ] **Step 1: Start the server**

```bash
cd server && npm start
```

Leave it running.

- [ ] **Step 2: Load the extension and export cookies**

1. Open `chrome://extensions`, enable Developer mode, **Load unpacked**, select the repo root.
2. Confirm Chrome is logged in to Instagram.
3. From the extension's service worker console (`chrome://extensions` → *service worker*), run:

```js
chrome.runtime.sendMessage({ action: "exportCookies" }, console.log)
```

Expected: `{ ok: true, count: <n> }` with `n` greater than zero.

- [ ] **Step 3: Confirm the file landed**

```bash
head -3 server/data/cookies.txt
```

Expected: the Netscape header, then tab-separated cookie lines including `sessionid`.

- [ ] **Step 4: Retrieve a real saved Reel**

Open a saved **video** post on Instagram, copy its URL, then:

```bash
yt-dlp --cookies server/data/cookies.txt --simulate --print "%(id)s %(title)s" "<REEL_URL>"
```

Expected: an id and title. **Any authentication error means the gate has failed.**

- [ ] **Step 5: Retrieve a real saved image post**

Open a saved **image** post, copy its URL, then:

```bash
.venv/Scripts/gallery-dl.exe --cookies server/data/cookies.txt --simulate "<IMAGE_POST_URL>"
```

Expected: one or more resolvable image URLs.

- [ ] **Step 6: Record the outcome**

**If both succeeded:** append to the spec's *Risks and spikes* section, replacing the residual paragraph:

```markdown
**Spike B residual closed (date):** a real exported Chrome session retrieved
both a saved Reel (yt-dlp) and a saved image post (gallery-dl). The Instagram
media path is proven end to end.
```

Commit: `git commit -am "docs: close Spike B residual — real Instagram retrieval verified"`

**If either failed: stop and report.** Do not continue to Task 5. Capture the exact error and check, in order:
1. Does `cookies.txt` contain `sessionid` with a non-empty value?
2. Does the same URL open in a normal Chrome tab while logged in?
3. Does yt-dlp report a rate limit or a checkpoint rather than an auth failure? A checkpoint means the account needs attention in the Instagram UI first.

The fallback if exported cookies genuinely do not authenticate is to drop the automated media path and store Instagram as text plus permalink only — a smaller product, and one the user should decide on rather than have chosen for them.

---

## Task 5: Database module and schema

**Model:** Sonnet

**Files:**
- Create: `server/src/schema.sql`, `server/src/db.js`
- Test: `server/test/db.test.js`

**Interfaces:**
- Consumes: `CONFIG` (Task 1).
- Produces: `openDb(dbPath) -> DatabaseSync` — migrated, `sqlite-vec` loaded, WAL enabled, foreign keys on.

- [ ] **Step 1: Write the failing test**

Create `server/test/db.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-db-'));
  return { dir, file: path.join(dir, 'archive.db') };
}

test('sqlite-vec loads and vec0 tables accept 768-dim vectors', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    const v = db.prepare('select vec_version() as v').get();
    assert.match(v.v, /^v\d+\.\d+\.\d+/);

    const embedding = new Float32Array(768).fill(0.1);
    db.prepare('INSERT INTO vec_chunks(chunk_id, embedding) VALUES (?, ?)')
      .run(1n, new Uint8Array(embedding.buffer));

    const rows = db.prepare(
      'SELECT chunk_id FROM vec_chunks WHERE embedding MATCH ? ORDER BY distance LIMIT 1'
    ).all(new Uint8Array(embedding.buffer));
    assert.equal(Number(rows[0].chunk_id), 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('items enforces the platform constraint', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    assert.throws(() => db.prepare(
      "INSERT INTO items(platform, kind, url) VALUES ('myspace','post','u')").run());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('items defaults state to pending and url is unique', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO items(platform, kind, url) VALUES ('twitter','tweet','https://x.com/a/status/1')").run();
    const row = db.prepare("SELECT state, action_status FROM items WHERE url = ?")
      .get('https://x.com/a/status/1');
    assert.equal(row.state, 'pending');
    assert.equal(row.action_status, 'pending');
    assert.throws(() => db.prepare(
      "INSERT INTO items(platform, kind, url) VALUES ('twitter','tweet','https://x.com/a/status/1')").run());
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deleting an item cascades to its media rows', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO items(platform, kind, url) VALUES ('instagram','reel','https://instagram.com/p/x/')").run();
    const id = db.prepare("SELECT id FROM items WHERE url = ?").get('https://instagram.com/p/x/').id;
    db.prepare("INSERT INTO media(item_id, kind, path) VALUES (?, 'video', 'a.mp4')").run(id);
    db.prepare("DELETE FROM items WHERE id = ?").run(id);
    assert.equal(db.prepare("SELECT count(*) c FROM media").get().c, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('full-text search finds an item through the FTS triggers', () => {
  const { dir, file } = tmpDb();
  const db = openDb(file);
  try {
    db.prepare("INSERT INTO items(platform,kind,url,caption) VALUES ('twitter','tweet','u1','vector databases are useful')").run();
    assert.equal(db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'vector'").all().length, 1);

    db.prepare("UPDATE items SET caption = 'something else entirely' WHERE url = 'u1'").run();
    assert.equal(db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'vector'").all().length, 0);

    db.prepare("DELETE FROM items WHERE url = 'u1'").run();
    assert.equal(db.prepare(
      "SELECT rowid FROM items_fts WHERE items_fts MATCH 'entirely'").all().length, 0);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openDb is idempotent across reopens', () => {
  const { dir, file } = tmpDb();
  let db = openDb(file);
  db.prepare("INSERT INTO items(platform, kind, url) VALUES ('twitter','tweet','u1')").run();
  db.close();
  db = openDb(file);
  try {
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/db.test.js`
Expected: FAIL — `Cannot find module '../src/db.js'`.

- [ ] **Step 3: Write the schema**

Create `server/src/schema.sql`. This is the spec's *Data model* DDL with
`IF NOT EXISTS` added throughout, plus indexes and the FTS5 synchronisation
triggers:

```sql
CREATE TABLE IF NOT EXISTS items (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('twitter','instagram')),
  kind          TEXT NOT NULL,
  url           TEXT NOT NULL UNIQUE,
  external_id   TEXT,
  author        TEXT DEFAULT '',
  author_handle TEXT DEFAULT '',
  title         TEXT DEFAULT '',
  caption            TEXT DEFAULT '',
  transcript         TEXT DEFAULT '',
  visual_description TEXT DEFAULT '',
  document           TEXT DEFAULT '',
  category      TEXT,
  subcategory   TEXT,
  summary       TEXT,
  action_item   TEXT,
  action_status TEXT DEFAULT 'pending'
                CHECK (action_status IN ('pending','done','skipped')),
  key_insights  TEXT,
  state         TEXT NOT NULL DEFAULT 'pending',
  state_error   TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  pdf_path      TEXT,
  source_date   TEXT,
  saved_at      TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media (
  id         INTEGER PRIMARY KEY,
  item_id    INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  path       TEXT NOT NULL,
  bytes      INTEGER,
  width      INTEGER,
  height     INTEGER,
  duration_s REAL,
  sha256     TEXT,
  downloader TEXT
);

CREATE TABLE IF NOT EXISTS chunks (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  ord     INTEGER NOT NULL,
  text    TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding FLOAT[768]
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title, caption, transcript, visual_description,
  content='items', content_rowid='id'
);

CREATE TABLE IF NOT EXISTS job_runs (
  id      INTEGER PRIMARY KEY,
  item_id INTEGER REFERENCES items(id) ON DELETE CASCADE,
  stage   TEXT NOT NULL,
  status  TEXT NOT NULL,
  error   TEXT,
  ms      INTEGER,
  ran_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

-- items_fts is an external-content table: it stores no text of its own and
-- must be told about every write, or search silently returns nothing.
CREATE TRIGGER IF NOT EXISTS items_fts_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, caption, transcript, visual_description)
  VALUES (new.id, new.title, new.caption, new.transcript, new.visual_description);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, caption, transcript, visual_description)
  VALUES ('delete', old.id, old.title, old.caption, old.transcript, old.visual_description);
END;

CREATE TRIGGER IF NOT EXISTS items_fts_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, caption, transcript, visual_description)
  VALUES ('delete', old.id, old.title, old.caption, old.transcript, old.visual_description);
  INSERT INTO items_fts(rowid, title, caption, transcript, visual_description)
  VALUES (new.id, new.title, new.caption, new.transcript, new.visual_description);
END;
```

Then append these indexes:

```sql
CREATE INDEX IF NOT EXISTS idx_items_state    ON items(state);
CREATE INDEX IF NOT EXISTS idx_items_platform ON items(platform);
CREATE INDEX IF NOT EXISTS idx_items_saved_at ON items(saved_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_action   ON items(action_status);
CREATE INDEX IF NOT EXISTS idx_media_item     ON media(item_id);
CREATE INDEX IF NOT EXISTS idx_chunks_item    ON chunks(item_id);
```

Every `CREATE TABLE` gets `IF NOT EXISTS`; the two virtual tables are `CREATE VIRTUAL TABLE IF NOT EXISTS`. That is what makes Step 1's reopen test pass.

- [ ] **Step 4: Implement the module**

Create `server/src/db.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { allowExtension: true });
  db.enableLoadExtension(true);
  sqliteVec.load(db);
  db.enableLoadExtension(false);

  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}
```

`enableLoadExtension(false)` immediately after loading closes the window in which arbitrary extensions could be loaded.

- [ ] **Step 5: Run the tests**

Run: `cd server && node --test test/db.test.js`
Expected: PASS, 6 tests.

If the vector test fails with `Only integers are allowed for primary key values`, the `1n` BigInt literal was dropped — see Global Constraints.

- [ ] **Step 6: Commit**

```bash
git add server/src/schema.sql server/src/db.js server/test/db.test.js
git commit -m "feat(server): SQLite schema with FTS5 and sqlite-vec vectors"
```

---

## Task 6: Ingest and dedup endpoints

**Model:** Sonnet

**Files:**
- Create: `server/src/routes/ingest.js`
- Modify: `server/src/server.js`
- Test: `server/test/ingest.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 5); `send`, `readJson` (Task 1).
- Produces:
  - `POST /ingest` accepting `{ items: [ItemInput] }` → `{ ok: true, inserted, updated, skipped }`.
  - `POST /known-urls` accepting `{ urls: [string] }` → `{ known: [string] }`.
  - `ItemInput` = `{ platform, kind, url, externalId?, author?, authorHandle?, title?, caption?, sourceDate?, mediaUrls?: string[] }`.

The upsert rule is carried over from the existing `saveContent` at `background.js:116` — a type upgrade wins, otherwise longer text wins — so re-saving never degrades a record.

- [ ] **Step 1: Write the failing test**

Create `server/test/ingest.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ing-'));
  const db = openDb(path.join(dir, 'archive.db'));
  const server = createServer({ db, config: { COOKIES_PATH: path.join(dir, 'c.txt') } });
  return { dir, db, server };
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
}).then((r) => r.json());

test('ingest inserts new items', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'hello' },
      { platform: 'instagram', kind: 'reel', url: 'https://instagram.com/p/z/', caption: 'reel' },
    ]});
    assert.equal(out.inserted, 2);
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 2);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('re-ingesting identical content is skipped, not duplicated', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const item = { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'hello' };
    await post(base, '/ingest', { items: [item] });
    const out = await post(base, '/ingest', { items: [item] });
    assert.equal(out.skipped, 1);
    assert.equal(out.updated, 0);
    assert.equal(db.prepare('SELECT count(*) c FROM items').get().c, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a thread upgrade overwrites a tweet', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'short' }]});
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'thread', url: 'https://x.com/a/status/1', caption: 'hi' }]});
    assert.equal(out.updated, 1);
    assert.equal(db.prepare('SELECT kind FROM items WHERE url = ?')
      .get('https://x.com/a/status/1').kind, 'thread');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('longer caption wins for the same kind', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'short' }]});
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'a much longer caption' }]});
    assert.equal(db.prepare('SELECT caption FROM items WHERE url = ?')
      .get('https://x.com/a/status/1').caption, 'a much longer caption');
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('media urls are recorded as pending media rows', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [{
      platform: 'instagram', kind: 'post', url: 'https://instagram.com/p/q/',
      caption: 'x', mediaUrls: ['https://cdn/1.jpg', 'https://cdn/2.jpg'] }]});
    assert.equal(db.prepare('SELECT count(*) c FROM media').get().c, 2);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an item missing a url is rejected without aborting the batch', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    const out = await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet' },
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/2', caption: 'ok' },
    ]});
    assert.equal(out.inserted, 1);
    assert.equal(out.rejected, 1);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('known-urls returns only urls already stored', async () => {
  const { dir, db, server } = harness();
  const base = await listen(server);
  try {
    await post(base, '/ingest', { items: [
      { platform: 'twitter', kind: 'tweet', url: 'https://x.com/a/status/1', caption: 'x' }]});
    const out = await post(base, '/known-urls', {
      urls: ['https://x.com/a/status/1', 'https://x.com/a/status/999'] });
    assert.deepEqual(out.known, ['https://x.com/a/status/1']);
  } finally { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/ingest.test.js`
Expected: FAIL — every request 404s.

- [ ] **Step 3: Implement the routes**

Create `server/src/routes/ingest.js`:

```js
import { send, readJson } from './health.js';

const VALID_PLATFORMS = new Set(['twitter', 'instagram']);

export async function postIngest(req, res, { db }) {
  const body = await readJson(req);
  const items = Array.isArray(body?.items) ? body.items : null;
  if (!items) return send(res, 400, { error: 'no_items' });

  let inserted = 0, updated = 0, skipped = 0, rejected = 0;

  const findByUrl = db.prepare('SELECT id, kind, caption FROM items WHERE url = ?');
  const insertItem = db.prepare(`
    INSERT INTO items (platform, kind, url, external_id, author, author_handle,
                       title, caption, source_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const updateItem = db.prepare(`
    UPDATE items SET kind = ?, title = ?, author = ?, author_handle = ?,
                     caption = ?, source_date = ?, state = 'pending',
                     updated_at = datetime('now')
    WHERE id = ?`);
  const insertMedia = db.prepare(
    'INSERT INTO media (item_id, kind, path) VALUES (?, ?, ?)');

  for (const it of items) {
    if (!it?.url || !VALID_PLATFORMS.has(it.platform) || !it.kind) { rejected++; continue; }

    const existing = findByUrl.get(it.url);
    const caption = it.caption ?? '';

    if (!existing) {
      insertItem.run(it.platform, it.kind, it.url, it.externalId ?? null,
        it.author ?? '', it.authorHandle ?? '', it.title ?? '', caption, it.sourceDate ?? null);
      const id = findByUrl.get(it.url).id;
      for (const url of it.mediaUrls ?? []) insertMedia.run(id, 'image', url);
      inserted++;
      continue;
    }

    const isUpgrade = it.kind === 'thread' && existing.kind === 'tweet';
    const isLonger = caption.length > (existing.caption ?? '').length;
    if (isUpgrade || isLonger) {
      updateItem.run(it.kind, it.title ?? '', it.author ?? '', it.authorHandle ?? '',
        caption, it.sourceDate ?? null, existing.id);
      updated++;
    } else {
      skipped++;
    }
  }

  return send(res, 200, { ok: true, inserted, updated, skipped, rejected });
}

export async function postKnownUrls(req, res, { db }) {
  const body = await readJson(req);
  const urls = Array.isArray(body?.urls) ? body.urls : null;
  if (!urls) return send(res, 400, { error: 'no_urls' });
  if (urls.length === 0) return send(res, 200, { known: [] });

  const placeholders = urls.map(() => '?').join(',');
  const rows = db.prepare(`SELECT url FROM items WHERE url IN (${placeholders})`).all(...urls);
  return send(res, 200, { known: rows.map((r) => r.url) });
}
```

`media.path` holds the source URL until the media stage (Task 13) replaces it with a local path — that is what makes an unresolved download visible rather than lost.

- [ ] **Step 4: Register the routes**

In `server/src/server.js`:

```js
import { postIngest, postKnownUrls } from './routes/ingest.js';
```

```js
      if (req.method === 'POST' && url.pathname === '/ingest') {
        return await postIngest(req, res, deps);
      }
      if (req.method === 'POST' && url.pathname === '/known-urls') {
        return await postKnownUrls(req, res, deps);
      }
```

- [ ] **Step 5: Wire the real database into the entry point**

Replace the bottom block of `server/src/server.js`:

```js
if (import.meta.url === `file://${process.argv[1]}`) {
  const { openDb } = await import('./db.js');
  const db = openDb(CONFIG.DB_PATH);
  createServer({ db, config: CONFIG })
    .listen(CONFIG.PORT, CONFIG.HOST, () =>
      console.log(`[server] listening on http://${CONFIG.HOST}:${CONFIG.PORT}`));
}
```

- [ ] **Step 6: Run the whole suite**

Run: `cd server && node --test test/`
Expected: PASS — 23 tests across five files.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/ingest.js server/src/server.js server/test/ingest.test.js
git commit -m "feat(server): ingest and known-urls endpoints with richness-based upsert"
```

---

## Task 7: Extension API client with offline queue

**Model:** Sonnet

**Files:**
- Create: `api.js`
- Modify: `manifest.json` (add `api.js` to the X content script bundle)
- Test: `server/test/offline-queue.test.js`

**Interfaces:**
- Consumes: `POST /ingest`, `POST /known-urls`, `GET /health` (Tasks 1, 6).
- Produces, on `globalThis.SSPApi`:
  - `ingest(items) -> Promise<{ok, queued?, inserted?, updated?}>`
  - `knownUrls(urls) -> Promise<string[]>` (returns `[]` when the server is down, so a sync degrades to processing everything rather than nothing)
  - `flushQueue() -> Promise<{flushed: number}>`
  - `enqueue(items) -> Promise<void>`

The queue is the reason a save can never fail because Task Scheduler had not yet started the server.

- [ ] **Step 1: Write the failing test for the queue-merge logic**

The pure merge logic is testable in Node; the `chrome.*` surface is not. Create `server/test/offline-queue.test.js`:

```js
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/offline-queue.test.js`
Expected: FAIL — `Cannot find module '../../api.js'`.

- [ ] **Step 3: Implement the client**

Create `api.js` at the repo root:

```js
/**
 * Client for the local ingest server, with an offline queue.
 * Loaded by both the service worker and the content scripts.
 */
const SSP_SERVER = "http://127.0.0.1:8787";
const QUEUE_KEY = "ssp_pending_queue";
const QUEUE_MAX = 500;

/** Pure merge: newest wins per url, oldest dropped past the cap. Exported for tests. */
export function mergeQueue(existing, incoming) {
  const byUrl = new Map(existing.map((i) => [i.url, i]));
  for (const item of incoming) byUrl.set(item.url, item);
  const merged = [...byUrl.values()];
  return merged.length > QUEUE_MAX ? merged.slice(merged.length - QUEUE_MAX) : merged;
}

async function enqueue(items) {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const merged = mergeQueue(stored[QUEUE_KEY] ?? [], items);
  await chrome.storage.local.set({ [QUEUE_KEY]: merged });
}

async function postJson(path, body, timeoutMs = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SSP_SERVER}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`server ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function ingest(items) {
  try {
    const result = await postJson("/ingest", { items });
    return { ok: true, ...result };
  } catch (err) {
    await enqueue(items);
    console.warn("[SSP] server unreachable, queued", items.length, err.message);
    return { ok: true, queued: items.length };
  }
}

async function knownUrls(urls) {
  try {
    return (await postJson("/known-urls", { urls })).known ?? [];
  } catch {
    return [];
  }
}

async function flushQueue() {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  const pending = stored[QUEUE_KEY] ?? [];
  if (pending.length === 0) return { flushed: 0 };
  try {
    await postJson("/ingest", { items: pending });
    await chrome.storage.local.set({ [QUEUE_KEY]: [] });
    console.log(`[SSP] flushed ${pending.length} queued items`);
    return { flushed: pending.length };
  } catch {
    return { flushed: 0 };
  }
}

globalThis.SSPApi = { ingest, knownUrls, flushQueue, enqueue, mergeQueue };
```

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test test/offline-queue.test.js`
Expected: PASS, 3 tests.

- [ ] **Step 5: Do NOT add `api.js` to any content script**

`api.js` uses ESM `export` so its pure logic can be unit-tested. Chrome MV3
content scripts are classic scripts — an `export` statement there is a syntax
error that kills the entire script.

It is only ever imported by the service worker, which `manifest.json` already
declares as `"type": "module"`. No content script needs it: `content.js:584`
and `instagram.js` both reach the server via `chrome.runtime.sendMessage`, and
the service worker holds the only `SSPApi` instance. Leave `content_scripts`
untouched in this task.

- [ ] **Step 6: Commit**

```bash
git add api.js server/test/offline-queue.test.js
git commit -m "feat(extension): local server client with offline queue"
```

---

## Task 8: Repoint saves from Supabase to the local server

**Model:** Sonnet

**Files:**
- Modify: `background.js` (replace `saveContent` at `116-207`; delete `supabaseInsert` `50-71`, `supabaseUpdate` `72-93`, `supabaseSelect` `94-115`, `triggerAIProcessing` `208-229`; rewrite `getStats` `600-627` and `testConnection` `628-`)
- Modify: `manifest.json` (import `api.js` into the service worker)

**Interfaces:**
- Consumes: `globalThis.SSPApi` (Task 7).
- Produces: `saveContent(data) -> {success, message}` with the same shape `content.js:589-597` already branches on — `"Updated"`, `"Already saved"`, or a default success.

The response contract is preserved deliberately: `handleSaveClick` needs no change, so the button behaves exactly as it does today.

- [ ] **Step 1: Import the client into the service worker**

At the top of `background.js`:

```js
import "./api.js";
```

`manifest.json` already declares `"type": "module"` for the service worker, so this works unchanged.

- [ ] **Step 2: Replace `saveContent`**

Delete `background.js:116-207` and put in its place:

```js
async function saveContent(data) {
  const newFullText =
    data.fullText || (data.tweets ? data.tweets.map((t) => t.text).join("\n\n") : "");

  const item = {
    platform: data.platform || "twitter",
    kind: data.type || "tweet",
    url: data.url,
    externalId: data.externalId || null,
    author: data.author || "",
    authorHandle: data.authorHandle || "",
    title: data.title || "",
    caption: newFullText,
    sourceDate: data.date || null,
    mediaUrls: data.images || [],
  };

  const result = await SSPApi.ingest([item]);

  if (result.queued) return { success: true, message: "Queued" };
  if (result.updated > 0) return { success: true, message: "Updated" };
  if (result.skipped > 0) return { success: true, message: "Already saved" };
  if (result.rejected > 0) return { success: false, error: "Server rejected the item" };
  return { success: true, message: "Saved" };
}
```

- [ ] **Step 3: Delete the Supabase layer**

Remove `supabaseInsert`, `supabaseUpdate`, `supabaseSelect`, and `triggerAIProcessing` entirely. Remove `SUPABASE_URL` and `SUPABASE_ANON_KEY` from `loadConfig` (`background.js:22`) and from `isConfigured` (`background.js:42`) — `isConfigured` now returns `true` unconditionally, since there is nothing left to configure.

- [ ] **Step 4: Point stats and the connection test at the server**

Replace `getStats` and `testConnection`:

```js
async function getStats() {
  try {
    const res = await fetch("http://127.0.0.1:8787/health");
    if (!res.ok) throw new Error(`status ${res.status}`);
    const queue = (await chrome.storage.local.get("ssp_pending_queue"))
      .ssp_pending_queue ?? [];
    return { connected: true, pending: queue.length };
  } catch {
    const queue = (await chrome.storage.local.get("ssp_pending_queue"))
      .ssp_pending_queue ?? [];
    return { connected: false, pending: queue.length };
  }
}

async function testConnection() {
  try {
    const res = await fetch("http://127.0.0.1:8787/health");
    if (!res.ok) return { success: false, error: `Server returned ${res.status}` };
    return { success: true, message: "Local server reachable" };
  } catch (err) {
    return { success: false, error: "Local server not running — start it and retry." };
  }
}
```

- [ ] **Step 5: Flush the queue on startup**

Add near `setupSyncAlarm`:

```js
chrome.runtime.onStartup.addListener(() => SSPApi.flushQueue());
chrome.runtime.onInstalled.addListener(() => SSPApi.flushQueue());
```

- [ ] **Step 6: Verify by hand**

1. Start the server: `cd server && npm start`
2. Reload the extension at `chrome://extensions`.
3. Open any tweet, click **Save**. Expect `Saved ✓`.
4. Confirm the row landed:

```bash
node -e "const{openDb}=require('./server/src/db.js')" 2>/dev/null || \
  cd server && node -e "import('./src/db.js').then(async m=>{const d=m.openDb('./data/archive.db');console.log(d.prepare('SELECT platform,kind,url FROM items ORDER BY id DESC LIMIT 3').all())})"
```

5. Stop the server. Save another tweet. Expect `Saved ✓` again (queued).
6. Restart the server, reload the extension, and confirm the queued item appears in `items`.

Step 6 is the offline path from the spec's testing section. Do not skip it — it is the only manual check that the queue actually drains.

- [ ] **Step 7: Commit**

```bash
git add background.js manifest.json
git commit -m "feat(extension): send saves to the local server, remove Supabase client"
```

---

## Task 9: Remove the offscreen PDF machinery

**Model:** Sonnet

**Files:**
- Delete: `offscreen.html`, `offscreen.js`, `libs/jspdf.umd.min.js`
- Modify: `background.js` (delete `hasOffscreenDocument` `230-242`, `ensureOffscreen` `243-263`, `revokeBlob` `264-269`, `downloadPdf` `270-297`, `generateBookmarkPdf` `298-321`)
- Modify: `manifest.json`, `popup.html`, `popup.js`, `config.js`

PDF generation moves server-side in Phase 2, where Node's Unicode-capable libraries fix the emoji and non-Latin loss that jsPDF's WinAnsi fonts cause. Removing it now keeps Phase 1 from carrying two PDF paths.

- [ ] **Step 1: Delete the files**

```bash
git rm offscreen.html offscreen.js libs/jspdf.umd.min.js
```

- [ ] **Step 2: Remove the functions and their call sites**

Delete the five functions listed above from `background.js`, then remove every remaining call to `generateBookmarkPdf` — including the one inside `performBookmarkSync`. Also delete the `savePdfSettings` message branch from the listener if present.

- [ ] **Step 3: Drop the permissions**

In `manifest.json`, remove `"downloads"` and `"offscreen"` from `permissions`, and remove `"https://pbs.twimg.com/*"` from `host_permissions`. Nothing in the extension fetches images any more.

- [ ] **Step 4: Remove the popup controls**

In `popup.html`, delete the "Save a PDF copy of each bookmark" and "Include images in PDFs" checkboxes and their labels. In `popup.js`, delete `syncPdfFieldState` (`88`), `savePdfSettings` (`93`), and the two `addEventListener` registrations at `105-106`.

- [ ] **Step 5: Clean the config**

In `config.js`, delete `PDF_ENABLED`, `PDF_INCLUDE_IMAGES`, and `PDF_FOLDER`, and delete `SUPABASE_URL` and `SUPABASE_ANON_KEY`.

- [ ] **Step 6: Verify nothing dangles**

```bash
grep -rn "jspdf\|offscreen\|PDF_ENABLED\|generateBookmarkPdf\|supabase" \
  --include=*.js --include=*.json --include=*.html . | grep -v node_modules | grep -v docs/
```

Expected: no output. Any hit is a dangling reference — fix it before committing.

- [ ] **Step 7: Reload and smoke-test**

Reload the extension. Confirm no errors in the service worker console, and that saving a tweet still works.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(extension): remove offscreen PDF pipeline and Supabase config"
```

---

## Task 10: Fix the Twitter sync

**Model:** Sonnet

**Files:**
- Modify: `background.js` — `performBookmarkSync` (`399-567`), especially the tab creation at `475`
- Modify: `config.js`

**Interfaces:**
- Consumes: `SSPApi.knownUrls` (Task 7).
- Produces: no new exports. Behavioural change only.

Today every bookmark opens with `active: true`, stealing focus for roughly 3.5 seconds each — about twelve minutes for two hundred bookmarks.

- [ ] **Step 1: Add the tunables**

In `config.js`:

```js
  SYNC_CONCURRENCY: 2,     // bookmark tabs open at once during sync
  SYNC_WINDOW_WIDTH: 1200,
  SYNC_WINDOW_HEIGHT: 900,
```

- [ ] **Step 2: Skip bookmarks already in the database**

In `performBookmarkSync`, immediately after `bookmarkURLs` is built and before `toProcess` is computed, insert:

```js
    // Ask the local server which of these we already have; only open tabs for new ones.
    const alreadyKnown = new Set(await SSPApi.knownUrls(bookmarkURLs.map((b) => b.url)));
    bookmarkURLs = bookmarkURLs.filter((b) => !alreadyKnown.has(b.url));
    console.log(`[SSP] ${alreadyKnown.size} already archived, ${bookmarkURLs.length} to fetch`);
```

Change the `const bookmarkURLs` declaration to `let` so it can be reassigned.

When the server is unreachable `knownUrls` returns `[]`, so the sync degrades to processing everything rather than silently archiving nothing.

- [ ] **Step 3: Open a dedicated unfocused window**

Before the processing loop:

```js
    const syncWindow = await chrome.windows.create({
      url: "about:blank",
      focused: false,
      width: SSP_CONFIG.SYNC_WINDOW_WIDTH,
      height: SSP_CONFIG.SYNC_WINDOW_HEIGHT,
    });
```

Replace `background.js:475`:

```js
        const tab = await chrome.tabs.create({
          url: bm.url,
          active: true,
          windowId: syncWindow.id,
        });
```

`active: true` **within that window** keeps X rendering; the window itself never takes focus. Minimizing instead would throttle timers and leave X half-hydrated — that is why this is an unfocused window rather than a minimized one.

- [ ] **Step 4: Always close the sync window**

Wrap the loop in `try/finally` and close the window in `finally`:

```js
    } finally {
      try { await chrome.windows.remove(syncWindow.id); } catch { /* already closed */ }
    }
```

Without this, an exception mid-sync leaves an orphaned window with an open tab.

- [ ] **Step 5: Process two tabs at a time**

Replace the `for` loop with a small worker pool. Each worker runs the existing per-bookmark body unchanged:

```js
    let cursor = 0;
    let saved = 0, updated = 0, failed = 0;

    async function worker() {
      while (cursor < toProcess.length) {
        const i = cursor++;
        const bm = toProcess[i];
        updateSyncNotification(i + 1, toProcess.length);
        try {
          // Relocate the existing per-bookmark body verbatim from the current
          // background.js loop — the block running from `chrome.tabs.create`
          // through the `saveContent` result handling (originally lines
          // 474-530). Change only the `chrome.tabs.create` call, per Step 3.
          // Do not rewrite the retry logic; it is load-bearing for X hydration.
        } catch (err) {
          console.error(`[SSP] sync failed for ${bm.url}`, err);
          failed++;
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(SSP_CONFIG.SYNC_CONCURRENCY, toProcess.length) }, worker)
    );
```

Keep every `await` inside the body as it is. Concurrency comes from running two workers, not from removing waits — X still needs its render time per tab.

- [ ] **Step 6: Verify by hand**

1. Start the server, reload the extension.
2. Click **Sync Now** in the popup.
3. Confirm: a second window appears **behind** the active one, focus never jumps, and you can keep typing in another app throughout.
4. Run the sync a second time. Confirm the log reports most bookmarks as already archived and only a handful of tabs open.

- [ ] **Step 7: Commit**

```bash
git add background.js config.js
git commit -m "fix(sync): stop stealing focus, skip archived bookmarks, run two tabs at once"
```

---

## Task 11: Instagram saved-grid URL collection

**Model:** Sonnet

**Files:**
- Create: `instagram.js`
- Modify: `manifest.json` (second content script entry)
- Modify: `background.js` (`syncInstagram`, message branch)
- Modify: `popup.html`, `popup.js` (trigger button)

**Interfaces:**
- Consumes: `SSPApi.ingest` (Task 7), `exportInstagramCookies` (Task 3).
- Produces:
  - Content script message `{ action: "collectInstagramSaved" }` → `{ items: ItemInput[] }`.
  - `syncInstagram() -> Promise<{ok, collected, error?}>` in `background.js`.

Manual trigger only, in a visible tab, at human pace. No alarm. Scripted scrolling on a schedule is the pattern Meta action-blocks accounts for; the user watching it run is the safety mechanism.

- [ ] **Step 1: Write the content script**

Create `instagram.js`:

```js
/**
 * Instagram saved-posts collector.
 * Collects permalinks ONLY. No media fetching, no opening individual posts.
 * Media resolution happens server-side via yt-dlp / gallery-dl.
 */
(() => {
  const SCROLL_PAUSE_MIN = 1400;
  const SCROLL_PAUSE_MAX = 2600;
  const MAX_SCROLL_TIME = 180000;
  const IDLE_ROUNDS_BEFORE_STOP = 3;

  const jitter = () =>
    SCROLL_PAUSE_MIN + Math.random() * (SCROLL_PAUSE_MAX - SCROLL_PAUSE_MIN);

  function kindFromHref(href) {
    if (href.includes("/reel/")) return "reel";
    if (href.includes("/p/")) return "post";
    return "post";
  }

  function externalIdFromHref(href) {
    const m = href.match(/\/(?:p|reel)\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  /** Reads whatever the grid currently has mounted. Exported shape matches ItemInput. */
  function collectVisible(accumulator) {
    const links = document.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]');
    for (const a of links) {
      const href = a.href.split("?")[0];
      const externalId = externalIdFromHref(href);
      if (!externalId || accumulator.has(externalId)) continue;
      const img = a.querySelector("img");
      accumulator.set(externalId, {
        platform: "instagram",
        kind: kindFromHref(href),
        url: href,
        externalId,
        caption: img?.alt ?? "",
        title: "",
      });
    }
    return accumulator;
  }

  async function scrollAndCollect() {
    const found = new Map();
    const started = Date.now();
    let idleRounds = 0;

    while (Date.now() - started < MAX_SCROLL_TIME && idleRounds < IDLE_ROUNDS_BEFORE_STOP) {
      const before = found.size;
      collectVisible(found);
      window.scrollBy({ top: window.innerHeight * 0.8, behavior: "smooth" });
      await new Promise((r) => setTimeout(r, jitter()));
      idleRounds = found.size === before ? idleRounds + 1 : 0;
    }
    collectVisible(found);
    return [...found.values()];
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "collectInstagramSaved") {
      scrollAndCollect().then((items) => sendResponse({ items }));
      return true;
    }
  });

  console.log("[SSP] Instagram collector ready");
})();
```

The `Map` keyed by `externalId` is what survives Instagram's DOM virtualization: cards unmount as you scroll past, so anything not accumulated during the pass is gone.

- [ ] **Step 2: Register the content script**

In `manifest.json`, add a second entry to `content_scripts`:

```json
    {
      "matches": ["https://www.instagram.com/*"],
      "js": ["instagram.js"],
      "run_at": "document_idle"
    }
```

`api.js` is deliberately absent — see Task 7, Step 5. This script reaches the
server through the service worker, not directly.

- [ ] **Step 3: Drive the sync from the service worker**

In `background.js`:

```js
async function syncInstagram() {
  const cookieResult = await exportInstagramCookies();
  if (!cookieResult.ok) return { ok: false, error: cookieResult.error };

  const tab = await chrome.tabs.create({
    url: "https://www.instagram.com/saved/all-posts/",
    active: true,
  });
  try {
    await waitForTabLoad(tab.id);
    await new Promise((r) => setTimeout(r, 3000));

    const response = await chrome.tabs.sendMessage(tab.id, {
      action: "collectInstagramSaved",
    });
    const items = response?.items ?? [];
    if (items.length === 0) {
      return { ok: false, error: "No saved posts found — are you logged in?" };
    }

    const result = await SSPApi.ingest(items);
    chrome.notifications.create("ig-sync-done", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Instagram sync complete",
      message: `Collected ${items.length} saved posts`,
    });
    return { ok: true, collected: items.length, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
```

The tab is left open deliberately — the user triggered this and is watching; closing it would hide a checkpoint prompt if Instagram showed one.

Register the branch in the listener:

```js
  if (msg.action === "syncInstagram") {
    syncInstagram().then(sendResponse);
    return true;
  }
```

- [ ] **Step 4: Add the popup trigger**

In `popup.html`, next to the existing sync button:

```html
<button id="igSyncBtn" class="secondary">Sync Instagram</button>
```

In `popup.js`:

```js
const igSyncBtn = document.getElementById("igSyncBtn");
igSyncBtn.addEventListener("click", async () => {
  igSyncBtn.disabled = true;
  igSyncBtn.textContent = "Collecting…";
  const result = await chrome.runtime.sendMessage({ action: "syncInstagram" });
  showFeedback(result.ok ? "success" : "error",
    result.ok ? `Collected ${result.collected} posts` : result.error);
  igSyncBtn.disabled = false;
  igSyncBtn.textContent = "Sync Instagram";
});
```

- [ ] **Step 5: Verify by hand**

1. Start the server, reload the extension.
2. Click **Sync Instagram**. Watch the tab scroll at a human pace.
3. Confirm the notification reports a plausible count.
4. Confirm the rows landed:

```bash
cd server && node -e "import('./src/db.js').then(m=>{const d=m.openDb('./data/archive.db');console.log(d.prepare(\"SELECT kind, count(*) c FROM items WHERE platform='instagram' GROUP BY kind\").all())})"
```

- [ ] **Step 6: Commit**

```bash
git add instagram.js manifest.json background.js popup.html popup.js
git commit -m "feat(instagram): collect saved-post permalinks on manual trigger"
```

---

## Task 12: Media resolver

**Model:** Sonnet

**Files:**
- Create: `server/src/media/ytdlp.js`, `server/src/media/gallerydl.js`, `server/src/media/resolver.js`
- Test: `server/test/resolver.test.js`

**Interfaces:**
- Consumes: `CONFIG.MEDIA_DIR`, `CONFIG.COOKIES_PATH` (Task 1).
- Produces:
  - `chooseDownloader(item) -> 'yt-dlp' | 'gallery-dl'`
  - `downloadItem(item, deps) -> Promise<{ok, files: [{kind, path, bytes}], error?}>`, where `deps` is `{ config, run }` and `run(cmd, args) -> Promise<{code, stdout, stderr}>` is injected so tests never spawn a real process.

- [ ] **Step 1: Write the failing test**

Create `server/test/resolver.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chooseDownloader, downloadItem } from '../src/media/resolver.js';

test('reels and video tweets go to yt-dlp', () => {
  assert.equal(chooseDownloader({ platform: 'instagram', kind: 'reel' }), 'yt-dlp');
  assert.equal(chooseDownloader({ platform: 'twitter', kind: 'tweet' }), 'yt-dlp');
});

test('instagram image posts and carousels go to gallery-dl', () => {
  assert.equal(chooseDownloader({ platform: 'instagram', kind: 'post' }), 'gallery-dl');
  assert.equal(chooseDownloader({ platform: 'instagram', kind: 'carousel' }), 'gallery-dl');
});

test('a successful download reports the files that appeared', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async (cmd, args) => {
    const outDir = args[args.indexOf('-o') + 1];
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(outDir), 'clip.mp4'), 'x'.repeat(100));
    return { code: 0, stdout: '', stderr: '' };
  };
  const out = await downloadItem(
    { id: 7, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/a/' },
    { config, run });
  assert.equal(out.ok, true);
  assert.equal(out.files.length, 1);
  assert.equal(out.files[0].kind, 'video');
  assert.equal(out.files[0].bytes, 100);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a non-zero exit is reported, not thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'HTTP Error 401: Unauthorized' });
  const out = await downloadItem(
    { id: 8, platform: 'instagram', kind: 'reel', url: 'https://instagram.com/reel/b/' },
    { config, run });
  assert.equal(out.ok, false);
  assert.match(out.error, /401/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an expired session is reported as a named error, not a generic failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-med-'));
  const config = { MEDIA_DIR: dir, COOKIES_PATH: path.join(dir, 'c.txt') };
  const run = async () => ({ code: 1, stdout: '', stderr: 'login required to access this content' });
  const out = await downloadItem(
    { id: 9, platform: 'instagram', kind: 'post', url: 'https://instagram.com/p/c/' },
    { config, run });
  assert.equal(out.ok, false);
  assert.equal(out.errorKind, 'auth_expired');
  fs.rmSync(dir, { recursive: true, force: true });
});
```

The last test matters for the spec's error-handling requirement: an expired Instagram cookie must be distinguishable from any other download failure, because its fix is specific.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/resolver.test.js`
Expected: FAIL — `Cannot find module '../src/media/resolver.js'`.

- [ ] **Step 3: Write the process runner**

Create `server/src/media/ytdlp.js`:

```js
import { spawn } from 'node:child_process';

/** Default runner. Injected in tests so no real process is spawned. */
export function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
```

Create `server/src/media/gallerydl.js`:

```js
import path from 'node:path';

/** gallery-dl lives in the project venv, not on the system PATH. */
export function galleryDlPath() {
  return path.resolve(process.cwd(), '..', '.venv', 'Scripts', 'gallery-dl.exe');
}
```

- [ ] **Step 4: Implement the resolver**

Create `server/src/media/resolver.js`:

```js
import fs from 'node:fs';
import path from 'node:path';
import { run as defaultRun } from './ytdlp.js';
import { galleryDlPath } from './gallerydl.js';

const VIDEO_KINDS = new Set(['reel', 'tweet', 'thread', 'article']);
const AUTH_PATTERNS = [/login required/i, /rate.?limit/i, /checkpoint/i, /challenge_required/i];

export function chooseDownloader(item) {
  if (item.platform === 'instagram' && !VIDEO_KINDS.has(item.kind)) return 'gallery-dl';
  return 'yt-dlp';
}

function classifyKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (['.mp4', '.mkv', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.m4a', '.mp3', '.wav', '.opus'].includes(ext)) return 'audio';
  return 'image';
}

export async function downloadItem(item, { config, run = defaultRun }) {
  const itemDir = path.join(config.MEDIA_DIR, String(item.id));
  fs.mkdirSync(itemDir, { recursive: true });

  const downloader = chooseDownloader(item);
  const outTemplate = path.join(itemDir, '%(id)s.%(ext)s');

  const args = downloader === 'yt-dlp'
    ? ['--cookies', config.COOKIES_PATH, '--no-warnings', '-o', outTemplate, item.url]
    : ['--cookies', config.COOKIES_PATH, '-D', itemDir, item.url];

  const cmd = downloader === 'yt-dlp' ? 'yt-dlp' : galleryDlPath();
  const { code, stderr } = await run(cmd, args);

  if (code !== 0) {
    const errorKind = AUTH_PATTERNS.some((re) => re.test(stderr)) ? 'auth_expired' : 'download_failed';
    return { ok: false, files: [], error: stderr.trim().slice(0, 500), errorKind };
  }

  const files = fs.readdirSync(itemDir).map((name) => {
    const full = path.join(itemDir, name);
    return { kind: classifyKind(name), path: full, bytes: fs.statSync(full).size };
  });

  if (files.length === 0) {
    return { ok: false, files: [], error: 'downloader exited 0 but produced no files',
             errorKind: 'download_failed' };
  }
  return { ok: true, files };
}
```

- [ ] **Step 5: Run the tests**

Run: `cd server && node --test test/resolver.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add server/src/media server/test/resolver.test.js
git commit -m "feat(server): media resolver dispatching to yt-dlp or gallery-dl"
```

---

## Task 13: Media stage worker

**Model:** Sonnet

**Files:**
- Create: `server/src/worker/media-stage.js`
- Modify: `server/src/server.js`
- Test: `server/test/media-stage.test.js`

**Interfaces:**
- Consumes: `openDb` (Task 5), `downloadItem` (Task 12).
- Produces: `runMediaStage(db, { config, run, limit }) -> Promise<{processed, succeeded, failed}>`, advancing rows from `pending` to `media` or `failed`.

Resumability is the requirement being implemented here: a crash at item 340 of 500 must resume at 340.

- [ ] **Step 1: Write the failing test**

Create `server/test/media-stage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { runMediaStage } from '../src/worker/media-stage.js';

function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssp-ws-'));
  const db = openDb(path.join(dir, 'archive.db'));
  return { dir, db, config: { MEDIA_DIR: path.join(dir, 'media'),
                              COOKIES_PATH: path.join(dir, 'c.txt') } };
}

const okRun = (dir) => async (cmd, args) => {
  const out = args[args.indexOf('-o') + 1];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(out), 'a.mp4'), 'xyz');
  return { code: 0, stdout: '', stderr: '' };
};

test('pending items advance to media and record their files', async () => {
  const { dir, db, config } = harness();
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    const out = await runMediaStage(db, { config, run: okRun(dir), limit: 10 });
    assert.equal(out.succeeded, 1);
    assert.equal(db.prepare('SELECT state FROM items WHERE id = 1').get().state, 'media');
    assert.equal(db.prepare("SELECT count(*) c FROM media WHERE kind='video'").get().c, 1);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('already-processed items are not reprocessed', async () => {
  const { dir, db, config } = harness();
  try {
    db.prepare("INSERT INTO items(platform,kind,url,state) VALUES ('instagram','reel','https://ig/r/1','media')").run();
    const out = await runMediaStage(db, { config, run: okRun(dir), limit: 10 });
    assert.equal(out.processed, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a failure increments attempts and records the error', async () => {
  const { dir, db, config } = harness();
  const failRun = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    await runMediaStage(db, { config, run: failRun, limit: 10 });
    const row = db.prepare('SELECT state, attempts, state_error FROM items WHERE id = 1').get();
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 1);
    assert.match(row.state_error, /boom/);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an item parks in failed after three attempts', async () => {
  const { dir, db, config } = harness();
  const failRun = async () => ({ code: 1, stdout: '', stderr: 'boom' });
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    for (let i = 0; i < 3; i++) await runMediaStage(db, { config, run: failRun, limit: 10 });
    const row = db.prepare('SELECT state, attempts FROM items WHERE id = 1').get();
    assert.equal(row.state, 'failed');
    assert.equal(row.attempts, 3);
    const again = await runMediaStage(db, { config, run: failRun, limit: 10 });
    assert.equal(again.processed, 0);
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every attempt is logged to job_runs', async () => {
  const { dir, db, config } = harness();
  try {
    db.prepare("INSERT INTO items(platform,kind,url) VALUES ('instagram','reel','https://ig/r/1')").run();
    await runMediaStage(db, { config, run: okRun(dir), limit: 10 });
    const row = db.prepare("SELECT stage, status FROM job_runs WHERE item_id = 1").get();
    assert.equal(row.stage, 'media');
    assert.equal(row.status, 'ok');
  } finally { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd server && node --test test/media-stage.test.js`
Expected: FAIL — `Cannot find module '../src/worker/media-stage.js'`.

- [ ] **Step 3: Implement the stage**

Create `server/src/worker/media-stage.js`:

```js
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
      markFail.run(result.error ?? 'unknown', MAX_ATTEMPTS, item.id);
      logRun.run(item.id, 'media', 'error', `${result.errorKind}: ${result.error}`, ms);
      failed++;
    }
  }

  return { processed: pending.length, succeeded, failed };
}
```

`clearMedia` before re-inserting is what makes a retry idempotent — without it a second attempt doubles the rows.

- [ ] **Step 4: Run the tests**

Run: `cd server && node --test test/media-stage.test.js`
Expected: PASS, 5 tests.

- [ ] **Step 5: Drain the stage periodically**

In `server/src/server.js`, inside the entry-point block:

```js
  const { runMediaStage } = await import('./worker/media-stage.js');
  let draining = false;
  setInterval(async () => {
    if (draining) return;
    draining = true;
    try {
      const out = await runMediaStage(db, { config: CONFIG, limit: 5 });
      if (out.processed) console.log('[media]', out);
    } catch (err) {
      console.error('[media] stage error', err);
    } finally {
      draining = false;
    }
  }, 30000).unref();
```

The `draining` flag prevents overlapping runs; `unref()` keeps the timer from holding the process open on shutdown.

- [ ] **Step 6: Verify end to end**

1. Restart the server.
2. Run an Instagram sync from the popup.
3. Within a minute or two, confirm files land:

```bash
ls -R server/data/media | head -20
cd server && node -e "import('./src/db.js').then(m=>{const d=m.openDb('./data/archive.db');console.log(d.prepare('SELECT state, count(*) c FROM items GROUP BY state').all())})"
```

Expected: items moving from `pending` to `media`, with real files on disk.

- [ ] **Step 7: Commit**

```bash
git add server/src/worker server/src/server.js server/test/media-stage.test.js
git commit -m "feat(server): resumable media stage with attempt limits and job logging"
```

---

## Task 14: Auto-start at logon

**Model:** Haiku

**Files:**
- Create: `server/bin/start.cmd`, `server/bin/install-task.ps1`

**Interfaces:**
- Consumes: `server/src/server.js` (Task 6), `lms` CLI.
- Produces: a Windows scheduled task named `SocialSaverArchive` running at logon.

- [ ] **Step 1: Write the launcher**

Create `server/bin/start.cmd`:

```bat
@echo off
REM Starts LM Studio's headless API and the ingest server.
REM LM Studio is optional in Phase 1 — ingest, media download, and
REM transcription all work without it.
start "" /B "%USERPROFILE%\.lmstudio\bin\lms.exe" server start
cd /d "%~dp0\.."
node src\server.js
```

- [ ] **Step 2: Write the installer**

Create `server/bin/install-task.ps1`:

```powershell
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'start.cmd'
$action    = New-ScheduledTaskAction -Execute $script
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'SocialSaverArchive' -Action $action `
    -Trigger $trigger -Settings $settings -Description 'Local social archive ingest server' -Force
Write-Output 'Registered scheduled task: SocialSaverArchive'
```

`-ExecutionTimeLimit ([TimeSpan]::Zero)` means no time limit. Without it Windows kills the server after three days.

- [ ] **Step 3: Install and verify**

```powershell
powershell -ExecutionPolicy Bypass -File server\bin\install-task.ps1
Get-ScheduledTask -TaskName 'SocialSaverArchive' | Select-Object TaskName, State
```

- [ ] **Step 4: Prove it survives a logon**

Sign out and back in, then:

```bash
curl -s http://127.0.0.1:8787/health
```

Expected: `{"ok":true,"version":"1.0.0"}` with nothing started by hand.

- [ ] **Step 5: Commit**

```bash
git add server/bin
git commit -m "feat(ops): start the archive server at logon via Task Scheduler"
```

---

## Task 15: Update the README

**Model:** Haiku

**Files:**
- Modify: `README.md`

The README currently documents Supabase, Vercel, a Next.js dashboard, and the PDF export — none of which are still true. Leaving it is worse than having no README, because it describes a system that no longer exists.

- [ ] **Step 1: Rewrite the architecture section**

Replace the "Architecture" ASCII diagram with the one from the spec's *Architecture* section, and replace the Tech Stack table with:

```markdown
| Layer | Technology |
|-------|-----------|
| Extension | Chrome Manifest V3 |
| Server | Node 24, built-in `node:http` and `node:sqlite` |
| Database | SQLite + `sqlite-vec` (768-dim) + FTS5, one file |
| Media | yt-dlp, gallery-dl, ffmpeg |
| AI | LM Studio (qwen3-vl-8b, qwen3.6-35b-a3b, nomic-embed-text-v1.5) |
```

- [ ] **Step 2: Replace Quick Start**

Remove the Supabase setup steps. Document, in order: create the venv (Task 0), `cd server && npm install`, register the scheduled task, load the unpacked extension, export Instagram cookies from the popup.

- [ ] **Step 3: Fix the schema and structure sections**

Replace the `bookmarks` table documentation with the `items` / `media` / `chunks` schema. Update the project-structure tree to match this plan's *File structure*, removing `offscreen.*`, `libs/`, and `supabase-schema.sql`.

- [ ] **Step 4: Update the roadmap**

```markdown
- [x] Chrome extension with floating save button
- [x] Tweet, thread, and article extraction
- [x] Automated bookmark sync with scroll handling
- [x] Local SQLite archive with vector and full-text indexes
- [x] Instagram saved-post capture
- [x] Out-of-browser media download (yt-dlp / gallery-dl)
- [ ] Whisper transcription and VLM description (Phase 2)
- [ ] Local LLM categorization and action extraction (Phase 2)
- [ ] Hybrid search dashboard (Phase 3)
- [ ] Export to Obsidian (Phase 3)
```

- [ ] **Step 5: Delete the dead schema file**

```bash
git rm supabase-schema.sql
```

- [ ] **Step 6: Verify no stale references remain**

```bash
grep -rn "Supabase\|Vercel\|Next.js\|jsPDF" README.md
```

Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: document the local architecture, drop Supabase references"
```

---

## Phase 1 completion criteria

Phase 1 is done when all of these hold:

1. `cd server && node --test test/` passes every test.
2. Saving a tweet with the server **stopped** shows `Saved ✓`, and the item appears in `items` once the server returns.
3. A Twitter sync opens an unfocused window, never steals focus, and skips already-archived bookmarks on a second run.
4. An Instagram sync collects saved-post permalinks and rows land in `items` with `platform = 'instagram'`.
5. The media stage moves items from `pending` to `media` with real files under `server/data/media/`.
6. `curl http://127.0.0.1:8787/health` succeeds after a fresh logon with nothing started by hand.
7. No reference to Supabase, jsPDF, or the offscreen document survives anywhere outside `docs/`.

Phase 2 (transcription, description, enrichment, embeddings) gets its own plan, written once this has run against a real archive.
