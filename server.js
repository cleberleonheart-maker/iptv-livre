import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import dgram from 'node:dgram';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAuth } from './auth.js';
import { load as loadHealth, getHealth, recheck as recheckHealth, HEALTH_FILE } from './health.js';
import { whyHardDead, whyLabel, isSoft } from './streamstate.js';
import {
  loadHosts,
  hostIsDead,
  hostReason,
  hostDead,
  refreshHosts,
  extractHost,
  hostStats,
  getHosts,
} from './hosthealth.js';
import { notify, notificationsEnabled } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const CACHE_DIR = process.env.IPTV_CACHE_DIR
  ? path.isAbsolute(process.env.IPTV_CACHE_DIR)
    ? process.env.IPTV_CACHE_DIR
    : path.join(__dirname, process.env.IPTV_CACHE_DIR)
  : path.join(__dirname, '.cache');
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
/* Biblioteca local: raiz com as series em arquivo MP4 no HD (IPTV_MEDIA_DIR).
   Vazio = recurso desligado. Serve via /media (autenticado, com suporte a
   Range para o player buscar no meio do arquivo). */
const MEDIA_DIR = process.env.IPTV_MEDIA_DIR ? path.resolve(process.env.IPTV_MEDIA_DIR) : '';
const VIDEO_EXTS = new Set(['.mp4', '.m4v', '.mp4v', '.webm', '.mov']);
const IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

/* Gravacao (DVR): agenda a captura de um canal/programa para arquivo .ts no
   HD. Fica em <MEDIA_DIR>/recordings (servido por /media, com Range) ou no
   cache quando nao ha biblioteca configurada. Desligavel com IPTV_DVR=0. */
const DVR_ENABLED = process.env.IPTV_DVR !== '0';
const REC_DIR = MEDIA_DIR ? path.join(MEDIA_DIR, 'recordings') : path.join(CACHE_DIR, 'recordings');
const DVR_FILE = path.join(CACHE_DIR, 'dvr.json');
const DVR_TICK_MS = Number(process.env.IPTV_DVR_TICK_MS || 20e3);
/* Quantas gravacoes simultaneas o servidor aceita (CPU/banda) e o teto de
   disco das gravacoes prontas em GB (as mais antigas vao sendo apagadas). */
const DVR_MAX_CONCURRENT = Math.max(1, Number(process.env.IPTV_DVR_MAX_CONCURRENT || 2));
const DVR_MAX_GB = Math.max(0, Number(process.env.IPTV_DVR_MAX_GB || 20));
const DVR_KEEP = Math.max(0, Number(process.env.IPTV_DVR_KEEP || 0));

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/* Reencode sob demanda: alguns canais livres (ex.: o servidor "Astra", host
   38.65.175.84) emitem MPEG-2 dentro do MPEG-TS. Nenhum navegador decodifica
   MPEG-2 via MSE, entao o hls.js acaba tocando so o audio. O /transcode le o
   link pelo ffmpeg e devolve um MP4 fragmentado H.264/AAC progressivo que o
   <video> toca nativamente. Desligavel com IPTV_TRANSCODE=0. */
const FFMPEG_BIN = process.env.IPTV_FFMPEG || 'ffmpeg';
const FFPROBE_BIN = process.env.IPTV_FFPROBE || 'ffprobe';
const TRANSCODE_ON = process.env.IPTV_TRANSCODE !== '0';
const TRANSCODE_MAX = Math.max(1, Number(process.env.IPTV_TRANSCODE_MAX || 4));
const TRANSCODE_PREROLL_MS = Number(process.env.IPTV_TRANSCODE_PREROLL_MS || 20000);

/* Agentes com keep-alive para o proxy de stream. Cada segmento HLS pede um
   fetch: sem reuso de conexao, o player esgota o buffer esperando o
   handshake TCP+TLS do host do canal e o video "pausa" toda hora. Com o
   agente, os segmentos seguintes do mesmo host reusam a conexao. */
const UPSTREAM_AGENTS = {
  'http:': new http.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 128,
    maxFreeSockets: 32,
  }),
  'https:': new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 15000,
    maxSockets: 128,
    maxFreeSockets: 32,
  }),
};

const scrypt = promisify(crypto.scrypt);

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
    await loadHosts();
    const entries = getHealth().entries || {};
    const n = Object.keys(entries).length;
    const countChanged = n !== health.count;
    health.entries = entries;
    health.count = n;
    if (!health.ready) {
      health.ready = true;
      const hs = hostStats();
      console.log(
        `health: ${n} streams com estado carregado (${HEALTH_FILE}) | ${hs.dead} host(s) morto(s)`
      );
    } else if (countChanged || hasSettledDead(entries)) {
      // varredura terminou mais streams (ou veredito amadureceu): reconstroi
      catalogCache = null;
    }
  } catch {}
}

reloadHealth();
// a varredura pode levar horas; acompanha e aplica o resultado sem reiniciar
setInterval(reloadHealth, 60_000).unref?.();

/* Passada de DNS sobre os hosts do catalogo: esconde em massa os streams de
   provedores que sairam do ar, sem depender da varredura HTTP completa. */
const HOST_SWEEP_MS = Number(process.env.HOST_SWEEP_MS || 10 * 60e3);
/* Reimportacao das listas M3U do usuario (1x/dia por padrao; 0 desliga). */
const SOURCE_REFRESH_MS = Number(process.env.IPTV_SOURCE_REFRESH_MS || 24 * 3600e3);
let hostSweepRunning = false;
async function sweepHosts(force = false) {
  if (hostSweepRunning) return;
  hostSweepRunning = true;
  try {
    await loadHosts();
    // so as listas do usuario: as do iptv-org ja sao cobertas pela varredura HTTP
    const custom = readCustom().sources || [];
    const hosts = [
      ...new Set(
        custom.flatMap((s) => (s.streams || []).map((st) => extractHost(st.url)).filter(Boolean))
      ),
    ];
    if (!hosts.length) return;
    const { changed, checked, skipped } = await refreshHosts(hosts, {
      concurrency: Number(process.env.HOST_CONCURRENCY || 16),
      force,
    });
    if (checked) {
      console.log(
        `hosts: ${checked} verificados (${skipped} em cache)${changed ? ' — catalogo sera reconstruido' : ''}`
      );
    }
    if (changed) catalogCache = null;
    warnDyingSources();
    maybeNotify().catch(() => {});
  } catch {} finally {
    hostSweepRunning = false;
  }
}

/* Avisa (log) quando boa parte de uma lista cai de uma vez — sinal de que o
   provedor inteiro saiu do ar. */
function warnDyingSources() {
  for (const s of sourceList()) {
    if (!s.active || !s.count) continue;
    if (s.dead) console.warn(`AVISO: lista "${s.name}" esta fora do ar (${s.count} canais).`);
    else if (s.ratio >= 0.3)
      console.warn(
        `AVISO: lista "${s.name}" com ${Math.round(s.ratio * 100)}% dos canais fora do ar (${s.deadChannels}/${s.count}).`
      );
  }
}

/* ----------------------- notificacoes externas ----------------------- */
/* Estado para nao repetir o mesmo aviso: guarda hosts ja avisados como mortos
   e listas ja avisadas nas ultimas 24h. */
const NOTIFY_FILE = path.join(CACHE_DIR, 'notify.json');
let notifyState = { deadHosts: {}, warnedSources: {}, favDown: {} };
try {
  const d = JSON.parse(fs.readFileSync(NOTIFY_FILE, 'utf8'));
  notifyState = {
    deadHosts: d.deadHosts || {},
    warnedSources: d.warnedSources || {},
    favDown: d.favDown || {},
  };
} catch {}
function saveNotifyState() {
  notifyState.at = Date.now();
  try {
    fs.writeFileSync(NOTIFY_FILE, JSON.stringify(notifyState));
  } catch {}
}

async function maybeNotify() {
  if (!notificationsEnabled()) return;
  const hosts = getHosts().hosts || {};
  const newlyDead = [];
  for (const [h, e] of Object.entries(hosts)) {
    if (e && e.dead && !notifyState.deadHosts[h]) {
      newlyDead.push(h);
      notifyState.deadHosts[h] = Date.now();
    }
  }
  // host que voltou sai do estado: se cair de novo, avisa de novo
  for (const h of Object.keys(notifyState.deadHosts)) {
    const e = hosts[h];
    if (e && !e.dead) delete notifyState.deadHosts[h];
  }
  const dying = [];
  for (const s of sourceList()) {
    if (!s.active || !s.count) continue;
    if (s.dead || s.ratio >= 0.3) {
      const last = notifyState.warnedSources[s.id] || 0;
      if (Date.now() - last > 24 * 3600e3) {
        dying.push(
          `- ${s.name}: ${Math.round(s.ratio * 100)}% fora do ar (${s.deadChannels}/${s.count})`
        );
        notifyState.warnedSources[s.id] = Date.now();
      }
    } else {
      delete notifyState.warnedSources[s.id];
    }
  }
  let changed = false;
  if (newlyDead.length) {
    changed = true;
    await notify(
      `${newlyDead.length} host(s) fora do ar:\n` + newlyDead.slice(0, 20).join('\n'),
      { title: 'IPTV: host fora do ar', priority: 'high' }
    );
  }
  if (dying.length) {
    changed = true;
    await notify(`Listas com problema:\n${dying.join('\n')}`, {
      title: 'IPTV: lista caindo',
      priority: 'high',
    });
  }
  // favoritos que ficaram totalmente fora do ar (todos os links checados e mortos)
  let favDown = [];
  try {
    favDown = await favoriteDowns();
  } catch {}
  const seenFav = new Set();
  const favMsg = [];
  for (const f of favDown) {
    const key = `${f.user}|${f.id}`;
    seenFav.add(key);
    if (!notifyState.favDown[key]) {
      notifyState.favDown[key] = Date.now();
      favMsg.push(`${f.user}: ${f.name}`);
    }
  }
  for (const k of Object.keys(notifyState.favDown)) {
    if (!seenFav.has(k)) delete notifyState.favDown[k];
  }
  if (favMsg.length) {
    changed = true;
    await notify(
      `${favMsg.length} canal(is) favorito(s) fora do ar:\n` + favMsg.slice(0, 20).join('\n'),
      { title: 'IPTV: favorito fora do ar', priority: 'high' }
    );
  }
  if (changed) saveNotifyState();
}

/* Favoritos (por usuario) cujos canais estao totalmente fora do ar: todos os
   links ja checados pelo health deram erro. Canal sem nenhum veredito nao conta
   (evita alarme falso). Usa o catalogo ja carregado/persistido — nunca forca
   um rebuild (que travaria o event loop durante a varredura de hosts). */
function favoriteDowns() {
  const users = (rawUsers().users || []).map((u) => u.user).filter(Boolean);
  if (!users.length) return [];
  const favs = [];
  for (const u of users) {
    const f = readFavs(u);
    if (f.length) favs.push([u, f]);
  }
  if (!favs.length) return [];
  if (!catalogCache) loadPersistedCatalog();
  const cat = catalogCache;
  if (!cat || !Array.isArray(cat.items)) return [];
  const entries = health.entries || {};
  const byId = new Map(cat.items.map((i) => [i.id, i]));
  const down = [];
  for (const [u, list] of favs) {
    for (const id of list) {
      const it = byId.get(id);
      if (!it || !(it.streams || []).length) continue;
      let known = 0;
      let dead = 0;
      for (const s of it.streams) {
        const e = entries[s.url];
        if (!e) continue;
        known++;
        if (!e.ok) dead++;
      }
      if (known > 0 && dead === known) down.push({ user: u, id, name: it.name });
    }
  }
  return down;
}

setInterval(() => sweepHosts().catch(() => {}), HOST_SWEEP_MS).unref?.();

/* Re-verificacao sob demanda (auto-ao-falhar e botao "re-verificar agora").
   job roda em segundo plano e o cliente acompanha por /api/health/report. */
const recheckJob = { running: false, at: 0, total: 0, done: 0, dead: [], startedAt: 0 };

/* Fatia o catalogo para paginacao: offset + limite, com aviso de "tem mais". */
function paginate(items, offset, limit) {
  const page = items.slice(offset, offset + limit);
  return {
    total: items.length,
    offset,
    hasMore: offset + page.length < items.length,
    items: page,
  };
}

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
   HTTP 404/410, url invalida...) sao conclusivas e escondem na hora. A regra
   fica em streamstate.js para o verificador (health.js) usar a mesma. */
function streamAlive(url, { radio = false } = {}) {
  // host morto (dominio inexistente): conclusivo, esconde mesmo sem health
  if (hostIsDead(url)) return false;
  if (!health.ready) return true;
  const e = health.entries[url];
  if (!e || !e.checked) return true; // desconhecido: mantem
  if (e.ok) {
    // canal de TV com stream so de audio nao serve (radio passa)
    return radio || !e.audioOnly;
  }
  // So esconde com veredito conclusivo (404, ENOTFOUND, certificado ruim...).
  // Falha "mole" (403/429/timeout/HTML) NAO prova que o canal morreu.
  return !whyHardDead(e.why);
}

/* Motivo de um stream estar fora do ar (health ou host morto), ou null se
   nao ha veredito. Usado no diagnostico do player ("sem sinal" detalhado). */
function deadReason(url) {
  const e = health.entries[url];
  if (e && e.checked && !e.ok) return e.why || '?';
  return hostReason(url);
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
  if (hostIsDead(url)) return 'off';
  if (!health.ready) return 'unknown';
  const e = health.entries[url];
  if (!e || !e.checked) return 'unknown';
  if (e.ok) return 'on';
  return whyHardDead(e.why) ? 'off' : 'unknown';
}

/* Latencia medida na ultima sondagem (time-to-first-byte). Links sem medida
   vao para o fim da ordenacao: provavelmente e mais lento que um ja testado. */
