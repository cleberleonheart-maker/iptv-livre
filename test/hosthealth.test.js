import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// isola o cache: o modulo le IPTV_CACHE_DIR no carregamento
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosthealth-'));
process.env.IPTV_CACHE_DIR = tmp;
const hh = await import('../hosthealth.js');

test('extractHost: pega o hostname em minusculas', () => {
  assert.equal(hh.extractHost('http://EX.com/a.m3u8'), 'ex.com');
  assert.equal(hh.extractHost('https://a.b.c:8880/x?y=1'), 'a.b.c');
  assert.equal(hh.extractHost('nao-e-url'), '');
  assert.equal(hh.extractHost(null), '');
});

test('setHosts + hostIsDead/hostReason: host marcado como morto', () => {
  hh.setHosts({
    'morto.example': { dead: true, why: 'ENOTFOUND', at: Date.now() },
    'vivo.example': { dead: false, at: Date.now() },
  });
  assert.equal(hh.hostIsDead('http://morto.example/x.m3u8'), true);
  assert.equal(hh.hostReason('http://morto.example/x.m3u8'), 'ENOTFOUND');
  assert.equal(hh.hostIsDead('http://vivo.example/x.m3u8'), false);
  assert.equal(hh.hostReason('http://vivo.example/x.m3u8'), null);
  assert.equal(hh.hostIsDead('http://desconhecido.example/x'), false);
});

test('hostDead: entrada expirada nao conta', () => {
  hh.setHosts({ 'velho.example': { dead: true, why: 'ENOTFOUND', at: Date.now() - 7 * 3600e3 } });
  assert.equal(hh.hostDead('velho.example'), false);
});

test('hostStats: conta vivos e mortos', () => {
  hh.setHosts({
    a: { dead: true, at: Date.now() },
    b: { dead: false, at: Date.now() },
    c: { dead: false, at: Date.now() },
  });
  assert.deepEqual(hh.hostStats(), { total: 3, dead: 1, alive: 2 });
});

test('refreshHosts: ENOTFOUND vira host morto; resolvido fica vivo', async () => {
  hh.setHosts({});
  const resolver = async (host) => (host.endsWith('.invalid') ? { code: 'ENOTFOUND' } : { address: '1.2.3.4' });
  const { changed, cache } = await hh.refreshHosts(['nonexistent-rfc2606.invalid', 'vivo.example'], {
    resolver,
  });
  assert.equal(cache.hosts['nonexistent-rfc2606.invalid'].dead, true);
  assert.equal(cache.hosts['nonexistent-rfc2606.invalid'].why, 'ENOTFOUND');
  assert.equal(!!cache.hosts['vivo.example'].dead, false);
  assert.equal(changed, true);
});

test('refreshHosts: timeout de DNS nao marca host como morto', async () => {
  hh.setHosts({});
  const { cache } = await hh.refreshHosts(['lento.example'], { resolver: async () => ({ code: 'ETIMEOUT' }) });
  assert.equal(!!cache.hosts['lento.example'].dead, false);
});

test('refreshHosts: pula hosts com veredito valido (respeita cache)', async () => {
  hh.setHosts({ 'ok.example': { dead: false, at: Date.now() } });
  let calls = 0;
  const { checked, skipped } = await hh.refreshHosts(['ok.example'], {
    resolver: async () => {
      calls++;
      return { address: '1.2.3.4' };
    },
  });
  assert.equal(checked, 0);
  assert.equal(skipped, 1);
  assert.equal(calls, 0);
});
