/**
 * Social Saver Pro v2 - Background Service Worker
 * Handles: Supabase saves, midnight alarm, bookmark sync
 */

// ═══════════════════════════════════════════════════════════════
// CONFIG (loaded from storage, set via popup)
// ═══════════════════════════════════════════════════════════════

let config = {
  supabaseUrl: "",
  supabaseAnonKey: "",
  syncHour: 9,
  syncMinute: 0,
};

async function loadConfig() {
  const stored = await chrome.storage.local.get(["supabaseUrl", "supabaseAnonKey", "syncHour", "syncMinute"]);
  config.supabaseUrl = stored.supabaseUrl || "";
  config.supabaseAnonKey = stored.supabaseAnonKey || "";
  config.syncHour = stored.syncHour ?? 0;
  config.syncMinute = stored.syncMinute ?? 0;
  return config;
}

function isConfigured() {
  return config.supabaseUrl && config.supabaseAnonKey;
}

// ═══════════════════════════════════════════════════════════════
// SUPABASE CLIENT (lightweight, no SDK needed)
// ═══════════════════════════════════════════════════════════════

async function supabaseInsert(table, data) {
  if (!isConfigured()) throw new Error("Supabase not configured");

  const response = await fetch(`${config.supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseAnonKey,
      "Authorization": `Bearer ${config.supabaseAnonKey}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase insert failed: ${response.status} - ${err}`);
  }

  return response.json();
}

async function supabaseUpdate(table, id, data) {
  if (!isConfigured()) throw new Error("Supabase not configured");

  const response = await fetch(`${config.supabaseUrl}/rest/v1/${table}?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      "apikey": config.supabaseAnonKey,
      "Authorization": `Bearer ${config.supabaseAnonKey}`,
      "Prefer": "return=representation",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase update failed: ${response.status} - ${err}`);
  }

  return response.json();
}

async function supabaseSelect(table, query = "") {
  if (!isConfigured()) throw new Error("Supabase not configured");

  const response = await fetch(`${config.supabaseUrl}/rest/v1/${table}?${query}`, {
    headers: {
      "apikey": config.supabaseAnonKey,
      "Authorization": `Bearer ${config.supabaseAnonKey}`,
    },
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Supabase select failed: ${response.status} - ${err}`);
  }

  return response.json();
}

// ═══════════════════════════════════════════════════════════════
// SAVE CONTENT TO SUPABASE
// ═══════════════════════════════════════════════════════════════

async function saveContent(data) {
  await loadConfig();

  if (!isConfigured()) {
    return { success: false, error: "Please configure Supabase in the extension settings" };
  }

  try {
    // Build the new content
    const newFullText = data.fullText || (data.tweets ? data.tweets.map((t) => t.text).join("\n\n") : "");
    const newType = data.type || "tweet";

    // Check for duplicate by URL
    const existing = await supabaseSelect(
      "bookmarks",
      `url=eq.${encodeURIComponent(data.url)}&select=id,type,full_text`
    );

    if (existing && existing.length > 0) {
      const old = existing[0];
      // Determine if new data is richer:
      // 1. Type upgrade (thread > tweet) always wins
      // 2. Same type: update only if new text is longer
      const isTypeUpgrade = newType === "thread" && old.type === "tweet";
      const isLongerText = newFullText.length > (old.full_text || "").length;

      if (isTypeUpgrade || isLongerText) {
        const updatedFields = {
          type: newType,
          title: data.title || "",
          author: data.author || "",
          author_handle: data.authorHandle || "",
          full_text: newFullText,
          images: data.images || [],
          source_date: data.date || null,
          ai_processed: false, // Re-trigger AI on updated content
        };
        await supabaseUpdate("bookmarks", old.id, updatedFields);
        console.log(`[SSP] Updated existing bookmark ${old.id} (${old.type} → ${newType})`);

        // Re-trigger AI processing for updated content
        triggerAIProcessing(old.id).catch((err) =>
          console.warn("[SSP] AI processing trigger failed:", err)
        );

        return { success: true, message: "Updated", id: old.id };
      }

      return { success: true, message: "Already saved", id: old.id };
    }

    // Build the bookmark record for new insert
    const record = {
      url: data.url,
      type: newType,
      title: data.title || "",
      author: data.author || "",
      author_handle: data.authorHandle || "",
      full_text: newFullText,
      images: data.images || [],
      source_date: data.date || null,
      saved_at: new Date().toISOString(),
      // AI fields — will be populated by Edge Function
      category: null,
      action_item: null,
      ai_processed: false,
    };

    const result = await supabaseInsert("bookmarks", record);

    // Trigger AI processing via Edge Function (fire and forget)
    triggerAIProcessing(result[0]?.id).catch((err) =>
      console.warn("[SSP] AI processing trigger failed:", err)
    );

    return { success: true, id: result[0]?.id };
  } catch (err) {
    console.error("[SSP] Save error:", err);
    return { success: false, error: err.message };
  }
}

