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