function streamLatency(url) {
  const e = health.entries[url];
  if (e && e.ok && Number.isFinite(e.ms) && e.ms > 0) return e.ms;
  return 1e9;
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

const CAST_TTL = 24 * 3600e3; // 24h para evitar expiração em cadeias HLS longas
// Link de lista M3U (QR/link para players de TV): vale mais tempo que o cast.
const LIST_TTL = 30 * 24 * 3600e3;
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
purgeStaleCache();

/* Limpa o cache de download (arquivos "<16hex>.bin/.json": logos com TTL
   de 30 dias, catalogo, etc.) que passaram do prazo. Nunca toca em
   users.json, sessões, saúde, custom.json ou epg.json. */
function purgeStaleCache(maxAgeMs = 45 * 24 * 3600e3) {
  let purged = 0;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      if (!/^[0-9a-f]{16}\.(bin|json)$/.test(name)) continue;
      const file = path.join(CACHE_DIR, name);
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > maxAgeMs) {
          fs.unlinkSync(file);
          purged++;
        }
      } catch {}
    }
  } catch {}
  if (purged) console.log(`cache: ${purged} arquivo(s) velho(s) removido(s)`);
}
      fs.writeFileSync(file, _secret, { mode: 0o600 });
    } catch {}
  }
  return _secret;
}
function hmac(data) {
  return crypto.createHmac('sha256', serverSecret()).update(data).digest('base64url');
}
function makeCastToken(user, ttl = CAST_TTL) {
  const payload = `${Date.now() + ttl}.${user}`;
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
 * DLNA / UPnP: descobrir a TV (SSDP) e mandar o stream tocar nela
 * ------------------------------------------------------------------
 * O navegador nao faz UDP, entao quem varre a rede e o servidor.
 * A TV baixa o stream pelo /proxy com um token curto (o mesmo do Cast),
 * porque o receptor dela tambem nao tem o cookie de sessao. */

function parseSsdp(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function extractDlnaServices(body) {
  const services = [];
  const list = /<serviceList>([\s\S]*?)<\/serviceList>/.exec(String(body))?.[1] || String(body);
  for (const m of list.matchAll(/<service>([\s\S]*?)<\/service>/g)) {
    const s = m[1];
    const type = /<serviceType>([\s\S]*?)<\/serviceType>/.exec(s)?.[1]?.trim();
    const control = /<controlURL>([\s\S]*?)<\/controlURL>/.exec(s)?.[1]?.trim();
    if (type && control) services.push({ type, control: control.replace(/&amp;/g, '&') });
  }
  return services;
}

function dlnaFriendlyName(body) {
  return /<friendlyName>([\s\S]*?)<\/friendlyName>/.exec(String(body))?.[1]
    ?.replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim() || '';
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* Varre a rede com M-SEARCH e devolve os MediaRenderers com AVTransport. */
function ssdpSearch(sts = ['urn:schemas-upnp-org:device:MediaRenderer:1'], wait = 2500) {
  return new Promise((resolve) => {
    const seen = new Map(); // location -> headers
    let closed = false;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const finish = () => {
      if (closed) return;
      closed = true;
      try {
        sock.close();
      } catch {}
      clearTimeout(timer);
      resolve([...seen.values()]);
    };
    const timer = setTimeout(finish, wait);
    sock.on('error', finish);
    sock.on('message', (msg) => {
      const head = parseSsdp(msg.toString('utf8'));
      const loc = head.location || head.LOCATION;
      if (!loc) return;
      const key = loc.replace(/^https?:\/\//i, '');
      if (!seen.has(key)) seen.set(key, head);
    });
    for (const st of sts) {
      const m = [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 2',
        `ST: ${st}`,
        '', '',
      ].join('\r\n');
      try {
        sock.send(Buffer.from(m), 1900, '239.255.255.250');
      } catch {}
    }
  });
}

/* Baixa o XML de descricao e devolve { body, services }. */
function fetchDlnaDescription(location, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(location);
    } catch {
      return reject(new Error('location invalida'));
    }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('protocolo nao suportado'));
    const mod = u.protocol === 'https:' ? https : http;
    const rq = mod.get(u, { timeout: timeoutMs, headers: { 'User-Agent': UA } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ body, services: extractDlnaServices(body) });
      });
    });
    rq.setTimeout(timeoutMs, () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
  });
}

async function dlnaDiscover() {
  const heads = await ssdpSearch(
    ['urn:schemas-upnp-org:device:MediaRenderer:1', 'upnp:rootdevice'],
    2500
  );
  const locs = [];
  for (const h of heads) {
    if (h.location && !locs.includes(h.location)) locs.push(h.location);
  }
  const results = await Promise.allSettled(
    locs.slice(0, 10).map(async (loc) => {
      const d = await fetchDlnaDescription(loc);
      const av = d.services.find((s) => /AVTransport/i.test(s.type));
      if (!av) return null;
      return { name: dlnaFriendlyName(d.body) || loc, location: loc, control: av.control };
    })
  );
  return results
    .filter((r) => r.status === 'fulfilled' && r.value)
    .map((r) => r.value);
}

/* Envia um SOAP para o controle da TV e aceita apenas 2xx. */
function dlnaSoap(control, soapAction, body, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(control);
    } catch {
      return reject(new Error('control invalida'));
    }
    if (!/^https?:$/.test(u.protocol)) return reject(new Error('protocolo nao suportado'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          'Content-Type': 'text/xml; charset="utf-8"',
          SOAPAction: `"${soapAction}"`,
          'Content-Length': Buffer.byteLength(body),
          Connection: 'close',
          'User-Agent': UA,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
          else reject(new Error(`SOAP ${res.statusCode}: ${data.slice(0, 300)}`));
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function dlnaEnvelope(action, extra) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">` +
    '<InstanceID>0</InstanceID>' +
    extra +
    `</u:${action}>` +
    '</s:Body>' +
    '</s:Envelope>'
  );
}

