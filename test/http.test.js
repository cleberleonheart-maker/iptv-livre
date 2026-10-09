import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

/* Testa que entradas malformadas viram resposta HTTP - nunca derrubam o
   processo (o bug original: cookie '%' e corpo grande rejeitavam o handler). */

process.env.PORT = '0';
const { start, server } = await import('../server.js');

function req(method, path, { headers = {}, body = null } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
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

test.after(() => server.close());
