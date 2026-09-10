/**
 * Social Saver Pro v2 - Background Service Worker
 * Handles: local-server saves, midnight alarm, bookmark sync
 */

import "./api.js";
import "./config.js";

// ═══════════════════════════════════════════════════════════════
// CONFIG (loaded from storage, set via popup)
// ═══════════════════════════════════════════════════════════════

let config = {
  syncHour: 9,
  syncMinute: 0,
};

async function loadConfig() {
  const stored = await chrome.storage.local.get(["syncHour", "syncMinute"]);
  config.syncHour = stored.syncHour ?? 0;
  config.syncMinute = stored.syncMinute ?? 0;
  return config;
}

// ═══════════════════════════════════════════════════════════════
// SAVE CONTENT TO THE LOCAL SERVER
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// DAILY BOOKMARK SYNC (9 AM, auto-start)
// ═══════════════════════════════════════════════════════════════

async function setupSyncAlarm() {
  await loadConfig();

  await chrome.alarms.clear("daily-sync");

  const now = new Date();
  const next = new Date();
  next.setHours(config.syncHour, config.syncMinute, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  chrome.alarms.create("daily-sync", {
    when: next.getTime(),
    periodInMinutes: 24 * 60,
  });

  console.log("[SSP] Sync alarm set for:", next.toLocaleString());
}

// Drain anything queued while the local server was unreachable.
chrome.runtime.onStartup.addListener(() => SSPApi.flushQueue());
chrome.runtime.onInstalled.addListener(() => SSPApi.flushQueue());

// Alarm fires → sync starts immediately (no notification prompt)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "daily-sync") {
    await loadConfig();
    performBookmarkSync();
  }
});

// Helper: wait for a tab to finish loading
function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Tab load timeout"));
    }, 30000);

    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// Helper: inject content scripts if not already present
async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { action: "checkPage" });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["config.js", "content.js"],
    });
    await new Promise((r) => setTimeout(r, 1000));
  }
}

// Helper: update sync progress notification
function updateSyncNotification(current, total, message) {
  chrome.notifications.create("sync-progress", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Social Saver Pro — Syncing",
    message: message || `Syncing bookmark ${current} of ${total}...`,
    priority: 1,
    silent: true,
  });
}