/* Pede para a TV tocar a URL (ja reescrita para o proxy com token). */
async function dlnaPlay(device, absUrl) {
  const base = new URL(device.control, new URL(device.location));
  await dlnaSoap(
    base.toString(),
    'urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI',
    dlnaEnvelope('SetAVTransportURI', `<CurrentURI>${xmlEscape(absUrl)}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>`)
  );
  await dlnaSoap(
    base.toString(),
    'urn:schemas-upnp-org:service:AVTransport:1#Play',
    dlnaEnvelope('Play', '<Speed>1</Speed>')
  );
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
        agent: UPSTREAM_AGENTS[mod === https ? 'https:' : 'http:'],
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

const CATALOG_TTL = 6 * 3600e3;

let catalogCache = null;
let catalogLoad = null;

function catalogFresh(cache) {
  return !!cache && Date.now() - cache.at < CATALOG_TTL;
}

/* Reconstroi em segundo plano (single-flight). Nunca rejeita: se falhar,
   mantem o cache atual e registra o erro no status de refresh. */
function rebuildCatalogInBackground() {
  if (catalogLoad) return catalogLoad;
  catalogLoad = doBuildCatalog()
    .catch((err) => {
      refreshCtl.error = err.message;
      return catalogCache;
    })
    .finally(() => {
      catalogLoad = null;
    });
  return catalogLoad;
}

/* Serve o cache na hora. So bloqueia no primeiro carregamento (cache frio);
   com cache vencido, responde o cache e atualiza por tras, sem travar a
   resposta de quem pediu. */
async function buildCatalog() {
  if (catalogCache) {
    if (!catalogFresh(catalogCache)) rebuildCatalogInBackground();
    return catalogCache;
  }
  return rebuildCatalogInBackground();
}

/* ------------------------------------------------------------------ *
 * Atualizacao automatica: recarrega o catalogo (canais) e o guia EPG
 * escolhido de tempos em tempos, sem depender de abrir o app.
 * ------------------------------------------------------------------ */

const EPG_TTL = 6 * 3600e3;
const refreshCtl = { running: false, last: 0, lastEpg: 0, error: null, epgSrc: null, epgError: null };

/* Recarrega o guia de uma fonte, com fallback (ver loadEpg). */
async function loadEpgSrc(src) {
  return loadEpg(src);
}

async function runAutoRefresh({ force = false } = {}) {
  if (refreshCtl.running) return refreshCtl;
  refreshCtl.running = true;
  try {
    if (force) {
      catalogCache = null;
      await doBuildCatalog({ force: true });
    } else if (!catalogFresh(catalogCache)) {
      await doBuildCatalog();
    }
    const src =
      epgCache?.src || (await ensureEpg().catch(() => epgCache))?.src || null;
    if (src && (force || !refreshCtl.lastEpg || Date.now() - refreshCtl.lastEpg >= EPG_TTL)) {
      await loadEpgSrc(src);
    }
    if (force || src) refreshCtl.last = Date.now();
    refreshCtl.error = null;
  } catch (err) {
    refreshCtl.error = err.message;
  } finally {
    refreshCtl.running = false;
  }
  return refreshCtl;
}

function refreshStatus() {
  return {
    running: refreshCtl.running,
    last: refreshCtl.last,
    lastEpg: refreshCtl.lastEpg,
    error: refreshCtl.error,
    epgSrc: refreshCtl.epgSrc,
    epgError: refreshCtl.epgError,
    catalogAt: catalogCache?.at || 0,
    next: refreshCtl.last ? refreshCtl.last + CATALOG_TTL : Date.now() + CATALOG_TTL,
  };
}

/* A cada 6 horas o servidor atualiza sozinho (nao impede o processo de
   terminar nos testes). */
setInterval(() => runAutoRefresh().catch(() => {}), CATALOG_TTL).unref?.();

function srcId(url) {
  return crypto.createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
}

/* Várias listas M3U do usuário. Formato:
   { sources: [ { id, name, url, addedAt, active, streams:[...] } ] }
   Aceita também o formato antigo (uma lista só) e converte. */
function normalizeCustom(raw) {
  if (!raw || typeof raw !== 'object') return { sources: [] };
  if (Array.isArray(raw.sources)) return raw;
  if (Array.isArray(raw.streams)) {
    return {
      sources: raw.url
        ? [
            {
              id: srcId(raw.url),
              name: 'Minha lista',
              url: raw.url,
              addedAt: raw.addedAt || Date.now(),
              active: true,
              streams: raw.streams,
            },
          ]
        : [],
    };
  }
  return { sources: [] };
}

function readCustom() {
  const file = path.join(CACHE_DIR, 'custom.json');
  try {
    return normalizeCustom(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { sources: [] };
  }
}

function writeCustom(data) {
  const file = path.join(CACHE_DIR, 'custom.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(data));
  fs.renameSync(file + '.tmp', file);
  catalogCache = null;
}

function sourceList() {
  return readCustom().sources.map((s) => {
    const streams = s.streams || [];
    const hosts = [...new Set(streams.map((st) => extractHost(st.url)).filter(Boolean))];
    const deadHosts = hosts.filter((h) => hostDead(h));
    const deadSet = new Set(deadHosts);
    const deadChannels = streams.filter((st) => deadSet.has(extractHost(st.url))).length;
    // sem nenhum host vivo: a fonte inteira saiu do ar (ex.: provedor caiu)
    const dead = hosts.length > 0 && deadHosts.length === hosts.length;
    const ratio = streams.length ? deadChannels / streams.length : 0;
    return {
      id: s.id,
      name: s.name || 'Lista',
      url: s.url || '',
      active: s.active !== false,
      count: streams.length,
      hosts: hosts.length,
      deadHosts: deadHosts.length,
      deadChannels,
      ratio,
      // boa parte em host morto: avisa antes de a lista toda cair
      warning: !dead && deadChannels > 0 && ratio >= 0.3,
      dead,
      addedAt: s.addedAt || 0,
    };
  });
}

/* Links curtos de lista M3U (para players de TV que podem truncar URLs
   longas com query). Ex.: /list/<id>.m3u, valido por LIST_TTL. */
const m3uLinksFile = path.join(CACHE_DIR, 'm3u-links.json');
function readM3uLinks() {
  try {
    return JSON.parse(fs.readFileSync(m3uLinksFile, 'utf8')) || {};
  } catch {
    return {};
  }
}
function writeM3uLinks(map) {
  fs.writeFileSync(m3uLinksFile + '.tmp', JSON.stringify(map));
  fs.renameSync(m3uLinksFile + '.tmp', m3uLinksFile);
}
function addM3uLink() {
  const map = readM3uLinks();
  const now = Date.now();
  for (const k of Object.keys(map)) if (!map[k] || map[k] < now) delete map[k];
  const id = crypto.randomBytes(5).toString('hex');
  map[id] = now + LIST_TTL;
  writeM3uLinks(map);
  return id;
}
function resolveM3uLink(id) {
  const exp = readM3uLinks()[id];
  return !!exp && exp > Date.now();
}

/* Endereco publico (esquema + host) para montar URLs que um player externo
   vai seguir. Prioriza PUBLIC_URL; senao usa X-Forwarded-Proto/Host (atras de
   proxy/Tailscale) e por fim o Host da requisicao. */
function publicOrigin(req) {
  const pub = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (pub) return pub;
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const scheme = fwd === 'https' || fwd === 'http' ? fwd : SCHEME;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0]
    .trim();
  return scheme + '://' + host;
}

/* Lista M3U (players externos: VLC, Kodi, TiviMate, IBO...). Os streams entram
   pelo /proxy deste servidor com um token, porque o player nao tem o cookie de
   sessao. Passando pelo proxy, valem o CORS, o esquema HTTPS e o repasse do
   Content-Range (arquivos como os do Google Drive). Desligue com
   IPTV_M3U_PROXY=0 para exportar os links originais. */
async function m3uText(req, { kind = 'all', country = 'all' } = {}) {
  const cat = await buildCatalog();
  let items = cat.items.filter((i) => !i.isNsfw && !i.closed && !i.local);
  if (kind && kind !== 'all') items = items.filter((i) => i.kind === kind);
  if (country && country !== 'all') items = items.filter((i) => i.country === country);

  const viaProxy = process.env.IPTV_M3U_PROXY !== '0';
  const origin = viaProxy && req ? publicOrigin(req) : '';
  const token = viaProxy ? makeCastToken('m3u', LIST_TTL) : '';
  const link = (url) => {
    if (!viaProxy || !/^https?:/i.test(url)) return url;
    return (
      origin + '/proxy?u=' + encodeURIComponent(url) + '&token=' + encodeURIComponent(token)
    );
  };

  const out = ['#EXTM3U'];
  for (const i of items) {
    for (const s of i.streams) {
      out.push(
        `#EXTINF:-1 tvg-id="${i.id}" tvg-logo="${i.logo}" group-title="${
          i.group || i.categories[0] || 'general'
        }",${i.name}${s.quality ? ' (' + s.quality + ')' : ''}`
      );
      out.push(link(s.url));
    }
  }
  return out.join('\n') + '\n';
}

/* ------------------------------------------------------------------ *
 * Xtream Codes (XC) emulation
 * ------------------------------------------------------------------
 * Alguns players de TV (ex.: Ibo Player no Roku) so falam Xtream
 * (server + username + password) e chamam player_api.php. Montamos
 * essas respostas a partir do mesmo catalogo usado no M3U. Os IDs de
 * stream sao a posicao (1-based) na lista; /live/<u>/<p>/<id>.<ext>
 * resolve de volta e redireciona para o stream real. */
function xtreamItems() {
  const cat = catalogCache;
  if (!cat) return [];
  return cat.items.filter((i) => !i.isNsfw && !i.closed);
}
function xtreamData() {
  const items = xtreamItems();
  const at = (catalogCache && catalogCache.at) || Date.now();
  const added = String(Math.floor(at / 1000));

  const liveCat = new Map();
  const vodCat = new Map();
  const serieCat = new Map();
  const liveStreams = [];
  const vodStreams = [];
  const seriesMap = new Map();
  const seriesList = [];
  const seriesById = new Map();

  const catId = (map, name) => {
    const key = String(name || 'general');
    if (!map.has(key)) map.set(key, String(map.size + 1));
    return map.get(key);
  };
  const ext = (url) => {
    const m = String(url || '').match(/\.([a-z0-9]{2,4})(?:\?|$)/i);
    return m ? m[1].toLowerCase() : 'mp4';
  };

  items.forEach((it, idx) => {
    const stream_id = idx + 1;
    const cname = (it.categories && it.categories[0]) || it.group || 'general';

    if (it.type === 'series') {
      const { base, season, episode } = parseEpisode(it.name);
      const niceName = cleanSeriesName(base);
      const key = niceName.toLowerCase();
      let s = seriesMap.get(key);
      if (!s) {
        s = { name: niceName, category: cname, cover: it.logo || '', episodes: [] };
        seriesMap.set(key, s);
      }
      s.episodes.push({
        id: stream_id,
        title: it.name,
        season: season || 1,
        episode: episode || s.episodes.length + 1,
        ext: ext(it.primary),
      });
      return;
    }

    if (it.type === 'movie') {
      vodStreams.push({
        num: vodStreams.length + 1,
        name: it.name,
        stream_type: 'movie',
        stream_id,
        stream_icon: it.logo || '',
        rating: '0',
        rating_5based: 0,
        added,
        category_id: catId(vodCat, cname),
        container_extension: ext(it.primary),
        custom_sid: '',
        direct_source: '',
      });
      return;
    }

    liveStreams.push({
      num: liveStreams.length + 1,
      name: it.name,
      stream_type: 'live',
      stream_id,
      stream_icon: it.logo || '',
      epg_channel_id: it.id,
      added,
      category_id: catId(liveCat, cname),
      custom_sid: '',
      tv_archive: 0,
      direct_source: '',
      tv_archive_duration: 0,
    });
  });

  seriesMap.forEach((s) => {
    const sid = seriesList.length + 1;
    const category_id = catId(serieCat, s.category);
    s.series_id = sid;
    const seasons = [...new Set(s.episodes.map((e) => e.season || 1))].sort(
      (a, b) => a - b
    );
    const entry = {
      num: sid,
      name: s.name,
      series_id: sid,
      cover: s.cover,
      plot: '',
      cast: '',
      director: '',
      genre: s.category,
      releaseDate: '',
      last_modified: added,
      rating: '0',
      rating_5based: 0,
      backdrop_path: [],
      youtube_trailer: '',
      episode_run_time: '0',
      category_id,
      seasons,
      episodes: s.episodes,
    };
    seriesList.push(entry);
    seriesById.set(sid, entry);
  });

  const toCats = (map) =>
    [...map.entries()].map(([name, id]) => ({
      category_id: id,
      category_name: name,
      parent_id: 0,
    }));

  return {
    items,
    liveCategories: toCats(liveCat),
    liveStreams,
    vodCategories: toCats(vodCat),
    vodStreams,
    serieCategories: toCats(serieCat),
    seriesList,
    seriesById,
    added,
  };
}
const xtreamHost = (req) =>
  String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost')
    .split(',')[0]
    .trim();

/* Endereco publico que os players usam para montar os streams. Preferimos o
   PUBLIC_URL configurado; senão usamos o esquema real do proxy/front (X-Forwarded-Proto)
   e o host da requisicao. Assim o IBO Player nao tenta porta 8090 atras da Funnel HTTPS. */
function xtreamPublic(req) {
  const pub = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  let scheme = SCHEME;
  let host = '';
  let port = String(PORT);
  if (pub) {
    try {
      const u = new URL(pub);
      scheme = u.protocol.replace(':', '') || scheme;
      host = u.hostname;
      port = u.port ? String(u.port) : scheme === 'https' ? '443' : '80';
    } catch {}
  }
  if (!host) {
    const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (fwd === 'https' || fwd === 'http') scheme = fwd;
    host = xtreamHost(req);
    port = scheme === 'https' ? '443' : String(PORT);
  }
  return { scheme, host, port };
}

/* Auth do Xtream: os apps de TV enviam usuario/senha na propria URL, entao
   validamos contra a mesma base do login web. O scrypt e pesado, por isso
   guardamos o resultado em cache por alguns minutos. IPTV_XTREAM_AUTH=0
   desliga a exigencia (util para testes locais). */
const xtreamAuthCache = new Map();
const XTREAM_AUTH_TTL = 5 * 60e3;
const xtreamFails = new Map();

function xtreamAuthEnabled() {
  return process.env.IPTV_XTREAM_AUTH !== '0';
}

async function xtreamAuthorized(user, pass) {
  if (!xtreamAuthEnabled()) return true;
  if (!user) return false;
  const key = user + '\n' + pass;
  const hit = xtreamAuthCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  const ok = await auth.verify(String(user), String(pass));
  xtreamAuthCache.set(key, { ok, until: Date.now() + XTREAM_AUTH_TTL });
  if (xtreamAuthCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of xtreamAuthCache) if (v.until <= now) xtreamAuthCache.delete(k);
  }
  return ok;
}

function xtreamIpBlocked(ip) {
  const rec = xtreamFails.get(ip);
  return !!(rec && rec.until > Date.now() && rec.count >= 20);
}

function noteXtreamFail(ip) {
  const now = Date.now();
  const rec = xtreamFails.get(ip) || { count: 0, first: now, until: 0 };
  if (now - rec.first > 10 * 60e3) {
    rec.count = 0;
    rec.first = now;
  }
  rec.count++;
  if (rec.count >= 20) rec.until = now + 15 * 60e3;
  xtreamFails.set(ip, rec);
}

async function checkXtreamAuth(req, user, pass) {
  if (!xtreamAuthEnabled()) return true;
  const ip = req.socket.remoteAddress || '?';
  if (xtreamIpBlocked(ip)) return false;
  if (await xtreamAuthorized(String(user || ''), String(pass || ''))) {
    xtreamFails.delete(ip);
    return true;
  }
  noteXtreamFail(ip);
  return false;
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
async function verifyPin(cfg, pin) {
  if (!cfg || !cfg.hash || !cfg.salt) return false;
  const derived = await scrypt(String(pin), cfg.salt, 64);
  const a = Buffer.from(derived);
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

async function doBuildCatalog({ force = false } = {}) {
  const [chRes, stRes] = await Promise.all([
    fetchBuf(SOURCES.channels, { ttl: force ? 0 : undefined }),
    fetchBuf(SOURCES.streams, { ttl: force ? 0 : undefined }),
  ]);

  const channels = JSON.parse(chRes.buf.toString('utf8'));
  const streams = JSON.parse(stRes.buf.toString('utf8'));
  const custom = readCustom();

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

  // streams do usuário têm prioridade e stream proprio (por fonte, na ordem)
  const customByChannel = new Map();
  const slugKey = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 40);
  for (const src of custom.sources) {
    if (src.active === false) continue;
    for (const st of src.streams || []) {
      const chId = st.channel || `~c${slugKey(st.title || st.url)}`;
      const list = customByChannel.get(chId) || [];
      list.push({
        ...st,
        channel: chId,
        quality: st.quality || null,
        custom: true,
        source: src.id,
        sourceName: src.name || 'Lista',
        type: inferStreamType(st),
      });
      customByChannel.set(chId, list);
      const st2 = list[list.length - 1];
      const a = st.attrs || {};
      const cs = a['catchup-source'] || (a.catchup && a.catchup !== 'none' ? st.url : null);
      if (cs)
        st2.catchup = { source: cs, days: Number(a['catchup-days']) || 0, type: a.catchup || null };
    }
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

    // melhor link primeiro: ordena pela latencia medida (menor = mais rapido).
    // Como o sort e estavel, links sem medida preservam a ordem original
    // (listas do usuario antes dos do iptv-org).
    if (list.length > 1) {
      list.sort((a, b) => streamLatency(a.url) - streamLatency(b.url));
    }
    const primary = list[0];
    const name =
      meta?.name ||
      list.find((s) => s.title)?.title ||
      id.split('.')[0];

    const isCustom = !!primary.custom;
    const group = isCustom ? primary.group || null : null;
    const categories =
      meta?.categories && meta.categories.length
        ? meta.categories
        : group
        ? [group]
        : [];
    const type = isCustom
      ? primary.type || 'live'
      : categories.includes('movies')
      ? 'movie'
      : categories.includes('series')
      ? 'series'
      : 'live';

    items.push({
      id,
      name,
      country: meta?.country || null,
      categories,
      group,
      type,
      isNsfw: !!meta?.is_nsfw,
      closed: !!meta?.closed,
      logo:
        (isCustom && primary.logo) ||
        (meta ? `https://cdn.iptv-org.net/logo/${id}.png` : ''),
      altNames: meta?.alt_names || [],
      streams: list.map((s) => ({
        url: s.url,
        quality: s.quality || null,
        title: s.title || null,
        feed: s.feed || null,
        labels: s.labels || [],
        custom: !!s.custom,
        source: s.source || null,
        sourceName: s.sourceName || null,
        ...(s.catchup ? { catchup: s.catchup } : {}),
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

  // series locais do HD (se IPTV_MEDIA_DIR estiver configurado)
  items.push(...(await scanLibrary()));

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
  persistCatalog();
  return catalogCache;
}

/* Guarda o catalogo montado em disco para o proximo start ja subir quente.
   Escreve num .tmp e troca por rename: uma saida no meio do caminho nao
   deixa o catalog.json truncado (o proximo start sobe frio, sem corromper). */
function persistCatalog() {
  if (!catalogCache) return;
  const { at, items, stats, radioError } = catalogCache;
  const file = path.join(CACHE_DIR, 'catalog.json');
  const tmp = file + '.tmp';
  fsp
    .writeFile(tmp, JSON.stringify({ at, items, stats, radioError: radioError || null }))
    .then(() => fsp.rename(tmp, file))
    .catch(() => {});
}

function loadPersistedCatalog() {
  try {
    const file = path.join(CACHE_DIR, 'catalog.json');
    if (!fs.existsSync(file)) return;
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d && Array.isArray(d.items) && d.items.length) {
      catalogCache = {
        at: d.at || 0,
        items: d.items,
        stats: d.stats || null,
        radioError: d.radioError || null,
      };
    }
  } catch {}
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
        // guarda os atributos do #EXTINF: alguns provedores declaram
        // catch-up (catchup/catchup-source/catchup-days) para timeshift
        attrs: pending.attrs && Object.keys(pending.attrs).length ? pending.attrs : undefined,
      });
      pending = null;
    }
  }
  return out;
}

/* Classifica um stream de lista importada em "live", "movie" ou "series".
   Usa o group-title, o titulo e a URL: provedores Xtream costumam separar
   por grupo ("FILMES", "SERIES") e/ou por caminho (/movie/, /series/). */
function inferStreamType(stream) {
  const group = String(stream.group || '');
  const name = String(stream.title || stream.name || '');
  const u = String(stream.url || '').toLowerCase();
  const hint = (group + ' ' + name).toLowerCase();
  if (
    /\/series?\//.test(u) ||
    /\b(s[eé]ries?|temporadas?|seasons?|epis[oó]dios?|novelas?)\b/.test(hint)
  )
    return 'series';
  if (
    /\/movies?\//.test(u) ||
    /\b(filmes?|movies?|vod|cinema|lan[çc]amentos?)\b/.test(hint) ||
    /\.(mp4|mkv|avi|mov|m4v|wmv|flv|webm)(\?|$)/.test(u)
  )
    return 'movie';
  return 'live';
}

/* Separa o nome base da serie e o numero da temporada/episodio a partir do
   titulo. Reconhece os padroes mais usados: "S01E02", "1x02", "Temporada 1
   Episodio 2" e "Episodio 2". Sem padrao, usa o titulo inteiro. */
function parseEpisode(title) {
  const t = String(title || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
  let m;
  if ((m = t.match(/^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(.*)$/)))
    return { base: m[1], season: +m[2], episode: +m[3] };
  if ((m = t.match(/^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})(.*)$/)))
    return { base: m[1], season: +m[2], episode: +m[3] };
  if (
    (m = t.match(
      /^(.*?)[\s._-]*(?:temporada|season)[\s._-]*(\d{1,2})[\s._-]*(?:epis[oó]dio|ep|e)[\s._-]*(\d{1,3})?/i
    ))
  )
    return { base: m[1], season: +m[2], episode: +(m[3] || 0) };
  if ((m = t.match(/^(.*?)[\s._-]*(?:epis[oó]dio|ep|e)[\s._-]*(\d{1,3})(.*)$/i)))
    return { base: m[1], season: 1, episode: +m[2] };
  return { base: t, season: 1, episode: 0 };
}

/* Normaliza o nome base: tira separadores sobrando e espacos repetidos. */
function cleanSeriesName(name) {
  return String(name || '')
    .replace(/^[\s._-]+|[\s._-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim() || 'Série';
}

/* ------------------------------------------------------------------ *
 * Biblioteca local (series em arquivo no HD, raiz IPTV_MEDIA_DIR)
 * ------------------------------------------------------------------ */

function libId(rel) {
  return '~lib-' + crypto.createHash('sha1').update(rel).digest('hex').slice(0, 10);
}

/* Procura arte da serie junto aos arquivos: poster/cover/fanart ou qualquer
   imagem dentro da pasta (e subpastas art/posters). */
function findPoster(dir) {
  for (const d of [dir, path.join(dir, 'art'), path.join(dir, 'posters'), path.join(dir, 'capa')]) {
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    const img = names.find((f) => IMG_EXTS.has(path.extname(f).toLowerCase()));
    if (!img) continue;
    const rel = path.relative(MEDIA_DIR, path.join(d, img)).split(path.sep).join('/');
    return '/media/' + rel.split('/').map(encodeURIComponent).join('/');
  }
  return '';
}

function makeLibraryItem(rel, full) {
  const stem = path.basename(full, path.extname(full));
  const { base, season, episode } = parseEpisode(stem);
  const nice = cleanSeriesName(base);
  const name = episode > 0
    ? `${nice} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : nice;
  const url = '/media/' + rel.split('/').map(encodeURIComponent).join('/');
  return {
    id: libId(rel),
    name,
    country: null,
    categories: ['Séries'],
    group: rel.split('/')[0] || 'Séries',
    type: 'series',
    isNsfw: false,
    closed: false,
    logo: findPoster(path.dirname(full)),
    altNames: [nice],
    streams: [
      {
        url,
        quality: null,
        title: stem,
        feed: null,
        labels: [],
        custom: false,
        source: null,
        sourceName: null,
        local: true,
      },
    ],
    primary: url,
    signal: 'on',
    kind: 'tv',
    local: true,
  };
}

async function scanLibrary() {
  if (!MEDIA_DIR) return [];
  const out = [];
  const stack = [MEDIA_DIR];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!e.isFile()) continue;
      if (!VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      out.push(makeLibraryItem(path.relative(MEDIA_DIR, full).split(path.sep).join('/'), full));
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function importCustom(url, name) {
  const res = await fetchBuf(url, { ttl: 30 * 60e3, guard: true });
  let text = res.buf.toString('utf8');
  if (text.charCodeAt(0) === 0x1f && text.charCodeAt(1) === 0x8b) {
    text = zlib.gunzipSync(res.buf, INFLATE_OPTS).toString('utf8');
  }
  const parsed = parseM3U(text);
  const data = readCustom();
  const id = srcId(url);
  const i = data.sources.findIndex((s) => s.id === id);
  const name2 =
    (name && String(name).trim()) ||
    (i >= 0 ? data.sources[i].name : 'Lista ' + (data.sources.length + 1));
  const src = {
    id,
    name: name2,
    url,
    addedAt: i >= 0 ? data.sources[i].addedAt || Date.now() : Date.now(),
    active: true,
    streams: parsed,
  };
  if (i >= 0) data.sources[i] = src;
  else data.sources.push(src);
  writeCustom(data);
  return { count: parsed.length, id, name: name2, sources: data.sources.length };
}

function removeSource(id) {
  const data = readCustom();
  const before = data.sources.length;
  data.sources = data.sources.filter((s) => s.id !== id);
  writeCustom(data);
  return { removed: before - data.sources.length };
}

/* Reimporta periodicamente as listas M3U ativas: provedores costumam trocar
   os links e a lista local ficaria desatualizada. Uma lista por vez, para
   nao baixar varias grandes em paralelo. */
async function refreshCustomSources() {
  if (refreshSourcesCtl.running) return refreshSourcesCtl;
  const data = readCustom();
  const active = data.sources.filter((s) => s.active !== false && s.url);
  if (!active.length) return { sources: [] };
  refreshSourcesCtl.running = true;
  const out = [];
  try {
    for (const s of active) {
      try {
        const r = await importCustom(s.url, s.name);
        out.push({ id: r.id, name: r.name, count: r.count });
      } catch (e) {
        out.push({ id: s.id, name: s.name, error: (e.message || 'erro').slice(0, 80) });
      }
    }
    refreshSourcesCtl.last = Date.now();
    refreshSourcesCtl.result = out;
  } finally {
    refreshSourcesCtl.running = false;
  }
  return { sources: out };
}
const refreshSourcesCtl = { running: false, last: 0, result: null };

function toggleSource(id, active) {
  const data = readCustom();
  const s = data.sources.find((x) => x.id === id);
  if (s) s.active = active !== false;
  writeCustom(data);
  return { id, active: s ? s.active : false };
}

function renameSource(id, name) {
  const data = readCustom();
  const s = data.sources.find((x) => x.id === id);
  if (s && name) s.name = String(name).trim().slice(0, 60) || s.name;
  writeCustom(data);
  return { id, name: s ? s.name : null };
}

/* Backup/restauracao de tudo que e configuracao do usuario: contas (com
   hash), favoritos, historico, controle parental e as listas M3U. */
function rawUsers() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'users.json'), 'utf8'));
    if (d && Array.isArray(d.users)) return d;
  } catch {}
  return { users: [] };
}

function backupData() {
  const users = rawUsers();
  const names = (users.users || []).map((u) => u.user).filter(Boolean);
  const favs = {};
  const parental = {};
  const history = {};
  for (const u of names) {
    const f = readFavs(u);
    if (f.length) favs[u] = f;
    const p = readParental(u);
    if (p) parental[u] = p;
    const h = readHistory(u);
    if (h.length) history[u] = h;
  }
  return {
    app: 'iptv-livre',
    version: 1,
    at: Date.now(),
    custom: readCustom(),
    users,
    favs,
    parental,
    history,
  };
}

function writeRawUsers(data) {
  const file = path.join(CACHE_DIR, 'users.json');
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

function restoreData(b) {
  if (!b || b.app !== 'iptv-livre') throw new Error('arquivo de backup invalido');
  const u = b.users;
  if (!u || !Array.isArray(u.users) || !u.users.length)
    throw new Error('backup sem usuarios');
  if (!u.users.every((x) => x && x.user && x.hash && x.salt))
    throw new Error('usuarios com formato invalido');
  if (!u.users.some((x) => x.admin)) u.users[0].admin = true;

  if (b.custom) writeCustom(normalizeCustom(b.custom));
  Object.entries(b.favs || {}).forEach(([name, list]) => {
    if (Array.isArray(list)) writeFavs(name, list);
  });
  Object.entries(b.history || {}).forEach(([name, list]) => {
    if (Array.isArray(list)) writeHistory(name, list.slice(0, HISTORY_MAX));
  });
  Object.entries(b.parental || {}).forEach(([name, cfg]) => {
    if (cfg && cfg.hash && cfg.salt) writeParental(name, cfg);
  });
  writeRawUsers(u);
  catalogCache = null;
  return {
    users: u.users.length,
    sources: readCustom().sources.length,
  };
}

/* ------------------------------------------------------------------ *
 * EPG
 * ------------------------------------------------------------------ */

let epgCache = null;
const DEFAULT_EPG = process.env.IPTV_EPG || 'https://epg.pw/xmltv/epg_BR.xml.gz';
/* Cadeia de fallback independente: se a fonte principal (epg.pw) cair, o guia
   continua com as alternativas (epgshare01). Lista por env: IPTV_EPG_FALLBACK. */
const EPG_FALLBACK = (
  process.env.IPTV_EPG_FALLBACK ||
  [
    'https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz',
    'https://epgshare01.online/epgshare01/epg_ripper_BR2.xml.gz',
  ].join(',')
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
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
    if (Date.now() - saved.at < EPG_TTL) {
      // no disco ficam como arrays; aqui voltam a ser Map
      epgCache = {
        channels: new Map(saved.epg.channels),
        programs: new Map(saved.epg.programs),
        src: saved.epg.src,
      };
      epgCache.index = buildEpgIndex(epgCache);
      refreshCtl.epgSrc = saved.epg.src;
      refreshCtl.lastEpg = saved.at;
      return epgCache;
    }
  } catch {}

  try {
    return await loadEpg();
  } catch (err) {
    // nenhuma fonte no ar: mantem o guia salvo (mesmo velho) em vez de sumir
    if (epgCache) return epgCache;
    refreshCtl.epgError = err.message;
    throw err;
  }
}

/* Baixa e interpreta uma fonte de EPG; rejeita guia vazio. */
async function fetchParseEpg(src) {
  const r = await fetchBuf(src, { ttl: 0, guard: true, timeout: 30000 });
  let buf = r.buf;
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, INFLATE_OPTS);
  const epg = parseXMLTV(buf.toString('utf8'));
  if (!epg.channels.size) throw new Error('guia vazio');
  epg.index = buildEpgIndex(epg);
  epg.src = src;
  return epg;
}

/* Carrega o guia tentando a fonte pedida e, se falhar, as alternativas.
   Só troca o cache quando alguma responde (nunca deixa o guia vazio). */
/* Ordem das fontes a tentar: a pedida primeiro; se for uma fonte BR conhecida,
   soma as alternativas do mesmo pais (nunca troca de regiao sozinho). */
function epgSourceChain(primary) {
  const p = primary || DEFAULT_EPG;
  const known = [DEFAULT_EPG, ...EPG_FALLBACK];
  return [...new Set([p, ...(known.includes(p) ? known : [])])];
}

async function loadEpg(src) {
  const candidates = epgSourceChain(src);
  let lastErr = null;
  for (const s of candidates) {
    try {
      const epg = await fetchParseEpg(s);
      epgCache = epg;
      refreshCtl.lastEpg = Date.now();
      refreshCtl.epgSrc = s;
      refreshCtl.epgError = null;
      persistEpg();
      return epgCache;
    } catch (err) {
      lastErr = err;
    }
  }
  refreshCtl.epgError = lastErr ? lastErr.message : 'sem fonte de EPG';
  throw lastErr || new Error('sem fonte de EPG');
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

const RADIO_COUNT = Number(process.env.RADIO_COUNT || 1500);
let radioCache = null;
let radioLoad = null;

async function buildRadio() {
  if (radioCache && Date.now() - radioCache.at < 12 * 3600e3) return radioCache;
  if (radioLoad) return radioLoad;
  radioLoad = doBuildRadio().finally(() => {
    radioLoad = null;
  });
  return radioLoad;
}

async function doBuildRadio() {
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

/* Bloqueia URL para IPs privados/loopback (anti-SSRF no /api/import,
   /logo, /sub, /proxy e fontes de EPG). Hosts validados ficam em cache
   por alguns minutos, para segmentos HLS nao pagarem um DNS por request. */
const validatedHosts = new Map(); // host -> validade
async function assertPublicUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('apenas HTTP(S)');
  const host = u.hostname;
  if ((validatedHosts.get(host) || 0) > Date.now()) return;
  const addr = net.isIP(host) ? host : (await dns.lookup(host)).address;
  if (isPrivateIP(addr)) throw new Error('endereco privado bloqueado');
  validatedHosts.set(host, Date.now() + 5 * 60e3);
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

/* Rate-limit do PIN parental por usuario: apos 5 erros, espera 1s dobrando
   a cada nova falha (teto de 5min). O scrypt sozinho nao impede forca-bruta. */
const pinFails = new Map();
function pinGuard(user) {
  const rec = pinFails.get(user);
  if (rec && rec.until > Date.now())
    return { blocked: true, retryAfter: Math.ceil((rec.until - Date.now()) / 1000) };
  return { blocked: false };
}
function notePinFail(user) {
  const rec = pinFails.get(user) || { count: 0 };
  rec.count++;
  if (rec.count >= 5)
    rec.until = Date.now() + Math.min(1000 * 2 ** (rec.count - 5), 5 * 60e3);
  pinFails.set(user, rec);
}
function notePinOk(user) {
  pinFails.delete(user);
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
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' https://www.gstatic.com; " +
      "style-src 'self' 'unsafe-inline'; img-src * data:; media-src 'self' blob:; " +
      "connect-src 'self'; worker-src 'self' blob:; child-src 'none'; " +
      "frame-src 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; " +
      "manifest-src 'self'",
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
  '.ts': 'video/mp2t',
  '.m3u': 'audio/x-mpegurl; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mp4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.srt': 'application/x-subrip; charset=utf-8',
  '.vtt': 'text/vtt; charset=utf-8',
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

/* Arquivos da biblioteca local: stream direto com suporte a Range (o player
   precisa buscar no meio do arquivo). So arquivos regulares dentro de
   MEDIA_DIR, nada mais. */
async function serveMedia(req, res, pathname) {
  if (!MEDIA_DIR) return send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  const rel = decodeURIComponent(pathname.replace(/^\/media\//, ''));
  const file = path.resolve(MEDIA_DIR, rel);
  if (file !== MEDIA_DIR && !file.startsWith(MEDIA_DIR + path.sep))
    return send(res, 403, 'proibido', { 'Content-Type': 'text/plain; charset=utf-8' });

  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (!st.isFile())
    return send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });

  const ctype = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  return streamFileRange(req, res, file, st, ctype);
}

/* Serve um arquivo local com suporte a Range (usado por /media e /ts). */
function streamFileRange(req, res, file, st, ctype) {
  const total = st.size;
  const headers = {
    'Content-Type': ctype,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  };

  let status = 200;
  let start = 0;
  let end = total - 1;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (m) {
    start = m[1] !== '' ? parseInt(m[1], 10) : 0;
    end = m[2] !== '' && m[2] !== undefined ? parseInt(m[2], 10) : total - 1;
    if (start >= total || start > end) {
      headers['Content-Range'] = `bytes */${total}`;
      return send(res, 416, '', headers);
    }
    end = Math.min(end, total - 1);
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
    headers['Content-Length'] = String(end - start + 1);
  } else {
    headers['Content-Length'] = String(total);
  }

  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  const rs = fs.createReadStream(file, { start, end });
  rs.on('error', () => res.destroy());
  rs.pipe(res);
}

/* ------------------------------------------------------------------ *
 * Timeshift: grava o canal ao vivo em HLS no disco e deixa o player
 * rebobinar/pausar dentro da janela gravada (buffer circular).
 * ------------------------------------------------------------------ */
const TIMESHIFT_DIR = path.join(CACHE_DIR, 'timeshift');
const TIMESHIFT_SEGS = Number(process.env.IPTV_TIMESHIFT_SEGS || 450); // ~30 min a 4s
const TIMESHIFT_IDLE_MS = Number(process.env.IPTV_TIMESHIFT_IDLE || 3 * 60e3);
const TIMESHIFT = new Map(); // id -> sessao

function startTimeshift(url) {
  for (const s of TIMESHIFT.values()) if (s.url === url && s.status !== 'error') return s;
  const id = crypto.createHash('sha1').update(url).digest('hex').slice(0, 12) + '-' + Date.now().toString(36);
  const dir = path.join(TIMESHIFT_DIR, id);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-user_agent', UA,
    '-i', url,
    '-c', 'copy',
    '-f', 'hls',
    '-hls_time', '4',
    '-hls_list_size', String(TIMESHIFT_SEGS),
    '-hls_flags', 'delete_segments+omit_endlist',
    '-hls_segment_filename', path.join(dir, 'seg%05d.ts'),
    path.join(dir, 'index.m3u8'),
  ];
  let proc;
  try {
    proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch {
    return null;
  }
  const s = {
    id,
    url,
    dir,
    proc,
    started: Date.now(),
    lastAccess: Date.now(),
    status: 'starting',
    error: null,
  };
  let err = '';
  proc.stderr.on('data', (d) => {
    err = (err + d).slice(-400);
  });
  proc.on('error', (e) => {
    s.status = 'error';
    s.error = e.message;
  });
  proc.on('close', () => {
    if (s.status === 'starting' || s.status === 'running') {
      const has = fs.existsSync(path.join(dir, 'index.m3u8'));
      s.status = has ? 'stopped' : 'error';
      if (!has) s.error = (err.trim().split('\n').pop() || 'stream sem sinal').slice(0, 120);
    }
  });
  TIMESHIFT.set(id, s);
  return s;
}

function stopTimeshift(s, removeDir) {
  if (!s) return;
  try {
    s.proc.kill('SIGKILL');
  } catch {}
  TIMESHIFT.delete(s.id);
  if (removeDir !== false) {
    try {
      fs.rmSync(s.dir, { recursive: true, force: true });
    } catch {}
  }
}

function timeshiftReap() {
  const now = Date.now();
  for (const s of [...TIMESHIFT.values()]) {
    const idle = now - s.lastAccess > TIMESHIFT_IDLE_MS;
    const tooOld = now - s.started > TIMESHIFT_SEGS * 4000 * 3;
    if (idle || tooOld || s.status === 'error') stopTimeshift(s, true);
  }
}
setInterval(timeshiftReap, 30e3).unref?.();

async function serveTimeshift(req, res, pathname) {
  const m = /^\/ts\/([^/]+)\/(.+)$/.exec(pathname);
  if (!m) return send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  const s = TIMESHIFT.get(m[1]);
  if (!s) return send(res, 404, 'sessao expirada', { 'Content-Type': 'text/plain; charset=utf-8' });
  s.lastAccess = Date.now();
  const rel = decodeURIComponent(m[2]);
  const file = path.resolve(s.dir, rel);
  if (file !== s.dir && !file.startsWith(s.dir + path.sep))
    return send(res, 403, 'proibido', { 'Content-Type': 'text/plain; charset=utf-8' });

  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  if (!st.isFile())
    return send(res, 404, 'nao encontrado', { 'Content-Type': 'text/plain; charset=utf-8' });

  const ext = path.extname(file).toLowerCase();
  const ctype = MIME[ext] || 'application/octet-stream';
  if (ext === '.m3u8') {
    const data = await fsp.readFile(file);
    return send(res, 200, data, {
      'Content-Type': ctype,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    });
  }
  if (s.status === 'starting') s.status = 'running';
  return streamFileRange(req, res, file, st, ctype);
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
        agent: UPSTREAM_AGENTS[mod === https ? 'https:' : 'http:'],
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
      { method: 'GET', headers, timeout: 20000, agent: UPSTREAM_AGENTS[mod === https ? 'https:' : 'http:'] },
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
    // radio, video ao vivo e arquivo avulso (ex.: MP4 sem extensao na URL,
    // como o /download do Google Drive): repassa direto, sem buffer. Sem
    // copiar content-range/accept-ranges, um pedido com Range virava um 206
    // sem Content-Range, resposta invalida que o player recusa ("Format error").
    const headers = { 'Cache-Control': 'no-store' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'icy-name', 'icy-br']) {
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
 * Reencode sob demanda (MPEG-2 -> H.264) e sonda de codec
 * ------------------------------------------------------------------ */

let ffmpegReady = null;
function ffmpegAvailable() {
  if (!TRANSCODE_ON) return Promise.resolve(false);
  if (ffmpegReady !== null) return Promise.resolve(ffmpegReady);
  return new Promise((resolve) => {
    let done = false;
    let proc;
    try {
      proc = spawn(FFMPEG_BIN, ['-version'], { stdio: 'ignore' });
    } catch {
      ffmpegReady = false;
      return resolve(false);
    }
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch {}
      ffmpegReady = ok;
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), 4000);
    proc.on('error', () => finish(false));
    proc.on('exit', (code) => finish(code === 0));
  });
}

/* --------------------------- gravacao (DVR) --------------------------- */

let dvr = [];
try {
  const d = JSON.parse(fs.readFileSync(DVR_FILE, 'utf8'));
  if (Array.isArray(d)) dvr = d;
} catch {}
// uma conversao em andamento nao sobrevive ao restart; destrava a flag
for (const r of dvr) if (r.transcoding) r.transcoding = false;
const dvrProcs = new Map();
const dvrTransProcs = new Map();

function saveDvr() {
  try {
    const tmp = DVR_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(dvr));
    fs.renameSync(tmp, DVR_FILE);
  } catch {}
}

/* Gravacoes que ocupariam a mesma "linha" de tempo [start,end): contam para o
   limite de simultaneas. Ignora as ja terminadas/falhas/canceladas. */
function dvrIntervals() {
  return dvr
    .filter((r) => (r.status === 'pending' || r.status === 'recording') && r.start && r.end)
    .map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end }));
}

/* Pico de gravacoes ao mesmo tempo (varredura de eventos inicio/fim). */
function maxConcurrent(intervals) {
  const ev = [];
  for (const it of intervals) {
    ev.push([it.start, 1]);
    ev.push([it.end, -1]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let max = 0;
  for (const [, d] of ev) {
    cur += d;
    if (cur > max) max = cur;
  }
  return max;
}

/* Intervalos existentes que se sobrepoem a [start,end). */
function dvrOverlapping(start, end) {
  return dvrIntervals().filter((r) => r.start < end && r.end > start);
}

/* Apaga as gravacoes prontas mais antigas ate caber no teto de disco/quantidade.
   Nunca toca nas que estao gravando/agendadas. */
function pruneRecordings() {
  const maxBytes = DVR_MAX_GB * 1024 ** 3;
  let done = dvr.filter((r) => r.status === 'done');
  if (!done.length) return;
  done.sort((a, b) => (a.start || 0) - (b.start || 0)); // mais antigas primeiro
  let total = done.reduce((s, r) => s + (r.size || 0), 0);
  let count = done.length;
  for (const r of done) {
    const overBytes = maxBytes > 0 && total > maxBytes;
    const overCount = DVR_KEEP > 0 && count > DVR_KEEP;
    if (!overBytes && !overCount) break;
    total -= r.size || 0;
    count -= 1;
    removeRecording(r.id, true);
  }
}

function dvrUsedBytes() {
  return dvr.reduce((s, r) => s + (r.size || 0), 0);
}

function dvrList() {
  return dvr
    .slice()
    .sort((a, b) => (b.start || 0) - (a.start || 0))
    .map((r) => ({
      id: r.id,
      channel: r.channel || null,
      name: r.name,
      start: r.start,
      end: r.end,
      status: r.status,
      error: r.error || null,
      url: r.fileUrl || null,
      size: r.size || 0,
      codec: r.codec || null,
      needsTranscode: !!r.needsTranscode,
      transcoding: !!r.transcoding,
    }));
}

function recFileName(name, start) {
  const base =
    String(name || 'gravacao')
      .normalize('NFKD')
      .replace(/[^\w.-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'gravacao';
  const ts = new Date(start || Date.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${base}_${ts}.ts`;
}

function startRecording(rec) {
  if (!DVR_ENABLED) {
    rec.status = 'error';
    rec.error = 'gravacao desligada';
    return saveDvr();
  }
  // sonda o codec (assincrono) antes de ligar o ffmpeg: assim a gravacao ja
  // nasce em formato que o navegador toca
  rec.status = 'recording';
  rec.error = null;
  rec.fileUrl = null;
  saveDvr();
  probeCodec(rec.url, null)
    .then((info) => launchRecording(rec, info))
    .catch(() => launchRecording(rec, null));
}

/* Normaliza o audio: mantem AAC/MP3 e troca o resto (AC3/E-AC3/MP2) por AAC,
   que o navegador toca. O video e sempre copiado — reencodar HEVC em tempo
   real nao roda neste servidor. */
function recordingCodecArgs(info) {
  const args = ['-c:v', 'copy'];
  if (!info || info.failed) return [...args, '-c:a', 'copy'];
  const a = info.audio;
  if (a === 'aac' || a === 'mp3') args.push('-c:a', 'copy');
  else if (a) args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  else args.push('-an');
  return args;
}

function launchRecording(rec, info) {
  // a gravacao pode ter sido cancelada durante a sondagem do codec
  if (rec.status !== 'recording') return;
  rec.codec = info && !info.failed ? info.video : null;
  rec.needsTranscode = !!(rec.codec && rec.codec !== 'h264');
  try {
    fs.mkdirSync(REC_DIR, { recursive: true });
  } catch {}
  const file = path.join(REC_DIR, rec.file);
  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', UA, '-y'];
  args.push('-i', rec.url, ...recordingCodecArgs(info));
  if (rec.end) {
    args.push('-t', String(Math.max(1, Math.round((rec.end - Date.now()) / 1000))));
  }
  args.push('-f', 'mpegts', file);
  let proc;
  try {
    proc = spawn(FFMPEG_BIN, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  } catch {
    rec.status = 'error';
    rec.error = 'ffmpeg indisponivel';
    return saveDvr();
  }
  dvrProcs.set(rec.id, proc);
  let err = '';
  proc.stderr.on('data', (d) => {
    err = (err + d).slice(-500);
  });
  proc.on('error', (e) => {
    rec.status = 'error';
    rec.error = (e.message || 'erro no ffmpeg').slice(0, 100);
    saveDvr();
  });
  proc.on('close', (code) => {
    dvrProcs.delete(rec.id);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {}
    rec.size = size;
    if (rec.status === 'recording') rec.status = code === 0 || size > 0 ? 'done' : 'error';
    if (rec.status === 'error') rec.error = (err.split('\n').filter(Boolean).pop() || 'falha ao gravar').slice(0, 100);
    rec.fileUrl = size > 0 && MEDIA_DIR ? '/media/recordings/' + encodeURIComponent(rec.file) : null;
    saveDvr();
    // respeita o teto de disco assim que uma gravacao termina
    if (rec.status === 'done') pruneRecordings();
  });
}

function stopRecording(rec) {
  const proc = dvrProcs.get(rec.id);
  if (proc) {
    try {
      proc.kill('SIGINT');
    } catch {}
    dvrProcs.delete(rec.id);
  }
  if (rec.status === 'recording' || rec.status === 'pending')
    rec.status = rec.end && Date.now() < rec.end - 5000 ? 'canceled' : 'done';
  saveDvr();
}

/* Converte uma gravacao pronta para H.264/AAC MP4 (offline, sem pressa) para
   tocar no navegador. Roda uma por vez para nao afogar os 2 nucleos. */
function startTranscode(rec) {
  if (!rec || rec.status !== 'done' || !rec.file) return { ok: false, error: 'nada para converter' };
  if (rec.transcoding) return { ok: false, error: 'ja esta convertendo' };
  if (dvrTransProcs.size) return { ok: false, error: 'ja ha uma conversao em andamento' };
  const src = path.join(REC_DIR, rec.file);
  if (!fs.existsSync(src)) return { ok: false, error: 'arquivo nao encontrado' };
  const outName = rec.file.replace(/\.[a-z0-9]+$/i, '') + '.mp4';
  const out = path.join(REC_DIR, outName);
  let proc;
  try {
    proc = spawn(
      FFMPEG_BIN,
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', src,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        out,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
  } catch {
    return { ok: false, error: 'ffmpeg indisponivel' };
  }
  rec.transcoding = true;
  rec.error = null;
  saveDvr();
  dvrTransProcs.set(rec.id, proc);
  let err = '';
  proc.stderr.on('data', (d) => {
    err = (err + d).slice(-400);
  });
  proc.on('error', (e) => {
    dvrTransProcs.delete(rec.id);
    rec.transcoding = false;
    rec.error = (e.message || 'erro ao converter').slice(0, 100);
    saveDvr();
  });
  proc.on('close', (code) => {
    dvrTransProcs.delete(rec.id);
    rec.transcoding = false;
    let size = 0;
    try {
      size = fs.statSync(out).size;
    } catch {}
    if (code === 0 && size > 0) {
      try {
        fs.unlinkSync(src); // troca o .ts pela versao .mp4
      } catch {}
      rec.file = outName;
      rec.size = size;
      rec.codec = 'h264';
      rec.needsTranscode = false;
      rec.fileUrl = MEDIA_DIR ? '/media/recordings/' + encodeURIComponent(outName) : null;
    } else {
      rec.error = (err.split('\n').filter(Boolean).pop() || 'falha ao converter').slice(0, 100);
      try {
        fs.unlinkSync(out);
      } catch {}
    }
    saveDvr();
  });
  return { ok: true };
}

/* Aceita epoch em ms, epoch em segundos ou string ISO. Devolve NaN quando nao
   da pra interpretar (ai o chamador decide, em vez de assumir "agora"). */
function toEpoch(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const n = Number(v);
  if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
  const d = Date.parse(v);
  return Number.isNaN(d) ? NaN : d;
}

function scheduleRecording({ channel, name, url, start, end }) {
  const s = Number(start) || Date.now();
  const e = Number(end) || s + 30 * 60e3;
  // evita agendar duas vezes o mesmo canal no mesmo horario (clique duplo,
  // EPG + botao de gravar): reaproveita o agendamento existente
  const dup = dvr.find(
    (r) =>
      (r.status === 'pending' || r.status === 'recording') &&
      ((channel && r.channel === channel && Math.abs((r.start || 0) - s) < 60e3) ||
        (r.url === url && Math.abs((r.start || 0) - s) < 60e3))
  );
  if (dup) return dup;
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const rec = {
    id,
    channel: channel || null,
    name: name || 'Gravacao',
    url,
    start: s,
    end: e,
    // sufixo com o id garante nome unico mesmo para nome+horario iguais
    file: recFileName(name, s).replace(/\.ts$/, '') + '_' + id.slice(1, 5) + '.ts',
    status: 'pending',
    error: null,
    createdAt: Date.now(),
  };
  dvr.push(rec);
  saveDvr();
  if (s <= Date.now() + 1000) startRecording(rec);
  return rec;
}

function cancelRecording(id) {
  const r = dvr.find((x) => x.id === id);
  if (!r) return { ok: false };
  if (r.status === 'recording') stopRecording(r);
  else if (r.status === 'pending') {
    r.status = 'canceled';
    saveDvr();
  }
  return { ok: true, status: r.status };
}

function removeRecording(id, purge) {
  const i = dvr.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false };
  const r = dvr[i];
  if (r.status === 'recording') stopRecording(r);
  if (purge && r.file) {
    try {
      fs.unlinkSync(path.join(REC_DIR, r.file));
    } catch {}
  }
  dvr.splice(i, 1);
  saveDvr();
  return { ok: true };
}

let dvrTicking = false;
function dvrTick() {
  if (!DVR_ENABLED || dvrTicking) return;
  dvrTicking = true;
  try {
    const now = Date.now();
    let active = dvr.filter((r) => r.status === 'recording').length;
    for (const r of dvr) {
      if (r.status === 'pending' && r.start && r.start <= now) {
        if (active >= DVR_MAX_CONCURRENT) {
          r.status = 'error';
          r.error = 'limite de gravacoes simultaneas';
          saveDvr();
        } else {
          startRecording(r);
          active++;
        }
      } else if (r.status === 'recording' && r.end && r.end <= now) stopRecording(r);
    }
    pruneRecordings();
  } finally {
    dvrTicking = false;
  }
}

/* Escolhe qual link do canal gravar: prefere H.264, que o navegador toca sem
   reencode (o servidor nao da conta de reencodar HEVC em tempo real). Sonda
   os primeiros links em paralelo e fica com o primeiro H.264; se nenhum for,
   usa o primeiro link vivo mesmo. */
const REC_PROBE_MAX = 5;
async function recordUrlFor(channelId) {
  const cat = await buildCatalog();
  const it = cat.items.find((i) => i.id === channelId);
  if (!it || !it.streams || !it.streams.length) return null;
  const alive = it.streams.filter((x) => x.url && streamAlive(x.url));
  const cands = (alive.length ? alive : it.streams).filter((x) => x.url).slice(0, REC_PROBE_MAX);
  if (!cands.length) return null;
  const probes = await Promise.all(
    cands.map((s) => probeCodec(s.url, null).catch(() => null))
  );
  let pick = cands.findIndex((_s, i) => probes[i] && !probes[i].failed && probes[i].video === 'h264');
  if (pick < 0) pick = 0;
  return { url: cands[pick].url, name: it.name, codec: probes[pick] ? probes[pick].video : null };
}

/* Substitui os placeholders de um template de catch-up (catchup-source). */
function buildCatchupUrl(tpl, start, end) {
  const s = new Date(start);
  const pad = (n, w) => String(n).padStart(w || 2, '0');
  const map = {
    utc: Math.floor(start / 1000),
    utcend: Math.floor(end / 1000),
    lutc: Math.floor(Date.now() / 1000),
    timestamp: Math.floor(start / 1000),
    Y: s.getUTCFullYear(),
    m: pad(s.getUTCMonth() + 1),
    d: pad(s.getUTCDate()),
    H: pad(s.getUTCHours()),
    M: pad(s.getUTCMinutes()),
    S: pad(s.getUTCSeconds()),
    duration: Math.max(1, Math.floor((end - start) / 1000)),
  };
  return String(tpl).replace(/\{(\w+)\}/g, (m, k) => (map[k] !== undefined ? String(map[k]) : m));
}

/* Sonda o codec do primeiro trilho de video/audio via ffprobe. Cache curto
   por URL para nao repetir a sondagem a cada abertura do mesmo canal. */
const probeCache = new Map();
const PROBE_TTL = 30 * 60e3;

function runFfprobe(url, referer) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error', '-print_format', 'json', '-show_streams',
      '-rw_timeout', '8000000', '-user_agent', UA,
    ];
    if (referer) args.push('-referer', referer);
    args.push(url);
    let out = '', done = false, proc;
    try {
      proc = spawn(FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return resolve(null);
    }
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.kill('SIGKILL'); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), 9000);
    proc.stdout.on('data', (d) => (out += d));
    proc.on('error', () => finish(null));
    proc.on('exit', (code) => {
      if (code !== 0) return finish(null);
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find((s) => s.codec_type === 'video');
        const a = (j.streams || []).find((s) => s.codec_type === 'audio');
        finish({ video: v ? v.codec_name : null, audio: a ? a.codec_name : null });
      } catch {
        finish(null);
      }
    });
  });
}

