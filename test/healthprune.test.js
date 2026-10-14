import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// health.json isolado e carregado antes de usar o modulo
const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvhealth-'));
fs.writeFileSync(
  path.join(cache, 'health.json'),
  JSON.stringify({
    at: Date.now(),
    entries: {
      'http://a/x.m3u8': { ok: true, checked: Date.now() },
      'http://b/x.m3u8': { ok: false, why: 'HTTP 404', checked: Date.now() },
      'http://velho/x.m3u8': { ok: true, checked: Date.now() },
    },
  })
);
process.env.IPTV_CACHE_DIR = cache;
const h = await import('../health.js');

test('prune: remove entradas de URLs que nao existem mais', async () => {
  await h.load();
  const removed = h.prune(['http://a/x.m3u8', 'http://b/x.m3u8']);
  assert.equal(removed, 1);
  const entries = h.getHealth().entries;
  assert.deepEqual(Object.keys(entries).sort(), ['http://a/x.m3u8', 'http://b/x.m3u8']);
});

test('prune: mantem tudo quando todas as URLs ainda existem', async () => {
  await h.load();
  const removed = h.prune(new Set(['http://a/x.m3u8', 'http://b/x.m3u8', 'http://velho/x.m3u8']));
  assert.equal(removed, 0);
});

test.after(() => fs.rmSync(cache, { recursive: true, force: true }));
