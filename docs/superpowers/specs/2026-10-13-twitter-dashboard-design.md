# Twitter Dashboard — Design

**Date:** 2026-10-13
**Status:** Draft for review
**Extends:** [`2026-09-08-local-archive-dashboard-design.md`](2026-09-08-local-archive-dashboard-design.md), component 5 (Dashboard)

## Purpose

Give the user a way to look at their archive. Today the only way to see what
is stored is for someone to run SQL against `archive.db`.

The user's stated use is **both finding something specific and working through
saves, with search first**: a search box on top, a newest-first feed beneath
it, and a way to mark each item done or skipped so the feed shrinks as they work
through it.

## Scope

**v1 is Twitter only.** That is what the user asked for, and Twitter is the part
of the archive with media on disk. Every API below takes a `platform` parameter,
so adding Instagram later is mostly a UI change.

**Out of scope for v1:** Instagram, categories and summaries (they need Phase 2
enrichment, which has not started), insights charts, and export.

## What the data looks like

Measured 2026-10-13. These numbers drive several design choices below.

| | |
|---|---|
| Items | 186 — 156 tweets, 23 threads, 7 articles |
| Span | 2026-08-03 → 2026-10-12 |
| Text length | average 735 chars, maximum **13,222** |
| Authors | 157 distinct; none has more than 4 items |
| Media | 148 `.mp4`, 1 `.mov`, 1 `.mkv`, 2 `.mp3` |
| Largest video | **1 GB** |
| `action_status` | all `pending` |
| Captions containing `<…>` | **4** |

Consequences:

- **Search and recency carry the navigation.** With 157 authors and a maximum
  of 4 items each, browsing by author is close to useless, so v1 has no author
  facet.
- **The feed never ships full text.** A 13,222-character article is fetched
  only when its card is opened.
- **Video must support seeking.** A 1 GB file served without HTTP Range has to
  download completely before the user can scrub.
- **`.mkv` will not play inline** in most browsers, so every video also gets a
  direct link to the file.
- **Item text is attacker-controlled.** It was written by 157 accounts the user
  does not control, and four captions already contain angle-bracket text. See
  *Security*.
- `author_handle` is stored **with** its leading `@`. The UI must not add
  another.

## Architecture

Plain HTML, CSS and ES modules, served by the existing Node server. No
framework, no build step, no new dependencies. This follows the project's
existing choice: built-in Node modules only, with `sqlite-vec` as the sole
runtime dependency.

```
browser ──► 127.0.0.1:8787
              │
              ├── GET /, /app.js, /style.css   static, fixed allow-list
              ├── GET /api/search              FTS5 + bm25
              ├── GET /api/items               keyset-paginated feed
              ├── GET /api/items/:id           one item, full text
              ├── PATCH /api/items/:id         action_status only
              └── GET /media/:id               file stream, HTTP Range
```

New files:

```
server/public/index.html
server/public/app.js
server/public/style.css
server/src/routes/static.js
server/src/routes/items.js      list, get one, patch
server/src/routes/search.js
server/src/routes/media.js
server/src/fts.js               query sanitising
```

`server.js` gains the routes, the Host check, and the extended Origin guard.

## HTTP interface

All JSON responses use the existing `send()` helper. All new endpoints return
`404 {"error":"not_found"}` for an unknown id, and `400` with a named error for
bad input. None of them throw: a malformed request is answered, not crashed on.

### `GET /api/items`

Newest-first feed.

| Param | Values | Default |
|---|---|---|
| `platform` | `twitter`, `instagram` | `twitter` |
| `status` | `pending`, `done`, `skipped`, `all` | `pending` |
| `kind` | `tweet`, `thread`, `article`, or omitted | omitted (all) |
| `hasVideo` | `1`, or omitted — item has at least one `media` row of kind `video` | omitted |
| `limit` | 1–100 | 50 |
| `before` | an item id | omitted (first page) |

Ordered by `id DESC`. Ids are assigned in save order, so this is newest-saved
first, and keyset pagination on `id` stays stable while items are being added
or marked done. Offset pagination would skip or repeat items in exactly that
situation.

Response:

```json
{ "items": [ItemSummary], "nextBefore": 1234 }
```

`nextBefore` is `null` on the last page.

**`ItemSummary`**

