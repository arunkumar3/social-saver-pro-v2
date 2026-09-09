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

globalThis.SSPApi = { ingest, knownUrls, flushQueue, enqueue, mergeQueue, baseUrl: SSP_SERVER };
