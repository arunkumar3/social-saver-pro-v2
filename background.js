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
  syncHour: 0,
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
// MIDNIGHT BOOKMARK SYNC
// ═══════════════════════════════════════════════════════════════

// Set up the midnight alarm
async function setupSyncAlarm() {
  await loadConfig();

  // Clear existing alarm
  await chrome.alarms.clear("midnight-sync");

  // Calculate next occurrence
  const now = new Date();
  const next = new Date();
  next.setHours(config.syncHour, config.syncMinute, 0, 0);

  // If that time already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  chrome.alarms.create("midnight-sync", {
    when: next.getTime(),
    periodInMinutes: 24 * 60, // Repeat daily
  });

  console.log("[SSP] Sync alarm set for:", next.toLocaleString());
}

// Handle alarm firing
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "midnight-sync") {
    await loadConfig();
    if (!isConfigured()) {
      console.warn("[SSP] Sync skipped — Supabase not configured");
      return;
    }

    // Show notification
    chrome.notifications.create("sync-ready", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Social Saver Pro",
      message: "Ready to sync your X bookmarks. Click to start.",
      priority: 2,
      requireInteraction: true,
    });
  }
});

// Handle notification click — start the sync
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId === "sync-ready") {
    chrome.notifications.clear("sync-ready");
    await performBookmarkSync();
  }
});

async function performBookmarkSync() {
  try {
    // Open bookmarks page
    const tab = await chrome.tabs.create({
      url: "https://x.com/i/bookmarks",
      active: true,
    });

    // Wait for page to load
    await new Promise((resolve) => {
      const listener = (tabId, info) => {
        if (tabId === tab.id && info.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          setTimeout(resolve, 2000); // Extra wait for X's JS rendering
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });

    // Inject content script if not already there, then extract bookmarks
    let response;
    try {
      response = await chrome.tabs.sendMessage(tab.id, {
        action: "extractBookmarks",
        maxScrollTime: 60000,
      });
    } catch {
      // Content script might not be injected yet
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["config.js", "content.js"],
      });
      await new Promise((r) => setTimeout(r, 1000));
      response = await chrome.tabs.sendMessage(tab.id, {
        action: "extractBookmarks",
        maxScrollTime: 60000,
      });
    }

    const bookmarks = response?.bookmarks || [];
    console.log(`[SSP] Found ${bookmarks.length} bookmarks to sync`);

    // Save each bookmark
    let saved = 0;
    let updated = 0;
    let skipped = 0;

    for (const bookmark of bookmarks) {
      const result = await saveContent(bookmark);
      if (result.success) {
        if (result.message === "Already saved") skipped++;
        else if (result.message === "Updated") updated++;
        else saved++;
      }
      // Small delay to avoid rate limiting
      await new Promise((r) => setTimeout(r, 200));
    }

    // Close the bookmarks tab
    await chrome.tabs.remove(tab.id);

    // Show results notification
    const parts = [`${saved} new`];
    if (updated > 0) parts.push(`${updated} updated`);
    if (skipped > 0) parts.push(`${skipped} unchanged`);
    chrome.notifications.create("sync-done", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "Social Saver Pro — Sync Complete",
      message: `Bookmarks: ${parts.join(", ")}.`,
      priority: 1,
    });

    // Store last sync time
    await chrome.storage.local.set({ lastSyncTime: new Date().toISOString() });
  } catch (err) {
    console.error("[SSP] Bookmark sync failed:", err);
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
