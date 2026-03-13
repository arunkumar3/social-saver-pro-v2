/**
 * Social Saver Pro v2 - Popup Script
 */

const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const totalCount = document.getElementById("total-count");
const lastSync = document.getElementById("last-sync");
const syncBtn = document.getElementById("sync-btn");
const dashboardBtn = document.getElementById("dashboard-btn");
const settingsPanel = document.getElementById("settings-panel");
const toggleSettings = document.getElementById("toggle-settings");
const inputUrl = document.getElementById("input-url");
const inputKey = document.getElementById("input-key");
const saveConfigBtn = document.getElementById("save-config-btn");
const cancelConfigBtn = document.getElementById("cancel-config-btn");
const feedback = document.getElementById("feedback");

// ── Load status on open ──────────────────────────────────────

async function refreshStatus() {
  const stats = await chrome.runtime.sendMessage({ action: "getStats" });

  if (!stats.configured) {
    connDot.className = "status-dot dot-red";
    connText.textContent = "Not configured";
    totalCount.textContent = "—";
    syncBtn.disabled = true;
    // Auto-open settings if not configured
    settingsPanel.classList.add("open");
    toggleSettings.textContent = "▲ Hide Settings";
  } else {
    // Test actual connection
    const test = await chrome.runtime.sendMessage({ action: "testConnection" });
    if (test.success) {
      connDot.className = "status-dot dot-green";
      connText.textContent = "Connected";
      syncBtn.disabled = false;
    } else {
      connDot.className = "status-dot dot-red";
      connText.textContent = "Error";
      syncBtn.disabled = true;
    }
    totalCount.textContent = stats.totalBookmarks ?? "—";
  }

  if (stats.lastSync) {
    const d = new Date(stats.lastSync);
    lastSync.textContent = formatRelativeTime(d);
  }
}

function formatRelativeTime(date) {
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

// ── Load saved config into inputs ────────────────────────────

async function loadConfigInputs() {
  const stored = await chrome.storage.local.get(["supabaseUrl", "supabaseAnonKey"]);
  if (stored.supabaseUrl) inputUrl.value = stored.supabaseUrl;
  if (stored.supabaseAnonKey) inputKey.value = stored.supabaseAnonKey;
}

// ── Settings toggle ──────────────────────────────────────────

toggleSettings.addEventListener("click", () => {
  const isOpen = settingsPanel.classList.toggle("open");
  toggleSettings.textContent = isOpen ? "▲ Hide Settings" : "⚙ Settings";
  if (isOpen) loadConfigInputs();
});

// ── Save config ──────────────────────────────────────────────

saveConfigBtn.addEventListener("click", async () => {
  const url = inputUrl.value.trim().replace(/\/$/, "");
  const key = inputKey.value.trim();

  if (!url || !key) {
    showFeedback("error", "Both fields are required");
    return;
  }

  if (!url.startsWith("https://") || !url.includes("supabase")) {
    showFeedback("error", "Invalid Supabase URL");
    return;
  }

  saveConfigBtn.textContent = "Testing...";
  saveConfigBtn.disabled = true;

  const result = await chrome.runtime.sendMessage({
    action: "saveConfig",
    config: { supabaseUrl: url, supabaseAnonKey: key },
  });

  // Test the connection
  const test = await chrome.runtime.sendMessage({ action: "testConnection" });

  saveConfigBtn.textContent = "Save & Test";
  saveConfigBtn.disabled = false;

  if (test.success) {
    showFeedback("success", "Connected successfully!");
    settingsPanel.classList.remove("open");
    toggleSettings.textContent = "⚙ Settings";
    refreshStatus();
  } else {
    showFeedback("error", `Connection failed: ${test.error}`);
  }
});

cancelConfigBtn.addEventListener("click", () => {
  settingsPanel.classList.remove("open");
  toggleSettings.textContent = "⚙ Settings";
});

// ── Sync button ──────────────────────────────────────────────

syncBtn.addEventListener("click", async () => {
  syncBtn.disabled = true;
  syncBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="animation: spin 1s linear infinite">
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
    Syncing...
  `;

  await chrome.runtime.sendMessage({ action: "manualSync" });

  syncBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
    Done!
  `;

  setTimeout(() => {
    syncBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="23 4 23 10 17 10"/>
        <polyline points="1 20 1 14 7 14"/>
        <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
      </svg>
      Sync Now
    `;
    syncBtn.disabled = false;
    refreshStatus();
  }, 2000);
});

// ── Dashboard button ─────────────────────────────────────────

dashboardBtn.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("dashboardUrl");
  const url = stored.dashboardUrl || "https://social-saver-dashboard.vercel.app";
  chrome.tabs.create({ url });
});

// ── Feedback helper ──────────────────────────────────────────

function showFeedback(type, message) {
  feedback.textContent = message;
  feedback.className = `feedback show ${type}`;
  setTimeout(() => {
    feedback.className = "feedback";
  }, 4000);
}

// ── Init ─────────────────────────────────────────────────────

refreshStatus();
