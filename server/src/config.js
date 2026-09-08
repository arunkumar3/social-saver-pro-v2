import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const CONFIG = {
  HOST: '127.0.0.1',
  PORT: 8787,
  DATA_DIR: path.join(root, 'data'),
  MEDIA_DIR: path.join(root, 'data', 'media'),
  DB_PATH: path.join(root, 'data', 'archive.db'),
  COOKIES_PATH: path.join(root, 'data', 'cookies.txt'),
};
