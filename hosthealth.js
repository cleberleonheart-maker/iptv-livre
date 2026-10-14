/* ------------------------------------------------------------------ *
 * Veredito por HOST (DNS) — deteccao de provedor morto em massa
 *
 * Quando um provedor sai do ar, TODOS os streams do host dele morrem de
 * uma vez. Em vez de sondar cada URL por HTTP, resolvemos o DNS uma vez
 * por host e marcamos o host inteiro. Assim milhares de streams de um
 * provedor morto sao escondidos sem gastar uma tentativa de rede em cada.
 *
 * So NXDOMAIN (ENOTFOUND) conta como host morto: e conclusivo e estavel.
 * Timeout de DNS e temporario e NAO marca o host como morto.
 * ------------------------------------------------------------------ */

import dns from 'node:dns';
import net from 'node:net';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.IPTV_CACHE_DIR
  ? path.isAbsolute(process.env.IPTV_CACHE_DIR)
    ? process.env.IPTV_CACHE_DIR
    : path.join(__dirname, process.env.IPTV_CACHE_DIR)
  : path.join(__dirname, '.cache');
const HOSTS_FILE = path.join(CACHE_DIR, 'hosts.json');

const DEAD_TTL = Number(process.env.HOST_DEAD_TTL || 3600e3);
const ALIVE_TTL = Number(process.env.HOST_ALIVE_TTL || 3600e3);
const LOOKUP_TIMEOUT = Number(process.env.HOST_LOOKUP_TIMEOUT || 6000);

/* Antes de marcar um host como morto confirmamos com resolvedores publicos:
   um resolver local mal configurado pode devolver NXDOMAIN para um dominio
   que existe, e esconder um canal bom. So e morto se NENHUM resolver publico
   achar o host e ao menos um confirmar NXDOMAIN/ENODATA. */
const PUBLIC_RESOLVERS = (process.env.HOST_DNS_SERVERS || '1.1.1.1,8.8.8.8')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const CONFIRM_TIMEOUT = Number(process.env.HOST_CONFIRM_TIMEOUT || 3000);
const NO_ANSWER = new Set(['ETIMEOUT', 'EERR', 'ESERVFAIL', 'SERVFAIL', 'ECONNREFUSED', 'EREFUSED']);

let cache = { at: 0, hosts: {} };

export function extractHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function systemLookup(host, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve({ code: 'ETIMEOUT' });
    }, ms);
    dns.lookup(host, (err, address) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(err ? { code: err.code || 'EERR' } : { address });
    });
  });
}

function resolveWith(server, host, ms, fn = 'resolve4') {
  return new Promise((resolve) => {
    const r = new dns.Resolver();
    r.setServers([server]);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      resolve('ETIMEOUT');
    }, ms);
    r[fn](host, (err, addrs) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(err ? err.code || 'EERR' : addrs && addrs[0]);
    });
  });
}

/* Resolve via DNS publico (A e AAAA). Retorna um endereco ou null. Usado como
   reserva quando o resolver local falha (timeout/servfail) e na confirmacao
   de host morto. */
async function publicResolve(host, ms) {
  for (const server of PUBLIC_RESOLVERS) {
    for (const fn of ['resolve4', 'resolve6']) {
      const r = await resolveWith(server, host, ms, fn);
      if (r && !NO_ANSWER.has(r) && r !== 'ENOTFOUND' && r !== 'ENODATA') return r;
    }
  }
  return null;
}

/* Resolucao padrao: usa o resolver do sistema e, se ele falhar por timeout ou
   servico fora (nao por NXDOMAIN), tenta os resolvedores publicos — mitigando
   um resolver local instavel. NXDOMAIN fica para confirmDead decidir. */
async function lookup(host, ms) {
  const sys = await systemLookup(host, ms);
  if (sys && sys.address) return sys;
  if (sys && sys.code === 'ENOTFOUND') return sys;
  const pub = await publicResolve(host, ms);
  return pub ? { address: pub } : sys || { code: 'EERR' };
}

