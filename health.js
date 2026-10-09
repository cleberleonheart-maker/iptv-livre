/* ------------------------------------------------------------------ *
 * Verificador de saude dos streams
 *
 * Sonda cada URL do catalogo e guarda o resultado em .cache/health.json.
 * Canais sem nenhum stream vivo sao escondidos do catalogo e das listas.
 *
 * Como usar:
 *   node health.js            -> sonda tudo que ainda nao foi checado
 *   node health.js --all      -> ressonda tudo do zero
 *   node health.js BR         -> sonda so os canais do pais informado
 *   node health.js --stats    -> so mostra o resumo do estado atual
 * ------------------------------------------------------------------ */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, '.cache');
const HEALTH_FILE = path.join(CACHE_DIR, 'health.json');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const CONCURRENCY = Number(process.env.HEALTH_CONCURRENCY || 12);
const TIMEOUT = Number(process.env.HEALTH_TIMEOUT || 10000);
const SAMPLE = Number(process.env.HEALTH_SAMPLE || 24000);
const STALE_MS = 7 * 24 * 3600e3;
/* Morto confirmado demorado para voltar a ser sondado: rever o tempo todo
   reinicia o relogio de amadurecimento do servidor e deixa canal morto
   "aparecendo" sem sinal. */
const RECHECK_DEAD_MS = 6 * 3600e3;

/* Falhas que nao provam que o canal morreu: CDN bloqueando por anti-bot,
   timeout de rede, porta fechada. Precisam de nova sonda antes de contar
   como morto. "HTTP 404" e "ENOTFOUND" sao conclusivos e nao entram aqui. */
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

const isSoft = (why) => SOFT_WHY.has(why);

/* ---------------------------- estado ---------------------------- */

let state = { at: 0, entries: {} };

async function load() {
  try {
    state = JSON.parse(await fsp.readFile(HEALTH_FILE, 'utf8'));
    if (!state.entries) state = { at: 0, entries: {} };
  } catch {
    state = { at: 0, entries: {} };
  }
  return state;
}

let saving = null;
async function save() {
  if (saving) await saving;
  state.at = Date.now();
  saving = fsp
    .writeFile(HEALTH_FILE + '.tmp', JSON.stringify(state))
    .then(() => fsp.rename(HEALTH_FILE + '.tmp', HEALTH_FILE))
    .catch(() => {})
    .finally(() => {
      saving = null;
    });
  return saving;
}

/* Re-sonda um conjunto de URLs sob demanda (auto-revisao ao falhar / botao
   "re-verificar agora"), grava o novo estado e devolve os resultados.
   onResult permite acompanhar o progresso de lote grande. */
async function recheck(urls, { concurrency = CONCURRENCY, onResult = null } = {}) {
  const results = [];
  if (!urls.length) return results;
  let i = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, urls.length)) },
    async () => {
      while (i < urls.length) {
        const url = urls[i++];
        let r;
        try {
          r = await probe(url);
        } catch (e) {
          r = { ok: false, why: (e.code || e.message || 'erro').toString().slice(0, 40) };
        }
        state.entries[url] = {
          ok: r.ok,
          why: r.why || null,
          code: r.code || null,
          ctype: r.ctype || null,
          viaRetry: !!r.viaRetry,
          audioOnly: r.audioOnly || null,
          checked: Date.now(),
        };
        const rec = {
          url,
          ok: !!r.ok,
          why: r.why || null,
          code: r.code || null,
          audioOnly: !!r.audioOnly,
        };
        results.push(rec);
        if (onResult) onResult(rec);
      }
    }
  );
  await Promise.all(workers);
  await save();
  return results;
}

/* ---------------------------- sonda ---------------------------- */

/* Le o suficiente do corpo para confirmar que a URL entrega midia de verdade.
   Faz few requests de bytes (nao baixa o stream inteiro).

   O header Range e o principal motivo de 403 falso: WAF de Cloudflare/Akamai
   bloqueia requisicao parcial em origem de FAST. Quando a 1a tentativa falha
   de um jeito que nao prova morte (403, 429, timeout...), a sonda repete sem
   Range e com os cabecalhos que um player de navegador mandaria. A segunda
   resposta e o veredito. */
