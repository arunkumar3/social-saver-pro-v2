import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural checks on the page's Copy and Save-as-PDF features. Node has no
// DOM, so these pin the contract that a refactor must not quietly break; the
// behaviour itself is verified in a real browser.

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/** The body of the first `@media print { ... }` block, brace-matched. */
function printBlock(source) {
  const start = source.indexOf('@media print');
  if (start === -1) return null;
  let i = source.indexOf('{', start);
  const open = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
  }
  return null;
}

test('the stylesheet has a print block', () => {
  assert.ok(printBlock(css), 'no @media print block in style.css');
});

test('printing prints only the chosen item, not the rest of the feed', () => {
  const p = printBlock(css);
  assert.match(p, /\.card:not\(\.print-target\)/, 'other cards must be hidden in print');
  for (const sel of ['.top', '.search', '.filters', '.more']) {
    assert.ok(p.includes(sel), `${sel} must be hidden in print`);
  }
});

test('buttons and players never appear in the printed item', () => {
  const p = printBlock(css);
  for (const sel of ['.actions', '.detail-tools', 'video', 'audio']) {
    assert.ok(p.includes(sel), `${sel} must be hidden in the printed item`);
  }
});

test('print-only lines are hidden on screen and shown only in print', () => {
  const screen = css.replace(printBlock(css) ?? '', '');
  assert.match(screen, /\.print-only\s*\{[^}]*display:\s*none/, '.print-only must be hidden on screen');
  assert.match(printBlock(css), /\.print-only\s*\{[^}]*display:\s*block/, '.print-only must show in print');
});

test('Copy uses the async clipboard API', () => {
  assert.ok(code.includes('navigator.clipboard.writeText'), 'copy must use navigator.clipboard.writeText');
  assert.ok(!code.includes('execCommand'), 'execCommand is deprecated and must not be used');
});

test('Save as PDF opens the print dialog and restores the page afterwards', () => {
  assert.ok(code.includes('window.print('), 'Save as PDF must open the print dialog');
  assert.ok(code.includes("'afterprint'"), 'the page title and print markers must be restored on afterprint');
});
