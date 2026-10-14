import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* Biblioteca local (IPTV_MEDIA_DIR): arquivos de serie no HD viram itens do
   catalogo e sao servidos por /media com autenticacao e suporte a Range. */

const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'iptvlocal-'));
const media = path.join(cache, 'media');
fs.mkdirSync(path.join(media, 'Minha Serie'), { recursive: true });
fs.writeFileSync(path.join(media, 'Minha Serie', 'Minha Serie - S01E01.mp4'), 'aaaabbbbcccc');
fs.writeFileSync(path.join(media, 'Minha Serie', 'Minha Serie - S01E02.mp4'), 'ddddddddeee');
fs.writeFileSync(path.join(media, 'Minha Serie', 'poster.jpg'), 'jpgbytes');
fs.writeFileSync(path.join(media, 'Minha Serie', 'Outra Serie S01E03.mkv'), 'mkv');
fs.writeFileSync(path.join(media, 'Minha Serie', 'tema - musica.mp3'), 'mp3');

process.env.PORT = '0';
process.env.IPTV_CACHE_DIR = cache;
process.env.IPTV_USER = 'tester';
process.env.IPTV_PASS = 'senha123';
process.env.IPTV_MEDIA_DIR = media;

const { start, server, scanLibrary, buildCatchupUrl } = await import('../server.js');

function req(method, pathIn, { headers = {}, body = null } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: pathIn, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          buf: Buffer.concat(chunks),
          body: Buffer.concat(chunks).toString(),
          headers: res.headers,
        })
      );
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let sid = '';
async function ensureStarted() {
  if (!server.listening) {
    start();
    await new Promise((r) => server.once('listening', r));
  }
  if (!sid) {
    const a = await req('POST', '/api/login', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: 'tester', pass: 'senha123' }),
    });
    sid = /iptv_sid=([^;]+)/.exec(a.headers['set-cookie'] || '')?.[1];
    assert.ok(sid, 'login deveria emitir cookie de sessao');
  }
}

const EP = '/media/' + encodeURIComponent('Minha Serie/Minha Serie - S01E01.mp4');

test('scanLibrary: lista os MP4, ignora mkv/mp3 e monta o item', async () => {
  const items = await scanLibrary();
  assert.equal(items.length, 2, 'deveria achar 2 MP4 (mkv/mp3 fora da lista)');
  const it = items[0];
  assert.equal(it.kind, 'tv');
  assert.equal(it.local, true);
  assert.equal(it.type, 'series');
  assert.match(it.id, /^~lib-[0-9a-f]{10}$/);
  assert.equal(it.name, 'Minha Serie S01E01');
  assert.equal(it.primary, '/media/Minha%20Serie/Minha%20Serie%20-%20S01E01.mp4');
  assert.equal(it.logo, '/media/Minha%20Serie/poster.jpg');
  assert.deepEqual(it.categories, ['Séries']);
  assert.equal(it.signal, 'on');
});

test('scanLibrary: id e estavel (independe do caminho absoluto)', async () => {
  const items = await scanLibrary();
  assert.equal(items.find((i) => i.name === 'Minha Serie S01E02').primary, '/media/Minha%20Serie/Minha%20Serie%20-%20S01E02.mp4');
  const set = new Set(items.map((i) => i.id));
  assert.equal(set.size, 2);
});

test('/media exige sessao (401 sem cookie)', async () => {
  await ensureStarted();
  const a = await req('GET', EP);
  assert.equal(a.status, 401);
});

