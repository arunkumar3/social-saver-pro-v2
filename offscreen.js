/**
 * Social Saver Pro v2 - Offscreen PDF Renderer
 *
 * The MV3 service worker has no DOM and no URL.createObjectURL, so jsPDF runs
 * here instead. background.js creates this document on demand, sends a bookmark,
 * and gets back a blob: URL it can hand to chrome.downloads.
 */

const { jsPDF } = window.jspdf;

// ═══════════════════════════════════════════════════════════════
// LAYOUT CONSTANTS (mm, A4 portrait)
// ═══════════════════════════════════════════════════════════════

const PAGE = { w: 210, h: 297 };
const M = { top: 18, right: 15, bottom: 18, left: 15 };
const CONTENT_W = PAGE.w - M.left - M.right;
const PT_TO_MM = 0.352778;
const DOT = " · ";

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_PX = 1600;

// Blob URLs we handed to the service worker — revoked once the download lands
const liveBlobUrls = new Set();

function lineHeight(fontSizePt, factor = 1.35) {
  return fontSizePt * PT_TO_MM * factor;
}

// ═══════════════════════════════════════════════════════════════
// TEXT SANITIZING
// ═══════════════════════════════════════════════════════════════

// jsPDF's built-in fonts are WinAnsi-encoded. Anything outside Latin-1 (emoji,
// CJK, most symbols) renders as garbage, so normalize what we can and drop the
// rest rather than printing mojibake.
function sanitize(input) {
  if (!input) return "";
  let out = String(input)
    .replace(/\r\n?/g, "\n")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/…/g, "...")
    .replace(/[    　]/g, " ")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[•●▪]/g, "-")
    .replace(/→/g, "->")
    .replace(/←/g, "<-")
    .replace(/×/g, "x");

  // Keep tab/newline + printable ASCII + printable Latin-1 supplement
  out = out.replace(/[^\n\t\x20-\x7E\xA1-\xFF]/g, "");

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function formatDate(value) {
  const d = parseDate(value);
  if (!d) return sanitize(value);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

// ═══════════════════════════════════════════════════════════════
// FILENAME
// ═══════════════════════════════════════════════════════════════

function slugify(text, maxLen) {
  return sanitize(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
}

// chrome.downloads rejects absolute paths, "..", and reserved characters, so
// every component is slugified before it goes near the filename.
function buildFilename(data, folder) {
  const d = parseDate(data.date) || new Date();
  const datePart = d.toISOString().slice(0, 10);
  const handle = slugify((data.authorHandle || "").replace(/^@/, ""), 30) || "unknown";
  const slug = slugify(data.title || data.fullText || "", 50) || "bookmark";
  // Folder keeps its casing; only characters chrome.downloads rejects are stripped
  const dir = String(folder || "SocialSaver").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 40) || "SocialSaver";
  return `${dir}/${datePart}_${handle}_${slug}.pdf`;
}

// ═══════════════════════════════════════════════════════════════
// IMAGES
// ═══════════════════════════════════════════════════════════════

// Route every image through a canvas: normalizes WEBP/GIF (jsPDF only speaks
// JPEG/PNG reliably), downscales monsters, and flattens transparency.
async function fetchImage(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const blob = await res.blob();
  if (blob.size > MAX_IMAGE_BYTES) throw new Error(`too large (${Math.round(blob.size / 1024)}KB)`);

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE_PX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return { dataUrl: canvas.toDataURL("image/jpeg", 0.85), width: w, height: h };
}

// ═══════════════════════════════════════════════════════════════
// PDF BUILDER
// ═══════════════════════════════════════════════════════════════

function ensureSpace(doc, state, height) {
  if (state.y + height > PAGE.h - M.bottom) {
    doc.addPage();
    state.y = M.top;
    return true;
  }
  return false;
}

function writeParagraphs(doc, state, text, { size = 11, color = 30, indent = 0 } = {}) {
  const clean = sanitize(text);
  if (!clean) return;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(size);
  doc.setTextColor(color);

  const lh = lineHeight(size);
  const width = CONTENT_W - indent;

  for (const para of clean.split("\n")) {
    if (!para.trim()) {
      state.y += lh * 0.5;
      continue;
    }
    for (const line of doc.splitTextToSize(para, width)) {
      ensureSpace(doc, state, lh);
      doc.text(line, M.left + indent, state.y);
      state.y += lh;
    }
    state.y += lh * 0.35;
  }
}

function writeHeader(doc, state, data) {
  const title = sanitize(data.title) || "Untitled";

  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.setTextColor(15);
  const titleLh = lineHeight(14);
  for (const line of doc.splitTextToSize(title, CONTENT_W)) {
    ensureSpace(doc, state, titleLh);
    doc.text(line, M.left, state.y);
    state.y += titleLh;
  }

  // Author, handle, date, type
  const bits = [];
  if (data.author) bits.push(sanitize(data.author));
  if (data.authorHandle) bits.push(sanitize(data.authorHandle.replace(/^@?/, "@")));
  if (data.date) bits.push(formatDate(data.date));
  if (data.type) bits.push(sanitize(data.type));

  if (bits.length) {
    state.y += 1;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(120);
    doc.text(bits.join(DOT), M.left, state.y);
    state.y += lineHeight(9);
  }

  // Clickable source link
  if (data.url) {
    doc.setFontSize(9);
    doc.setTextColor(37, 99, 235);
    const display = data.url.length > 95 ? data.url.slice(0, 92) + "..." : data.url;
    doc.textWithLink(sanitize(display), M.left, state.y, { url: data.url });
    state.y += lineHeight(9);
  }

  // Hairline rule
  state.y += 2;
  doc.setDrawColor(210);
  doc.setLineWidth(0.2);
  doc.line(M.left, state.y, PAGE.w - M.right, state.y);
  state.y += 6;
}

function writeBody(doc, state, data) {
  const tweets = Array.isArray(data.tweets) ? data.tweets.filter((t) => t && t.text) : [];

  // Threads keep their per-tweet structure; everything else is one text block.
  if (data.type === "thread" && tweets.length > 1) {
    tweets.forEach((tweet, i) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8);
      doc.setTextColor(150);
      ensureSpace(doc, state, lineHeight(8));
      doc.text(`${i + 1} / ${tweets.length}`, M.left, state.y);
      state.y += lineHeight(8) + 1;

      writeParagraphs(doc, state, tweet.text);
      state.y += 3;
    });
    return;
  }

  const body = data.fullText || tweets.map((t) => t.text).join("\n\n");
  if (sanitize(body)) {
    writeParagraphs(doc, state, body);
  } else {
    writeParagraphs(doc, state, "(No text content was captured for this bookmark.)", {
      size: 10,
      color: 150,
    });
  }
}