async function confirmDead(host) {
  let nx = 0;
  let resolved = false;
  for (const server of PUBLIC_RESOLVERS) {
    for (const fn of ['resolve4', 'resolve6']) {
      const r = await resolveWith(server, host, CONFIRM_TIMEOUT, fn);
      if (r === 'ENOTFOUND' || r === 'ENODATA') nx++;
      else if (r && !NO_ANSWER.has(r)) resolved = true;
    }
  }
  return !resolved && nx > 0;
}

export async function loadHosts() {
  try {
    const data = JSON.parse(await fsp.readFile(HOSTS_FILE, 'utf8'));
    cache = data && data.hosts ? data : { at: 0, hosts: {} };
  } catch {
    cache = { at: 0, hosts: {} };
  }
  return cache;
}

export async function saveHosts() {
  if (!cache.hosts) cache.hosts = {};
  cache.at = Date.now();
  await fsp
    .writeFile(HOSTS_FILE + '.tmp', JSON.stringify(cache))
    .then(() => fsp.rename(HOSTS_FILE + '.tmp', HOSTS_FILE))
    .catch(() => {});
  return cache;
}

function entryOf(host) {
  const e = host ? cache.hosts[host] : null;
  if (!e) return null;
  const ttl = e.dead ? DEAD_TTL : ALIVE_TTL;
  return Date.now() - (e.at || 0) > ttl ? null : e;
}

export function hostDead(host) {
  const e = entryOf(String(host || '').toLowerCase());
  return !!(e && e.dead);
}

export function hostIsDead(url) {
  return hostDead(extractHost(url));
}

export function hostReason(url) {
  const e = entryOf(extractHost(url));
  return e && e.dead ? e.why || 'ENOTFOUND' : null;
}

/* Sonda DNS de uma lista de hosts e atualiza o cache. Pula hosts com veredito
   ainda valido (respeita TTL) — a menos que force=true. Retorna se mudou
   (dead<->alive) para o chamador decidir se reconstroi o catalogo. */
export async function refreshHosts(
  hosts,
  { concurrency = 8, timeout = LOOKUP_TIMEOUT, force = false, onResult, onProgress, resolver = lookup } = {}
) {
  const useConfirm = resolver === lookup;
  const all = [...new Set((hosts || []).map((h) => String(h).toLowerCase()).filter(Boolean))];
  const list = force ? all : all.filter((h) => !entryOf(h));
  const skipped = all.length - list.length;
  let changed = false;
  let done = 0;
  const queue = list.slice();
  const workers = Array.from({ length: Math.min(concurrency, queue.length) || 1 }, async () => {
    while (queue.length) {
      const host = queue.shift();
      let entry;
      if (net.isIP(host)) {
        entry = { dead: false, at: Date.now() };
      } else {
        const r = await resolver(host, timeout);
        let dead = r && r.code === 'ENOTFOUND';
        if (dead && useConfirm) dead = await confirmDead(host);
        entry = dead ? { dead: true, why: 'ENOTFOUND', at: Date.now() } : { dead: false, at: Date.now() };
      }
      const prev = cache.hosts[host];
      if (!prev || !!prev.dead !== !!entry.dead) changed = true;
      cache.hosts[host] = entry;
      if (onResult) onResult(host, entry);
      if (onProgress && ++done % 100 === 0) onProgress(done, list.length);
    }
  });
  await Promise.all(workers);
  await saveHosts();
  return { changed, checked: list.length, skipped, cache };
}

/* Usado pelos testes: injeta um cache conhecido sem tocar o disco. */
export function setHosts(hosts) {
  cache = { at: Date.now(), hosts: hosts || {} };
}

export function getHosts() {
  return cache;
}

export function hostStats() {
  const hosts = Object.values(cache.hosts || {});
  const dead = hosts.filter((e) => e && e.dead).length;
  return { total: hosts.length, dead, alive: hosts.length - dead };
}

export { HOSTS_FILE };
