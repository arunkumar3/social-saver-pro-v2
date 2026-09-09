/**
 * Social Saver Pro v2 - Popup Script
 */

const connDot = document.getElementById("conn-dot");
const connText = document.getElementById("conn-text");
const pendingRow = document.getElementById("pending-row");
const pendingCount = document.getElementById("pending-count");
const lastSync = document.getElementById("last-sync");
const syncBtn = document.getElementById("sync-btn");
const dashboardBtn = document.getElementById("dashboard-btn");

// ── Load status on open ──────────────────────────────────────

async function refreshStatus() {
  const stats = await chrome.runtime.sendMessage({ action: "getStats" });

  if (stats.connected) {
    connDot.className = "status-dot dot-green";
    connText.textContent = "Connected";
    syncBtn.disabled = false;
  } else {
    connDot.className = "status-dot dot-red";
    connText.textContent = "Local server not running";
    syncBtn.disabled = true;
  }

  if (stats.pending > 0) {
    pendingRow.hidden = false;
    pendingCount.textContent = `${stats.pending} save${stats.pending === 1 ? "" : "s"}`;
  } else {
    pendingRow.hidden = true;
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

// ── Init ─────────────────────────────────────────────────────

refreshStatus();