```json
{
  "id": 1466,
  "platform": "twitter",
  "kind": "tweet",
  "url": "https://x.com/oneviske/status/2097612432072167859",
  "author": "…",
  "authorHandle": "@oneviske",
  "sourceDate": "2026-09-04T12:00:00.000Z",
  "savedAt": "2026-09-08 15:57:45",
  "actionStatus": "pending",
  "excerpt": "first 280 characters of the caption",
  "textLength": 735,
  "media": [{ "id": 77, "kind": "video", "bytes": 18206984, "ext": ".mp4" }]
}
```

`excerpt` is the first 280 characters, counted as code points so an emoji is
never split in half. JavaScript's `slice` counts UTF-16 units and would cut a
surrogate pair, leaving a broken glyph. `textLength` is in the same units and
tells the UI whether there is more to fetch.

### `GET /api/items/:id`

One item, with the full caption as `text` in place of `excerpt`. Used when a
card is opened.

### `GET /api/search`

| Param | Values | Default |
|---|---|---|
| `q` | search text | required |
| `platform` | as above | `twitter` |
| `status` | as above | `all` |
| `limit` | 1–100 | 50 |

`status` defaults to `all` here rather than `pending`: someone looking for a
specific saved item should find it whether or not they have already marked it
done.

Response: `{ "items": [ItemSummary + { "snippet": SnippetSpan[] }] }`, ranked by
`bm25(items_fts)`, best match first.

A blank or whitespace-only `q` returns `{ "items": [] }`, not an error, since
the UI calls this on every keystroke.

**Query sanitising** (`fts.js`). FTS5's `MATCH` has its own syntax, and raw
user input breaks it: a stray `"` is a syntax error, and a leading `-` is an
operator. Each whitespace-separated token has its double quotes removed and is
wrapped in quotes, then the tokens are joined with spaces (implicit AND). The
last token gets a `*` suffix for prefix matching, so results appear while a word
is still being typed. Empty tokens are dropped. If the sanitised query is still
rejected, the endpoint returns an empty result rather than a 500.

**Snippets are returned as data, not HTML.** See *Security*. `snippet()` runs
with private-use sentinel characters as its markers, and the server splits the
result into a list of spans:

```json
[{ "text": "a new ", "hit": false }, { "text": "agent", "hit": true }, { "text": " framework", "hit": false }]
```

The page renders each span as a text node, wrapping hits in `<mark>`. No
markup ever travels inside a string.

### `PATCH /api/items/:id`

Body: `{ "actionStatus": "pending" | "done" | "skipped" }`.

Returns `{ "ok": true, "id": 1466, "actionStatus": "done" }`. Any other field or
value is `400 {"error":"bad_action_status"}`. This is the dashboard's only
write, and it touches only `action_status` and `updated_at`.

### `GET /media/:id`

Streams the file recorded on media row `id`.

- **The file is found by database id only.** No part of the URL is ever used as
  a filesystem path.
- The stored path must still resolve inside `MEDIA_DIR`; anything else is
  refused. The path is trusted data in practice, but this costs one line, and it
  is the only place this server hands a file to a browser.
- `Range: bytes=a-b` returns `206` with `Content-Range`. A range starting past
  the end of the file returns `416`. With no `Range` header the response is
  `200` with the whole file, streamed, never buffered.
- `Content-Type` comes from the extension: `.mp4` `video/mp4`, `.mov`
  `video/quicktime`, `.mkv` `video/x-matroska`, `.mp3` `audio/mpeg`, `.webm`
  `video/webm`, `.jpg`/`.jpeg` `image/jpeg`, `.png` `image/png`, `.webp`
  `image/webp`; anything else `application/octet-stream`.
- A row whose file is missing returns `404`, not a stream error.

### Static files

`GET /`, `/app.js` and `/style.css` map through a fixed table to the three files
in `server/public/`. Any other path falls through to the existing 404. The URL
is never joined onto a directory.

## The page

One page, top to bottom:

1. **Header** — archive counts from `/api/stats`.
2. **Search box** — queries `/api/search` 250 ms after typing stops. While it
   holds text, it replaces the feed with ranked results. Clearing it restores
   the feed.
3. **Filters** — status chips **To do / Done / Skipped / All** (default To do),
   kind chips **Tweet / Thread / Article** (none selected = all), and a **Has
   video** toggle. Kind chips are single-select, matching the single `kind`
   parameter: choosing one shows only that kind, and choosing it again clears
   it.
4. **Feed** — cards showing handle, saved date, excerpt, a video badge when
   media exists, and **Done** and **Skip** buttons. "Load more" fetches the next
   page by `before`.
