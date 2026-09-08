/**
 * Serialize chrome.cookies.Cookie objects into a Netscape cookie file.
 * yt-dlp and gallery-dl both read this format via --cookies.
 */
export function toNetscape(cookies) {
  const lines = ['# Netscape HTTP Cookie File'];
  for (const c of cookies) {
    for (const field of [c.domain, c.path, c.name, c.value]) {
      if (typeof field === 'string' && field.includes('\t')) {
        throw new Error(`Cookie field contains a tab, which would corrupt the file: ${c.name}`);
      }
    }
    const includeSubdomains = c.hostOnly ? 'FALSE' : 'TRUE';
    const domain = c.hostOnly || c.domain.startsWith('.') ? c.domain : `.${c.domain}`;
    lines.push([
      domain,
      includeSubdomains,
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      Math.floor(c.expirationDate ?? 0),
      c.name,
      c.value,
    ].join('\t'));
  }
  return lines.join('\n') + '\n';
}
