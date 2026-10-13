/**
 * FTS5 query building and snippet parsing for the dashboard's search.
 *
 * MATCH has its own syntax, and raw user input breaks it: a stray `"` is a
 * syntax error, a leading `-` is an operator, `NEAR(` opens a group. Quoting
 * every token turns operators and punctuation into literal text, which is
 * what a person typing into a search box means.
 */

// Private-use code points as snippet() markers. They cannot be typed into a
// search box and are vanishingly rare in captions. The server turns them into
// span data, so no markup ever travels inside a string.
export const HIT_OPEN = '';
export const HIT_CLOSE = '';

// A token is only worth searching if it contains a letter or digit. An emoji
// or punctuation-only token tokenizes to nothing, which FTS5 rejects inside a
// phrase, so it is dropped rather than passed through.
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

// Control characters become separators. A NUL inside a quoted FTS5 phrase is
// "unterminated string", which reached the user as a 500.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function toMatchQuery(raw) {
  if (typeof raw !== 'string') return null;
  const tokens = raw
    .replace(CONTROL_CHARS, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ''))
    .filter((t) => HAS_WORD_CHAR.test(t));
  if (tokens.length === 0) return null;
  // The last token gets a prefix star, so results appear while a word is
  // still being typed.
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
    .join(' ');
}

export function toSpans(snippet) {
  const spans = [];
  let hit = false;
  let buf = '';
  const flush = () => {
    if (buf) spans.push({ text: buf, hit });
    buf = '';
  };
  for (const ch of String(snippet ?? '')) {
    if (ch === HIT_OPEN) { flush(); hit = true; }
    else if (ch === HIT_CLOSE) { flush(); hit = false; }
    else buf += ch;
  }
  flush();
  return spans;
}
