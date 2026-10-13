import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// "GET //" used to kill the whole server process: new URL('//', base) throws,
// and the parse sat outside the handler's try, so the throw became an
// unhandled rejection. Any web page could send it with
// fetch('http://127.0.0.1:8787//', { mode: 'no-cors' }) and take the archive
// offline until the next logon.
//
// This spawns a real server process. An in-process test cannot catch the
// failure: the unhandled rejection would kill the test runner along with it.

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8797;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rawGet(target) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1', () => {
      s.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('close', () => resolve(got.split('\r\n')[0] || null));
    s.on('error', () => resolve(null));
  });
}

test('an unparseable request path is answered with 400 and the server survives', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: SERVER_DIR,
    env: { ...process.env, SSP_PORT: String(PORT) },
    stdio: 'ignore',
  });
  let exited = false;
  child.on('exit', () => { exited = true; });
  try {
    for (let i = 0; i < 40; i++) {
      if (await fetch(`http://127.0.0.1:${PORT}/health`).then(() => true, () => false)) break;
      await sleep(150);
    }
    for (const target of ['//', '///', '//evil']) {
      const status = await rawGet(target);
      assert.ok(status, `${target}: the connection was dropped with no response`);
      assert.match(status, /^HTTP\/1\.1 400 /, `${target}: got ${status}`);
      await sleep(200);
      assert.equal(exited, false, `${target} killed the server process`);
    }
    const r = await fetch(`http://127.0.0.1:${PORT}/health`);
    assert.equal(r.status, 200, 'the server still serves normal requests afterwards');
  } finally {
    if (!exited) child.kill();
  }
});