async function writeImages(doc, state, images) {
  const urls = (images || []).filter(Boolean).slice(0, MAX_IMAGES);
  if (!urls.length) return;

  state.y += 3;
  for (const url of urls) {
    let img;
    try {
      img = await fetchImage(url);
    } catch (err) {
      // A dead CDN link must never abort the PDF
      console.warn("[SSP:pdf] Skipped image", url, err.message);
      continue;
    }

    const maxH = PAGE.h - M.top - M.bottom;
    let w = CONTENT_W;
    let h = (img.height / img.width) * w;
    if (h > maxH) {
      h = maxH;
      w = (img.width / img.height) * h;
    }

    ensureSpace(doc, state, h + 4);
    try {
      doc.addImage(img.dataUrl, "JPEG", M.left, state.y, w, h);
      state.y += h + 4;
    } catch (err) {
      console.warn("[SSP:pdf] Could not embed image", url, err.message);
    }
  }
}

function writeFooters(doc, savedAt) {
  const total = doc.getNumberOfPages();
  const label = `Saved ${formatDate(savedAt)}${DOT}Social Saver Pro`;

  for (let i = 1; i <= total; i++) {
    doc.setPage(i);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(160);
    doc.text(sanitize(label), M.left, PAGE.h - 10);
    doc.text(`Page ${i} of ${total}`, PAGE.w - M.right, PAGE.h - 10, { align: "right" });
  }
}

async function buildPdf(data, options = {}) {
  const doc = new jsPDF({ unit: "mm", format: "a4", compress: true });
  const state = { y: M.top };

  doc.setProperties({
    title: sanitize(data.title) || "Social Saver bookmark",
    author: sanitize(data.author) || "",
    subject: data.url || "",
    creator: "Social Saver Pro",
  });

  writeHeader(doc, state, data);
  writeBody(doc, state, data);
  if (options.includeImages !== false) {
    await writeImages(doc, state, data.images);
  }
  writeFooters(doc, new Date().toISOString());

  return doc.output("blob");
}

// ═══════════════════════════════════════════════════════════════
// MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleGenerate(msg) {
  const data = msg.data || {};
  const blob = await buildPdf(data, msg.options || {});
  const blobUrl = URL.createObjectURL(blob);
  liveBlobUrls.add(blobUrl);

  return {
    success: true,
    blobUrl,
    filename: buildFilename(data, msg.options && msg.options.folder),
    size: blob.size,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return; // popup/content messages aren't ours

  if (msg.action === "generatePdf") {
    handleGenerate(msg)
      .then(sendResponse)
      .catch((err) => {
        console.error("[SSP:pdf] Generation failed:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // async
  }

  if (msg.action === "revokeBlob") {
    if (liveBlobUrls.has(msg.blobUrl)) {
      URL.revokeObjectURL(msg.blobUrl);
      liveBlobUrls.delete(msg.blobUrl);
    }
    sendResponse({ success: true });
    return false;
  }
});

console.log("[SSP:pdf] Offscreen renderer ready");
