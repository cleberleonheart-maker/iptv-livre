import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { load as loadHealth, getHealth, recheck as recheckHealth, HEALTH_FILE } from './health.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = path.join(__dirname, '.cache');
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const IPTV = 'https://iptv-org.github.io';
const SOURCES = {
  channels: `${IPTV}/api/channels.json`,
  streams: `${IPTV}/api/streams.json`,
  categories: `${IPTV}/api/categories.json`,
  languages: `${IPTV}/api/languages.json`,
};

fs.mkdirSync(CACHE_DIR, { recursive: true });

/* ------------------------------------------------------------------ *
 * Saude dos streams (health.js)
 *
 * SoRemove o que ja foi checado e deu errado. Stream nunca checado
 * continua na lista - melhor mostrar um canal possivelmente morto do que
 * esconder um canal vivo.
 * ------------------------------------------------------------------ */

const health = { entries: {}, ready: false, count: 0 };

/* Um stream so e escondido depois que o veredito "morto" amadurece.
   Isso evita que uma varredura em andamento derrube um canal que esta
   tocando no momento. */
const HEALTH_SETTLE_MS = 60 * 60e3;

function hasSettledDead(entries) {
  for (const e of Object.values(entries)) {
    if (!e || !e.checked || e.ok) continue;
    if (Date.now() - (e.checked || 0) > HEALTH_SETTLE_MS) return true;
  }
  return false;
}

async function reloadHealth() {
  try {
    await loadHealth();
    const entries = getHealth().entries || {};
    const n = Object.keys(entries).length;
    const countChanged = n !== health.count;
    health.entries = entries;
    health.count = n;
    if (!health.ready) {
      health.ready = true;
      console.log(`health: ${n} streams com estado carregado (${HEALTH_FILE})`);
    } else if (countChanged || hasSettledDead(entries)) {
      // varredura terminou mais streams (ou veredito amadureceu): reconstroi
      catalogCache = null;
    }
  } catch {}
}

reloadHealth();
// a varredura pode levar horas; acompanha e aplica o resultado sem reiniciar
setInterval(reloadHealth, 60_000).unref?.();

/* Re-verificacao sob demanda (auto-ao-falhar e botao "re-verificar agora").
   job roda em segundo plano e o cliente acompanha por /api/health/report. */
const recheckJob = { running: false, at: 0, total: 0, done: 0, dead: [], startedAt: 0 };

function knownStreams(cat) {
  const known = new Map();
  for (const it of cat.items)
    for (const s of it.streams || []) if (!known.has(s.url)) known.set(s.url, it.name);
  return known;
}

async function runRecheckJob(targets, known) {
  recheckJob.running = true;
  recheckJob.at = 0;
  recheckJob.total = targets.length;
  recheckJob.done = 0;
  recheckJob.dead = [];
  recheckJob.startedAt = Date.now();
  try {
    await recheckHealth(targets, {
      onResult: (rec) => {
        recheckJob.done++;
        if (!rec.ok)
          recheckJob.dead.push({
            name: known.get(rec.url) || '',
            url: rec.url,
            why: rec.why || '?',
            code: rec.code || null,
          });
        if (recheckJob.dead.length > 500) recheckJob.dead.length = 500;
      },
    });
    await reloadHealth();
    catalogCache = null;
  } catch {} finally {
    recheckJob.running = false;
    recheckJob.at = Date.now();
  }
}

/* Falhas que nao provam morte (CDN anti-bot, rede). As demais (ENOTFOUND,
   HTTP 404/410, url invalida...) sao conclusivas e escondem na hora. */
const SOFT_WHY = new Set([
  'HTTP 401',
  'HTTP 403',
  'HTTP 429',
  'HTTP 500',
  'HTTP 502',
  'HTTP 503',
  'HTTP 504',
  'timeout',
  'ECONNRESET',
  'EPIPE',
  'socket hang up',
  'retornou HTML',
]);

function whyHardDead(why) {
  return !!why && !SOFT_WHY.has(why);
}

function streamAlive(url, { radio = false } = {}) {
  if (!health.ready) return true;
  const e = health.entries[url];
  if (!e || !e.checked) return true; // desconhecido: mantem
  if (e.ok) {
    // canal de TV com stream so de audio nao serve (radio passa)
    return radio || !e.audioOnly;
  }
  // veredito forte esconde na hora; "mole" espera o amadurecimento
  if (whyHardDead(e.why)) return false;
  return Date.now() - (e.checked || 0) < HEALTH_SETTLE_MS;
}

function healthSummary() {
  if (!health.ready) return { checked: 0, alive: 0, dead: 0, enabled: false };
  let checked = 0;
  let alive = 0;
  for (const e of Object.values(health.entries)) {
    if (!e || !e.checked) continue;
    checked++;
    if (e.ok) alive++;
  }
  return {
    checked,
    alive,
    dead: checked - alive,
    enabled: true,
    file: path.basename(HEALTH_FILE),
  };
}

/* Sinal de um canal com base no health.json: "on" (stream confirmado no ar),
   "off" (checado e confirmadamente morto) ou "unknown" (nunca checado). */
function streamSignal(url) {
  if (!health.ready) return 'unknown';
  const e = health.entries[url];
  if (!e || !e.checked) return 'unknown';
  if (e.ok) return 'on';
  return whyHardDead(e.why) ? 'off' : 'unknown';
}

function channelSignal(item) {
  let seen = 'unknown';
  for (const s of item.streams || []) {
    const sig = streamSignal(s.url);
    if (sig === 'on') return 'on';
    if (sig === 'off') seen = 'off';
  }
  return seen;
}

const auth = createAuth(CACHE_DIR, {
  onFirstRun: ({ user, pass }) => {
    console.log('');
    console.log('  ================================================');
    console.log('   LOGIN CRIADO (guarde este usuario e senha)');
    console.log(`   usuario: ${user}`);
    console.log(`   senha:   ${pass}`);
    console.log('   em .cache/users.json  ->  edite para trocar');
    console.log('  ================================================');
    console.log('');
  },
});

/* ------------------------------------------------------------------ *
 * Token de sessao para o Chromecast
 * ------------------------------------------------------------------
 * O receiver do Chromecast busca o stream por conta propria e nao tem o
 * cookie de sessao; entao emitimos um token HMAC curto que ele usa em
 * /proxy?token=... (e que o proxy propaga para os segmentos). */

