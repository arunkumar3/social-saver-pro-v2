/**
 * Social Saver Pro v2 - Content Script
 * Captures tweets, threads, and articles from Twitter/X
 */

(function () {
  "use strict";

  let floatingBtn = null;
  let isSaving = false;

  // ═══════════════════════════════════════════════════════════════
  // PAGE TYPE DETECTION
  // ═══════════════════════════════════════════════════════════════

  function getPageType() {
    const url = window.location.href;

    // Bookmarks page — handled by background sync, not manual save
    if (url.includes("/i/bookmarks")) return "bookmarks";

    // Article pages
    if (url.includes("/i/article/") || url.includes("/articles/")) return "article";

    // Check for Article heading
    const headings = document.querySelectorAll('h2 span, [role="heading"] span');
    for (const h of headings) {
      const ht = h.textContent.trim().toLowerCase();
      if (ht === "article" || ht === "notes") return "article";
    }

    // Tweet/thread pages: /username/status/1234
    if (url.match(/\/(status|statuses)\/\d+/)) {
      // Check if it's a thread (multiple tweets from same author)
      const tweets = document.querySelectorAll('article[data-testid="tweet"]');
      if (tweets.length > 1) {
        const authors = new Set();
        tweets.forEach((t) => {
          const handle = t.querySelector('a[href*="/"] > div > span')?.textContent;
          if (handle) authors.add(handle);
        });
        // If mostly same author, it's a thread
        if (tweets.length >= 3 && authors.size <= 2) return "thread";
      }
      return "tweet";
    }

    // Profile page or feed — don't show save button
    return null;
  }

  function isSaveablePage() {
    const type = getPageType();
    return type === "tweet" || type === "thread" || type === "article";
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTENT EXTRACTION — TWEET
  // ═══════════════════════════════════════════════════════════════

  function extractTweet() {
    const pc = document.querySelector('[data-testid="primaryColumn"]') || document;
    
    // The "focal" tweet is the one that's expanded (larger text)
    // It's typically the first article element or the one with larger font
    const articles = pc.querySelectorAll('article[data-testid="tweet"]');
    if (!articles.length) return null;

    // Find the focal tweet — it's usually the first one on a status page
    const focalTweet = articles[0];

    const data = extractTweetData(focalTweet);
    data.type = "tweet";
    data.url = window.location.href.split("?")[0];
    data.fullText = data.text; // handleSaveClick + background.js expect fullText
    data.title = generateTitle(data.text);

    return data;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTENT EXTRACTION — THREAD
  // ═══════════════════════════════════════════════════════════════

  function extractThread() {
    const pc = document.querySelector('[data-testid="primaryColumn"]') || document;
    const articles = pc.querySelectorAll('article[data-testid="tweet"]');
    if (!articles.length) return null;

    // Get the thread author from the first tweet
    const firstTweet = extractTweetData(articles[0]);
    const threadAuthor = firstTweet.authorHandle;

    const tweets = [];
    const seen = new Set();

    for (const article of articles) {
      const td = extractTweetData(article);
      // Only include tweets from the thread author
      if (td.authorHandle === threadAuthor && td.text && !seen.has(td.text)) {
        seen.add(td.text);
        tweets.push(td);
      }
    }

    return {
      type: "thread",
      url: window.location.href.split("?")[0],
      author: firstTweet.author,
      authorHandle: threadAuthor,
      date: firstTweet.date,
      title: generateTitle(tweets.map((t) => t.text).join(" ")),
      tweets: tweets,
      fullText: tweets.map((t) => t.text).join("\n\n"),
      images: tweets.flatMap((t) => t.images),
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // CONTENT EXTRACTION — ARTICLE (from v1, simplified)
  // ═══════════════════════════════════════════════════════════════

  function extractArticle() {
    const pc = document.querySelector('[data-testid="primaryColumn"]') || document;
    const data = {
      type: "article",
      url: window.location.href.split("?")[0],
      title: "",
      author: "",
      authorHandle: "",
      date: "",
      fullText: "",
      images: [],
    };

    // Title
    const skipTitles = new Set(["Article", "Conversation", "Post", "Home", "Explore"]);
    for (const el of pc.querySelectorAll("h1")) {
      const t = el.innerText.trim();
      if (t.length > 5 && !skipTitles.has(t)) { data.title = t; break; }
    }

    // Fallback: X Notes-specific heading selectors
    if (!data.title) {
      const noteHeading = pc.querySelector(
        '[data-testid="article"] h1, [data-testid="articleContent"] h1'
      );
      if (noteHeading) {
        const t = noteHeading.innerText.trim();
        if (t.length > 5 && !skipTitles.has(t)) data.title = t;
      }
    }

    if (!data.title) {
      const h2 = pc.querySelector('article h2[role="heading"], article h2');
      if (h2) {
        const t = h2.innerText.trim();
        if (t.length > 5 && !skipTitles.has(t)) data.title = t;
      }
    }

    // Fallback: tree-walker scanning for large font-size text
    if (!data.title) {
      const article = pc.querySelector("article") || pc;
      const walker = document.createTreeWalker(article, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        const text = node.innerText?.trim();
        if (!text || text.length < 8 || text.length > 120 || skipTitles.has(text)) continue;
        if (text.startsWith("@") || text.startsWith("http")) continue;
        const cs = window.getComputedStyle(node);
        if (parseFloat(cs.fontSize) >= 23) { data.title = text; break; }
      }
    }

    // Author
    const userName = pc.querySelector('[data-testid="User-Name"]');
    if (userName) {
      for (const a of userName.querySelectorAll("a")) {
        const t = a.innerText.trim();
        if (t.startsWith("@")) data.authorHandle = t;
        else if (t.length > 1 && t !== "\u00B7") data.author = data.author || t;
      }
    }

    // Date
    const timeEl = pc.querySelector("time");
    if (timeEl) {
      const dt = timeEl.getAttribute("datetime") || timeEl.innerText;
      try { data.date = new Date(dt).toISOString(); }
      catch { data.date = dt; }
    }

    // Full text — cascading extraction with fallbacks
    const paragraphs = [];

    // Attempt 1: Standard tweetText selector (works for regular tweets embedded in articles)
    pc.querySelectorAll('[data-testid="tweetText"]').forEach((tt) => {
      const text = tt.innerText.trim();
      if (text && text.length > 10) paragraphs.push(text);
    });

    // Attempt 2: X Notes/Article-specific content areas
    if (!paragraphs.length) {
      const articleContent = pc.querySelector(
        '[data-testid="articleContent"], [data-testid="article"], article[role="article"]'
      );
      if (articleContent) {
        articleContent.querySelectorAll('p, [data-testid="tweetText"], div[dir="auto"]').forEach((el) => {
          const text = el.innerText.trim();
          if (text && text.length > 10) paragraphs.push(text);
        });
      }
    }

    // Attempt 3: Grab text from article elements, scoped to the article author only
    // Stop when we hit content from a different author (replies section)
    if (!paragraphs.length) {
      const articleAuthor = data.authorHandle;
      const cells = pc.querySelectorAll('[data-testid="cellInnerDiv"]');
      for (const cell of cells) {
        // Check if this cell belongs to a different author
        if (articleAuthor) {
          const cellHandle = cell.querySelector('[data-testid="User-Name"] a');
          const cellHandleText = cellHandle?.innerText.trim();
          if (cellHandleText && cellHandleText.startsWith("@") && cellHandleText !== articleAuthor) {
            break; // Hit reply section — stop collecting
          }
        }
        cell.querySelectorAll('p, div[dir="auto"], [lang]').forEach((el) => {
          const text = el.innerText.trim();
          if (text && text.length > 20 && !text.startsWith("@") && !text.startsWith("http")) {
            paragraphs.push(text);
          }
        });
      }
    }

    // Attempt 4: Last resort — innerText of first cellInnerDiv section
    if (!paragraphs.length) {
      const firstCell = pc.querySelector('[data-testid="cellInnerDiv"]');
      const mainArea = firstCell || pc.querySelector("article") || pc;
      const allText = mainArea.innerText?.trim();
      if (allText && allText.length > 50) {
        paragraphs.push(allText);
      }
    }

    data.fullText = paragraphs.join("\n\n");

    // Images
    pc.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]').forEach((img) => {
      if (img.src && !img.src.includes("profile_images") && !img.src.includes("emoji")) {
        data.images.push(img.src);
      }
    });

    // Fallback: article images not in tweetPhoto containers
    if (!data.images.length) {
      pc.querySelectorAll('article img[src*="pbs.twimg.com"], img[src*="ton.twimg.com"]').forEach((img) => {
        if (img.src && !img.src.includes("profile_images") && !img.src.includes("emoji") && img.naturalWidth > 100) {
          data.images.push(img.src);
        }
      });
    }

    if (!data.title) data.title = generateTitle(data.fullText);

    return data;
  }

  // ═══════════════════════════════════════════════════════════════
  // SHARED EXTRACTION HELPERS
  // ═══════════════════════════════════════════════════════════════

  function extractTweetData(articleEl) {
    const data = {
      author: "",
      authorHandle: "",
      date: "",
      text: "",
      images: [],
    };

    // Author info
    const userName = articleEl.querySelector('[data-testid="User-Name"]');
    if (userName) {
      for (const a of userName.querySelectorAll("a")) {
        const t = a.innerText.trim();
        if (t.startsWith("@")) data.authorHandle = t;
        else if (t.length > 1 && t !== "\u00B7") data.author = data.author || t;
      }
    }

    // Date
    const timeEl = articleEl.querySelector("time");
    if (timeEl) {
      const dt = timeEl.getAttribute("datetime") || timeEl.innerText;
      try { data.date = new Date(dt).toISOString(); }
      catch { data.date = dt; }
    }

    // Tweet text
    const tweetText = articleEl.querySelector('[data-testid="tweetText"]');
    if (tweetText) {
      data.text = tweetText.innerText.trim();
    }

    // Images
    articleEl.querySelectorAll('[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]').forEach((img) => {
      if (img.src && !img.src.includes("profile_images") && !img.src.includes("emoji")) {
        data.images.push(img.src);
      }
    });

    return data;
  }

  function generateTitle(text) {
    if (!text) return "Untitled";
    // Use first sentence or first 80 chars
    const firstSentence = text.match(/^[^.!?\n]+[.!?]?/);
    if (firstSentence && firstSentence[0].length > 10) {
      return firstSentence[0].substring(0, 100);
    }
    return text.substring(0, 80) + (text.length > 80 ? "..." : "");
  }

  // ═══════════════════════════════════════════════════════════════
  // MAIN EXTRACTION ROUTER
  // ═══════════════════════════════════════════════════════════════

  function extractContent() {
    const type = getPageType();

    switch (type) {
      case "tweet":
        return extractTweet();
      case "thread":
        return extractThread();
      case "article":
        return extractArticle();
      default:
        return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // BOOKMARK PAGE EXTRACTION (for midnight sync)
  // ═══════════════════════════════════════════════════════════════

  // Collect visible bookmark items from current DOM into an accumulator Map.
  // Always overwrites on re-encounter — re-rendered nodes may have richer content.
  function collectVisibleBookmarks(accumulator) {
    const articles = document.querySelectorAll('article[data-testid="tweet"]');

    for (const article of articles) {
      const data = extractTweetData(article);
      if (!data.text || data.text.length < (SSP_CONFIG?.MIN_TWEET_LENGTH || 30)) continue;

      const timeLink = article.querySelector("time")?.closest("a");
      const tweetUrl = timeLink ? "https://x.com" + timeLink.getAttribute("href") : "";

      if (tweetUrl) {
        // Always overwrite — latest render may have expanded t.co links, loaded images
        accumulator.set(tweetUrl, {
          type: "tweet",
          url: tweetUrl,
          title: generateTitle(data.text),
          author: data.author,
          authorHandle: data.authorHandle,
          date: data.date,
          fullText: data.text,
          images: data.images,
        });
      }
    }
  }

  // Scroll and incrementally collect bookmarks to handle DOM virtualization.
  // Returns accumulated bookmarks as an array.
  async function scrollAndCollectBookmarks(maxTime) {
    const max = maxTime || SSP_CONFIG?.MAX_SCROLL_TIME || 60000;
    const start = Date.now();
    const scrollEl = document.scrollingElement || document.documentElement;
    const accumulator = new Map();
    let lastHeight = 0;
    let lastSeenCount = 0;
    let staleCount = 0;
    const SCROLL_WAIT = 2000;
    const STALE_THRESHOLD = 8;

    // Collect initial visible bookmarks
    collectVisibleBookmarks(accumulator);

    while (Date.now() - start < max) {
      // Scroll to bottom
      scrollEl.scrollTop = scrollEl.scrollHeight;
      await new Promise((r) => setTimeout(r, SCROLL_WAIT));

      // Scroll jiggle — scroll up slightly then back down to trigger intersection observers
      scrollEl.scrollTop = scrollEl.scrollHeight - 500;
      await new Promise((r) => setTimeout(r, 300));
      scrollEl.scrollTop = scrollEl.scrollHeight;
      await new Promise((r) => setTimeout(r, 500));

      // Collect any newly visible bookmarks
      collectVisibleBookmarks(accumulator);

      const newHeight = scrollEl.scrollHeight;
      const newSeenCount = accumulator.size;

      // Content is still loading if EITHER scrollHeight changed OR new unique URLs appeared
      if (newHeight === lastHeight && newSeenCount === lastSeenCount) {
        staleCount++;
        console.log(`[SSP] Bookmark scroll: stale ${staleCount}/${STALE_THRESHOLD}, collected ${newSeenCount}`);
        if (staleCount >= STALE_THRESHOLD) break;
      } else {
        staleCount = 0;
        console.log(`[SSP] Bookmark scroll: collected ${newSeenCount} bookmarks`);
      }

      lastHeight = newHeight;
      lastSeenCount = newSeenCount;
    }

    // Scroll back to top
    scrollEl.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 300));

    return Array.from(accumulator.values());
  }

  // ═══════════════════════════════════════════════════════════════
  // FLOATING SAVE BUTTON
  // ═══════════════════════════════════════════════════════════════

  function createFloatingButton() {
    if (floatingBtn) return;

    floatingBtn = document.createElement("div");
    floatingBtn.id = "ssp-save-btn";
    floatingBtn.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      <span>Save</span>
    `;
    floatingBtn.title = "Save to Social Saver Pro";
    floatingBtn.addEventListener("click", handleSaveClick);
    document.body.appendChild(floatingBtn);
  }

  function removeFloatingButton() {
    if (floatingBtn) {
      floatingBtn.remove();
      floatingBtn = null;
    }
  }

  function updateButtonState(state, text) {
    if (!floatingBtn) return;
    const span = floatingBtn.querySelector("span");
    floatingBtn.className = "";
    floatingBtn.id = "ssp-save-btn";

    switch (state) {
      case "saving":
        floatingBtn.classList.add("ssp-saving");
        span.textContent = "Saving...";
        break;
      case "saved":
        floatingBtn.classList.add("ssp-saved");
        span.textContent = text || "Saved ✓";
        break;
      case "error":
        floatingBtn.classList.add("ssp-error");
        span.textContent = text || "Failed ✗";
        break;
      default:
        span.textContent = "Save";
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // SAVE HANDLER
  // ═══════════════════════════════════════════════════════════════

  async function handleSaveClick() {
    if (isSaving) return;
    isSaving = true;
    updateButtonState("saving");

    try {
      // Auto-scroll to ensure all content is loaded
      // Include "tweet" on status pages — it may be a thread that hasn't fully rendered yet
      const type = getPageType();
      if (type === "thread" || type === "article" || type === "tweet") {
        await autoScrollForContent();
      }

      const content = extractContent();

      if (!content || (!content.fullText && (!content.tweets || !content.tweets.length))) {
        updateButtonState("error", "No content");
        setTimeout(() => updateButtonState("default"), 2500);
        return;
      }

      // Send to background service worker for Supabase save
      const response = await chrome.runtime.sendMessage({
        action: "saveContent",
        data: content,
      });

      if (response?.success) {
        if (response.message === "Updated") {
          updateButtonState("saved", "Updated ✓");
        } else if (response.message === "Already saved") {
          updateButtonState("saved", "Already saved");
        } else {
          updateButtonState("saved");
        }
        setTimeout(() => updateButtonState("default"), 2500);
      } else {
        updateButtonState("error", response?.error || "Save failed");
        setTimeout(() => updateButtonState("default"), 3000);
      }
    } catch (err) {
      console.error("[SSP] Save failed:", err);
      updateButtonState("error");
      setTimeout(() => updateButtonState("default"), 3000);
    } finally {
      isSaving = false;
    }
  }

  async function autoScrollForContent() {
    const scrollEl = document.scrollingElement || document.documentElement;
    const startPos = scrollEl.scrollTop;
    const step = window.innerHeight;
    const MAX_TIME = 15000;
    const SCROLL_PAUSE = 500;
    const STALE_LIMIT = 3;
    const start = Date.now();
    let staleCount = 0;
    let lastHeight = scrollEl.scrollHeight;

    let pos = 0;
    while (Date.now() - start < MAX_TIME) {
      pos += step;
      scrollEl.scrollTop = pos;
      await new Promise((r) => setTimeout(r, SCROLL_PAUSE));

      const newHeight = scrollEl.scrollHeight;
      if (newHeight === lastHeight) {
        // Check if we've scrolled past all content
        if (pos >= newHeight) {
          staleCount++;
          if (staleCount >= STALE_LIMIT) break;
        }
      } else {
        staleCount = 0;
        lastHeight = newHeight;
      }
    }

    // Scroll back to top and pause for final re-render
    scrollEl.scrollTop = startPos;
    await new Promise((r) => setTimeout(r, 500));
  }

  // ═══════════════════════════════════════════════════════════════
  // PAGE OBSERVER
  // ═══════════════════════════════════════════════════════════════

  function checkPage() {
    setTimeout(() => {
      if (isSaveablePage()) createFloatingButton();
      else removeFloatingButton();
    }, 800);
    // Recheck after Twitter finishes rendering
    setTimeout(() => {
      if (isSaveablePage() && !floatingBtn) createFloatingButton();
    }, 3000);
  }

  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      removeFloatingButton();
      checkPage();
    }
    if (!floatingBtn && isSaveablePage()) createFloatingButton();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // Listen for messages from background (bookmark sync)
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "extractBookmarks") {
      scrollAndCollectBookmarks(msg.maxScrollTime).then((bookmarks) => {
        sendResponse({ bookmarks });
      });
      return true; // async response
    }

    if (msg.action === "checkPage") {
      sendResponse({ type: getPageType() });
    }

    if (msg.action === "extractContent") {
      const content = extractContent();
      sendResponse({ content });
    }
  });

  checkPage();
})();
