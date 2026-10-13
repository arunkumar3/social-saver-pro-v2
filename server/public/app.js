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

// Captured once at load. Printing restores to this, not to whatever the title
// was a moment ago, so a missed afterprint can never leave an item's title on
// the tab.
const PAGE_TITLE = document.title;

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
    // A PDF cannot hold video or audio, so the printed copy says so instead.
    if (m.kind === 'video' || m.kind === 'audio') {
      parts.push(el('p', {
        class: 'print-only print-media',
        text: `${m.kind === 'video' ? 'Video' : 'Audio'} · ${fmtBytes(m.bytes)} — not included, see source link`,
      }));
    }
  }
  const href = safeHref(full.url);
  if (href) parts.push(el('p', { class: 'print-only print-source', text: `Source: ${href}` }));
  parts.push(el('div', { class: 'detail-tools' },
    copyButton(full),
    el('button', {
      type: 'button',
      class: 'act act-pdf',
      onclick: (e) => { e.stopPropagation(); printItem(li, full); },
    }, 'Save as PDF'),
    href ? el('a', { class: 'out-link', href, target: '_blank', rel: 'noopener noreferrer' }, 'Open on X ↗') : null));
  detail.replaceChildren(...parts);
}

function copyButton(full) {
  const btn = el('button', { type: 'button', class: 'act act-copy' }, 'Copy');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      // 127.0.0.1 counts as a secure context, so the async clipboard API is
      // available. If the browser still refuses, say so rather than appear to
      // have copied.
      await navigator.clipboard.writeText(full.text || '');
      flash(btn, 'Copied ✓', 2000);
    } catch {
      flash(btn, 'Copy failed — select the text and press Ctrl+C', 4000);
    }
  });
  return btn;
}

function flash(btn, text, ms) {
  btn.dataset.label ??= btn.textContent;
  btn.textContent = text;
  clearTimeout(Number(btn.dataset.timer));
  btn.dataset.timer = String(setTimeout(() => { btn.textContent = btn.dataset.label; }, ms));
}

/**
 * Open the print dialog for one item. The print stylesheet shows only the card
 * marked as the print target, so choosing "Save as PDF" there produces a clean
 * document of that item alone. The page title becomes Chrome's suggested file
 * name, so it is set to the item for the moment of printing and restored after.
 */
function printItem(li, full) {
  const reset = () => {
    document.title = PAGE_TITLE;
    document.body.classList.remove('printing-item');
    for (const t of document.querySelectorAll('.print-target')) t.classList.remove('print-target');
  };
  reset();
  const lead = Array.from((full.text || '').replace(/\s+/g, ' ').trim()).slice(0, 60).join('');
  document.title = [full.authorHandle || full.author, lead].filter(Boolean).join(' — ') || PAGE_TITLE;
  document.body.classList.add('printing-item');
  li.classList.add('print-target');
  window.addEventListener('afterprint', reset, { once: true });
  window.print();
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
