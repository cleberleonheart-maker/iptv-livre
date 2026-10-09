import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Testa que entradas malformadas viram resposta HTTP - nunca derrubam o
   processo (o bug original: cookie '%' e corpo grande rejeitavam o handler). */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvhttp-'));
process.env.PORT = '0';
process.env.IPTV_CACHE_DIR = tmp;
process.env.IPTV_USER = 'tester';
process.env.IPTV_PASS = 'senha123';

const { start, server } = await import('../server.js');

function req(method, path, { headers = {}, body = null } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () =>
        resolve({ status: res.statusCode, body: data, headers: res.headers })
      );
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

async function ensureStarted() {
  if (!server.listening) {
    start();
    await new Promise((r) => server.once('listening', r));
  }
}

test('cookie malformado nao derruba o servidor', async () => {
  await ensureStarted();
  const a = await req('GET', '/api/me', { headers: { Cookie: 'iptv_sid=%' } });
  assert.ok([200, 401].includes(a.status), `status inesperado: ${a.status}`);
  const b = await req('GET', '/health');
  assert.equal(b.status, 200);
});

test('corpo grande demais nao derruba o servidor', async () => {
  await ensureStarted();
  const big = 'x'.repeat(70 * 1024);
  try {
    await req('POST', '/api/login', {
      headers: { 'Content-Type': 'application/json', 'Content-Length': big.length },
      body: big,
    });
  } catch {
    // socket pode ser fechado; o importante e o servidor continuar vivo
  }
  const b = await req('GET', '/health');
  assert.equal(b.status, 200);
});

test('rota inexistente responde 404', async () => {
  await ensureStarted();
  const r = await req('GET', '/nao-existe-xyz');
  assert.equal(r.status, 404);
});

test('login e paginacao do catalogo (offset/hasMore)', async () => {
  await ensureStarted();
  const login = await req('POST', '/api/login', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: 'tester', pass: 'senha123' }),
  });
  assert.equal(login.status, 200, login.body);
  const sid = /iptv_sid=([^;]+)/.exec(login.headers['set-cookie'] || '')?.[1];
  assert.ok(sid);

  const p1 = await req('GET', '/api/catalog?kind=all&limit=3&offset=0', {
    headers: { Cookie: `iptv_sid=${sid}` },
  });
  assert.equal(p1.status, 200, p1.body);
  const d1 = JSON.parse(p1.body);
  assert.equal(d1.offset, 0);
  assert.equal(d1.items.length, 3);
  assert.equal(d1.hasMore, d1.total > 3);

  const p2 = await req('GET', '/api/catalog?kind=all&limit=3&offset=3', {
    headers: { Cookie: `iptv_sid=${sid}` },
  });
  const d2 = JSON.parse(p2.body);
  assert.equal(d2.items.length, 3);
  assert.notEqual(d2.items[0].id, d1.items[0].id);

  const last = await req(`GET`, `/api/catalog?kind=all&limit=100000&offset=0`, {
    headers: { Cookie: `iptv_sid=${sid}` },
  });
  const dl = JSON.parse(last.body);
  assert.equal(last.status, 200);
  assert.ok(dl.total >= dl.items.length);
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});