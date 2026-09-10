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
const igSyncBtn = document.getElementById("ig-sync-btn");
const archiveSummary = document.getElementById("archive-summary");
const downloadRow = document.getElementById("download-row");
const downloadProgress = document.getElementById("download-progress");
const igPreview = document.getElementById("ig-preview");
const igPreviewSummary = document.getElementById("ig-preview-summary");
const igPreviewNote = document.getElementById("ig-preview-note");
const igConfirmBtn = document.getElementById("ig-confirm-btn");
const igCancelBtn = document.getElementById("ig-cancel-btn");

const SERVER = "http://127.0.0.1:8787";
let pollTimer = null;

function formatBytes(n) {
  if (!n) return "0 MB";
  const gb = n / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(n / (1024 ** 2))} MB`;
}

async function fetchStats() {
  try {
    const res = await fetch(`${SERVER}/api/stats`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function renderArchive(stats) {
  if (!stats) { archiveSummary.textContent = "—"; return; }
  const p = stats.items.byPlatform ?? {};
  const parts = [];
  if (p.twitter) parts.push(`${p.twitter} X`);
  if (p.instagram) parts.push(`${p.instagram} IG`);
  const who = parts.length ? parts.join(" · ") : "empty";
  archiveSummary.textContent = stats.items.total
    ? `${who} · ${formatBytes(stats.media.bytes)}`
    : "empty";
}

// While media is downloading the popup polls, so the user can watch a long
// sync progress instead of staring at a button that says nothing.
function renderProgress(stats) {
  if (!stats) { downloadRow.hidden = true; return; }
  const { pending, done, failed } = stats.queue;
  if (pending === 0) {
    downloadRow.hidden = true;
    stopPolling();
    return;
  }
  downloadRow.hidden = false;
  const total = pending + done;
  downloadProgress.textContent =
    `${done} / ${total}` + (failed ? ` · ${failed} failed` : "");
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const stats = await fetchStats();
    renderArchive(stats);
    renderProgress(stats);
  }, 3000);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// A popup is torn down when it closes; clear the interval so it does not
// keep firing against a dead document.
window.addEventListener("unload", stopPolling);

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

  const archive = await fetchStats();
  renderArchive(archive);
  renderProgress(archive);
  if (archive && archive.queue.pending > 0) startPolling();
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

// ── Instagram sync button ────────────────────────────────────

igSyncBtn.addEventListener("click", async () => {
  igSyncBtn.disabled = true;
  const originalHTML = igSyncBtn.innerHTML;
  igSyncBtn.textContent = "Collecting…";
  igPreview.hidden = true;

  // Collects permalinks and diffs them against the archive. Downloads nothing:
  // ingesting is what starts the media stage, and that only happens on confirm.
  const result = await chrome.runtime.sendMessage({ action: "previewInstagramSync" });

  if (!result.ok) {
    igSyncBtn.textContent = "Sync failed";
    console.error("[SSP] Instagram preview failed:", result.error);
    showFeedback("error", result.error);
    setTimeout(() => {
      igSyncBtn.innerHTML = originalHTML;
      igSyncBtn.disabled = false;
    }, 2500);
    return;
  }

  igSyncBtn.innerHTML = originalHTML;

  if (result.newCount === 0) {
    igSyncBtn.disabled = false;
    showFeedback("success", `Already up to date — ${result.total} saved posts, all archived`);
    return;
  }

  igPreviewSummary.textContent =
    `${result.newCount} new of ${result.total} saved · about ${formatBytes(result.estBytes)}`;
  igPreviewNote.textContent = result.estimateIsSeeded
    ? `${result.alreadyArchived} already archived. Size is a rough guess until more media is downloaded.`
    : `${result.alreadyArchived} already archived. Size estimated from your existing media.`;
  igConfirmBtn.textContent = `Download ${result.newCount}`;
  igPreview.hidden = false;
});

igConfirmBtn.addEventListener("click", async () => {
  igConfirmBtn.disabled = true;
  igConfirmBtn.textContent = "Queuing…";
  const result = await chrome.runtime.sendMessage({ action: "commitInstagramSync" });
  igPreview.hidden = true;
  igConfirmBtn.disabled = false;
  igSyncBtn.disabled = false;

  if (result.ok) {
    showFeedback("success", `${result.queued} queued — downloading in the background`);
    startPolling();
  } else {
    showFeedback("error", result.error);
  }
  refreshStatus();
});

igCancelBtn.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "cancelInstagramSync" });
  igPreview.hidden = true;
  igSyncBtn.disabled = false;
});

// ── Dashboard button ─────────────────────────────────────────

dashboardBtn.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("dashboardUrl");
  const url = stored.dashboardUrl || "https://social-saver-dashboard.vercel.app";
  chrome.tabs.create({ url });
});

// ── Init ─────────────────────────────────────────────────────

refreshStatus();