const CAST_TTL = 6 * 3600e3;
let _secret = null;
function serverSecret() {
  if (_secret) return _secret;
  const file = path.join(CACHE_DIR, 'secret.key');
  try {
    _secret = fs.readFileSync(file, 'utf8').trim();
  } catch {}
  if (!_secret) {
    _secret = crypto.randomBytes(32).toString('hex');
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(file, _secret, { mode: 0o600 });
    } catch {}
  }
  return _secret;
}
function hmac(data) {
  return crypto.createHmac('sha256', serverSecret()).update(data).digest('base64url');
}
function makeCastToken(user) {
  const payload = `${Date.now() + CAST_TTL}.${user}`;
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + hmac(payload);
}
function verifyCastToken(token) {
  if (!token) return null;
  const [b64, sig] = String(token).split('.');
  if (!b64 || !sig) return null;
  let payload;
  try {
    payload = Buffer.from(b64, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const dot = payload.indexOf('.');
  const exp = Number(payload.slice(0, dot));
  if (!exp || exp < Date.now()) return null;
  return payload.slice(dot + 1) || null; // usuario
}

/* ------------------------------------------------------------------ *
 * HTTP fetch helper with on-disk cache
 * ------------------------------------------------------------------ */

const MAX_FETCH_BYTES = 32 * 1024 * 1024; // teto de download por fetch
const MAX_DECOMPRESS = 64 * 1024 * 1024; // teto ao descomprimir (anti zip-bomb)

/* Opcoes de zlib que recusam saida gigante (bomba de descompressao). */
const INFLATE_OPTS = { maxOutputLength: MAX_DECOMPRESS };

async function fetchBuf(
  url,
  { ttl = 6 * 3600e3, referer, headers = {}, timeout = 90000, guard = false } = {}
) {
  const key = path.join(
    CACHE_DIR,
    createHash(url) + '.bin'
  );
  const metaFile = key + '.json';

  try {
    const meta = JSON.parse(await fsp.readFile(metaFile, 'utf8'));
    if (Date.now() - meta.at < ttl) {
      const buf = await fsp.readFile(key);
      return { buf, cached: true, at: meta.at };
    }
  } catch {}

  // valida so no cache-miss (evita DNS lookup a cada logo ja em cache)
  if (guard) await assertPublicUrl(url);

  const res = await rawFetch(url, { referer, headers, timeout, guard });
  await fsp.writeFile(key, res.body).catch(() => {});
  await fsp
    .writeFile(metaFile, JSON.stringify({ at: Date.now(), url }))
    .catch(() => {});
  return { buf: res.body, cached: false, at: Date.now() };
}

function rawFetch(
  url,
  { referer, headers = {}, timeout = 15000, guard = false, hops = 0 } = {}
) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (hops >= 5) {
            reject(new Error(`redirects demais em ${url}`));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          const follow = () =>
            rawFetch(next, { referer, headers, timeout, guard, hops: hops + 1 }).then(
              resolve,
              reject
            );
          if (guard) {
            assertPublicUrl(next).then(follow, (e) =>
              reject(new Error(`redirect bloqueado: ${e.message}`))
            );
          } else {
            follow();
          }
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} em ${url}`));
          return;
        }
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len > MAX_FETCH_BYTES) {
            req.destroy(new Error(`resposta grande demais em ${url}`));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => resolve({ body: Buffer.concat(chunks) }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error(`timeout em ${url}`));
    });
    req.end();
  });
}

function createHash(str) {
  return crypto.createHash('sha1').update(str).digest('hex').slice(0, 16);
}

/* ------------------------------------------------------------------ *
 * Catálogo de canais
 * ------------------------------------------------------------------ */

let catalogCache = null;

function readCustomCatalog() {
  const file = path.join(CACHE_DIR, 'custom.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { streams: [], addedAt: 0 };
  }
}

/* Favoritos por usuario (sincroniza APK/celular). Escrita atomica. */
function favFile(user) {
  const safe = String(user).replace(/[^a-zA-Z0-9._-]/g, '') || 'default';
  return path.join(CACHE_DIR, 'favs-' + safe + '.json');
}
function readFavs(user) {
  try {
    return JSON.parse(fs.readFileSync(favFile(user), 'utf8'));
  } catch {
    return [];
  }
}
function writeFavs(user, list) {
  const file = favFile(user);
  fs.writeFileSync(file + '.tmp', JSON.stringify(list));
  fs.renameSync(file + '.tmp', file);
}

/* Historico por usuario: guarda os ultimos canais e a posicao de playback,
   para "continuar de onde parou" valer tambem no APK e no celular. */
function historyFile(user) {
  const safe = String(user).replace(/[^a-zA-Z0-9._-]/g, '') || 'default';
  return path.join(CACHE_DIR, 'history-' + safe + '.json');
}
function readHistory(user) {
  try {
    const d = JSON.parse(fs.readFileSync(historyFile(user), 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch {
    return [];
  }
}
function writeHistory(user, list) {
  const file = historyFile(user);
  fs.writeFileSync(file + '.tmp', JSON.stringify(list));
  fs.renameSync(file + '.tmp', file);
}
const HISTORY_MAX = 100;
function upsertHistory(user, { id, pos, dur, live }) {
  if (!id || typeof id !== 'string') return null;
  const list = readHistory(user).filter((h) => h && h.id !== id);
  list.unshift({
    id: id.slice(0, 200),
    at: Date.now(),
    pos: Number.isFinite(pos) ? Math.max(0, Math.floor(pos)) : 0,
    dur: Number.isFinite(dur) ? Math.max(0, Math.floor(dur)) : 0,
    live: !!live,
  });
  const trimmed = list.slice(0, HISTORY_MAX);
  writeHistory(user, trimmed);
  return trimmed;
}

/* Controle parental por usuario: PIN (scrypt) + categorias bloqueadas.
   Fica liberado por 30 min depois de acertar o PIN. */
function parentalFile(user) {
  const safe = String(user).replace(/[^a-zA-Z0-9._-]/g, '') || 'default';
  return path.join(CACHE_DIR, 'parental-' + safe + '.json');
}
function readParental(user) {
  try {
    const d = JSON.parse(fs.readFileSync(parentalFile(user), 'utf8'));
    if (d && d.hash && d.salt) return d;
  } catch {}
  return null;
}
function writeParental(user, cfg) {
  const file = parentalFile(user);
  if (!cfg) {
    try {
      fs.unlinkSync(file);
    } catch {}
    return;
  }
  fs.writeFileSync(file + '.tmp', JSON.stringify(cfg));
  fs.renameSync(file + '.tmp', file);
}
function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 64).toString('hex') };
}
function verifyPin(cfg, pin) {
  if (!cfg) return false;
  const { hash } = hashPin(pin, cfg.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(cfg.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const parentalUnlock = new Map(); // user -> timestamp ate quando esta liberado
const PARENTAL_UNLOCK_MS = 30 * 60e3;
function parentalState(user) {
  const cfg = readParental(user);
  if (!cfg) return { configured: false, unlocked: true, blocked: [] };
  return {
    configured: true,
    unlocked: (parentalUnlock.get(user) || 0) > Date.now(),
    blocked: cfg.blocked || [],
  };
}
function parentalActive(user) {
  const cfg = readParental(user);
  if (!cfg) return false;
  return (parentalUnlock.get(user) || 0) <= Date.now();
}
function parentalFilter(items, user) {
  if (!parentalActive(user)) return items;
  const blocked = new Set(readParental(user)?.blocked || []);
  if (!blocked.size) return items;
  return items.filter((i) => !i.categories.some((c) => blocked.has(c)));
}

async function buildCatalog() {
  if (catalogCache && Date.now() - catalogCache.at < 6 * 3600e3) return catalogCache;

  const [chRes, stRes] = await Promise.all([
    fetchBuf(SOURCES.channels),
    fetchBuf(SOURCES.streams),
  ]);

  const channels = JSON.parse(chRes.buf.toString('utf8'));
  const streams = JSON.parse(stRes.buf.toString('utf8'));
  const custom = readCustomCatalog();

  const byId = new Map();
  for (const ch of channels) byId.set(ch.id, ch);

  // agrupa streams por canal
  const streamsByChannel = new Map();
  const orphans = [];
  for (const st of streams) {
    if (!st.channel) {
      if (st.title && st.url) orphans.push(st);
      continue;
    }
    const list = streamsByChannel.get(st.channel) || [];
    list.push(st);
    streamsByChannel.set(st.channel, list);
  }

  // streams do usuário têm prioridade e stream proprio
  const customByChannel = new Map();
  for (const st of custom.streams) {
    const list = customByChannel.get(st.channel) || [];
    list.push({ ...st, quality: st.quality || null, custom: true });
    customByChannel.set(st.channel, list);
  }

  const items = [];
  const ids = new Set([...streamsByChannel.keys(), ...customByChannel.keys()]);

  for (const id of ids) {
    const meta = byId.get(id);
    let list = [...(customByChannel.get(id) || []), ...(streamsByChannel.get(id) || [])];

    // descarta apenas streams ja sabidamente mortos
    const before = list.length;
    list = list.filter((s) => streamAlive(s.url));
    if (!list.length && before) continue; // canal sem nenhum link vivo
    const primary = list[0];
    const name =
      meta?.name ||
      list.find((s) => s.title)?.title ||
      id.split('.')[0];

    items.push({
      id,
      name,
      country: meta?.country || null,
      categories: meta?.categories || [],
      isNsfw: !!meta?.is_nsfw,
      closed: !!meta?.closed,
      logo: `https://cdn.iptv-org.net/logo/${id}.png`,
      altNames: meta?.alt_names || [],
      streams: list.map((s) => ({
        url: s.url,
        quality: s.quality || null,
        title: s.title || null,
        feed: s.feed || null,
        labels: s.labels || [],
        custom: !!s.custom,
      })),
      primary: primary.url,
      signal: list.some((s) => streamSignal(s.url) === 'on') ? 'on' : 'unknown',
    });
  }

  // canais extras (sem metadado) entram pelo titulo do stream
  for (const st of orphans) {
    if (!streamAlive(st.url)) continue;
    const key = `~${st.title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
    if (ids.has(key)) continue;
    ids.add(key);
    items.push({
      id: key,
      name: st.title,
      country: null,
      categories: ['general'],
      isNsfw: false,
      closed: false,
      logo: '',
      altNames: [],
      streams: [
        {
          url: st.url,
          quality: st.quality || null,
          title: st.title,
          feed: st.feed || null,
          labels: st.labels || [],
          custom: false,
        },
      ],
      primary: st.url,
      signal: streamSignal(st.url) === 'on' ? 'on' : 'unknown',
    });
  }

  // itens de TV recebem kind explicito; o radio entra depois
  for (const it of items) it.kind = 'tv';

  const radio = await buildRadio();
  const all = items.concat(radio.items);

  catalogCache = {
    at: Date.now(),
    items: all,
    radioError: radio.error,
    stats: {
      channels: items.length,
      streams: items.reduce((n, i) => n + i.streams.length, 0),
      countries: new Set(all.map((i) => i.country).filter(Boolean)).size,
      radio: radio.items.length,
      total: all.length,
      health: healthSummary(),
    },
  };
  return catalogCache;
}

/* ------------------------------------------------------------------ *
 * Importador de M3U do usuário
 * ------------------------------------------------------------------ */

function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let pending = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      const attrs = {};
      const attrRe = /([a-zA-Z0-9-]+)="([^"]*)"/g;
      let m;
      while ((m = attrRe.exec(line))) attrs[m[1].toLowerCase()] = m[2];
      const name = line.split(',').slice(1).join(',').trim() || 'Sem nome';
      pending = {
        name,
        id: (attrs['tvg-id'] || '').split('@')[0] || null,
        logo: attrs['tvg-logo'] || '',
        group: attrs['group-title'] || 'general',
        country: attrs['tvg-country'] || null,
        attrs,
      };
      continue;
    }

    if (line.startsWith('#')) continue;

    if (pending) {
      out.push({
        channel: pending.id,
        title: pending.name,
        logo: pending.logo,
        group: pending.group,
        country: pending.country,
        url: line,
      });
      pending = null;
    }
  }
  return out;
}

async function importCustom(url) {
  const res = await fetchBuf(url, { ttl: 30 * 60e3, guard: true });
  let text = res.buf.toString('utf8');
  if (text.charCodeAt(0) === 0x1f && text.charCodeAt(1) === 0x8b) {
    text = zlib.gunzipSync(res.buf, INFLATE_OPTS).toString('utf8');
  }
  const parsed = parseM3U(text);
  const file = path.join(CACHE_DIR, 'custom.json');
  await fsp.writeFile(
    file,
    JSON.stringify({ url, streams: parsed, addedAt: Date.now() }, null, 0)
  );
  catalogCache = null;
  return { count: parsed.length };
}

/* ------------------------------------------------------------------ *
 * EPG
 * ------------------------------------------------------------------ */

let epgCache = null;
const DEFAULT_EPG = 'https://epg.pw/xmltv/epg_BR.xml.gz';
const EPG_LIST = [
  { id: 'BR', name: 'Brasil', url: DEFAULT_EPG },
  { id: 'US', name: 'Estados Unidos', url: 'https://epg.pw/xmltv/epg_US.xml.gz' },
  { id: 'ES', name: 'Espanha', url: 'https://epg.pw/xmltv/epg_ES.xml.gz' },
  { id: 'DE', name: 'Alemanha', url: 'https://epg.pw/xmltv/epg_DE.xml.gz' },
  { id: 'FR', name: 'Franca', url: 'https://epg.pw/xmltv/epg_FR.xml.gz' },
  { id: 'CA', name: 'Canada', url: 'https://epg.pw/xmltv/epg_CA.xml.gz' },
  { id: 'AU', name: 'Australia', url: 'https://epg.pw/xmltv/epg_AU.xml.gz' },
  { id: 'IN', name: 'India', url: 'https://epg.pw/xmltv/epg_IN.xml.gz' },
];

/* Carrega o guia BR na primeira consulta e guarda em disco, para nao
   baixar 500 KB de novo a cada boot do servidor. */
async function ensureEpg() {
  if (epgCache) return epgCache;

  const file = path.join(CACHE_DIR, 'epg.json');
  try {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8'));
    if (Date.now() - saved.at < 6 * 3600e3) {
      // no disco ficam como arrays; aqui voltam a ser Map
      epgCache = {
        channels: new Map(saved.epg.channels),
        programs: new Map(saved.epg.programs),
        src: saved.epg.src,
      };
      epgCache.index = buildEpgIndex(epgCache);
      return epgCache;
    }
  } catch {}

  const r = await fetchBuf(DEFAULT_EPG, { ttl: 3 * 3600e3 });
  let buf = r.buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  epgCache = parseXMLTV(buf.toString('utf8'));
  epgCache.index = buildEpgIndex(epgCache);
  epgCache.src = DEFAULT_EPG;
  persistEpg();

  return epgCache;
}

/* Grava o EPG em disco (atual e o escolhido por ?src=) */
function persistEpg() {
  if (!epgCache) return;
  const plain = {
    programs: [...epgCache.programs],
    channels: [...epgCache.channels],
    src: epgCache.src,
  };
  fsp
    .writeFile(path.join(CACHE_DIR, 'epg.json'), JSON.stringify({ at: Date.now(), epg: plain }))
    .catch(() => {});
}

function parseXMLTV(xml) {
  const programs = new Map();
  const channels = new Map();

  const chanRe = /<channel\s+id="([^"]+)"[\s\S]*?<\/channel>/g;
  let m;
  while ((m = chanRe.exec(xml))) {
    const id = m[1];
    const nameM = /<display-name[^>]*>([\s\S]*?)<\/display-name>/.exec(m[0]);
    const iconM = /<icon\s+src="([^"]+)"/.exec(m[0]);
    channels.set(id, {
      name: nameM ? nameM[1].trim() : id,
      logo: iconM ? iconM[1] : '',
    });
  }

  // <programme> pode ter os atributos em qualquer ordem -> extrai por atributo
  const progRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g;
  while ((m = progRe.exec(xml))) {
    const attrs = m[1];
    const body = m[2];
    const pick = (n) => {
      const r = new RegExp(n + '="([^"]*)"').exec(attrs);
      return r ? r[1] : null;
    };
    const start = pick('start');
    const stop = pick('stop');
    const ch = pick('channel');
    if (!start || !stop || !ch) continue;

    const titleM = /<title[^>]*>([\s\S]*?)<\/title>/.exec(body);
    const descM = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(body);
    if (!programs.has(ch)) programs.set(ch, []);
    programs.get(ch).push({
      start: xmltvTime(start),
      stop: xmltvTime(stop),
      title: titleM ? decodeEntities(titleM[1]).trim() : 'Sem titulo',
      desc: descM ? decodeEntities(descM[1]).trim().slice(0, 400) : '',
    });
  }
  return { programs, channels };
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/* XMLTV usa "20261005000000 +0000"; a saida vira ISO para o front. */
function xmltvTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4}|Z)?/.exec(s.trim());
  if (!m) return s;
  const tz = !m[7] ? 'Z' : m[7] === 'Z' ? 'Z' : `${m[7].slice(0, 3)}:${m[7].slice(3)}`;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${tz}`;
}