test('/media: serve arquivo com Content-Type e Accept-Ranges', async () => {
  await ensureStarted();
  const { headers } = await req('GET', EP, { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(headers['content-type'], 'video/mp4');
  assert.equal(headers['accept-ranges'], 'bytes');
});

test('/media: Range parcial responde 206 com o trecho pedido', async () => {
  await ensureStarted();
  const a = await req('GET', EP, {
    headers: { Cookie: `iptv_sid=${sid}`, Range: 'bytes=5-9' },
  });
  assert.equal(a.status, 206);
  assert.equal(a.headers['content-range'], 'bytes 5-9/12');
  assert.equal(a.body, 'bbbcc');
});

test('/media: Range satisfativo de novo e 416 fora do limite', async () => {
  await ensureStarted();
  const a = await req('GET', EP, { headers: { Cookie: `iptv_sid=${sid}`, Range: 'bytes=0-3' } });
  assert.equal(a.status, 206);
  assert.equal(a.body, 'aaaa');
  const b = await req('GET', EP, { headers: { Cookie: `iptv_sid=${sid}`, Range: 'bytes=99-200' } });
  assert.equal(b.status, 416);
});

test('/media: traversal sai de MEDIA_DIR da 403', async () => {
  await ensureStarted();
  // barra eundida (%2F) escapa do parse de URL e chega ao handler como ".."
  const a = await req('GET', '/media/..%2F..%2Fetc/passwd', {
    headers: { Cookie: `iptv_sid=${sid}` },
  });
  assert.equal(a.status, 403);
});

test('/media: HEAD so devolve cabecalhos', async () => {
  await ensureStarted();
  const a = await req('HEAD', EP, { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(a.status, 200);
  assert.equal(a.headers['content-length'], '12');
  assert.equal(a.body, '');
});

test('/api/stream-status: exige url (400) e sessao (401)', async () => {
  await ensureStarted();
  const noSid = await req('GET', '/api/stream-status?u=http%3A%2F%2Fx%2Fa.m3u8');
  assert.equal(noSid.status, 401);
  const noUrl = await req('GET', '/api/stream-status', { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(noUrl.status, 400);
});

test('/api/stream-status: bloqueia host privado (403)', async () => {
  await ensureStarted();
  const u = encodeURIComponent('http://127.0.0.1/x.m3u8');
  const a = await req('GET', '/api/stream-status?u=' + u, { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(a.status, 403);
});

test('/api/health/overview: exige sessao e devolve resumo', async () => {
  await ensureStarted();
  const noSid = await req('GET', '/api/health/overview');
  assert.equal(noSid.status, 401);
  const a = await req('GET', '/api/health/overview', { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(a.status, 200);
  const d = JSON.parse(a.body);
  assert.ok(d.streams && typeof d.streams.checked === 'number');
  assert.ok(d.hosts && typeof d.hosts.total === 'number');
  assert.ok(Array.isArray(d.deadHosts));
  assert.ok(Array.isArray(d.sources));
});

test('/api/alternatives: valida id (400/404) e sessao (401)', async () => {
  await ensureStarted();
  const noSid = await req('GET', '/api/alternatives?id=qualquer');
  assert.equal(noSid.status, 401);
  const noId = await req('GET', '/api/alternatives', { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(noId.status, 400);
  const notFound = await req('GET', '/api/alternatives?id=naoexiste123', {
    headers: { Cookie: `iptv_sid=${sid}` },
  });
  assert.equal(notFound.status, 404);
});

test('/api/health/hosts: exige sessao e aceita disparo', async () => {
  await ensureStarted();
  const noSid = await req('POST', '/api/health/hosts');
  assert.equal(noSid.status, 401);
  const a = await req('POST', '/api/health/hosts', { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(a.status, 202);
});

test('/api/dvr: exige sessao e lista gravacoes', async () => {
  await ensureStarted();
  const noSid = await req('GET', '/api/dvr');
  assert.equal(noSid.status, 401);
  const a = await req('GET', '/api/dvr', { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(a.status, 200);
  const d = JSON.parse(a.body);
  assert.equal(typeof d.enabled, 'boolean');
  assert.ok(Array.isArray(d.recordings));
  for (const r of d.recordings) assert.equal(typeof r.transcoding, 'boolean');
});

test('/api/dvr: POST sem canal valido devolve erro controlado', async () => {
  await ensureStarted();
  const noSid = await req('POST', '/api/dvr', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channel: 'x' }),
  });
  assert.equal(noSid.status, 401);
});

test('/api/dvr: start em ISO futuro fica agendado (nao grava o atual)', async () => {
  await ensureStarted();
  const start = new Date(Date.now() + 30 * 60e3);
  const stop = new Date(Date.now() + 60 * 60e3);
  const r = await req('POST', '/api/dvr', {
    headers: { 'Content-Type': 'application/json', Cookie: `iptv_sid=${sid}` },
    body: JSON.stringify({
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      name: 'futuro',
      start: start.toISOString(),
      end: stop.toISOString(),
    }),
  });
  assert.equal(r.status, 200);
  const d = JSON.parse(r.body);
  assert.equal(d.recording.status, 'pending', 'programa futuro nao pode comecar a gravar na hora');
  assert.ok(
    Math.abs(d.recording.start - start.getTime()) < 2000,
    'start deveria ser o horario futuro pedido, nao "agora"'
  );
});

test('/api/dvr: start invalido devolve 400 (nao grava agora)', async () => {
  await ensureStarted();
  const r = await req('POST', '/api/dvr', {
    headers: { 'Content-Type': 'application/json', Cookie: `iptv_sid=${sid}` },
    body: JSON.stringify({
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
      name: 'x',
      start: 'nao-e-data',
      end: 'tambem-nao',
    }),
  });
  assert.equal(r.status, 400);
});

test('/api/dvr: GET expoe limite de simultaneas e uso de disco', async () => {
  await ensureStarted();
  const a = await req('GET', '/api/dvr', { headers: { Cookie: `iptv_sid=${sid}` } });
  const d = JSON.parse(a.body);
  assert.equal(typeof d.maxConcurrent, 'number');
  assert.equal(typeof d.used, 'number');
  assert.equal(typeof d.maxGB, 'number');
});

test('/api/dvr: bloqueia acima do limite de gravacoes simultaneas (409) e aceita force', async () => {
  await ensureStarted();
  const H = { 'Content-Type': 'application/json', Cookie: `iptv_sid=${sid}` };
  const base = Date.now() + 120 * 60e3;
  const at = (ms) => new Date(ms).toISOString();
  const sched = (n) =>
    req('POST', '/api/dvr', {
      headers: H,
      body: JSON.stringify({
        url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8?c' + n,
        name: 'conf' + n,
        start: at(base),
        end: at(base + 30 * 60e3),
      }),
    });
  assert.equal((await sched(1)).status, 200);
  assert.equal((await sched(2)).status, 200);
  const over = await sched(3);
  assert.equal(over.status, 409, 'a terceira no mesmo horario deveria dar conflito');
  const bodyOver = JSON.parse(over.body);
  assert.equal(bodyOver.canForce, true);
  const r = await req('POST', '/api/dvr', {
    headers: H,
    body: JSON.stringify({
      url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8?c4',
      name: 'conf4',
      start: at(base),
      end: at(base + 30 * 60e3),
      force: true,
    }),
  });
  assert.equal(r.status, 200, 'com force deveria aceitar mesmo em conflito');
});

test('/api/dvr/transcode: exige sessao, id valido e gravacao pronta', async () => {
  await ensureStarted();
  const H = { 'Content-Type': 'application/json', Cookie: `iptv_sid=${sid}` };
  const noSid = await req('POST', '/api/dvr/transcode', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'x' }),
  });
  assert.equal(noSid.status, 401);
  assert.equal((await req('POST', '/api/dvr/transcode', { headers: H, body: '{}' })).status, 400);
  const missing = await req('POST', '/api/dvr/transcode', {
    headers: H,
    body: JSON.stringify({ id: 'nao-existe' }),
  });
  assert.equal(missing.status, 404);
});

test('/api/catchup: exige sessao, id e canal com catch-up', async () => {
  await ensureStarted();
  const noSid = await req('GET', '/api/catchup?id=x');
  assert.equal(noSid.status, 401);
  const noId = await req('GET', '/api/catchup', { headers: { Cookie: `iptv_sid=${sid}` } });
  assert.equal(noId.status, 400);
  const missing = await req('GET', '/api/catchup?id=inexistente', {
    headers: { Cookie: `iptv_sid=${sid}` },
  });
  assert.equal(missing.status, 404);
});

test('buildCatchupUrl: substitui placeholders do template', () => {
  const start = Date.UTC(2026, 0, 2, 3, 4, 5);
  const end = start + 30 * 60e3;
  const out = buildCatchupUrl('http://h/x?start={utc}&end={utcend}&dur={duration}', start, end);
  assert.equal(out, `http://h/x?start=${Math.floor(start / 1000)}&end=${Math.floor(end / 1000)}&dur=1800`);
  assert.equal(buildCatchupUrl('{Y}{m}{d}{H}{M}{S}', start, end), '20260102030405');
  assert.equal(buildCatchupUrl('no-placeholders', start, end), 'no-placeholders');
});

test('/api/timeshift: exige sessao e url', async () => {
  await ensureStarted();
  const noSid = await req('POST', '/api/timeshift', {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ u: 'http://x/a.m3u8' }),
  });
  assert.equal(noSid.status, 401);
  const noUrl = await req('POST', '/api/timeshift', {
    headers: { 'Content-Type': 'application/json', Cookie: `iptv_sid=${sid}` },
    body: JSON.stringify({}),
  });
  assert.equal(noUrl.status, 400);
  const priv = await req('POST', '/api/timeshift', {
    headers: { 'Content-Type': 'application/json', Cookie: `iptv_sid=${sid}` },
    body: JSON.stringify({ u: 'http://127.0.0.1/x.m3u8' }),
  });
  assert.ok(priv.status === 400 || priv.status === 403);
});

test.after(() => {
  server.close();
  fs.rmSync(cache, { recursive: true, force: true });
});