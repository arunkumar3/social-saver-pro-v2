import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// here = <repo root>/server/src/media -> walk up to <repo root>
const repoRoot = path.resolve(here, '..', '..', '..');

/**
 * gallery-dl lives in the project venv, not on the system PATH.
 * Resolved from this module's own location (import.meta.url) rather than
 * process.cwd(), so it works regardless of the directory the server process
 * was launched from.
 */
export function galleryDlPath() {
  return path.resolve(repoRoot, '.venv', 'Scripts', 'gallery-dl.exe');
}