/* Casamento entre o EPG (ids proprios, geralmente numericos) e o catalogo
   do iptv-org (ids tipo "Band.br"), feito pelo nome normalizado. */

const norm = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\b(hd|sd|fhd|uhd|4k|ao vivo|live|hd tv)\b/g, '')
    .replace(/[^a-z0-9]/g, '');

/* programs e um Map por canal; o total e a soma das listas */
function countProgrammes(epg) {
  let n = 0;
  for (const list of epg.programs.values()) n += list.length;
  return n;
}

function buildEpgIndex(epg) {
  const index = new Map();
  for (const [id, ch] of epg.channels) {
    const key = norm(ch.name);
    if (key && !index.has(key)) index.set(key, id);
  }
  return index;
}

function findEpgChannel(epg, index, channel) {
  const names = [channel.name, ...(channel.altNames || [])];
  for (const n of names) {
    const key = norm(n);
    if (index.has(key)) return index.get(key);
  }
  // sem casamento exato: tenta sufixo/prefixo (ex: "record news" ~ "record")
  for (const n of names) {
    const key = norm(n);
    if (key.length < 4) continue;
    for (const [k, id] of index) {
      if (k.includes(key) || key.includes(k)) return id;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * Radio (radio-browser.info) - estacoes abertas, todas gratuitas
 * ------------------------------------------------------------------ */

const RADIO_API = 'https://de1.api.radio-browser.info/json';
const RADIO_COUNT = Number(process.env.RADIO_COUNT || 1500);
let radioCache = null;

async function buildRadio() {
  if (radioCache && Date.now() - radioCache.at < 12 * 3600e3) return radioCache;

  const servers = ['de1', 'de2', 'at1'];
  let stations = null;
  let lastErr = null;

  for (const s of servers) {
    try {
      const r = await fetchBuf(
        `https://${s}.api.radio-browser.info/json/stations/topvote/${RADIO_COUNT}`,
        { ttl: 12 * 3600e3, timeout: 60000 }
      );
      stations = JSON.parse(r.buf.toString('utf8'));
      if (Array.isArray(stations) && stations.length) break;
    } catch (e) {
      lastErr = e;
      stations = null;
    }
  }

  if (!Array.isArray(stations)) {
    radioCache = { at: Date.now(), items: [], error: lastErr?.message || 'sem resposta' };
    return radioCache;
  }

  const items = [];
  const seen = new Set();

  for (const st of stations) {
    const url = st.url_resolved || st.url;
    if (!/^https?:\/\//.test(url || '')) continue;
    if (seen.has(url)) continue;
    if (!streamAlive(url, { radio: true })) continue;

    const codec = (st.codec || '').toUpperCase();
    // o player so toca o que o navegador decodifica sem plugin
    if (codec && !['MP3', 'AAC', 'AAC+', 'AACP', 'AAC+ (HE-AAC)', 'OGG'].includes(codec))
      continue;
    if (st.codec === 'MP3' && Number(st.bitrate) > 320) continue;

    seen.add(url);

    const tags = (st.tags || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 4);
    const genre = tags.find((t) =>
      ['music', 'news', 'talk', 'sports', 'classical', 'oldies', 'pop', 'rock',
       'jazz', 'country', 'electronic', 'hip hop', 'rap', 'reggae', 'latin',
       'world', 'public radio', 'culture', 'religion', 'comedy', 'station'].includes(t)
    ) || 'music';

    const name = (st.name || 'Sem nome').trim().slice(0, 80);
    const key = '~radio:' + createHash(name + st.countrycode);

    items.push({
      id: key,
      kind: 'radio',
      name,
      country: st.countrycode || null,
      categories: [genre],
      isNsfw: false,
      closed: false,
      logo: st.favicon || '',
      altNames: [],
      bitrate: st.bitrate ? Number(st.bitrate) : null,
      codec: st.codec || null,
      streams: [
        {
          url,
          quality: st.bitrate ? Math.round(st.bitrate / 8) + 'k' : null,
          title: name,
          feed: null,
          labels: tags,
          custom: false,
        },
      ],
      primary: url,
      signal: streamSignal(url) === 'on' ? 'on' : 'unknown',
    });
  }

  radioCache = { at: Date.now(), items, error: null };
  return radioCache;
}

/* ------------------------------------------------------------------ *
 * HTTP helpers
 * ------------------------------------------------------------------ */

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        reject(new Error('corpo grande demais'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- protecoes simples ---------------- */

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a === 169 ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
    );
  }
  const l = ip.toLowerCase();
  return (
    l === '::' || l === '::1' ||
    l.startsWith('fe8') || l.startsWith('fc') || l.startsWith('fd')
  );
}

/* Bloqueia URL para IPs privados/loopback (anti-SSRF no /api/import). */
async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('apenas HTTP(S)');
  const host = u.hostname;
  const addr = net.isIP(host) ? host : (await dns.lookup(host)).address;
  if (isPrivateIP(addr)) throw new Error('endereco privado bloqueado');
}

/* Rate-limit simples por IP: apos 10 falhas em 10min, bloqueia 15min. */
const loginFails = new Map();
function loginGuard(ip) {
  const rec = loginFails.get(ip);
  if (rec && rec.until > Date.now() && rec.count >= 10) {
    return {
      blocked: true,
      retryAfter: Math.ceil((rec.until - Date.now()) / 1000),
    };
  }
  return { blocked: false };
}
function noteLoginFail(ip) {
  const now = Date.now();
  const rec = loginFails.get(ip) || { count: 0, first: now, until: 0 };
  if (now - rec.first > 10 * 60e3) {
    rec.count = 0;
    rec.first = now;
  }
  rec.count++;
  if (rec.count >= 10) rec.until = now + 15 * 60e3;
  loginFails.set(ip, rec);
}
function noteLoginOk(ip) {
  loginFails.delete(ip);
}

function send(res, status, body, headers = {}) {
  const req = res.req;
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const ctype = headers['Content-Type'] || '';
  const compressible =
    !/image\//.test(ctype) &&
    !/audio\//.test(ctype) &&
    !/video\//.test(ctype) &&
    !ctype.includes('application/zip') &&
    buf.length >= 1024;
  const enc = compressible ? pickEncoding(req?.headers['accept-encoding']) : null;
  if (enc) {
    buf = enc === 'br' ? zlib.brotliCompressSync(buf) : zlib.gzipSync(buf);
    headers = { ...headers, 'Content-Encoding': enc, Vary: 'Accept-Encoding' };
  }
  headers = {
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    ...headers,
  };
  res.writeHead(status, headers);
  res.end(buf);
}

function pickEncoding(header = '') {
  const encodings = header.split(',').map((e) => e.trim().split(';')[0]);
  if (encodings.includes('br')) return 'br';
  if (encodings.includes('gzip')) return 'gzip';
  return null;
}

function sendJSON(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.xml': 'application/xml; charset=utf-8',
};

/* Muitos logos vem de URLs sem extensao; descobre o tipo real pelo conteudo. */
function sniffImage(buf, ext) {
  if (buf.length >= 4) {
    if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'image/gif';
    if (
      buf.slice(0, 4).toString('ascii') === 'RIFF' &&
      buf.slice(8, 12).toString('ascii') === 'WEBP'
    )
      return 'image/webp';
    const head = buf.slice(0, 300).toString('utf8').trimStart();
    if (head.startsWith('<svg') || head.startsWith('<?xml')) return 'image/svg+xml';
  }
  return MIME[ext] || 'image/png';
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'proibido');

  try {
    const st = await fsp.stat(file);
    if (st.isDirectory()) return serveStatic(req, res, path.posix.join(rel, 'index.html'));
    const ext = path.extname(file).toLowerCase();
    const data = await fsp.readFile(file);
    const noCache = ext === '.html' || ext === '.js' || ext === '.css' || ext === '.webmanifest';
    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': noCache ? 'no-store, no-cache, must-revalidate' : 'public, max-age=3600',
    };
    if (noCache) {
      headers.Pragma = 'no-cache';
      headers.Expires = '0';
    }
    send(res, 200, data, headers);
  } catch {
    send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
}

/* ------------------------------------------------------------------ *
 * Proxy de stream (resolve CORS + HTTP)
 * ------------------------------------------------------------------ */

/* Versao streaming: entrega o response aberto para o consumidor.
   Necessario para radio e live, que nunca "terminam" - bufferizar
   essas respostas trava o proxy. */
function upstream(url, { referer, headers = {}, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      {
        method: 'GET',
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
          'Icy-MetaData': '1',
          ...(referer ? { Referer: referer } : {}),
          ...headers,
        },
        timeout,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, url).toString();
          upstream(next, { referer, headers, timeout }).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} em ${url}`));
          return;
        }
        resolve(res);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error(`timeout em ${url}`)));
    req.end();
  });
}

async function readAll(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

/* Para segmentos: abre o upstream seguindo redirects (o "imvstream" dobra o
   301 ate outro host e, se o proxy repassar o 301 sem Location, o player
   traba com erro vazio e mostra "sem sinal"). Mantem o status original para
   4xx/5xx para o hls.js poder tratar. */
async function fetchUpstream(url, headers, hops = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('url invalida'));
    }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('redirect nao-http'));
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      { method: 'GET', headers, timeout: 20000 },
      (r) => {
        if (hops < 5 && r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
          r.resume();
          const next = new URL(r.headers.location, u).toString();
          fetchUpstream(next, headers, hops + 1).then(resolve, reject);
          return;
        }
        resolve(r);
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function proxyStream(req, res, target, castToken = '') {
  let u;
  try {
    u = new URL(target);
  } catch {
    return send(res, 400, 'url invalida');
  }
  if (!/^https?:$/.test(u.protocol)) return send(res, 400, 'protocolo nao suportado');

  const ext = path.extname(u.pathname).toLowerCase();
  const isSegment = /\.ts$|\.m4s$|\.mp4$|\.aac$|\.mp3$|\.webm$|\.ogg$/i.test(u.pathname);

  // Para segmentos/arquivos de mídia: repassa direto com status original (evita 502 em 404)
  if (isSegment || ext === '.ts' || ext === '.m4s') {
    try {
      const upstreamRes = await fetchUpstream(target, {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        Referer: (req.headers && req.headers.referer) || u.origin,
        Origin: (req.headers && req.headers.origin) || u.origin,
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      });

      const headers = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        if (upstreamRes.headers[h]) headers[h] = upstreamRes.headers[h];
      }
      res.writeHead(upstreamRes.statusCode || 200, headers);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
      res.on('close', () => upstreamRes.destroy());
      return;
    } catch (err) {
      return send(res, 502, `erro ao buscar stream: ${err.message}`, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
  }

  let upstreamRes;
  try {
    upstreamRes = await upstream(target, {
      referer: req.headers.referer || u.origin,
      headers: {
        Origin: req.headers.origin || '*',
        ...(req.headers.range ? { Range: req.headers.range } : {}),
      },
    });
  } catch (err) {
    return send(res, 502, `erro ao buscar stream: ${err.message}`, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }

  const ctype = (upstreamRes.headers['content-type'] || '').toLowerCase();
  const isPlaylist =
    ext === '.m3u8' || ext === '.m3u' || ext === '.mpd' ||
    ctype.includes('mpegurl') || ctype.includes('x-mpegurl');

  if (!isPlaylist && (ctype.startsWith('audio') || ctype.startsWith('video'))) {
    // radio e video ao vivo: repassa direto, sem buffer
    const headers = { 'Cache-Control': 'no-store' };
    for (const h of ['content-type', 'content-length', 'icy-name', 'icy-br']) {
      if (upstreamRes.headers[h]) headers[h] = upstreamRes.headers[h];
    }
    res.writeHead(upstreamRes.statusCode || 200, { 'Access-Control-Allow-Origin': '*', ...headers });
    upstreamRes.pipe(res);
    upstreamRes.on('error', () => res.destroy());
    res.on('close', () => upstreamRes.destroy());
    return;
  }

  // playlist ou trecho binario
  let buf;
  try {
    buf = await readAll(upstreamRes);
  } catch (err) {
    return send(res, 502, `erro ao ler playlist: ${err.message}`);
  }

  if (!isPlaylist) {
    return send(res, upstreamRes.statusCode || 200, buf, {
      'Content-Type': ctype || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
  }

  // o CDN as vezes envia a playlist compactada mesmo sem pedirmos (CloudFront/
  // jmvstream mandam content-encoding: gzip). Sem descomprimir, a reescrita
  // vira lixo e o player mostra "sem sinal" com o canal no ar.
  try {
    const enc = String(upstreamRes.headers['content-encoding'] || '')
      .toLowerCase().split(',')[0].trim();
    if (enc === 'gzip' || enc === 'x-gzip') buf = zlib.gunzipSync(buf, INFLATE_OPTS);
    else if (enc === 'br') buf = zlib.brotliDecompressSync(buf, INFLATE_OPTS);
    else if (enc === 'deflate') buf = zlib.inflateSync(buf, INFLATE_OPTS);
  } catch {}

  // reescreve segmentos, variantes e URIs de tags para passarem pelo proxy
  send(res, 200, rewritePlaylist(buf.toString('utf8'), target, castToken), {
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Cache-Control': 'no-store',
  });
}

/* Cobre o que o navegador nao consegue acessar sem o proxy:
   - linhas de segmento/variante (listas de <url>)
   - URIs dentro de tags: #EXT-X-KEY (AES-128), #EXT-X-MAP (fMP4),
     #EXT-X-MEDIA (audios/legendas alternativas), #EXT-X-I-FRAME-STREAM-INF,
     #EXT-X-PRELOAD-HINT e #EXT-X-SESSION-KEY */
function proxify(base, raw, token = '') {
  if (String(raw).startsWith('/proxy?u=')) return raw;
  try {
    const abs = new URL(raw, base).toString();
    if (!/^https?:/.test(abs)) return raw;
    const t = token ? '&token=' + encodeURIComponent(token) : '';
    return '/proxy?u=' + encodeURIComponent(abs) + t;
  } catch {
    return raw;
  }
}

function rewritePlaylist(text, target, token = '') {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (line.startsWith('#')) {
        if (!/URI\s*=\s*"/i.test(line)) return line;
        return line.replace(/URI\s*=\s*"([^"]*)"/gi, (_m, uri) => {
          return `URI="${proxify(target, uri, token)}"`;
        });
      }
      return proxify(target, trimmed, token);
    })
    .join('\n');
}

/* Converte SRT (ou qualquer legenda com timestamps com vírgula) para WebVTT,
   que é o único formato que o <track> do navegador aceita. */
function srtToVtt(text) {
  let t = String(text).replace(/^\uFEFF/, '').replace(/\r+/g, '');
  if (/^\s*WEBVTT/.test(t)) return t;
  t = t.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  return 'WEBVTT\n\n' + t.trim() + '\n';
}

/* ------------------------------------------------------------------ *
 * Rotas
 * ------------------------------------------------------------------ */

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (process.env.IPTV_LOG === '1') {
    const via = req.socket.remoteAddress || '?';
    res.on('finish', () =>
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} ${via}`)
    );
  }

  if (req.method === 'OPTIONS') {
    return send(res, 204, '');
  }

  /* ---------------- login / sessao ---------------- */

  if (p === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '?';
    const guard = loginGuard(ip);
    if (guard.blocked) {
      return sendJSON(res, 429, {
        error: `muitas tentativas. Tente de novo em ${guard.retryAfter}s`,
      });
    }
    const body = await readBody(req);
    let user = '', pass = '';
    try {
      ({ user, pass } = JSON.parse(body || '{}'));
    } catch {
      return sendJSON(res, 400, { error: 'json invalido' });
    }
    if (!auth.attempt(res, String(user || ''), String(pass || ''))) {
      await sleep(400);
      noteLoginFail(ip);
      return sendJSON(res, 401, { error: 'usuario ou senha invalidos' });
    }
    noteLoginOk(ip);
    return sendJSON(res, 200, { ok: true, user });
  }

  if (p === '/api/logout' && req.method === 'POST') {
    auth.logout(req, res);
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/me') {
    const user = auth.currentUser(req);
    return user
      ? sendJSON(res, 200, { ok: true, user })
      : sendJSON(res, 401, { ok: false });
  }

  // tudo abaixo exige sessao valida (ou token de cast, so no /proxy)
  const castUser = p === '/proxy' ? verifyCastToken(url.searchParams.get('token')) : null;
  if (!auth.currentUser(req) && !castUser) {
    if (p.startsWith('/api') || p === '/proxy' || p === '/sub' || p === '/logo')
      return sendJSON(res, 401, { error: 'nao autenticado' });
  }

  try {
    if (p === '/api/catalog') {
      const cat = await buildCatalog();
      const country = url.searchParams.get('country');
      const search = (url.searchParams.get('q') || '').toLowerCase();
      const category = url.searchParams.get('category');
      const onlyId = url.searchParams.get('id');
      const kind = url.searchParams.get('kind') || 'tv';
      const limit = Math.min(Number(url.searchParams.get('limit') || 0) || Infinity, 5000);

      let items = cat.items.filter((i) => !i.isNsfw && !i.closed);
      items = parentalFilter(items, auth.currentUser(req));
      if (onlyId) items = items.filter((i) => i.id === onlyId);
      if (kind !== 'all') items = items.filter((i) => i.kind === kind);
      if (country && country !== 'all') items = items.filter((i) => i.country === country);
      if (category && category !== 'all')
        items = items.filter((i) => i.categories.includes(category));
      if (search)
        items = items.filter(
          (i) =>
            i.name.toLowerCase().includes(search) ||
            i.id.toLowerCase().includes(search) ||
            i.altNames.some((n) => n.toLowerCase().includes(search))
        );

      return sendJSON(res, 200, {
        stats: cat.stats,
        updatedAt: cat.at,
        total: items.length,
        items: items.slice(0, limit),
      });
    }

    if (p === '/api/health') {
      return sendJSON(res, 200, healthSummary());
    }

    if (p === '/api/health/recheck' && req.method === 'POST') {
      const body = await readBody(req);
      let urls = null;
      try {
        urls = JSON.parse(body || '{}').urls;
      } catch {}
      const cat = await buildCatalog();
      const known = knownStreams(cat);

      // lista pequena (um canal que falhou no player): sonda na hora e responde
      if (Array.isArray(urls) && urls.length) {
        const targets = [
          ...new Set(urls.filter((u) => typeof u === 'string' && known.has(u))),
        ].slice(0, 60);
        if (!targets.length) return sendJSON(res, 200, { total: 0, dead: [], alive: 0 });
        const results = await recheckHealth(targets);
        await reloadHealth();
        catalogCache = null;
        const dead = results
          .filter((r) => !r.ok)
          .map((r) => ({ name: known.get(r.url) || '', url: r.url, why: r.why || '?', code: r.code || null }));
        return sendJSON(res, 200, {
          at: Date.now(),
          total: results.length,
          alive: results.length - dead.length,
          dead,
        });
      }

      // sem lista: re-verifica todos os streams visiveis (roda em background)
      if (!recheckJob.running) {
        const targets = [...known.keys()].filter((u) => {
          const e = health.entries[u];
          return !e || e.ok;
        });
        runRecheckJob(targets, known);
      }
      return sendJSON(res, 200, {
        started: true,
        running: recheckJob.running,
        total: recheckJob.total,
      });
    }

    if (p === '/api/health/report') {
      return sendJSON(res, 200, {
        running: recheckJob.running,
        at: recheckJob.at,
        startedAt: recheckJob.startedAt,
        total: recheckJob.total,
        done: recheckJob.done,
        dead: recheckJob.dead,
      });
    }

    if (p === '/api/health/channels') {
      const ids = (url.searchParams.get('ids') || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 500);
      const cat = await buildCatalog();
      const byId = new Map(cat.items.map((i) => [i.id, i]));
      const signal = {};
      for (const id of ids) {
        const it = byId.get(id);
        signal[id] = it ? it.signal : 'unknown';
      }
      return sendJSON(res, 200, { signal, at: Date.now() });
    }

    if (p === '/api/favs' && req.method === 'GET') {
      return sendJSON(res, 200, { favs: readFavs(auth.currentUser(req)) });
    }

    if (p === '/api/favs' && req.method === 'POST') {
      const body = await readBody(req);
      let ids = null;
      try {
        ids = JSON.parse(body || '{}').ids;
      } catch {}
      if (!Array.isArray(ids)) return sendJSON(res, 400, { error: 'envie {"ids":[...]}' });
      const clean = [...new Set(ids.filter((x) => typeof x === 'string').map((x) => x.slice(0, 200)))];
      writeFavs(auth.currentUser(req), clean);
      return sendJSON(res, 200, { ok: true, favs: clean });
    }

    if (p === '/api/history' && req.method === 'GET') {
      return sendJSON(res, 200, { history: readHistory(auth.currentUser(req)) });
    }

    if (p === '/api/history' && req.method === 'POST') {
      const me = auth.currentUser(req);
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || '{}');
      } catch {}
      if (data.clear) {
        writeHistory(me, []);
        return sendJSON(res, 200, { ok: true, history: [] });
      }
      const list = upsertHistory(me, data);
      if (!list) return sendJSON(res, 400, { error: 'informe {"id":...}' });
      return sendJSON(res, 200, { ok: true, history: list });
    }

    if (p === '/api/history' && req.method === 'DELETE') {
      const me = auth.currentUser(req);
      const id = url.searchParams.get('id');
      if (id) writeHistory(me, readHistory(me).filter((h) => h.id !== id));
      else writeHistory(me, []);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/account') {
      const me = auth.currentUser(req);
      return sendJSON(res, 200, {
        user: me,
        users: auth.users(),
        sessions: auth.sessionCount(me),
        history: readHistory(me).length,
        favs: readFavs(me).length,
        uptime: Math.round(process.uptime()),
        health: healthSummary(),
      });
    }

    if (p === '/api/logout-all' && req.method === 'POST') {
      auth.logoutAll(auth.currentUser(req), res);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/cast-token' && req.method === 'GET') {
      const me = auth.currentUser(req);
      return sendJSON(res, 200, { token: makeCastToken(me), ttl: CAST_TTL / 1000 });
    }

    if (p === '/api/parental' && req.method === 'GET') {
      const me = auth.currentUser(req);
      const cat = await buildCatalog();
      const categories = new Set();
      for (const i of cat.items)
        if (!i.isNsfw && !i.closed) for (const c of i.categories) categories.add(c);
      return sendJSON(res, 200, { ...parentalState(me), categories: [...categories].sort() });
    }

    if (p === '/api/parental' && req.method === 'POST') {
      const me = auth.currentUser(req);
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || '{}');
      } catch {}
      const cfg = readParental(me);
      if (data.action === 'set') {
        if (cfg && !verifyPin(cfg, data.current || ''))
          return sendJSON(res, 401, { error: 'PIN atual incorreto' });
        if (String(data.pin || '').length < 4)
          return sendJSON(res, 400, { error: 'o PIN precisa de ao menos 4 dígitos' });
        const blocked = Array.isArray(data.blocked)
          ? [
              ...new Set(
                data.blocked
                  .filter((x) => typeof x === 'string')
                  .map((x) => x.slice(0, 60))
              ),
            ]
          : [];
        writeParental(me, { ...hashPin(String(data.pin)), blocked });
        parentalUnlock.set(me, Date.now() + PARENTAL_UNLOCK_MS);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      if (data.action === 'unlock') {
        if (!cfg || !verifyPin(cfg, data.pin || ''))
          return sendJSON(res, 401, { error: 'PIN incorreto' });
        parentalUnlock.set(me, Date.now() + PARENTAL_UNLOCK_MS);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      if (data.action === 'lock') {
        parentalUnlock.delete(me);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      if (data.action === 'disable') {
        if (cfg && !verifyPin(cfg, data.pin || ''))
          return sendJSON(res, 401, { error: 'PIN incorreto' });
        writeParental(me, null);
        parentalUnlock.delete(me);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      return sendJSON(res, 400, { error: 'acao invalida' });
    }

    if (p === '/api/users' && req.method === 'GET') {
      return sendJSON(res, 200, { users: auth.users() });
    }

    if (p === '/api/users' && req.method === 'POST') {
      const body = await readBody(req);
      let user = '', pass = '';
      try {
        ({ user, pass } = JSON.parse(body || '{}'));
      } catch {}
      if (!String(user || '').trim() || !String(pass || ''))
        return sendJSON(res, 400, { error: 'informe user e pass' });
      if (String(pass).length < 6)
        return sendJSON(res, 400, { error: 'senha deve ter pelo menos 6 caracteres' });
      const out = auth.addUser(String(user).trim(), String(pass));
      return out.ok
        ? sendJSON(res, 200, out)
        : sendJSON(res, 400, out);
    }

    if (p === '/api/users' && req.method === 'DELETE') {
      const user = url.searchParams.get('user');
      if (!user) return sendJSON(res, 400, { error: 'informe ?user=' });
      if (user === auth.currentUser(req))
        return sendJSON(res, 400, { error: 'nao pode remover a propria conta' });
      const ok = auth.removeUser(user);
      return ok
        ? sendJSON(res, 200, { ok: true })
        : sendJSON(res, 404, { ok: false, error: 'usuario nao encontrado' });
    }

    if (p === '/api/pass' && req.method === 'POST') {
      const me = auth.currentUser(req);
      const body = await readBody(req);
      let old = '', next = '';
      try {
        ({ old, next } = JSON.parse(body || '{}'));
      } catch {}
      if (!auth.verify(me, String(old || '')))
        return sendJSON(res, 401, { error: 'senha atual incorreta' });
      if (String(next || '').length < 6)
        return sendJSON(res, 400, { error: 'nova senha deve ter pelo menos 6 caracteres' });
      auth.changePassword(me, String(next));
      auth.issue(res, me);
      return sendJSON(res, 200, { ok: true });
    }

    if (p === '/api/meta') {
      const kind = url.searchParams.get('kind') || 'tv';
      const cat = await buildCatalog();
      const pool = cat.items.filter(
        (i) => !i.isNsfw && !i.closed && (kind === 'all' || i.kind === kind)
      );
      const visible = parentalFilter(pool, auth.currentUser(req));
      const countries = {};
      for (const i of visible) {
        const c = i.country || '??';
        countries[c] = (countries[c] || 0) + 1;
      }
      const categories = {};
      for (const i of visible) {
        for (const c of i.categories) categories[c] = (categories[c] || 0) + 1;
      }
      let cats = [];
      try {
        const r = await fetchBuf(SOURCES.categories, { ttl: 24 * 3600e3 });
        cats = JSON.parse(r.buf.toString('utf8'));
      } catch {}
      const catName = Object.fromEntries(cats.map((c) => [c.id, c.name]));

      return sendJSON(res, 200, {
        stats: cat.stats,
        countries: Object.entries(countries)
          .map(([code, count]) => ({ code, count }))
          .sort((a, b) => b.count - a.count),
        categories: Object.entries(categories)
          .map(([id, count]) => ({ id, name: catName[id] || id, count }))
          .sort((a, b) => b.count - a.count),
      });
    }

    if (p === '/api/import') {
      const url2 = url.searchParams.get('url');
      if (!url2) return sendJSON(res, 400, { error: 'informe ?url=' });
      try {
        await assertPublicUrl(url2);
      } catch (e) {
        return sendJSON(res, 400, { error: `url bloqueada: ${e.message}` });
      }
      const out = await importCustom(url2);
      return sendJSON(res, 200, out);
    }

    if (p === '/api/m3u') {
      const cat = await buildCatalog();
      const country = url.searchParams.get('country');
      const kind = url.searchParams.get('kind') || 'all';
      let items = cat.items.filter((i) => !i.isNsfw && !i.closed);
      if (kind !== 'all') items = items.filter((i) => i.kind === kind);
      if (country && country !== 'all') items = items.filter((i) => i.country === country);

      const out = ['#EXTM3U'];
      for (const i of items) {
        for (const s of i.streams) {
          out.push(
            `#EXTINF:-1 tvg-id="${i.id}" tvg-logo="${i.logo}" group-title="${
              i.categories[0] || 'general'
            }",${i.name}${s.quality ? ' (' + s.quality + ')' : ''}`
          );
          out.push(s.url);
        }
      }
      return send(res, 200, out.join('\n') + '\n', {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Content-Disposition': 'attachment; filename="iptv.m3u"',
      });
    }

    if (p === '/api/epg') {
      const src = url.searchParams.get('src');
      if (!src) return sendJSON(res, 400, { error: 'informe ?src=<url do guide.xml>' });
      const r = await fetchBuf(src, { ttl: 3 * 3600e3, guard: true });
      let buf = r.buf;
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, INFLATE_OPTS);
      epgCache = parseXMLTV(buf.toString('utf8'));
      epgCache.index = buildEpgIndex(epgCache);
      epgCache.src = src;
      persistEpg();

      // mede quantos canais do catalogo casaram com o guia
      const cat = await buildCatalog();
      let matched = 0;
      for (const it of cat.items) {
        if (!it.isNsfw && !it.closed && findEpgChannel(epgCache, epgCache.index, it))
          matched++;
      }
      return sendJSON(res, 200, {
        channels: epgCache.channels.size,
        programmes: countProgrammes(epgCache),
        matched,
        src,
      });
    }

    if (p === '/api/epg/guide') {
      const epg = await ensureEpg();
      const chId = url.searchParams.get('channel');
      if (chId) {
        const cat = await buildCatalog();
        let channel = cat.items.find((i) => i.id === chId);
        if (!channel) {
          const names = (epg.channels.get(chId)?.name || '').split(/\s*[\/|,]\s*/);
          channel = {
            id: chId,
            name: names[0] || chId,
            altNames: names.slice(1),
            country: null,
            categories: [],
          };
        }
        const epgId = epg.channels.has(chId)
          ? chId
          : findEpgChannel(epg, epg.index, channel);
        const programmes = epgId ? epg.programs.get(epgId) || [] : [];
        return sendJSON(res, 200, {
          channel: epg.channels.get(epgId) || { name: channel.name },
          epgId,
          programmes: programmes.slice(0, 200),
        });
      }
      return sendJSON(res, 200, {
        channels: [...epg.channels.entries()].slice(0, 3000),
      });
    }

    /* "Agora na TV": programas passando neste instante entre os canais
       que tem EPG casado com o catalogo. */
    if (p === '/api/epg/now') {
      const epg = await ensureEpg();
      const cat = await buildCatalog();
      const kind = url.searchParams.get('kind') || 'tv';
      const country = url.searchParams.get('country') || '';
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const limit = Math.min(Number(url.searchParams.get('limit') || 60) || 60, 300);
      const now = Date.now();
      const items = [];
      for (const it of cat.items) {
        if (it.isNsfw || it.closed) continue;
        if (kind !== 'all' && it.kind !== kind) continue;
        if (country && country !== 'all' && it.country !== country) continue;
        if (q && !it.name.toLowerCase().includes(q)) continue;
        const epgId = epg.channels.has(it.id) ? it.id : findEpgChannel(epg, epg.index, it);
        if (!epgId) continue;
        const list = epg.programs.get(epgId) || [];
        const cur = list.find(
          (pr) => Date.parse(pr.start) <= now && Date.parse(pr.stop) > now
        );
        if (!cur) continue;
        items.push({
          id: it.id,
          name: it.name,
          logo: it.logo,
          kind: it.kind,
          country: it.country,
          title: cur.title,
          desc: cur.desc,
          start: cur.start,
          stop: cur.stop,
          signal: it.signal,
        });
        if (items.length >= limit) break;
      }
      return sendJSON(res, 200, { at: now, total: items.length, items });
    }

    /* Busca por titulo de programa dentro do EPG carregado. */
    if (p === '/api/epg/search') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (q.length < 2) return sendJSON(res, 200, { total: 0, items: [] });
      const epg = await ensureEpg();
      const cat = await buildCatalog();
      const limit = Math.min(Number(url.searchParams.get('limit') || 60) || 60, 200);
      const byEpg = new Map();
      for (const it of cat.items) {
        if (it.isNsfw || it.closed || it.kind !== 'tv') continue;
        const epgId = epg.channels.has(it.id) ? it.id : findEpgChannel(epg, epg.index, it);
        if (epgId && !byEpg.has(epgId)) byEpg.set(epgId, it);
      }
      const now = Date.now();
      const items = [];
      for (const [epgId, list] of epg.programs) {
        const it = byEpg.get(epgId);
        if (!it) continue;
        for (const pr of list) {
          if (!pr.title.toLowerCase().includes(q)) continue;
          items.push({
            id: it.id,
            name: it.name,
            logo: it.logo,
            country: it.country,
            title: pr.title,
            desc: pr.desc,
            start: pr.start,
            stop: pr.stop,
            live: Date.parse(pr.start) <= now && Date.parse(pr.stop) > now,
            signal: it.signal,
          });
        }
        if (items.length > 5000) break;
      }
      items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      return sendJSON(res, 200, { total: items.length, items: items.slice(0, limit) });
    }

    if (p === '/proxy') {
      const target = url.searchParams.get('u');
      if (!target) return send(res, 400, 'informe ?u=');
      return proxyStream(req, res, target, castUser ? url.searchParams.get('token') : '');
    }

    if (p === '/health')
      return sendJSON(res, 200, {
        ok: true,
        uptime: Math.round(process.uptime()),
        auth: !!auth.currentUser(req),
      });

    if (p === '/api/epg/sources') {
      return sendJSON(res, 200, { sources: EPG_LIST });
    }

    if (p === '/api/epg/load') {
      const src = url.searchParams.get('src') || 'https://epg.pw/xmltv/epg_BR.xml.gz';
      const r = await fetchBuf(src, { ttl: 3 * 3600e3, guard: true });
      let buf = r.buf;
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, INFLATE_OPTS);
      epgCache = parseXMLTV(buf.toString('utf8'));
      epgCache.index = buildEpgIndex(epgCache);
      epgCache.src = src;
      persistEpg();
      const cat = await buildCatalog();
      let matched = 0;
      for (const it of cat.items)
        if (!it.isNsfw && !it.closed && findEpgChannel(epgCache, epgCache.index, it))
          matched++;
      return sendJSON(res, 200, {
        channels: epgCache.channels.size,
        programmes: countProgrammes(epgCache),
        matched,
        src,
      });
    }

    if (p === '/logo') {
      const target = url.searchParams.get('u');
      if (!target || !/^https?:/.test(target)) return send(res, 404, '');
      try {
        const r = await fetchBuf(target, { ttl: 30 * 24 * 3600e3, timeout: 15000, guard: true });
        const ext = path.extname(new URL(target).pathname).toLowerCase();
        const ct = sniffImage(r.buf, ext);
        // SVG pode embutir script e rodar na origem do app: nunca serve.
        if (ct === 'image/svg+xml') return send(res, 404, 'formato nao suportado');
        return send(res, 200, r.buf, {
          'Content-Type': ct,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=86400',
        });
      } catch {
        return send(res, 404, 'logo indisponivel');
      }
    }

    if (p === '/sub') {
      const target = url.searchParams.get('u');
      if (!target || !/^https?:/.test(target)) return send(res, 400, 'informe ?u=');
      try {
        await assertPublicUrl(target);
      } catch (e) {
        return send(res, 400, `url bloqueada: ${e.message}`);
      }
      try {
        const r = await fetchBuf(target, { ttl: 6 * 3600e3, timeout: 15000, guard: true });
        let buf = r.buf;
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, INFLATE_OPTS);
        const text = srtToVtt(buf.toString('utf8'));
        return send(res, 200, text, {
          'Content-Type': 'text/vtt; charset=utf-8',
          'Cache-Control': 'public, max-age=3600',
        });
      } catch {
        return send(res, 404, 'legenda indisponivel');
      }
    }

    return serveStatic(req, res, p);
  } catch (err) {
    console.error('[erro]', p, err.message);
    return sendJSON(res, 500, { error: 'erro interno' });
  }
}

