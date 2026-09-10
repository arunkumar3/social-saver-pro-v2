import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const PORT = Number(process.env.SSP_TEST_PORT) || 8799;

async function pollHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res.json();
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${lastErr}`);
}

test('npm start actually boots the server and serves /health', async () => {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: serverRoot,
    env: { ...process.env, SSP_PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let exited = false;
  let exitInfo = '';
  child.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `code=${code} signal=${signal}`;
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const healthUrl = `http://127.0.0.1:${PORT}/health`;
    const deadline = Date.now() + 5000;
    let body;
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(`server process exited early (${exitInfo}); stderr: ${stderr}`);
      }
      try {
        body = await pollHealth(healthUrl, 200);
        break;
      } catch {
        // keep polling until the outer deadline
      }
    }

    if (!body) {
      if (exited) {
        throw new Error(`server process exited early (${exitInfo}); stderr: ${stderr}`);
      }
      throw new Error(`server never responded on ${healthUrl} within timeout`);
    }

    assert.equal(body.ok, true);
  } finally {
    if (!exited) {
      child.kill();
    }
  }
});
