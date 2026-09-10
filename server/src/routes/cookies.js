import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { send, readJson } from '../http.js';
import { toNetscape } from '../cookies/netscape.js';

// NTFS does not translate POSIX mode bits into ACL entries, so the `mode:
// 0o600` passed to fs.writeFileSync below is cosmetic on Windows: it does
// NOT restrict who can read the file there, even though it genuinely does
// restrict access to the owner on POSIX filesystems. On win32 we additionally
// lock the file's ACL down to the current user only, since this file holds a
// live Instagram session token. If that ACL call fails for any reason we log
// a warning and continue — the whole point is defence in depth, and a failed
// ACL lockdown must never take down cookie export (and with it the entire
// Instagram ingest path).
export function defaultRestrictAcl(filePath) {
  if (process.platform !== 'win32') return;
  const user = process.env.USERNAME || process.env.USER;
  if (!user) {
    console.warn('[cookies] could not determine current user; skipping ACL lockdown for', filePath);
    return;
  }
  // Qualify with the domain/machine name (DOMAIN\user), not just the bare
  // username. On a machine whose computer name happens to match the account
  // name, icacls can resolve the bare name to the computer account instead
  // of the actual user, granting Full Control to the wrong principal and
  // silently locking the real user out of the very file it just wrote.
  const qualifiedUser = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${user}` : user;
  try {
    execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${qualifiedUser}:F`], { stdio: 'ignore' });
  } catch (err) {
    console.warn('[cookies] failed to restrict ACL on', filePath, '-', err.message);
  }
}

export async function postCookies(req, res, { config, restrictAcl = defaultRestrictAcl }) {
  const body = await readJson(req);
  const cookies = body?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return send(res, 400, { error: 'no_cookies' });
  }
  fs.mkdirSync(path.dirname(config.COOKIES_PATH), { recursive: true });
  fs.writeFileSync(config.COOKIES_PATH, toNetscape(cookies), { encoding: 'utf8', mode: 0o600 });
  // Belt-and-braces: defaultRestrictAcl already swallows its own errors, but
  // guard the call site too so that ANY restrictAcl implementation (default
  // or injected) can never take cookie export down with it.
  try {
    restrictAcl(config.COOKIES_PATH);
  } catch (err) {
    console.warn('[cookies] failed to restrict ACL on', config.COOKIES_PATH, '-', err.message);
  }
  return send(res, 200, { ok: true, count: cookies.length, path: config.COOKIES_PATH });
}