function probe(url, { timeout = TIMEOUT } = {}) {
  return attempt(url, { timeout, headers: headersFor(url, false) }).then(
    (first) => {
      if (first.ok || !isSoft(first.why)) return first;
      return attempt(url, {
        timeout,
        headers: headersFor(url, true),
      }).then((second) => ({ ...second, viaRetry: true }));
    }
  );
}

/* Cabecalho minimo que um player real mandaria para a origem. */
function headersFor(url, browserish) {
  const isPlaylist = /\.m3u8?(\?|$)/i.test(url);
  const base = {
    'User-Agent': UA,
    Accept: isPlaylist
      ? 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*'
      : '*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
  };
  if (!browserish) {
    return { ...base, 'Icy-MetaData': '1', Range: 'bytes=0-4095' };
  }
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {}
  // sem Range de proposito: e o que o WAF responde 403
  return {
    ...base,
    Origin: origin,
    Referer: origin + '/',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

/* Busca limitada (bytes iniciais) seguindo redirects, para conferir se o
   SEGMENTO de uma playlist ajuda de verdade. O master pode estar no ar e o
   canal ainda assim ser impossivel de tocar quando todo segmento falha. */
function burst(url, headers, maxData = 16384, timeout = TIMEOUT, hops = 0) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve(null);
    }
    if (!/^https?:$/.test(u.protocol)) return resolve(null);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(
      u,
      { method: 'GET', headers, timeout },
      (res) => {
        const code = res.statusCode || 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.destroy();
          if (hops >= 4) return resolve(null);
          const next = new URL(res.headers.location, url).toString();
          if (next === url) return resolve(null);
          burst(next, headers, maxData, timeout, hops + 1).then(resolve);
          return;
        }
        if (code !== 200 && code !== 206) {
          res.destroy();
          return resolve({ code });
        }
        const chunks = [];
        let got = 0;
        res.on('data', (c) => {
          chunks.push(c);
          got += c.length;
          if (got >= maxData) res.destroy();
        });
        const ok = () =>
          resolve({
            code,
            buf: Buffer.concat(chunks),
            ctype: String(res.headers['content-type'] || '').split(';')[0].trim(),
          });
        res.on('end', ok);
        res.on('close', ok);
        res.on('error', () => resolve(null));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

/* Primeira URI "de verdade" da playlist (variante ou segmento). */
function firstUri(head, base) {
  const lines = head.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (i === 0 || l.startsWith('#') || !l) continue;
    const prev = lines[i - 1] ? lines[i - 1].trim() : '';
    if (/#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF|MEDIA|MAP|KEY|BYTERANGE)/.test(prev))
      continue;
    try {
      return /^https?:/.test(l) ? l : new URL(l, base).toString();
    } catch {
      return null;
    }
  }
  return null;
}

/* Confirma se o primeiro pedaço de media da playlist baixa de verdade. */
async function drillSegment(base, head) {
  const seg = firstUri(head, base);
  if (!seg) return null;
  const r = await burst(seg, {
    'User-Agent': UA,
    Accept: '*/*',
    Range: 'bytes=0-16383',
  });
  if (!r || !r.buf || !r.buf.length) return false;
  if (/^text\/html/i.test(r.ctype)) return false;
  return true;
}

function attempt(url, { timeout = TIMEOUT, headers = {} } = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return resolve({ ok: false, why: 'url invalida' });
    }
    if (!/^https?:$/.test(u.protocol)) {
      return resolve({ ok: false, why: 'protocolo' });
    }
    const mod = u.protocol === 'http:' ? http : https;
    const isPlaylist = /\.m3u8?(\?|$)/i.test(url);

    const req = mod.request(
      u,
      {
        method: 'GET',
        headers,
        timeout,
      },
      (res) => {
        const code = res.statusCode || 0;

        if (code >= 300 && code < 400 && res.headers.location) {
          res.destroy();
          const next = new URL(res.headers.location, url).toString();
          if (next === url) return resolve({ ok: false, why: 'loop de redirect' });
          attempt(next, { timeout, headers }).then((r) =>
            resolve({ ...r, code, redirect: next })
          );
          return;
        }

        if (code !== 200 && code !== 206) {
          res.destroy();
          return resolve({ ok: false, why: `HTTP ${code}`, code });
        }

        const ctype = String(res.headers['content-type'] || '').split(';')[0].trim();
        const chunks = [];
        let got = 0;

        res.on('data', (c) => {
          chunks.push(c);
          got += c.length;
          if (got >= SAMPLE) res.destroy();
        });
        res.on('end', () => finish(Buffer.concat(chunks)));
        res.on('close', () => finish(Buffer.concat(chunks)));
        res.on('error', () => finish(Buffer.concat(chunks)));

        let done = false;
        function finish(buf) {
          if (done) return;
          done = true;
          let sample = buf.subarray(0, SAMPLE);
          // CDN que manda playlist compactada (content-encoding: gzip) mesmo
          // sem pedirmos: descomprime antes de tentar reconhecer o formato
          if (sample[0] === 0x1f && sample[1] === 0x8b) {
            try {
              sample = zlib.gunzipSync(sample);
            } catch {}
          }
          const head = sample.toString('utf8', 0, Math.min(sample.length, 8192));

          if (isPlaylist || /#EXTM3U/i.test(head)) {
            if (!/#EXTM3U/i.test(head)) {
              return resolve({ ok: false, why: 'nao e playlist m3u', code });
            }
            // playlist mestre = variantes declaradas; media = segmentos
            const variants = /#EXT-X-(?:STREAM-INF|I-FRAME-STREAM-INF)/i.test(head);
            const segments = (head.match(/^(?!#).+/gm) || []).filter((l) => l.trim());
            const media = /#EXT-X-MEDIA\b/i.test(head);
            if (!variants && !segments.length && !media) {
              return resolve({ ok: false, why: 'playlist vazia', code });
            }
            // playlist mestre sem nenhuma variante com video = canal so de audio
            // (ex.: o "Sony Channel" brasileiro so servia faixas de audio).
            // Isso derruba o stream no servidor para canais de TV, mas nao para radio.
            if (variants) {
              const attrLines = head.match(/#EXT-X-STREAM-INF:[^\n]*/gi) || [];
              const audioOnly =
                attrLines.length > 0 &&
                attrLines.every((line) => {
                  const attr = line.replace(/^#EXT-X-STREAM-INF:/i, '');
                  if (/RESOLUTION\s*=\s*\d+\s*x/i.test(attr)) return false;
                  const codecs = (attr.match(/CODECS\s*=\s*"([^"]*)"/i) || [])[1] || '';
                  return !/avc1|hvc1|hev1|dvav|vp9|vp8|av01|mp4v/i.test(codecs);
                });
              drillSegment(url, head).then((segOk) => {
                  if (segOk === false)
                    return resolve({ ok: false, why: 'segmento invalido', code });
                  return resolve({
                    ok: true,
                    code,
                    ctype,
                    bytes: got,
                    kind: 'master',
                    audioOnly,
                  });
                });
              return;
            }
            drillSegment(url, head).then((segOk) => {
              if (segOk === false)
                return resolve({ ok: false, why: 'segmento invalido', code });
              return resolve({
                ok: true,
                code,
                ctype,
                bytes: got,
                kind: 'media',
              });
            });
          }

          // resposta HTML num player de midia = pagina de erro/anti-bot
          if (/^text\/html/i.test(ctype) || /^\s*<(!doctype|html)/i.test(head)) {
            return resolve({ ok: false, why: 'retornou HTML', code });
          }
          if (!buf.length) return resolve({ ok: false, why: 'corpo vazio', code });

          return resolve({ ok: true, code, ctype, bytes: got });
        }
      }
    );

    req.on('error', (e) =>
      resolve({ ok: false, why: (e.code || e.message || 'erro').toString().slice(0, 40) })
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, why: 'timeout' });
    });
    req.end();
  });
}

/* --------------------------- catalogo --------------------------- */

const IPTV = 'https://iptv-org.github.io';

async function streamUrls() {
  const res = await fetch(IPTV + '/api/streams.json', {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(120000),
  });
  const streams = await res.json();
  return [...new Set(streams.map((s) => s.url).filter(Boolean))];
}

/* ----------------------------- run ----------------------------- */

async function run({ force = false, country = null } = {}) {
  await load();
  const urls = await streamUrls();
  if (!urls.length) {
    console.error('nenhuma URL obtida do catalogo');
    process.exit(1);
  }

  const todo = urls.filter((u) => {
    if (force) return true;
    const e = state.entries[u];
    if (!e) return true;
    if (Date.now() - (e.checked || 0) > STALE_MS) return true;
    if (!e.ok && !e.viaRetry) {
      // morto confirmado: espera o RECHECK_DEAD_MS antes de sondar de novo,
      // senao a revisao mantem o canal morto "aparecendo" sem sinal
      if (Date.now() - (e.checked || 0) < RECHECK_DEAD_MS) return false;
      return true;
    }
    return false;
  });

  console.log(
    `${urls.length} URLs no catalogo | ${todo.length} a checar | concurrency ${CONCURRENCY}${country ? ` | pais ${country}` : ''}`
  );

  let done = 0;
  let alive = 0;
  let dead = 0;
  let revived = 0;
  let skipped = 0;
  const t0 = Date.now();

  const queue = todo.slice();
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const url = queue.shift();
      const r = await probe(url);
      state.entries[url] = {
        ok: r.ok,
        why: r.why || null,
        code: r.code || null,
        ctype: r.ctype || null,
        viaRetry: !!r.viaRetry,
        audioOnly: r.audioOnly || null,
        checked: Date.now(),
      };
      if (r.ok) {
        alive++;
        if (r.viaRetry) revived++;
      } else dead++;
      done++;

      if (done % 50 === 0) {
        const pct = ((done / todo.length) * 100).toFixed(1);
        const rate = done / ((Date.now() - t0) / 1000);
        const eta = Math.round((todo.length - done) / Math.max(rate, 0.01));
        console.log(
          `${done}/${todo.length} (${pct}%) vivos ${alive} mortos ${dead} | ${rate.toFixed(1)}/s | ETA ${eta}s`
        );
        await save();
      }
    }
  });

  await Promise.all(workers);
  await save();

  if (!todo.length) skipped = urls.length;
  console.log(
    `\npronto em ${Math.round((Date.now() - t0) / 1000)}s | checados ${done} | vivos ${alive} | mortos ${dead} | ja conhecidos ${skipped}`
  );
  if (revived) console.log(`${revived} voltaram a funcionar no retry (403 -> 200)`);
  console.log(`estado salvo em ${HEALTH_FILE}`);
}

function stats() {
  const entries = Object.values(state.entries);
  const alive = entries.filter((e) => e.ok).length;
  const dead = entries.length - alive;
  const soft = entries.filter((e) => !e.ok && isSoft(e.why)).length;
  const unverified = entries.filter((e) => !e.ok && !e.viaRetry).length;
  const byWhy = {};
  for (const e of entries) if (!e.ok) byWhy[e.why || '?'] = (byWhy[e.why || '?'] || 0) + 1;
  console.log(`checados: ${entries.length} | vivos: ${alive} | mortos: ${dead}`);
  console.log(
    `  dos mortos: ${soft} sao falha mole (podem voltar) | ${unverified} ainda nao passaram pelo retry`
  );
  const top = Object.entries(byWhy)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12);
  for (const [why, n] of top) console.log(`  ${String(n).padStart(6)}  ${why}`);
}

/* ----------------------------- cli ----------------------------- */

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--stats')) {
    await load();
    stats();
  } else {
    const country = args.find((a) => !a.startsWith('--')) || null;
    await run({ force: args.includes('--all'), country });
  }
}

function getHealth() {
  return state;
}

export { probe, load, save, recheck, HEALTH_FILE, getHealth };