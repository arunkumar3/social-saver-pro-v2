import fs from 'node:fs';
import path from 'node:path';
import { send, readJson } from '../http.js';
import { toNetscape } from '../cookies/netscape.js';

export async function postCookies(req, res, { config }) {
  const body = await readJson(req);
  const cookies = body?.cookies;
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return send(res, 400, { error: 'no_cookies' });
  }
  fs.mkdirSync(path.dirname(config.COOKIES_PATH), { recursive: true });
  fs.writeFileSync(config.COOKIES_PATH, toNetscape(cookies), { encoding: 'utf8', mode: 0o600 });
  return send(res, 200, { ok: true, count: cookies.length, path: config.COOKIES_PATH });
}