/* Envolve o handler para que QUALQUER rejeicao (URL invalida, cookie
   malformado, corpo grande, etc.) vire uma resposta - nunca derrube o
   processo. O handler interno ja trata os erros das rotas. */
function handle(req, res) {
  handleRequest(req, res).catch((err) => {
    console.error('[erro nao tratado]', req.method, req.url, err?.message || err);
    try {
      if (!res.headersSent) {
        send(res, 500, 'erro interno', { 'Content-Type': 'text/plain; charset=utf-8' });
      } else {
        res.destroy();
      }
    } catch {}
  });
}

/* TLS opcional: se TLS=1 (ou TLS!=0 e existirem os arquivos), sobe HTTPS
   com o certificado em .cache/tls/. Gere com: ./ctl.sh tls
   Variaveis: TLS_CERT, TLS_KEY. */
function resolveTls() {
  const dir = path.join(CACHE_DIR, 'tls');
  const certFile = process.env.TLS_CERT || path.join(dir, 'cert.pem');
  const keyFile = process.env.TLS_KEY || path.join(dir, 'key.pem');
  const haveFiles = fs.existsSync(certFile) && fs.existsSync(keyFile);
  const want = process.env.TLS === '1' || (haveFiles && process.env.TLS !== '0');
  if (want && haveFiles) {
    try {
      return {
        cert: fs.readFileSync(certFile),
        key: fs.readFileSync(keyFile),
      };
    } catch (e) {
      console.warn(`[tls] falha ao ler certificado: ${e.message}`);
    }
  }
  return null;
}

const tls = resolveTls();
const server = tls ? https.createServer(tls, handle) : http.createServer(handle);
const SCHEME = tls ? 'https' : 'http';
auth.setSecure(SCHEME === 'https');

/* Requisicao malformada no nivel HTTP: responde 400 e segue vivo. */
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

/* Rede de seguranca: nada de derrubar o processo por um erro solto. */
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err?.stack || err);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err?.stack || err);
  process.exit(1);
});

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

function start() {
  server.listen(PORT, HOST, () => {
    console.log(`IPTV rodando em ${SCHEME}://localhost:${PORT}`);
  });
}

if (isMain) start();

export {
  buildCatalog,
  parseM3U,
  parseXMLTV,
  rewritePlaylist,
  srtToVtt,
  makeCastToken,
  verifyCastToken,
  start,
  server,
};