async function performBookmarkSync() {
  const TAB_LOAD_WAIT = 3500;
  const BETWEEN_TAB_DELAY = 1500;
  const RETRY_WAIT = 2000;

  try {
    // ── Phase 1: Collect bookmark URLs from bookmarks page ──
    updateSyncNotification(0, 0, "Opening bookmarks page...");

    const bmTab = await chrome.tabs.create({
      url: "https://x.com/i/bookmarks",
      active: true,
    });

    await waitForTabLoad(bmTab.id);
    await new Promise((r) => setTimeout(r, TAB_LOAD_WAIT));
    await ensureContentScript(bmTab.id);

    const urlResponse = await chrome.tabs.sendMessage(bmTab.id, {
      action: "extractBookmarkURLs",
      maxScrollTime: 60000,
    });

    const bookmarkURLs = urlResponse?.bookmarks || [];
    console.log(`[SSP] Phase 1: collected ${bookmarkURLs.length} bookmark URLs`);

    // Close bookmarks tab
    await chrome.tabs.remove(bmTab.id);

    if (bookmarkURLs.length === 0) {
      chrome.notifications.create("sync-done", {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "Social Saver Pro — Sync Complete",
        message: "No bookmarks found to sync.",
        priority: 1,
      });
      await chrome.storage.local.set({ ssp_last_sync: Date.now() });
      return;
    }

    // ── Phase 1.5: Filter out bookmarks the server already has ──
    const urls = bookmarkURLs.map((b) => b.url);
    let existingComplete = new Set();
    try {
      const known = await SSPApi.knownUrls(urls);
      existingComplete = new Set(known);
    } catch (err) {
      console.warn("[SSP] Could not filter existing bookmarks:", err);
    }

    const toProcess = bookmarkURLs.filter((b) => !existingComplete.has(b.url));
    const skippedCount = bookmarkURLs.length - toProcess.length;
    console.log(`[SSP] Phase 2: processing ${toProcess.length}, skipping ${skippedCount} complete`);

    updateSyncNotification(0, toProcess.length, `Syncing bookmarks... (0 of ${toProcess.length})`);

    // ── Phase 2: Open each URL individually for full extraction ──
    // Tabs are opened in a dedicated, unfocused window so the sync never
    // steals the user's focus. The window is unfocused (not minimized) so
    // its timers aren't throttled and X can actually hydrate.
    let saved = 0;
    let updated = 0;
    let failed = 0;

    const syncWindow = await chrome.windows.create({
      url: "about:blank",
      focused: false,
      width: SSP_CONFIG.SYNC_WINDOW_WIDTH,
      height: SSP_CONFIG.SYNC_WINDOW_HEIGHT,
    });

    let cursor = 0;

    async function worker() {
      while (cursor < toProcess.length) {
        const i = cursor++;
        const bm = toProcess[i];
        updateSyncNotification(i + 1, toProcess.length);

        let tab;
        try {
          tab = await chrome.tabs.create({
            url: bm.url,
            active: true,
            windowId: syncWindow.id,
          });
          try {
            await waitForTabLoad(tab.id);
            await new Promise((r) => setTimeout(r, TAB_LOAD_WAIT));
            await ensureContentScript(tab.id);

            // Auto-scroll to load lazy content (threads, articles), then extract
            let response = await chrome.tabs.sendMessage(tab.id, {
              action: "autoScrollAndExtract",
            });

            let content = response?.content;
            console.log(`[SSP] [${i + 1}/${toProcess.length}] ${bm.url} → ${content?.fullText?.length || 0} chars`);

            // Retry once if content came back empty (X may still be hydrating)
            if (!content?.fullText || content.fullText.length === 0) {
              console.log(`[SSP] Retry: waiting ${RETRY_WAIT}ms for ${bm.url}`);
              await new Promise((r) => setTimeout(r, RETRY_WAIT));
              response = await chrome.tabs.sendMessage(tab.id, {
                action: "autoScrollAndExtract",
              });
              content = response?.content;
              console.log(`[SSP] Retry result: ${content?.fullText?.length || 0} chars`);
            }

            if (content && content.fullText && content.fullText.length > 0) {
              const result = await saveContent(content);
              if (result.success) {
                if (result.message === "Updated") updated++;
                else if (result.message !== "Already saved") saved++;
              }
            } else {
              // Fallback: save with metadata from Phase 1
              const fallback = {
                url: bm.url,
                type: "tweet",
                title: "",
                author: bm.author || "",
                authorHandle: bm.authorHandle || "",
                fullText: "",
                images: [],
                date: null,
              };
              await saveContent(fallback);
              failed++;
            }
          } finally {
            if (tab) {
              try {
                await chrome.tabs.remove(tab.id);
              } catch {
                /* tab may already be closed/discarded */
              }
            }
          }
        } catch (err) {
          console.warn(`[SSP] Failed to process ${bm.url}:`, err);
          failed++;
        }

        // Delay between tabs to be gentle on X
        if (i < toProcess.length - 1) {
          await new Promise((r) => setTimeout(r, BETWEEN_TAB_DELAY));
        }
      }
    }

    try {
      await Promise.all(
        Array.from({ length: Math.min(SSP_CONFIG.SYNC_CONCURRENCY, toProcess.length) }, worker)
      );
    } finally {
      try {
        await chrome.windows.remove(syncWindow.id);
      } catch {
        /* already closed */
      }
    }

    // Clear progress notification
    chrome.notifications.clear("sync-progress");

    // Show results
    const parts = [];
    if (saved > 0) parts.push(`${saved} new`);
    if (updated > 0) parts.push(`${updated} updated`);
    if (skippedCount > 0) parts.push(`${skippedCount} skipped`);
    if (failed > 0) parts.push(`${failed} failed`);
    chrome.notifications.create("sync-done", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Social Saver Pro — Sync Complete",
      message: `Bookmarks: ${parts.join(", ") || "nothing to update"}.`,
      priority: 1,
    });

    await chrome.storage.local.set({ ssp_last_sync: Date.now() });
  } catch (err) {
    console.error("[SSP] Bookmark sync failed:", err);
    chrome.notifications.clear("sync-progress");
    chrome.notifications.create("sync-error", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Social Saver Pro — Sync Failed",
      message: err.message || "Something went wrong during sync",
      priority: 1,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function exportInstagramCookies() {
  try {
    const cookies = await chrome.cookies.getAll({ domain: "instagram.com" });
    if (!cookies.length) {
      return { ok: false, error: "No Instagram cookies found — log in to Instagram in Chrome first." };
    }
    const res = await fetch(`${SSPApi.baseUrl}/cookies`, {
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

const IG_STAGED_KEY = "ssp_ig_staged";
// Used only until the archive has real media to average. One verified reel
// measured 18.2 MB; treat that as the seed rather than a hard assumption.
const IG_FALLBACK_BYTES = 18 * 1024 * 1024;

/**
 * Collect saved-post permalinks and report what a sync WOULD do, without
 * ingesting anything.
 *
 * Ingesting is what starts downloads: the server's media stage drains every
 * 30 seconds, so anything POSTed to /ingest begins downloading immediately.
 * The collected list is therefore stashed in chrome.storage and only committed
 * once the user confirms. The stash also survives the popup being closed.
 */
async function previewInstagramSync() {
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

    // Ask the server which of these it already has. If it is unreachable this
    // returns [], so the preview degrades to "everything looks new" rather
    // than silently claiming there is nothing to do.
    const known = new Set(await SSPApi.knownUrls(items.map((i) => i.url)));
    const fresh = items.filter((i) => !known.has(i.url));

    await chrome.storage.local.set({ [IG_STAGED_KEY]: fresh });

    let meanBytes = IG_FALLBACK_BYTES;
    try {
      const res = await fetch(`${SSPApi.baseUrl}/api/stats`);
      if (res.ok) {
        const stats = await res.json();
        // Instagram's own mean, never the global one. Real data had a 603 MB
        // tweet video alongside 18 MB reels; the global mean would estimate
        // this download at roughly seven times its true size.
        const igMean = stats.media?.meanBytesByPlatform?.instagram;
        if (igMean > 0) meanBytes = igMean;
      }
    } catch {
      // Estimate stays on the fallback; not worth failing the preview over.
    }

    return {
      ok: true,
      total: items.length,
      alreadyArchived: items.length - fresh.length,
      newCount: fresh.length,
      estBytes: fresh.length * meanBytes,
      estimateIsSeeded: meanBytes === IG_FALLBACK_BYTES,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Ingest the stashed permalinks. This is the point downloads begin. */
async function commitInstagramSync() {
  const stored = await chrome.storage.local.get(IG_STAGED_KEY);
  const staged = stored[IG_STAGED_KEY] ?? [];
  if (staged.length === 0) {
    return { ok: false, error: "Nothing staged — run a preview first." };
  }

  const result = await SSPApi.ingest(staged);
  await chrome.storage.local.remove(IG_STAGED_KEY);
  await chrome.storage.local.set({ ssp_last_sync: new Date().toISOString() });

  chrome.notifications.create("ig-sync-done", {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Instagram sync started",
    message: `${staged.length} posts queued — media downloads in the background`,
  });
  return { ok: true, queued: staged.length, ...result };
}

/** Discard a staged preview without ingesting it. */
async function cancelInstagramSync() {
  await chrome.storage.local.remove(IG_STAGED_KEY);
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "saveContent") {
    saveContent(msg.data).then(sendResponse);
    return true; // async
  }

  if (msg.action === "getStats") {
    getStats().then(sendResponse);
    return true;
  }

  if (msg.action === "testConnection") {
    testConnection().then(sendResponse);
    return true;
  }

  if (msg.action === "manualSync") {
    performBookmarkSync().then(() => sendResponse({ success: true }));
    return true;
  }

  if (msg.action === "exportCookies") {
    exportInstagramCookies().then(sendResponse);
    return true;
  }

  if (msg.action === "previewInstagramSync") {
    previewInstagramSync().then(sendResponse);
    return true;
  }

  if (msg.action === "commitInstagramSync") {
    commitInstagramSync().then(sendResponse);
    return true;
  }

  if (msg.action === "cancelInstagramSync") {
    cancelInstagramSync().then(sendResponse);
    return true;
  }

  if (msg.action === "saveConfig") {
    chrome.storage.local.set(msg.config).then(() => {
      loadConfig().then(() => {
        setupSyncAlarm();
        sendResponse({ success: true });
      });
    });
    return true;
  }
});

async function getStats() {
  const stored = await chrome.storage.local.get(["ssp_pending_queue", "ssp_last_sync"]);
  const queue = stored.ssp_pending_queue ?? [];
  const lastSync = stored.ssp_last_sync ?? null;
  try {
    const res = await fetch(`${SSPApi.baseUrl}/health`);
    if (!res.ok) throw new Error(`status ${res.status}`);
    return { connected: true, pending: queue.length, lastSync };
  } catch {
    return { connected: false, pending: queue.length, lastSync };
  }
}

async function testConnection() {
  try {
    const res = await fetch(`${SSPApi.baseUrl}/health`);
    if (!res.ok) return { success: false, error: `Server returned ${res.status}` };
    return { success: true, message: "Local server reachable" };
  } catch (err) {
    return { success: false, error: "Local server not running — start it and retry." };
  }
}

// ═══════════════════════════════════════════════════════════════
// INITIALIZATION
// ═══════════════════════════════════════════════════════════════

chrome.runtime.onInstalled.addListener(async () => {
  await loadConfig();
  await setupSyncAlarm();
  console.log("[SSP] Social Saver Pro v2 installed");
});

// Re-setup alarm on service worker startup
loadConfig().then(() => setupSyncAlarm());