5. **Opened card** — click to expand. Fetches `/api/items/:id` for the full
   text, shows a `<video controls preload="metadata">` per video, a direct link
   to each media file (the `.mkv` fallback), and **Open on X**.

Marking an item done or skipped in the To-do view removes its card at once, and
the request goes out in the background. If the request fails, the card is put
back and an error shown, so the screen never claims a change the server did not
accept.

Empty states are explicit: "Nothing to do" and "No matches" are messages, not a
blank page. A server that cannot be reached shows a visible banner, not a
silently empty feed.

## Security

Serving the archive to a browser adds three exposures the server did not have
before. Each one is closed on the server, so a bug in `app.js` cannot reopen it.

**1. Script injection through item text — the main risk.** Item text is written
by third parties, and four captions in the archive already contain `<…>`. If
any of it reached the page as HTML, a tweet containing
`<img src=x onerror=…>` would run script with the dashboard's origin, and that
script could call the API.

- `app.js` writes item data only through `textContent` and DOM node creation.
  It never uses `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
  `document.write` with any data that came from the API.
- Search highlighting arrives as span data, as described above, so the safe way
  to render it is also the only way.
- Responses for the three page files carry a Content-Security-Policy:
  `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`.
  Inline script is therefore refused even if markup does slip through, which
  makes the CSP a second line of defence rather than the only one.

**2. DNS rebinding.** A hostile site can point its own domain at `127.0.0.1`.
The browser then treats the archive as same-origin with that site and lets it
read every response. Every request is therefore checked: the hostname in its
`Host` header must be `127.0.0.1`, `localhost` or `[::1]`, or the response is
`403 {"error":"forbidden_host"}`. Only the hostname is compared, not the port,
so the tests' ephemeral ports keep working and the extension's requests — which
send `Host: 127.0.0.1:8787` — are unaffected.

**3. Writes from other sites.** The existing `Origin` guard covers only `POST`.
`PATCH` would be the first write it does not protect. The guard is extended to
every method that is not `GET` or `HEAD`, keeping its current allow rules:
no Origin, a loopback origin, or a `chrome-extension:` origin.

The server stays bound to `127.0.0.1`. Nothing here is reachable from the
network.

## Error handling

- Every new endpoint answers a malformed request with a 4xx and a named error.
  None of them can crash the process.
- A client that disconnects partway through a video stream (normal behaviour
  when seeking) closes the file handle. Seeking through a 1 GB video must not
  leak file descriptors.
- A failed `PATCH` restores the card, so the screen never shows a change the
  server rejected.

## Testing

**Server — `node:test`, one file per route module:**

- `search`: ranking order; a stray `"`, a leading `-`, and an unbalanced
  bracket each return results or an empty list, never a 500; prefix matching on
  the last token; span output contains no markup; the `status` filter; the
  `platform` filter.
- `items`: newest-first order; keyset pagination neither skips nor repeats when
  an item is marked done between pages; each filter; `nextBefore` is `null` on
  the last page; `excerpt` is cut at 280; `GET /:id` returns the full text.
- `PATCH`: each valid status; an unknown status and an extra field are both
  `400`; an unknown id is `404`; a cross-site `Origin` is `403`; a
  `chrome-extension:` origin is allowed.
- `media`: a full `200`; a `206` with the correct `Content-Range` and length; a
  `416` past the end; a missing file is `404`; a stored path outside
  `MEDIA_DIR` is refused; `Content-Type` per extension.
- `static`: the three files are served with the CSP header; any other path
  under `/` is `404`; a traversal attempt such as `/../server.js` is `404`.
- Host check: `Host: evil.example` is `403` on every route, and loopback hosts
  pass.

**Page — the in-app browser.** Load the dashboard against the real archive,
search, open a card, play a video, scrub to the middle of a large one, mark an
item done, and screenshot each step. This is the check the extension never had.
Its absence is what let the `Origin` regression through, because no test could
exercise a real browser request.

**An injection check against the real page.** Insert a test item whose caption
is `<img src=x onerror="window.__pwned=1">` and confirm that searching for it,
showing it in the feed and opening it all leave `window.__pwned` undefined.
Then remove the item.

## Open questions

None blocking. If the user later wants Instagram in the same page, the API
already supports it. The UI needs a platform switch and handling for the 1,384
deferred items that have text but no media yet.