async function probeCodec(url, referer) {
  const hit = probeCache.get(url);
  if (hit && Date.now() - hit.at < PROBE_TTL) return hit;
  const r = await runFfprobe(url, referer);
  const rec = r
    ? { at: Date.now(), video: r.video, audio: r.audio, failed: false }
    : { at: Date.now(), video: null, audio: null, failed: true };
  probeCache.set(url, rec);
  if (probeCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of probeCache) if (now - v.at > PROBE_TTL) probeCache.delete(k);
  }
  return rec;
}

const transcodes = new Set();

/* Le o link remoto pelo ffmpeg e entrega MP4 fragmentado (H.264/AAC)
   progressivo. Espera o primeiro byte antes de responder: assim um link
   quebrado vira 502 de verdade em vez de um 200 vazio no <video>. */
function transcodeStream(req, res, target) {
  if (!TRANSCODE_ON) {
    return send(res, 501, 'reencode desligado (IPTV_TRANSCODE=0)', {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
  if (transcodes.size >= TRANSCODE_MAX) {
    return send(res, 503, 'servidor ocupado: muitas reencodagens ativas', {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '5',
    });
  }

  const args = ['-hide_banner', '-loglevel', 'error', '-user_agent', UA];
  if (req.headers.referer) args.push('-referer', req.headers.referer);
  args.push(
    '-i', target,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-crf', '24', '-pix_fmt', 'yuv420p', '-g', '48', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  );

  let proc;
  try {
    proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    return send(res, 502, 'falha ao iniciar ffmpeg: ' + err.message, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
  }
  transcodes.add(proc);

  let started = false;
  let ended = false;
  let stderr = '';
  const cleanup = () => {
    if (ended) return;
    ended = true;
    transcodes.delete(proc);
    try { proc.kill('SIGKILL'); } catch {}
  };
  const preroll = setTimeout(() => {
    if (started) return;
    cleanup();
    if (!res.headersSent)
      send(res, 504, 'tempo esgotado reencodando o canal', {
        'Content-Type': 'text/plain; charset=utf-8',
      });
  }, TRANSCODE_PREROLL_MS);

  proc.stderr.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-2000);
  });
  proc.stdout.on('error', cleanup);
  proc.on('error', (err) => {
    clearTimeout(preroll);
    cleanup();
    if (!res.headersSent)
      send(res, 502, 'falha ao reencodar: ' + err.message, {
        'Content-Type': 'text/plain; charset=utf-8',
      });
  });
  proc.on('exit', (code) => {
    clearTimeout(preroll);
    if (!started && !res.headersSent) {
      const last = stderr.split('\n').map((s) => s.trim()).filter(Boolean).pop();
      cleanup();
      return send(res, 502, 'reencode falhou: ' + (last || 'codigo ' + code), {
        'Content-Type': 'text/plain; charset=utf-8',
      });
    }
    cleanup();
    if (!res.writableEnded) {
      try { res.end(); } catch {}
    }
  });

  // primeiro byte: agora sim vale a pena responder 200 e streamar
  proc.stdout.once('data', (chunk) => {
    started = true;
    clearTimeout(preroll);
    if (res.headersSent) {
      try { res.write(chunk); } catch { cleanup(); }
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(chunk);
    proc.stdout.pipe(res);
  });

  res.on('close', cleanup);
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
    if (!(await auth.attempt(res, String(user || ''), String(pass || '')))) {
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

  // tudo abaixo exige sessao valida (ou token de cast/lista, sem cookie)
  const castUser =
    p === '/proxy' || p === '/api/m3u' || p === '/transcode'
      ? verifyCastToken(url.searchParams.get('token'))
      : null;
  if (!auth.currentUser(req) && !castUser) {
    if (p.startsWith('/api') || p === '/proxy' || p === '/transcode' || p === '/sub' || p === '/logo' || p.startsWith('/media') || p.startsWith('/ts/'))
      return sendJSON(res, 401, { error: 'nao autenticado' });
  }

  try {
    if (p === '/api/probe') {
      const target = url.searchParams.get('u');
      if (!target) return sendJSON(res, 400, { error: 'informe ?u=' });
      try {
        await assertPublicUrl(target);
      } catch {
        return sendJSON(res, 403, { error: 'url bloqueada' });
      }
      const info = await probeCodec(target, req.headers.referer);
      return sendJSON(res, 200, {
        ok: !info.failed,
        video: info.video || null,
        audio: info.audio || null,
        transcode: await ffmpegAvailable(),
      });
    }

    // diagnostico de um stream que falhou no player: por que nao tocou?
    if (p === '/api/stream-status') {
      const target = url.searchParams.get('u');
      if (!target) return sendJSON(res, 400, { error: 'informe ?u=' });
      try {
        await assertPublicUrl(target);
      } catch {
        return sendJSON(res, 403, { error: 'url bloqueada' });
      }
      const e = health.entries[target] || null;
      const hostDead = hostIsDead(target);
      const why = deadReason(target);
      return sendJSON(res, 200, {
        url: target,
        host: extractHost(target),
        checked: e ? e.checked || 0 : 0,
        hostDead,
        dead: !!why,
        why: why || null,
        label: why ? whyLabel(why) : null,
      });
    }

    // links alternativos para o mesmo canal (para o player tentar quando o
    // link atual falha). Casa por id ou por nome normalizado.
    if (p === '/api/alternatives') {
      const id = url.searchParams.get('id');
      if (!id) return sendJSON(res, 400, { error: 'informe ?id=' });
      const tried = new Set(
        (url.searchParams.get('exclude') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const cat = await buildCatalog();
      const item = cat.items.find((i) => i.id === id);
      if (!item) return sendJSON(res, 404, { error: 'canal nao encontrado' });
      const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
      const keys = new Set([norm(item.name), ...(item.altNames || []).map(norm)].filter((k) => k.length >= 5));
      const own = new Set((item.streams || []).map((s) => s.url));
      const seen = new Set();
      const alts = [];
      if (keys.size) {
        for (const it of cat.items) {
          if (it.id === id) continue;
          if (item.country && it.country && item.country !== it.country) continue;
          const cand = [norm(it.name), ...(it.altNames || []).map(norm)];
          if (!cand.some((k) => keys.has(k))) continue;
          for (const s of it.streams || []) {
            const u = s.url;
            if (!u || own.has(u) || tried.has(u) || seen.has(u)) continue;
            if (!streamAlive(u)) continue;
            seen.add(u);
            alts.push({
              url: u,
              quality: s.quality || null,
              sourceName: s.sourceName || null,
              custom: !!s.custom,
            });
          }
        }
      }
      return sendJSON(res, 200, { id, name: item.name, alternatives: alts.slice(0, 8) });
    }

    if (p === '/api/catalog') {
      const cat = await buildCatalog();
      const country = url.searchParams.get('country');
      const search = (url.searchParams.get('q') || '').toLowerCase();
      const category = url.searchParams.get('category');
      const onlyId = url.searchParams.get('id');
      const kind = url.searchParams.get('kind') || 'tv';
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.min(Number(limitParam) || 0, 5000) : 5000;
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);

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
        ...paginate(items, offset, limit),
      });
    }

    if (p === '/api/health') {
      return sendJSON(res, 200, healthSummary());
    }

    // resumo detalhado: streams, hosts mortos e saude por lista (painel)
    if (p === '/api/health/overview') {
      const checked = Object.values(health.entries).filter((e) => e && e.checked);
      let alive = 0;
      let soft = 0;
      for (const e of checked) {
        if (e.ok) alive++;
        else if (isSoft(e.why)) soft++;
      }
      const deadHostsMap = new Map();
      for (const src of readCustom().sources) {
        for (const st of src.streams || []) {
          const h = extractHost(st.url);
          if (hostDead(h)) deadHostsMap.set(h, (deadHostsMap.get(h) || 0) + 1);
        }
      }
      const deadHosts = [...deadHostsMap.entries()]
        .map(([host, channels]) => ({ host, channels, why: hostReason(`http://${host}/`) }))
        .sort((a, b) => b.channels - a.channels);
      return sendJSON(res, 200, {
        at: Date.now(),
        streams: {
          checked: checked.length,
          alive,
          dead: checked.length - alive,
          soft,
        },
        hosts: hostStats(),
        deadHosts,
        sources: sourceList(),
        notify: { enabled: notificationsEnabled(), last: notifyState.at || 0 },
        recheck: { running: recheckJob.running, done: recheckJob.done, total: recheckJob.total },
      });
    }

    // forca uma nova passada de DNS nos hosts das listas do usuario
    if (p === '/api/health/hosts' && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      if (hostSweepRunning) return sendJSON(res, 200, { started: false, running: true });
      sweepHosts(true).catch(() => {});
      return sendJSON(res, 202, { started: true, running: true });
    }

    if (p === '/api/health/notify-test' && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      if (!notificationsEnabled())
        return sendJSON(res, 200, { ok: false, enabled: false, error: 'notificacoes desligadas' });
      const sent = await notify('Teste de notificacao do IPTV Livre.', { title: 'IPTV: teste' });
      return sendJSON(res, 200, { ok: true, enabled: true, sent });
    }

    if (p === '/api/dvr' && req.method === 'GET') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      return sendJSON(res, 200, {
        enabled: DVR_ENABLED,
        used: dvrUsedBytes(),
        maxGB: DVR_MAX_GB,
        maxConcurrent: DVR_MAX_CONCURRENT,
        recordings: dvrList(),
      });
    }

    if (p === '/api/dvr' && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      if (!DVR_ENABLED) return sendJSON(res, 400, { error: 'gravacao desligada' });
      const body = JSON.parse((await readBody(req)) || '{}');
      // start so vira "agora" quando o pedido realmente nao pede horario
      // (gravar ja). Horario informado mas invalido da 400, nunca grava o atual.
      const hasStart = body.start != null && body.start !== '';
      const start = hasStart ? toEpoch(body.start) : Date.now();
      if (hasStart && !Number.isFinite(start))
        return sendJSON(res, 400, { error: 'horario de inicio invalido' });
      let end = toEpoch(body.end);
      if (!Number.isFinite(end) && Number(body.duration))
        end = start + Number(body.duration) * 60e3;
      if (!Number.isFinite(end)) end = start + 30 * 60e3;
      if (end <= start) return sendJSON(res, 400, { error: 'fim antes do inicio' });
      // conflito de agenda: nao passa do limite de gravacoes simultaneas
      if (!body.force) {
        const overlaps = dvrOverlapping(start, end);
        if (maxConcurrent([...overlaps, { start, end }]) > DVR_MAX_CONCURRENT) {
          return sendJSON(res, 409, {
            error: 'conflito: limite de ' + DVR_MAX_CONCURRENT + ' gravacoes simultaneas',
            conflicts: overlaps.map((r) => r.id),
            canForce: true,
          });
        }
      }
      let url = body.url;
      let name = body.name;
      if (!url && body.channel) {
        const r = await recordUrlFor(body.channel);
        if (!r) return sendJSON(res, 404, { error: 'canal sem link para gravar' });
        url = r.url;
        name = name || r.name;
      }
      if (!url) return sendJSON(res, 400, { error: 'informe channel ou url' });
      try {
        await assertPublicUrl(url);
      } catch {
        return sendJSON(res, 403, { error: 'url bloqueada' });
      }
      const rec = scheduleRecording({ channel: body.channel, name, url, start, end });
      return sendJSON(res, 200, { ok: true, recording: dvrList().find((r) => r.id === rec.id) });
    }

    if ((p === '/api/dvr/cancel' || p === '/api/dvr/remove') && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.id) return sendJSON(res, 400, { error: 'informe id' });
      const out = p.endsWith('/remove') ? removeRecording(body.id, body.purge !== false) : cancelRecording(body.id);
      return sendJSON(res, 200, out);
    }

    if (p === '/api/dvr/transcode' && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (!body.id) return sendJSON(res, 400, { error: 'informe id' });
      const rec = dvr.find((r) => r.id === body.id);
      if (!rec) return sendJSON(res, 404, { error: 'gravacao nao encontrada' });
      const out = startTranscode(rec);
      if (!out.ok) return sendJSON(res, 409, out);
      return sendJSON(res, 200, { ok: true, recording: dvrList().find((r) => r.id === rec.id) });
    }

    /* Catch-up/timeshift: monta a URL do programa no passado a partir do
       template declarado pelo provedor (catchup-source). */
    if (p === '/api/catchup') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      const id = url.searchParams.get('id');
      const minutes = Math.max(1, Number(url.searchParams.get('minutes') || 30) || 30);
      if (!id) return sendJSON(res, 400, { error: 'informe id' });
      const cat = await buildCatalog();
      const it = cat.items.find((i) => i.id === id);
      if (!it) return sendJSON(res, 404, { error: 'canal nao encontrado' });
      const s = (it.streams || []).find((x) => x.catchup && x.catchup.source);
      if (!s) return sendJSON(res, 404, { error: 'canal sem catch-up' });
      const end = Date.now();
      const start = end - minutes * 60e3;
      const target = buildCatchupUrl(s.catchup.source, start, end);
      try {
        await assertPublicUrl(target);
      } catch {
        return sendJSON(res, 403, { error: 'url bloqueada' });
      }
      return sendJSON(res, 200, {
        url: target,
        minutes,
        start,
        end,
        days: s.catchup.days || 0,
      });
    }

    /* Timeshift: inicia (ou reaproveita) um buffer HLS do canal ao vivo. */
    if (p === '/api/timeshift' && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      if (!(await ffmpegAvailable()))
        return sendJSON(res, 400, { error: 'gravacao indisponivel (ffmpeg)' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const target = body.u || body.url;
      if (!target) return sendJSON(res, 400, { error: 'informe u' });
      try {
        await assertPublicUrl(target);
      } catch {
        return sendJSON(res, 403, { error: 'url bloqueada' });
      }
      const s = startTimeshift(target);
      if (!s) return sendJSON(res, 500, { error: 'nao foi possivel iniciar o timeshift' });
      return sendJSON(res, 200, { id: s.id, playlist: '/ts/' + s.id + '/index.m3u8', status: s.status });
    }

    if (p === '/api/timeshift/stop' && req.method === 'POST') {
      if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.id) {
        const s = TIMESHIFT.get(body.id);
        if (s) stopTimeshift(s, true);
      } else if (body.u) {
        for (const s of [...TIMESHIFT.values()]) if (s.url === body.u) stopTimeshift(s, true);
      }
      return sendJSON(res, 200, { ok: true });
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

    // atualizacao do catalogo + guia: GET consulta, POST dispara
    if (p === '/api/refresh') {
      if (req.method === 'POST') {
        if (!auth.currentUser(req)) return sendJSON(res, 401, { error: 'nao autenticado' });
        if (refreshCtl.running)
          return sendJSON(res, 409, { error: 'atualizacao ja em andamento' });
        runAutoRefresh({ force: true }).catch(() => {});
        return sendJSON(res, 202, refreshStatus());
      }
      return sendJSON(res, 200, refreshStatus());
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
      const admin = auth.isAdmin(me);
      return sendJSON(res, 200, {
        user: me,
        admin,
        users: admin ? auth.users() : [],
        sessions: auth.sessionCount(me),
        history: readHistory(me).length,
        favs: readFavs(me).length,
        uptime: Math.round(process.uptime()),
        health: healthSummary(),
        refresh: refreshStatus(),
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

    if (p === '/api/m3u-token' && req.method === 'GET') {
      const me = auth.currentUser(req);
      const token = makeCastToken(me, LIST_TTL);
      const base = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
      const origin = base || SCHEME + '://' + (req.headers.host || 'localhost');
      const id = addM3uLink();
      const url = origin + '/list/' + id + '.m3u';
      return sendJSON(res, 200, { token, id, ttl: LIST_TTL / 1000, url });
    }

    if (p === '/api/dlna/discover' && req.method === 'GET') {
      const devices = await dlnaDiscover();
      return sendJSON(res, 200, { devices });
    }

    if (p === '/api/dlna/play' && req.method === 'POST') {
      const me = auth.currentUser(req);
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || '{}');
      } catch {}
      const device = data.device;
      const target = String(data.url || '');
      if (!device || !device.control || !target)
        return sendJSON(res, 400, { error: 'informe device e url' });
      if (!/^https?:/.test(target))
        return sendJSON(res, 400, { error: 'url invalida' });
      // a TV nao tem o cookie de sessao: usa token curto no /proxy
      const abs = new URL(
        '/proxy?u=' + encodeURIComponent(target) +
          '&token=' + encodeURIComponent(makeCastToken(me)),
        `http://${req.headers.host || 'localhost'}`
      ).toString();
      try {
        await dlnaPlay(device, abs);
        return sendJSON(res, 200, { ok: true });
      } catch (err) {
        return sendJSON(res, 502, { error: err.message });
      }
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
      const guard = pinGuard(me);
      if (guard.blocked)
        return sendJSON(res, 429, {
          error: `muitas tentativas. Tente de novo em ${guard.retryAfter}s`,
        });
      const body = await readBody(req);
      let data = {};
      try {
        data = JSON.parse(body || '{}');
      } catch {}
      const cfg = readParental(me);
      if (data.action === 'set') {
        if (cfg && !(await verifyPin(cfg, data.current || ''))) {
          notePinFail(me);
          return sendJSON(res, 401, { error: 'PIN atual incorreto' });
        }
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
        notePinOk(me);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      if (data.action === 'unlock') {
        if (!cfg || !(await verifyPin(cfg, data.pin || ''))) {
          notePinFail(me);
          return sendJSON(res, 401, { error: 'PIN incorreto' });
        }
        parentalUnlock.set(me, Date.now() + PARENTAL_UNLOCK_MS);
        notePinOk(me);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      if (data.action === 'lock') {
        parentalUnlock.delete(me);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      if (data.action === 'disable') {
        if (cfg && !(await verifyPin(cfg, data.pin || ''))) {
          notePinFail(me);
          return sendJSON(res, 401, { error: 'PIN incorreto' });
        }
        writeParental(me, null);
        parentalUnlock.delete(me);
        notePinOk(me);
        return sendJSON(res, 200, { ok: true, ...parentalState(me) });
      }
      return sendJSON(res, 400, { error: 'acao invalida' });
    }

    if (p === '/api/users' && req.method === 'GET') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'permissao negada' });
      return sendJSON(res, 200, { users: auth.users() });
    }

    if (p === '/api/users' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'permissao negada' });
      const body = await readBody(req);
      let user = '', pass = '';
      try {
        ({ user, pass } = JSON.parse(body || '{}'));
      } catch {}
      if (!String(user || '').trim() || !String(pass || ''))
        return sendJSON(res, 400, { error: 'informe user e pass' });
      if (String(pass).length < 6)
        return sendJSON(res, 400, { error: 'senha deve ter pelo menos 6 caracteres' });
      const out = await auth.addUser(String(user).trim(), String(pass));
      return out.ok
        ? sendJSON(res, 200, out)
        : sendJSON(res, 400, out);
    }

    if (p === '/api/users' && req.method === 'DELETE') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'permissao negada' });
      const user = url.searchParams.get('user');
      if (!user) return sendJSON(res, 400, { error: 'informe ?user=' });
      if (user === auth.currentUser(req))
        return sendJSON(res, 400, { error: 'nao pode remover a propria conta' });
      if (auth.isAdmin(user))
        return sendJSON(res, 400, { error: 'nao pode remover um administrador' });
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
      if (!(await auth.verify(me, String(old || ''))))
        return sendJSON(res, 401, { error: 'senha atual incorreta' });
      if (String(next || '').length < 6)
        return sendJSON(res, 400, { error: 'nova senha deve ter pelo menos 6 caracteres' });
      await auth.changePassword(me, String(next));
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

    if (p === '/api/sources' && req.method === 'GET') {
      return sendJSON(res, 200, {
        sources: sourceList(),
        refresh: { running: refreshSourcesCtl.running, last: refreshSourcesCtl.last },
      });
    }

    if (p === '/api/sources/refresh' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      const out = await refreshCustomSources();
      return sendJSON(res, 200, {
        ...out,
        running: refreshSourcesCtl.running,
        last: refreshSourcesCtl.last,
      });
    }

    if (p === '/api/sources' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      const url2 = body.url;
      if (!url2) return sendJSON(res, 400, { error: 'informe a url' });
      try {
        await assertPublicUrl(url2);
      } catch (e) {
        return sendJSON(res, 400, { error: `url bloqueada: ${e.message}` });
      }
      const out = await importCustom(url2, body.name);
      return sendJSON(res, 200, out);
    }

    if (p === '/api/sources/toggle' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      return sendJSON(res, 200, toggleSource(body.id, body.active));
    }

    if (p === '/api/sources/rename' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      return sendJSON(res, 200, renameSource(body.id, body.name));
    }

    if (p === '/api/sources/remove' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      let body = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch {}
      return sendJSON(res, 200, removeSource(body.id));
    }

    if (p === '/api/backup' && req.method === 'GET') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      const body = JSON.stringify(backupData());
      const name = `iptv-backup-${new Date().toISOString().slice(0, 10)}.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${name}"`,
        'Cache-Control': 'no-store',
      });
      return res.end(body);
    }

    if (p === '/api/backup' && req.method === 'POST') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      let body = '';
      try {
        body = await readBody(req, 8 * 1024 * 1024);
      } catch (e) {
        return sendJSON(res, 413, { error: e.message });
      }
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return sendJSON(res, 400, { error: 'json invalido' });
      }
      try {
        return sendJSON(res, 200, { ok: true, ...restoreData(parsed) });
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
    }

    if (p === '/api/import') {
      if (!auth.isAdmin(auth.currentUser(req)))
        return sendJSON(res, 403, { error: 'somente administrador' });
      const url2 = url.searchParams.get('url');
      if (!url2) return sendJSON(res, 400, { error: 'informe ?url=' });
      try {
        await assertPublicUrl(url2);
      } catch (e) {
        return sendJSON(res, 400, { error: `url bloqueada: ${e.message}` });
      }
      const out = await importCustom(url2, url.searchParams.get('name'));
      return sendJSON(res, 200, out);
    }

    if (p === '/api/m3u') {
      const country = url.searchParams.get('country') || 'all';
      const kind = url.searchParams.get('kind') || 'all';
      return send(res, 200, await m3uText(req, { kind, country }), {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
        'Content-Disposition': 'attachment; filename="iptv.m3u"',
      });
    }

    // link curto de lista (sem login): /list/<id>.m3u
    const m3uLink = p.match(/^\/list\/([0-9a-f]{6,})\.m3u8?$/i);
    if (m3uLink) {
      if (!resolveM3uLink(m3uLink[1].toLowerCase()))
        return send(res, 404, 'link de lista invalido ou expirado', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      return send(res, 200, await m3uText(req, { kind: 'all', country: 'all' }), {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
      });
    }

    /* ---- Xtream Codes (XC) ----
       Players de TV (ex.: Ibo no Roku) chamam player_api.php mesmo
       quando a URL colada parece um M3U. Aceitamos qualquer caminho
       que contenha player_api.php e respondemos as acoes padrao. */
    if (p.includes('player_api.php') || p.includes('panel_api.php')) {
      const action = url.searchParams.get('action') || '';
      const pub = xtreamPublic(req);
      const xuser = url.searchParams.get('username') || '';
      const xpass = url.searchParams.get('password') || '';
      if (!(await checkXtreamAuth(req, xuser, xpass))) {
        return sendJSON(res, 200, {
          user_info: {
            username: xuser,
            password: '',
            message: 'credenciais invalidas',
            auth: 0,
            status: 'Disabled',
          },
        });
      }
      await buildCatalog();
      if (!action) {
        return sendJSON(res, 200, {
          user_info: {
            username: url.searchParams.get('username') || '',
            password: url.searchParams.get('password') || '',
            message: '',
            auth: 1,
            status: 'Active',
            exp_date: String(Math.floor((Date.now() + 365 * 24 * 3600e3) / 1000)),
            is_trial: '0',
            active_cons: '0',
            created_at: String(Math.floor(Date.now() / 1000)),
            max_connections: '1',
            allowed_output_formats: ['m3u8', 'ts'],
          },
          server_info: {
            url: pub.host,
            port: pub.scheme === 'https' ? '443' : String(PORT),
            https_port: '443',
            server_protocol: pub.scheme,
            rtmp_port: '0',
            timezone: 'America/Sao_Paulo',
            timestamp_now: Math.floor(Date.now() / 1000),
            time_now: new Date().toISOString().slice(0, 19).replace('T', ' '),
          },
        });
      }
      const xd = xtreamData();

      if (action === 'get_live_categories') return sendJSON(res, 200, xd.liveCategories);
      if (action === 'get_live_streams') {
        const cid = url.searchParams.get('category_id');
        return sendJSON(
          res,
          200,
          cid
            ? xd.liveStreams.filter((s) => s.category_id === String(cid))
            : xd.liveStreams
        );
      }

      if (action === 'get_vod_categories') return sendJSON(res, 200, xd.vodCategories);
      if (action === 'get_vod_streams') {
        const cid = url.searchParams.get('category_id');
        return sendJSON(
          res,
          200,
          cid
            ? xd.vodStreams.filter((s) => s.category_id === String(cid))
            : xd.vodStreams
        );
      }
      if (action === 'get_vod_info') {
        const id = url.searchParams.get('vod_id');
        const s = xd.vodStreams.find((x) => String(x.stream_id) === String(id));
        if (!s) return sendJSON(res, 200, {});
        return sendJSON(res, 200, {
          info: {
            name: s.name,
            stream_id: s.stream_id,
            cover_big: s.stream_icon,
            movie_image: s.stream_icon,
            plot: '',
            cast: '',
            director: '',
            genre: '',
            releaseDate: '',
            rating: '0',
            rating_5based: 0,
            duration: '0',
            backdrop_path: [],
            youtube_trailer: '',
            tmdb_id: '',
          },
          movie_data: {
            stream_id: s.stream_id,
            name: s.name,
            added: s.added,
            category_id: s.category_id,
            container_extension: s.container_extension,
          },
        });
      }

      if (action === 'get_series_categories')
        return sendJSON(res, 200, xd.serieCategories);
      if (action === 'get_series') {
        const cid = url.searchParams.get('category_id');
        const list = cid
          ? xd.seriesList.filter((s) => s.category_id === String(cid))
          : xd.seriesList;
        return sendJSON(res, 200, list.map(({ seasons, episodes, ...rest }) => rest));
      }
      if (action === 'get_series_info') {
        const s = xd.seriesById.get(Number(url.searchParams.get('series_id')));
        if (!s) return sendJSON(res, 200, { seasons: [], info: {}, episodes: {} });
        const episodes = {};
        for (const ep of s.episodes) {
          const season = String(ep.season || 1);
          (episodes[season] ||= []).push({
            id: String(ep.id),
            episode_num: ep.episode,
            title: ep.title,
            container_extension: ep.ext,
            season: ep.season || 1,
            info: {},
            custom_sid: '',
            added: xd.added,
          });
        }
        return sendJSON(res, 200, {
          seasons: s.seasons.map((n) => ({
            season_number: n,
            name: `Temporada ${n}`,
            cover: s.cover,
            cover_big: s.cover,
          })),
          info: {
            name: s.name,
            cover: s.cover,
            plot: '',
            cast: '',
            director: '',
            genre: s.genre,
            releaseDate: '',
            last_modified: xd.added,
            rating: '0',
            rating_5based: 0,
            backdrop_path: [],
            youtube_trailer: '',
            episode_run_time: '0',
          },
          episodes,
        });
      }

      if (action === 'get_short_epg' || action === 'get_simple_data_table')
        return sendJSON(res, 200, {});
      return sendJSON(res, 200, []);
    }

    if (p.includes('get.php')) {
      if (
        !(await checkXtreamAuth(
          req,
          url.searchParams.get('username'),
          url.searchParams.get('password')
        ))
      ) {
        return send(res, 401, 'nao autorizado', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      await buildCatalog();
      return send(res, 200, await m3uText(req, { kind: 'all', country: 'all' }), {
        'Content-Type': 'audio/x-mpegurl; charset=utf-8',
      });
    }

    // stream do Xtream: /<live|movie|series>/<user>/<pass>/<stream_id>.<ext>
    const liveM = p.match(
      /^\/(?:live|movie|series)\/([^/]+)\/([^/]+)\/(\d+)(?:\.[a-z0-9]+)?$/i
    );
    if (liveM) {
      const dec = (s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      };
      if (!(await checkXtreamAuth(req, dec(liveM[1]), dec(liveM[2])))) {
        return send(res, 401, 'nao autorizado', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      await buildCatalog();
      const it = xtreamItems()[Number(liveM[3]) - 1];
      if (!it || !it.primary)
        return send(res, 404, 'canal nao encontrado', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      // fonte https vai direto; fonte http passa pelo /proxy (mesmo
      // esquema/host do cliente) para evitar erro TLS (app em https)
      const target = it.primary;
      const castToken = makeCastToken('xtream');
      return proxyStream(req, res, target, castToken);
    }

    if (p === '/api/epg') {
      const src = url.searchParams.get('src');
      if (!src) return sendJSON(res, 400, { error: 'informe ?src=<url do guide.xml>' });
      try {
        await loadEpgSrc(src);
      } catch (err) {
        return sendJSON(res, 502, { error: 'falha ao baixar o guia: ' + err.message });
      }

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
        active: epgCache.src,
      });
    }

    if (p === '/api/epg/guide') {
      const epg = await ensureEpg();
      const chId = url.searchParams.get('channel');
      if (chId) {
        const cat = await buildCatalog();
        let channel = cat.items.find((i) => i.id === chId);
        if (!channel) {
          const names = (epg.channels.get(chId)?.name || '').split(/\s*[/|,]\s*/);
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

    /* Grade de programacao (timeline): canais com EPG casado e os programas
       que caem na janela pedida, para o front desenhar a grade. */
    if (p === '/api/epg/timeline') {
      const epg = await ensureEpg();
      const cat = await buildCatalog();
      const kind = url.searchParams.get('kind') || 'tv';
      const country = url.searchParams.get('country') || '';
      const category = url.searchParams.get('category') || '';
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const fromMs = Number(url.searchParams.get('from')) || Date.now() - 3600e3;
      const toMs = Number(url.searchParams.get('to')) || fromMs + 7 * 3600e3;
      const limit = Math.min(Number(url.searchParams.get('limit') || 30) || 30, 80);
      const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);

      const pool = cat.items.filter((i) => !i.isNsfw && !i.closed);
      const channels = [];
      for (const it of pool) {
        if (kind !== 'all' && it.kind !== kind) continue;
        if (country && country !== 'all' && it.country !== country) continue;
        if (category && category !== 'all' && !it.categories.includes(category)) continue;
        if (q && !it.name.toLowerCase().includes(q)) continue;
        const epgId = epg.channels.has(it.id) ? it.id : findEpgChannel(epg, epg.index, it);
        if (!epgId) continue;
        const progs = (epg.programs.get(epgId) || []).filter(
          (pr) => Date.parse(pr.start) < toMs && Date.parse(pr.stop) > fromMs
        );
        if (!progs.length) continue;
        channels.push({
          id: it.id,
          name: it.name,
          logo: it.logo,
          kind: it.kind,
          country: it.country,
          programmes: progs,
        });
      }
      channels.sort((a, b) => a.name.localeCompare(b.name));
      const total = channels.length;
      const page = channels.slice(offset, offset + limit);
      return sendJSON(res, 200, {
        window: { start: fromMs, end: toMs },
        total,
        hasMore: offset + page.length < total,
        channels: page,
      });
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
      // peer de registro de origem/publico (anti-SSRF): nunca sonda a rede
      // local mesmo para um cliente autenticado
      try {
        await assertPublicUrl(target);
      } catch (e) {
        return send(res, 403, `url bloqueada: ${e.message}`, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      return proxyStream(req, res, target, castUser ? url.searchParams.get('token') : '');
    }

    if (p === '/transcode') {
      const target = url.searchParams.get('u');
      if (!target) return send(res, 400, 'informe ?u=');
      try {
        await assertPublicUrl(target);
      } catch (e) {
        return send(res, 403, `url bloqueada: ${e.message}`, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      return transcodeStream(req, res, target);
    }

    if (p === '/health')
      return sendJSON(res, 200, {
        ok: true,
        uptime: Math.round(process.uptime()),
        auth: !!auth.currentUser(req),
      });

    if (p === '/api/epg/sources') {
      return sendJSON(res, 200, {
        sources: EPG_LIST,
        active: epgCache?.src || null,
        fallback: EPG_FALLBACK,
      });
    }

    if (p === '/api/epg/load') {
      const src = url.searchParams.get('src') || DEFAULT_EPG;
      let epg;
      try {
        epg = await loadEpg(src); // tenta a fonte pedida e, se falhar, as alternativas
      } catch (err) {
        return sendJSON(res, 502, { error: 'falha ao baixar o guia: ' + err.message });
      }
      const cat = await buildCatalog();
      let matched = 0;
      for (const it of cat.items)
        if (!it.isNsfw && !it.closed && findEpgChannel(epg, epg.index, it)) matched++;
      return sendJSON(res, 200, {
        channels: epg.channels.size,
        programmes: countProgrammes(epg),
        matched,
        src: epg.src,
        requested: src,
        fellBack: epg.src !== src,
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

    if (p.startsWith('/media')) return serveMedia(req, res, p);
    if (p.startsWith('/ts/')) return serveTimeshift(req, res, p);

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
  loadPersistedCatalog();
  // marca hosts mortos logo no boot (nao espera a varredura HTTP completa)
  sweepHosts().catch(() => {});
  // limpa buffers de timeshift deixados por uma execucao anterior
  try {
    fs.rmSync(TIMESHIFT_DIR, { recursive: true, force: true });
  } catch {}
  // reimporta as listas M3U do usuario de tempos em tempos (desliga com 0)
  if (SOURCE_REFRESH_MS > 0) {
    setTimeout(() => refreshCustomSources().catch(() => {}), 60_000).unref?.();
    setInterval(() => refreshCustomSources().catch(() => {}), SOURCE_REFRESH_MS).unref?.();
  }
  // gravacao (DVR): dispara e encerra gravacoes agendadas
  if (DVR_ENABLED) {
    dvrTick();
    setInterval(dvrTick, DVR_TICK_MS).unref?.();
  }
  server.listen(PORT, HOST, () => {
    console.log(`IPTV rodando em ${SCHEME}://localhost:${PORT}`);
  });
}

if (isMain) start();

export {
  buildCatalog,
  parseM3U,
  inferStreamType,
  parseEpisode,
  scanLibrary,
  parseXMLTV,
  epgSourceChain,
  rewritePlaylist,
  srtToVtt,
  paginate,
  makeCastToken,
  verifyCastToken,
  parseSsdp,
  extractDlnaServices,
  xmlEscape,
  dlnaEnvelope,
  buildCatchupUrl,
  start,
  server,
};