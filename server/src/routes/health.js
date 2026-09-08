import { send } from '../http.js';

export function health(req, res) {
  send(res, 200, { ok: true, version: '1.0.0' });
}