async function triggerAIProcessing(bookmarkId) {
  if (!bookmarkId || !isConfigured()) return;

  await fetch(`${config.supabaseUrl}/functions/v1/process-bookmark`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${config.supabaseAnonKey}`,
    },
    body: JSON.stringify({ bookmarkId }),
  });
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

// Alarm fires → sync starts immediately (no notification prompt)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "daily-sync") {
    await loadConfig();
    if (!isConfigured()) {
      console.warn("[SSP] Sync skipped — Supabase not configured");
      return;
    }
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
  const TAB_LOAD_WAIT = 2000;
  const BETWEEN_TAB_DELAY = 1500;

  try {
    // ── Phase 1: Collect bookmark URLs from bookmarks page ──
    updateSyncNotification(0, 0, "Opening bookmarks page...");

    const bmTab = await chrome.tabs.create({
      url: "https://x.com/i/bookmarks",
      active: false,
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
      await chrome.storage.local.set({ lastSyncTime: new Date().toISOString() });
      return;
    }

    // ── Phase 1.5: Filter out already-complete bookmarks ──
    const urls = bookmarkURLs.map((b) => b.url);
    let existingComplete = new Set();
    try {
      // Query bookmarks that already have full content and AI processing
      const existing = await supabaseSelect(
        "bookmarks",
        `url=in.(${urls.map((u) => `"${encodeURIComponent(u)}"`).join(",")})`
        + `&select=url,full_text,ai_processed`
      );
      for (const row of existing) {
        if (row.full_text && row.full_text.length > 200 && row.ai_processed) {
          existingComplete.add(row.url);
        }
      }
    } catch (err) {
      console.warn("[SSP] Could not filter existing bookmarks:", err);
    }

    const toProcess = bookmarkURLs.filter((b) => !existingComplete.has(b.url));
    const skippedCount = bookmarkURLs.length - toProcess.length;
    console.log(`[SSP] Phase 2: processing ${toProcess.length}, skipping ${skippedCount} complete`);

    updateSyncNotification(0, toProcess.length, `Syncing bookmarks... (0 of ${toProcess.length})`);

    // ── Phase 2: Open each URL individually for full extraction ──
    let saved = 0;
    let updated = 0;
    let failed = 0;

    for (let i = 0; i < toProcess.length; i++) {
      const bm = toProcess[i];
      updateSyncNotification(i + 1, toProcess.length);

      try {
        const tab = await chrome.tabs.create({ url: bm.url, active: false });
        await waitForTabLoad(tab.id);
        await new Promise((r) => setTimeout(r, TAB_LOAD_WAIT));
        await ensureContentScript(tab.id);

        // Auto-scroll to load lazy content (threads, articles), then extract
        const response = await chrome.tabs.sendMessage(tab.id, {
          action: "autoScrollAndExtract",
        });

        const content = response?.content;

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

        await chrome.tabs.remove(tab.id);
      } catch (err) {
        console.warn(`[SSP] Failed to process ${bm.url}:`, err);
        failed++;
      }

      // Delay between tabs to be gentle on X
      if (i < toProcess.length - 1) {
        await new Promise((r) => setTimeout(r, BETWEEN_TAB_DELAY));
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

    await chrome.storage.local.set({ lastSyncTime: new Date().toISOString() });
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
  await loadConfig();
  const lastSync = (await chrome.storage.local.get("lastSyncTime")).lastSyncTime;

  if (!isConfigured()) {
    return { configured: false, lastSync };
  }

  try {
    // Get count of bookmarks
    const response = await fetch(
      `${config.supabaseUrl}/rest/v1/bookmarks?select=id&limit=1`,
      {
        headers: {
          "apikey": config.supabaseAnonKey,
          "Authorization": `Bearer ${config.supabaseAnonKey}`,
          "Prefer": "count=exact",
        },
      }
    );

    const count = response.headers.get("content-range")?.split("/")[1] || "0";
    return { configured: true, totalBookmarks: parseInt(count), lastSync };
  } catch {
    return { configured: true, totalBookmarks: "?", lastSync };
  }
}

async function testConnection() {
  await loadConfig();
  if (!isConfigured()) {
    return { success: false, error: "Missing Supabase URL or key" };
  }

  try {
    const response = await fetch(`${config.supabaseUrl}/rest/v1/bookmarks?select=id&limit=1`, {
      headers: {
        "apikey": config.supabaseAnonKey,
        "Authorization": `Bearer ${config.supabaseAnonKey}`,
      },
    });

    if (response.ok) {
      return { success: true };
    } else {
      const err = await response.text();
      return { success: false, error: `${response.status}: ${err}` };
    }
  } catch (err) {
    return { success: false, error: err.message };
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
