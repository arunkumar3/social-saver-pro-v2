import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Item text is written by strangers, and four captions in the real archive
// already contain angle-bracket text. These checks make "render item data
// only as text" a rule the build enforces, not a habit.

const pub = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');

// Strip comments first, so the file can explain the rule without tripping it.
const code = app
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

test('app.js never turns strings into markup', () => {
  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write',
    'createContextualFragment', 'DOMParser', 'srcdoc']) {
    assert.ok(!code.includes(sink), `app.js must not use ${sink}`);
  }
});

test('app.js never evaluates strings as code', () => {
  assert.ok(!/\beval\s*\(/.test(code), 'eval');
  assert.ok(!/new\s+Function\s*\(/.test(code), 'new Function');
  assert.ok(!/set(?:Timeout|Interval)\s*\(\s*['"`]/.test(code), 'string timer');
});

test('app.js never sets a style attribute, which the CSP would refuse', () => {
  assert.ok(!/setAttribute\(\s*['"]style['"]/.test(code));
});

test('index.html has no inline script, style or handlers', () => {
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/<style/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'inline on* handler');
});

test('index.html loads app.js as a module and style.css as a stylesheet', () => {
  assert.match(html, /<script type="module" src="\/app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\/style\.css">/);
});
