/* App: catalogo, busca, filtros, favoritos, navegacao por controle remoto. */

const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const empty = $('#empty');

const state = {
  items: [],
  shown: 0,
  page: 60,
  offset: 0,
  hasMore: false,
  country: 'all',
  category: 'all',
  tab: 'tv',
  kind: 'tv',
  query: '',
};

const PAGE_SIZE = 300; // itens por requisicao ao servidor

const FAVS_KEY = 'iptvlivre.favs';
const FAVS_REMOVED_KEY = 'iptvlivre.favs.removed';

/* ---------------- favoritos ---------------- */

let favs = new Set();
let favRemoved = new Set(); // apagados aqui e ainda nao confirmados pelo servidor
try {
  favs = new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]'));
} catch {}
try {
  favRemoved = new Set(JSON.parse(localStorage.getItem(FAVS_REMOVED_KEY) || '[]'));
} catch {}
const saveFavs = () => {
  localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]));
  localStorage.setItem(FAVS_REMOVED_KEY, JSON.stringify([...favRemoved]));
};

/* Sincroniza com o servidor (mesmos favoritos no APK e no celular).
   localStorage continua sendo o cache offline. */
let favPushTimer;
function pushFavs() {
  clearTimeout(favPushTimer);
  favPushTimer = setTimeout(async () => {
    try {
      const r = await fetch('/api/favs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...favs] }),
      });
      // o servidor passou a ter a lista exata: tombstones nao sao mais necessarios
      if (r.ok && favRemoved.size) {
        favRemoved.clear();
        saveFavs();
      }
    } catch {}
  }, 400);
}
/* Junta o servidor com o local sem perder nada:
   - a uniao cobre favoritos marcados offline (push pode ter falhado)
   - os tombstones evitam que o servidor "ressuscite" o que apagamos aqui */
async function loadServerFavs() {
  try {
    const r = await fetch('/api/favs');
    if (!r.ok) return;
    const d = await r.json();
    const server = new Set(Array.isArray(d.favs) ? d.favs : []);
    const merged = new Set([...favs, ...[...server].filter((id) => !favRemoved.has(id))]);
    const changed = merged.size !== server.size || [...merged].some((id) => !server.has(id));
    favs = merged;
    saveFavs();
    if (changed) pushFavs();
  } catch {}
}

/* ---------------- historico / continuar de onde parou ---------------- */

const RECENT_KEY = 'iptvlivre.recent';
const HIST_KEY = 'iptvlivre.history';
let recents = [];
let historyMap = new Map();
try {
  recents = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
} catch {}
try {
  const h = JSON.parse(localStorage.getItem(HIST_KEY) || '{}');
  historyMap = new Map(Object.entries(h));
} catch {}

function saveLocalHistory() {
  localStorage.setItem(RECENT_KEY, JSON.stringify(recents));
  localStorage.setItem(HIST_KEY, JSON.stringify(Object.fromEntries(historyMap)));
}

async function loadServerHistory() {
  try {
    const r = await fetch('/api/history');
    if (!r.ok) return;
    const d = await r.json();
    const serverList = Array.isArray(d.history) ? d.history : [];
    const serverBy = new Map(serverList.map((h) => [h.id, h]));

    // merge local+servidor mantendo a versao mais recente de cada id
    const merged = new Map(historyMap);
    for (const h of serverList) {
      const cur = merged.get(h.id);
      if (!cur || (h.at || 0) >= (cur.at || 0)) merged.set(h.id, h);
    }

    // sobe o que o servidor nao tem (ou tem mais antigo): nada se perde offline
    for (const [id, h] of historyMap) {
      const s = serverBy.get(id);
      if (!s || (s.at || 0) < (h.at || 0)) sendHistory(h);
    }

    historyMap = merged;
    recents = [...merged.values()]
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .map((h) => h.id)
      .slice(0, 100);
    saveLocalHistory();
  } catch {}
}

/* Marca o canal como visto agora (reordena o historico) e sincroniza. */
let histPushTimer = null;
function pushHistory(id, patch = {}) {
  const prev = historyMap.get(id) || { pos: 0, dur: 0, live: false };
  const rec = { id, at: Date.now(), ...prev, ...patch };
  historyMap.set(id, rec);
  recents = [id, ...recents.filter((x) => x !== id)].slice(0, 100);
  saveLocalHistory();
  clearTimeout(histPushTimer);
  histPushTimer = setTimeout(() => sendHistory(rec), 700);
}

/* Salva a posicao de playback sem reordenar (chamado pelo player).
   O player emite a cada tick: so grava quando vale a pena. */
let progPushTimer = null;
const lastProg = new Map();
function saveProgress(id, { pos, dur, live }) {
  const now = Date.now();
  const last = lastProg.get(id) || { pos: -1, live: null, at: 0 };
  if (last.live === !!live && Math.abs((pos || 0) - last.pos) < 4 && now - last.at < 15000) return;
  lastProg.set(id, { pos: Math.floor(pos || 0), live: !!live, at: now });

  const rec = historyMap.get(id) || { id, at: now };
  rec.pos = Math.max(0, Math.floor(pos || 0));
  rec.dur = live ? 0 : Math.max(0, Math.floor(dur || 0));
  rec.live = !!live;
  rec.at = now;
  historyMap.set(id, rec);
  saveLocalHistory();
  clearTimeout(progPushTimer);
  progPushTimer = setTimeout(() => sendHistory(rec), 5000);
}

function sendHistory(rec) {
  fetch('/api/history', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: rec.id, pos: rec.pos, dur: rec.dur, live: rec.live }),
  }).catch(() => {});
}

function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) +
    ':' + String(s).padStart(2, '0');
}

/* ---------------- api ---------------- */

async function api(path, opts) {
  const init = opts
    ? {
        ...opts,
        headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
        body:
          opts.body == null
            ? undefined
            : typeof opts.body === 'string'
              ? opts.body
              : JSON.stringify(opts.body),
      }
    : undefined;
  const r = await fetch(path, init);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function loadMeta() {
  const d = await api('/api/meta?kind=' + state.kind);
  const total =
    state.kind === 'radio'
      ? d.stats.radio
      : d.stats.channels;
  $('#statsLine').textContent =
    `${total.toLocaleString('pt-BR')} ${state.kind === 'radio' ? 'rádios' : 'canais'} · ${d.stats.countries} países`;

  const mk = (label, count, onClick, key) =>
    `<div class="side-item${key && key === state.country ? ' active' : ''}" data-val="${key ?? ''}">
       <span>${label}</span><span>${count}</span>
     </div>`;

  const br = d.countries.find((c) => c.code === 'BR');
  $('#countryList').innerHTML =
    mk(state.kind === 'radio' ? 'Todas' : 'Todos', total, null, 'all') +
    (br ? mk('🇧🇷 Brasil', br.count, null, 'BR') : '') +
    d.countries
      .filter((c) => c.code !== 'BR')
      .slice(0, 120)
      .map((c) => mk(c.code, c.count, null, c.code))
      .join('');

  $('#categoryList').innerHTML =
    mk('Todas', total, null, 'all') +
    d.categories.slice(0, 30).map((c) => mk(c.name, c.count, null, c.id)).join('');

  $('#countryList').onclick = $('#categoryList').onclick = (e) => {
    const el = e.target.closest('.side-item');
    if (!el) return;
    const v = el.dataset.val;
    if (e.currentTarget.id === 'countryList') state.country = v;
    else state.category = v;
    $('#sidebar').classList.remove('open');
    reload();
  };
}

async function loadItems(reset = true) {
  if (reset) {
    state.items = [];
    state.shown = 0;
    state.page = 60;
    state.offset = 0;
    state.hasMore = false;
  }
  const p = new URLSearchParams();
  const searching = !!state.query;
  p.set('kind', searching ? 'all' : state.kind);
  if (!searching && state.country !== 'all') p.set('country', state.country);
  if (!searching && state.category !== 'all') p.set('category', state.category);
  if (state.query) p.set('q', state.query);
  p.set('limit', String(PAGE_SIZE));
  p.set('offset', String(state.offset));

  const d = await api('/api/catalog?' + p);
  state.items = reset ? d.items : state.items.concat(d.items);
  state.offset = state.items.length;
  state.hasMore = !!d.hasMore;
  render(reset);
}

/* ---------------- render ---------------- */

function visible() {
  if (state.query) return state.items;
  if (state.tab === 'fav') return state.items.filter((i) => favs.has(i.id));
  if (state.tab === 'recent') {
    const byId = new Map(state.items.map((i) => [i.id, i]));
    return recents.map((id) => byId.get(id)).filter(Boolean);
  }
  return state.items;
}

function render(reset) {
  const list = visible();

  if (reset) {
    grid.innerHTML = '';
    state.shown = 0;
  }

  const end = state.shown + state.page;
  for (let i = state.shown; i < Math.min(end, list.length); i++) {
    grid.appendChild(cardFor(list[i], i + 1));
  }
  state.shown = Math.min(end, list.length);

  empty.hidden = list.length > 0;
  $('#btnMore').parentElement.hidden = !(state.shown < list.length || state.hasMore);
}

function cardFor(ch, num) {
  const el = document.createElement('div');
  el.className = 'card' + (favs.has(ch.id) ? ' fav-on' : '') + (ch.kind === 'radio' ? ' is-radio' : '');
  el.tabIndex = 0;
  el.dataset.id = ch.id;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', ch.name + (favs.has(ch.id) ? ' (favorito)' : ''));

  const logoUrl =
    ch.logo && /^https?:\/\//.test(ch.logo)
      ? '/logo?u=' + encodeURIComponent(ch.logo)
      : (ch.logo || '');

  const logo = logoUrl
    ? `<img class="logo" loading="lazy" referrerpolicy="no-referrer" src="${escapeHTML(logoUrl)}" alt="">`
    : `<div class="logo ph">${ch.kind === 'radio' ? '🎙' : '📺'}</div>`;

  const qual =
    ch.kind === 'radio'
      ? ch.bitrate
        ? ch.bitrate + ' kbps'
        : ch.codec || ''
      : ch.streams[0]?.quality || '';

  const sig = ch.signal === 'on' ? 'on' : 'unknown';
  const hist = historyMap.get(ch.id);
  const resume =
    state.tab === 'recent' &&
    hist &&
    !hist.live &&
    hist.dur > 0 &&
    hist.pos > 5 &&
    hist.pos < hist.dur - 5
      ? 'continuar ' + fmtTime(hist.pos)
      : '';

  el.innerHTML =
    `<span class="sig ${sig}" title="${
      sig === 'on' ? 'sinal verificado' : 'sinal não verificado'
    }"></span>` +
    `<span class="chnum" title="Número para zapping">${num || ''}</span>` +
    logo +
    `<div class="name">${escapeHTML(ch.name)}</div>` +
    `<div class="sub">${ch.country || '—'}${qual ? ' · ' + escapeHTML(String(qual)) : ''}${
      resume ? ' · ' + resume : ''
    }</div>` +
    `<button class="fav" title="Favoritar">${favs.has(ch.id) ? '★' : '☆'}</button>`;

  el.onclick = (e) => {
    if (e.target.classList.contains('fav')) return;
    play(ch, el);
  };
  el.querySelector('.fav').onclick = (e) => {
    e.stopPropagation();
    toggleFav(ch.id);
  };
  el.querySelector('.fav').setAttribute(
    'aria-label',
    favs.has(ch.id) ? 'Remover dos favoritos' : 'Adicionar aos favoritos'
  );
  const img = el.querySelector('img.logo');
  if (img) {
    img.addEventListener(
      'error',
      () => {
        img.outerHTML = `<div class="logo ph">${ch.kind === 'radio' ? '🎙' : '📺'}</div>`;
      },
      { once: true }
    );
  }
  el.onkeydown = (e) => {
    if (e.target.closest('.fav')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      play(ch, el);
    }
  };
  return el;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

/* ---------------- acoes ---------------- */

let currentChannel = null;
let prevChannel = null;
let zapBuf = '';
let zapTimer = null;
const zapOverlay = document.getElementById('zapOverlay');

function updatePrevBtn() {
  const b = document.getElementById('btnPrev');
  if (b) b.hidden = !prevChannel;
}

function play(ch, el = null) {
  if (currentChannel && currentChannel.id !== ch.id) prevChannel = currentChannel;
  currentChannel = ch;
  updatePrevBtn();
  document.querySelectorAll('.card.playing').forEach((n) => n.classList.remove('playing'));
  if (el) el.classList.add('playing');
  pushHistory(ch.id);
  const h = historyMap.get(ch.id);
  const startAt =
    h && !h.live && h.dur > 0 && h.pos > 30 && h.pos < h.dur - 15 ? h.pos : 0;
  if (startAt) toast('retomando de ' + fmtTime(startAt));
  Player.open(
    ch,
    () => {
      if (el) {
        el.classList.remove('playing');
        el.focus();
      }
    },
    { startAt, onProgress: (p) => saveProgress(ch.id, p), onEnded: () => playNextEpisode(ch) }
  );
  updateFavBtn();
}

/* ---------------- próximo episódio automático ---------------- */

/* Extrai a serie e a temporada/episodio de um nome "SERIE S01E02 ..." ou
   "SERIE 1x02". Sem esse padrao, devolve null (nao e serie/nao da pra encadear). */
function parseSeriesName(name) {
  const t = String(name || '').trim();
  let m = t.match(/^(.*?)[\s._-]*[Ss](\d{1,2})[\s._-]*[Ee](\d{1,3})(?:[\s._-].*)?$/);
  if (!m) m = t.match(/^(.*?)[\s._-]*(\d{1,2})x(\d{1,3})(?:[\s._-].*)?$/);
  if (!m) return null;
  const base = m[1].replace(/[-._\s]+$/, '').replace(/\s+/g, ' ').trim();
  if (!base) return null;
  const season = Number(m[2]);
  const episode = Number(m[3]);
  return { base, key: base.toLowerCase(), season, episode, order: season * 10000 + episode };
}

/* Episodios da mesma serie, em ordem. Usa o que ja esta carregado; se o
   proximo nao estiver na lista (pagina/filtro), busca no catalogo. */
async function seriesEpisodes(ch) {
  const cur = parseSeriesName(ch.name);
  if (!cur) return null;
  const scan = (arr) =>
    arr
      .map((i) => ({ i, k: parseSeriesName(i.name) }))
      .filter((x) => x.k && x.k.key === cur.key)
      .sort((a, b) => a.k.order - b.k.order)
      .map((x) => x.i);
  const local = scan(state.items);
  const idx = local.findIndex((x) => x.id === ch.id);
  if (idx >= 0 && idx + 1 < local.length) return local;
  try {
    const d = await api(
      '/api/catalog?kind=all&q=' + encodeURIComponent(cur.base) + '&limit=2000'
    );
    const all = scan(d.items || []);
    if (all.length > local.length) return all;
  } catch {}
  return local.length ? local : null;
}

let nextOpening = false;
async function playNextEpisode(ch) {
  if (nextOpening) return;
  nextOpening = true;
  try {
    const list = await seriesEpisodes(ch);
    if (!list) return;
    const i = list.findIndex((x) => x.id === ch.id);
    if (i < 0 || i + 1 >= list.length) {
      toast('fim dos episódios disponíveis');
      return;
    }
    const next = list[i + 1];
    toast('a seguir: ' + next.name);
    play(next);
  } finally {
    nextOpening = false;
  }
}

/* ---------------- zapping: numero do canal + canal anterior ---------------- */

function showZap() {
  if (!zapOverlay) return;
  zapOverlay.innerHTML = '<span>canal</span><strong>' + escapeHTML(zapBuf) + '</strong>';
  zapOverlay.hidden = false;
}
function hideZap() {
  if (zapOverlay) zapOverlay.hidden = true;
}

function zapDigit(d) {
  zapBuf += d;
  if (zapBuf.length > 4) zapBuf = zapBuf.slice(-4);
  showZap();
  clearTimeout(zapTimer);
  zapTimer = setTimeout(() => {
    const n = parseInt(zapBuf, 10);
    zapBuf = '';
    hideZap();
    if (n > 0) zapToNumber(n);
  }, 1200);
}

function zapToNumber(n) {
  const list = visible();
  const ch = list[n - 1];
  if (!ch) {
    toast('canal ' + n + ' não existe');
    return;
  }
  const el = grid.querySelector(`[data-id="${CSS.escape(ch.id)}"]`);
  if (el) el.scrollIntoView({ block: 'nearest' });
  play(ch, el);
}

function zapToPrev() {
  if (!prevChannel) return;
  toast('canal anterior');
  play(prevChannel);
}

document.getElementById('btnPrev')?.addEventListener('click', zapToPrev);

function toggleFav(id) {
  if (favs.has(id)) {
    favs.delete(id);
    favRemoved.add(id);
  } else {
    favs.add(id);
    favRemoved.delete(id);
  }
  saveFavs();
  pushFavs();
  toast(favs.has(id) ? '★ adicionado aos favoritos' : '☆ Removido dos favoritos');
  if (state.tab === 'fav') render(true);
  else {
    const el = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) {
      const on = favs.has(id);
      el.classList.toggle('fav-on', on);
      el.setAttribute(
        'aria-label',
        (el.querySelector('.name')?.textContent || '') + (on ? ' (favorito)' : '')
      );
      const fb = el.querySelector('.fav');
      fb.textContent = on ? '★' : '☆';
      fb.setAttribute('aria-label', on ? 'Remover dos favoritos' : 'Adicionar aos favoritos');
    }
  }
  updateFavBtn();
}

function updateFavBtn() {
  const ch = Player.channel;
  $('#btnFav').textContent = ch && favs.has(ch.id) ? '★' : '☆';
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), 2200);
}

async function reload() {
  await loadItems(true);
}

/* ---------------- eventos ---------------- */

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = e.target.value.trim();
    reload();
  }, 350);
});
$('#btnSearch').onclick = () => {
  state.query = $('#search').value.trim();
  reload();
};
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    state.query = e.target.value.trim();
    reload();
  }
});

document.querySelectorAll('.chip').forEach((c) => {
  c.onclick = async () => {
    const tab = c.dataset.tab;
    if (!tab) return;

    document.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');

    if (tab === 'br') {
      state.kind = 'tv';
      state.country = 'BR';
    } else if (tab === 'radio') {
      state.kind = 'radio';
      state.country = 'all';
    } else if (tab === 'recent') {
      state.kind = 'all';
      state.country = 'all';
    } else {
      // tv, fav ou reset
      state.kind = 'tv';
      if (state.country === 'BR') state.country = 'all';
    }
    state.tab = tab;
    state.category = 'all';

    $('#sidebar').querySelectorAll('.side-item').forEach((n) =>
      n.classList.toggle('active', n.dataset.val === state.country)
    );
    $('#search').value = '';
    state.query = '';

    // a lista lateral e a estatistica mudam com TV/radio
    if (tab === 'fav') {
      state.kind = 'all';
      await loadMeta();
      await loadItems();
    } else {
      await loadMeta();
      await loadItems();
    }
  };
});

let loadingMore = false;
$('#btnMore').onclick = async () => {
  if (state.shown < visible().length) {
    state.page += 60;
    render(false);
    return;
  }
  if (!state.hasMore || loadingMore) return;
  // ja mostrou tudo o que baixou: busca a proxima pagina no servidor
  loadingMore = true;
  try {
    await loadItems(false);
  } finally {
    loadingMore = false;
  }
};

/* Rolagem continua: carrega a proxima pagina quando o rodape chega perto.
   O botao continua existindo (controle remoto / leitores de tela). */
if ('IntersectionObserver' in window) {
  const sentinel = $('#loadMoreWrap');
  new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) $('#btnMore').click();
    },
    { rootMargin: '700px' }
  ).observe(sentinel);
}

$('#btnMenu').onclick = () => $('#sidebar').classList.toggle('open');
$('#btnBack').onclick = () => Player.close();
$('#btnFav').onclick = () => Player.channel && toggleFav(Player.channel.id);

/* Navegacao por controle nos botoes do topo (TV, Radio, Favoritos...).
   ◀/▶ percorrem a fila, ▼ desce para a grade, ▲ volta. O foco nunca sai
   da barra rolando a pagina inteira. */
function allChips() {
  return [...document.querySelectorAll('.chip')].filter((c) => c.offsetParent !== null);
}
function focusChips(dir) {
  const chips = allChips();
  if (!chips.length) return;
  let i;
  if (dir === 0) {
    const act = chips.findIndex((c) => c.classList.contains('active'));
    i = act >= 0 ? act : 0;
  } else {
    const cur = chips.indexOf(document.activeElement);
    i = cur >= 0 ? cur + dir : dir > 0 ? -1 : 0;
    i = (i + chips.length) % chips.length;
  }
  chips[i].focus();
  try {
    chips[i].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  } catch {}
}

/* Desliza a faixa de botoes do topo na horizontal (◀/▶). A pagina em si
   nunca rola; so a barra se move dentro da sua area. */
function slideQuick(dir) {
  const q = document.querySelector('.quick');
  if (!q) return;
  const max = q.scrollWidth - q.clientWidth;
  if (max <= 0) return;
  const step = Math.min(150, max);
  let to = q.scrollLeft + dir * step;
  to = Math.min(Math.max(to, 0), max);
  q.scrollTo({ left: to, behavior: 'smooth' });
}

/* Normaliza as teclas de direcao do controle remoto: alguns WebView de TV
   entregam DPAD como keyCode 19-22 com e.key = 'Unidentified' (ou 'Up'/
   'Down'/'Left'/'Right'), outros usam ArrowUp/Down/Left/Right padrao. */
function arrowKey(e) {
  const k = e.key;
  const c = e.keyCode;
  if (k === 'ArrowLeft' || k === 'Left' || c === 21 || c === 37) return 'left';
  if (k === 'ArrowRight' || k === 'Right' || c === 22 || c === 39) return 'right';
  if (k === 'ArrowUp' || k === 'Up' || c === 19 || c === 38) return 'up';
  if (k === 'ArrowDown' || k === 'Down' || c === 20 || c === 40) return 'down';
  return null;
}

document.addEventListener('keydown', (e) => {
  // zapping: digitar o numero do canal (funciona tambem com o player aberto)
  if (
    /^[0-9]$/.test(e.key) &&
    dlg.hidden &&
    panel.hidden &&
    egGrid.hidden &&
    shareDlg.hidden &&
    m3uDlg.hidden &&
    $('#parDlg').hidden
  ) {
    const t = e.target;
    if (!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable))) {
      e.preventDefault();
      zapDigit(e.key);
      return;
    }
  }
  if (e.key === 'Backspace' || e.key === 'BrowserBack' || e.keyCode === 4) {
    if (dlg.hidden && Player.isOpen) Player.close();
    return; // nunca sobrepoe a digitacao
  }
  if (e.key === 'Escape' || e.keyCode === 27) {
    if (!dlg.hidden) return closeDlg(null);
    if (!egGrid.hidden) return closeGrid();
    if (!shareDlg.hidden) {
      shareDlg.hidden = true;
      return;
    }
    if (!m3uDlg.hidden) {
      m3uDlg.hidden = true;
      return;
    }
    if (Player.isOpen) Player.close();
    else $('#sidebar').classList.remove('open');
    return;
  }
  if (Player.isOpen) {
    if (e.key === 'f' || e.key === 'F') updateFavBtn();
    // setas L/R percorrem os botoes do topo do player no remoto
    const k = arrowKey(e);
    const btns = ['btnBack', 'btnPrev', 'btnQual', 'btnCC', 'btnCast', 'btnFs', 'btnShare', 'btnSleep', 'btnFav']
      .map((id) => document.getElementById(id))
      .filter((b) => b && !b.hidden && b.offsetParent !== null);
    if (btns.length && (k === 'left' || k === 'right')) {
      e.preventDefault();
      let i = btns.indexOf(document.activeElement);
      if (i >= 0) i = (i + (k === 'right' ? 1 : -1) + btns.length) % btns.length;
      else i = k === 'right' ? 0 : btns.length - 1;
      btns[i].focus();
    }
    return;
  }
  const k = arrowKey(e);
  const ae = document.activeElement;
  const onInput = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
  if (!k) return;
  if (dlg.hidden && onInput) return; // setas dentro da caixa de busca
  e.preventDefault(); // nada de a pagina rolar/pular com o controle

  // dialogo aberto: setas circulam pelos botoes do dialogo (OK/Cancel...)
  if (!dlg.hidden) {
    if (onInput) return;
    const dd = [...dlg.querySelectorAll('button')].filter((b) => b.offsetParent !== null);
    if (!dd.length) return;
    const dir = k === 'left' || k === 'up' ? -1 : 1;
    let n;
    if (dd.indexOf(ae) < 0) n = dir > 0 ? 0 : dd.length - 1;
    else n = (dd.indexOf(ae) + dir + dd.length) % dd.length;
    dd[n].focus();
    return;
  }

  const onCard = ae?.classList?.contains('card');
  const onChip = ae?.classList?.contains('chip');

  if (onChip) {
    // ◀/▶ deslizam a barra de botoes (o foco fica parado no botao ativo)
    if (k === 'left') slideQuick(-1);
    else if (k === 'right') slideQuick(1);
    else if (k === 'down') {
      const c = grid.querySelector('.card');
      if (c) c.focus();
    }
    return;
  }

  if (onCard) {
    const cards = [...grid.children];
    const i = cards.indexOf(ae);
    let n = -1;
    if (k === 'right') n = i + 1;
    if (k === 'left') n = i - 1;
    if (k === 'down') n = i + Math.floor(grid.clientWidth / 150) || i + 4;
    if (k === 'up') {
      n = i - 4;
      // voltou para a primeira linha: sobe de novo os botoes do topo
      if (n < 0) {
        focusChips(0);
        return;
      }
    }
    if (n >= 0 && n < cards.length) cards[n].focus();
    return;
  }

  // foco fora da barra/grelha (corpo da pagina): setas deslizam o topo
  if (k === 'left') slideQuick(-1);
  else if (k === 'right') slideQuick(1);
  else if (k === 'down') {
    const c = grid.querySelector('.card');
    if (c) c.focus();
  } else focusChips(0);
});

/* ---------------- EPG ---------------- */

$('#btnEpg').onclick = async () => {
  const btn = $('#btnEpg');
  let sources;
  try {
    const r = await fetch('/api/epg/sources');
    sources = (await r.json()).sources || [];
  } catch {
    return toast('falha ao buscar guias');
  }
  if (!sources.length) return toast('nenhum guia configurado');

  // puxa o ultimo guia usado para o topo, pra escolha ficar mais rapida
  const epgLast = localStorage.getItem('epg:last');
  if (epgLast)
    sources.sort((a, b) =>
      a.url === epgLast ? -1 : b.url === epgLast ? 1 : 0
    );

  const src = await openDlg({
    title: 'Guia EPG',
    help:
      'Escolha o país do guia de programação' +
      (epgLast ? ` (último: ${sources[0].name})` : ''),
    choices: sources.map((s) => ({ label: s.name, value: s.url })),
  });
  if (!src) return;

  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Carregando guia…';
  try {
    const d = await (
      await fetch('/api/epg/load?src=' + encodeURIComponent(src))
    ).json();
    if (d.error) return toast('Falha ao carregar o guia: ' + d.error);
    localStorage.setItem('epg:last', src);
    const resumo = `${d.channels.toLocaleString('pt-BR')} canais, ${d.programmes.toLocaleString('pt-BR')} programas`;
    toast(
      d.fellBack
        ? `Fonte pedida fora do ar — usei uma alternativa: ${resumo}`
        : `Guia carregado: ${resumo}`
    );
  } catch (err) {
    toast('Falha ao carregar o guia: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
};

$('#btnLogout').onclick = async () => {
  await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  location.reload();
};

/* ---------------- Agora na TV + busca na programacao ---------------- */

async function channelById(id) {
  let ch = state.items.find((i) => i.id === id);
  if (ch) return ch;
  try {
    const d = await api('/api/catalog?id=' + encodeURIComponent(id) + '&kind=all&limit=1');
    return d.items[0] || null;
  } catch {
    return null;
  }
}

const fmtClock = (iso) =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = (iso) =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

$('#btnNow').onclick = async () => {
  const btn = $('#btnNow');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Carregando…';
  try {
    const p = new URLSearchParams();
    p.set('kind', state.kind === 'radio' ? 'tv' : state.kind);
    if (state.country && state.country !== 'all') p.set('country', state.country);
    const d = await api('/api/epg/now?' + p);
    const items = d.items || [];
    if (!items.length) return toast('Nada agora — carregue o Guia EPG primeiro');
    const chosen = await openDlg({
      title: 'Agora na TV',
      help: `${items.length} canal(is) com programação neste momento`,
      choices: items.map((it) => ({
        label: `${fmtClock(it.start)}  ${it.name}: ${it.title}`,
        value: it.id,
      })),
    });
    if (!chosen) return;
    const ch = await channelById(chosen);
    if (ch) play(ch);
    else toast('canal indisponível na lista atual');
  } catch (err) {
    toast('falha: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
};

$('#btnEpgSearch').onclick = async () => {
  const btn = $('#btnEpgSearch');
  let term = ($('#search').value || state.query || '').trim();
  if (!term)
    term = await openDlg({
      title: 'Buscar na programação',
      help: 'Digite o nome de um programa',
      okLabel: 'Buscar',
      placeholder: 'programa',
    });
  if (!term) return;
  btn.disabled = true;
  try {
    const d = await api('/api/epg/search?q=' + encodeURIComponent(term) + '&limit=80');
    const items = d.items || [];
    if (!items.length) return toast('Nenhum programa para "' + term + '"');
    const chosen = await openDlg({
      title: `Programação: ${term}`,
      help: `${items.length} resultado(s)`,
      choices: items.map((it) => ({
        label: `${fmtDay(it.start)}  ${it.name}: ${it.title}${it.live ? '  ← agora' : ''}`,
        value: it.id,
      })),
    });
    if (!chosen) return;
    const ch = await channelById(chosen);
    if (ch) play(ch);
    else toast('canal indisponível');
  } catch (err) {
    toast('falha na busca de programação: ' + err.message);
  } finally {
    btn.disabled = false;
  }
};

/* ---------------- grade de programacao (timeline) ---------------- */

const egGrid = $('#epgGrid');
const egBody = $('#egBody');
let egFrom = 0;
const EG_HOURS = 7;

function egClock(ms) {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function closeGrid() {
  egGrid.hidden = true;
}

async function loadGrid() {
  const from = egFrom;
  const to = from + EG_HOURS * 3600e3;
  const p = new URLSearchParams({ from: String(from), to: String(to), limit: '40' });
  p.set('kind', state.kind === 'all' ? 'all' : state.kind);
  if (state.country && state.country !== 'all') p.set('country', state.country);
  if (state.category && state.category !== 'all') p.set('category', state.category);
  if (state.query) p.set('q', state.query);
  egBody.innerHTML = '<p class="eg-msg">carregando…</p>';
  try {
    const d = await api('/api/epg/timeline?' + p.toString());
    if (!d.channels || !d.channels.length) {
      egBody.innerHTML =
        '<p class="eg-msg">Sem programação para este filtro. Carregue o Guia EPG primeiro.</p>';
      return;
    }
    renderGrid(d);
  } catch (err) {
    egBody.innerHTML = '<p class="eg-msg">falha: ' + escapeHTML(err.message) + '</p>';
  }
}

function renderGrid(d) {
  const { start, end } = d.window;
  const span = end - start;
  const now = Date.now();

  let ticks = '';
  const first = Math.ceil(start / 1800e3) * 1800e3;
  for (let t = first; t < end; t += 1800e3) {
    const left = ((t - start) / span) * 100;
    ticks += `<span class="eg-tick" style="left:${left.toFixed(3)}%">${egClock(t)}</span>`;
  }

  let rows = '';
  for (const ch of d.channels) {
    let blocks = '';
    for (const pr of ch.programmes) {
      const s = Date.parse(pr.start);
      const e = Date.parse(pr.stop);
      const left = Math.max(0, ((s - start) / span) * 100);
      const right = Math.min(100, ((e - start) / span) * 100);
      const w = Math.max(0.4, right - left);
      const isNow = s <= now && e > now;
      blocks +=
        `<button class="eg-prog${isNow ? ' now' : ''}" style="left:${left.toFixed(3)}%;width:${w.toFixed(3)}%"` +
        ` data-id="${escapeHTML(ch.id)}" title="${escapeHTML(pr.title)}">` +
        `<b>${escapeHTML(egClock(s))}</b> ${escapeHTML(pr.title)}</button>`;
    }
    rows +=
      `<div class="eg-row"><div class="eg-chan" title="${escapeHTML(ch.name)}">${escapeHTML(
        ch.name
      )}</div><div class="eg-track">${blocks}</div></div>`;
  }

  const nowLeft = now >= start && now <= end ? ((now - start) / span) * 100 : -1;
  egBody.innerHTML =
    `<div class="eg-ruler"><div class="eg-chan"></div><div class="eg-scale">${ticks}</div></div>` +
    `<div class="eg-rows">${rows}</div>` +
    (nowLeft >= 0 ? `<div class="eg-now" style="left:calc(var(--egchan) + ${nowLeft.toFixed(3)}%)"></div>` : '');

  egBody.querySelectorAll('.eg-prog').forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.id;
      closeGrid();
      channelById(id).then((ch) => {
        if (ch) play(ch);
        else toast('canal indisponível na lista atual');
      });
    };
  });
}

$('#btnGrid').onclick = () => {
  egFrom = Date.now() - 1800e3;
  egGrid.hidden = false;
  loadGrid();
};
$('#egClose').onclick = closeGrid;
$('#egPrev').onclick = () => {
  egFrom -= 3 * 3600e3;
  loadGrid();
};
$('#egNext').onclick = () => {
  egFrom += 3 * 3600e3;
  loadGrid();
};
$('#egNow').onclick = () => {
  egFrom = Date.now() - 1800e3;
  loadGrid();
};
egGrid.addEventListener('click', (e) => {
  if (e.target === egGrid) closeGrid();
});

/* ---------------- compartilhar canal (link + QR) ---------------- */

const shareDlg = $('#shareDlg');

function shareCurrentChannel() {
  const ch = Player.channel;
  if (!ch) return;
  const url = location.origin + '/?c=' + encodeURIComponent(ch.id);
  $('#shareName').textContent = ch.name;
  $('#shareUrl').value = url;
  const qr = $('#shareQr');
  qr.hidden = true;
  qr.onload = () => {
    qr.hidden = false;
  };
  qr.onerror = () => {
    qr.hidden = true;
  };
  qr.src =
    'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' +
    encodeURIComponent(url);
  shareDlg.hidden = false;
}

$('#btnShare').onclick = shareCurrentChannel;
$('#shareClose').onclick = () => {
  shareDlg.hidden = true;
};
$('#shareCopy').onclick = () => copyText($('#shareUrl').value);
shareDlg.addEventListener('click', (e) => {
  if (e.target === shareDlg) shareDlg.hidden = true;
});

function downloadCsv(name, rows) {
  const esc = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const csv = rows.map((r) => r.map(esc).join(';')).join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}

function downloadDeadCsv(dead, name) {
  downloadCsv(name, [
    ['Canal', 'URL', 'Motivo', 'HTTP'].concat(
      dead.map((d) => [d.name || '', d.url || '', d.why || '', d.code ?? ''])
    ),
  ]);
}

$('#btnRecheck').onclick = async () => {
  const btn = $('#btnRecheck');
  if (btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  const label = btn.textContent;
  try {
    const start = await api('/api/health/recheck', { method: 'POST', body: {} });
    if (!start?.total && !start?.running) {
      toast('Nada para re-verificar');
      return;
    }
    for (;;) {
      await new Promise((s) => setTimeout(s, 2000));
      const rep = await api('/api/health/report');
      btn.textContent = `⏳ ${rep.done}/${rep.total}`;
      if (!rep.running) {
        const dead = rep.dead || [];
        await loadItems(true);
        if (!dead.length) toast('Tudo certo: nenhum canal morto encontrado');
        else {
          const r = await openDlg({
            title: `Re-verificação: ${dead.length} morto(s) escondido(s)`,
            help:
              dead.slice(0, 25).map((d, i) => `${i + 1}. ${d.name || d.url} (${d.why})`).join('  |  ') +
              (dead.length > 25 ? `  … e mais ${dead.length - 25}.` : ''),
            choices: [
              { label: 'Fechar', value: 'ok' },
              { label: '📄 Exportar CSV', value: 'csv' },
            ],
          });
          if (r === 'csv')
            downloadDeadCsv(dead, `canais-mortos-${new Date().toISOString().slice(0, 10)}.csv`);
        }
        return;
      }
    }
  } catch {
    toast('Falha na re-verificação');
  } finally {
    btn.textContent = label;
    btn.dataset.busy = '0';
  }
};

/* ---------------- painel da conta ---------------- */

const panel = $('#panel');
const panelBody = $('#panelBody');
$('#panelClose').onclick = () => (panel.hidden = true);
panel.addEventListener('click', (e) => {
  if (e.target === panel) panel.hidden = true;
});

function fmtUptime(sec) {
  sec = Number(sec) || 0;
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}min`;
  return `${m}min`;
}

function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'agora mesmo';
  const m = Math.floor(s / 60);
  if (m < 60) return `há ${m}min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `há ${h}h`;
  return `há ${Math.floor(h / 24)}d`;
}

async function refreshFlow() {
  try {
    const r = await fetch('/api/refresh', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    if (r.status === 409) return toast('já está atualizando…');
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    toast('atualizando catálogo e guia…');
    for (let i = 0; i < 150; i++) {
      await new Promise((s) => setTimeout(s, 3000));
      const s2 = await (await fetch('/api/refresh')).json().catch(() => ({}));
      if (!s2.running) {
        toast(s2.error ? 'falha: ' + s2.error : 'catálogo e guia atualizados');
        await loadItems(true);
        if (!panel.hidden) openPanel();
        return;
      }
    }
    toast('ainda atualizando em segundo plano');
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

async function openPanel() {
  panel.hidden = false;
  panelBody.innerHTML = '<p class="muted" style="padding:20px">carregando…</p>';
  let acct = {};
  let par = { configured: false, unlocked: true, blocked: [], categories: [] };
  let srcs = { sources: [] };
  let hov = null;
  let dvr = { enabled: false, recordings: [] };
  try {
    [acct, par, srcs, hov, dvr] = await Promise.all([
      api('/api/account'),
      api('/api/parental'),
      api('/api/sources'),
      api('/api/health/overview').catch(() => null),
      api('/api/dvr').catch(() => dvr),
    ]);
  } catch {
    panelBody.innerHTML = '<p class="muted" style="padding:20px">falha ao carregar</p>';
    return;
  }
  const h = acct.health || {};
  const hs = (hov && hov.streams) || {};
  const hh = (hov && hov.hosts) || {};
  const deadHosts = (hov && hov.deadHosts) || [];
  const healthCards = [
    ['Canais vivos', hs.alive ?? '—'],
    ['Canais mortos', hs.dead ?? '—'],
    ['Instáveis', hs.soft ?? '—'],
    ['Hosts vivos', hh.total ? `${hh.alive ?? 0} / ${hh.total}` : '—'],
  ];
  const deadHostRows = deadHosts
    .slice(0, 6)
    .map(
      (d) =>
        `<div class="src-row"><span class="src-dead">⚠ ${escapeHTML(d.host)}</span><span class="muted">${d.channels} canal(is)</span></div>`
    )
    .join('');
  const recLabel = { recording: 'gravando…', pending: 'agendada', done: 'pronta', error: 'falhou', canceled: 'cancelada' };
  const recRows = (dvr.recordings || [])
    .map((r) => {
      const done = r.status === 'done';
      const note = r.transcoding
        ? ' · convertendo para H.264…'
        : r.needsTranscode
          ? ' · ⚠ HEVC, pode não tocar no navegador'
          : '';
      return `<div class="src-row">
        <span class="${done ? '' : 'src-dead'}">${done ? '⏺' : '•'} ${escapeHTML(r.name || 'gravação')}</span>
        <span class="muted">${escapeHTML(recLabel[r.status] || r.status)}${
        r.size > 0 ? ' · ' + Math.max(1, Math.round(r.size / 1048576)) + ' MB' : ''
      }${note}</span>
        ${done && r.url ? `<button class="ghost tiny" data-rec-play="${escapeHTML(r.url)}">Assistir</button>` : ''}
        ${done && r.url ? `<a class="ghost tiny" href="${escapeHTML(r.url)}" download>Baixar</a>` : ''}
        ${
          done && r.needsTranscode && !r.transcoding
            ? `<button class="ghost tiny" data-rec-transcode="${r.id}">Converter para H.264</button>`
            : ''
        }
        ${
          r.status === 'recording'
            ? `<button class="ghost tiny danger" data-rec-cancel="${r.id}">Parar</button>`
            : `<button class="ghost tiny danger" data-rec-rm="${r.id}">Remover</button>`
        }
      </div>`;
    })
    .join('');
  const rows = [
    ['Usuário', acct.user || '—'],
    ['Sessões ativas', acct.sessions ?? '—'],
    ['Favoritos', acct.favs ?? '—'],
    ['No histórico', acct.history ?? '—'],
    ['Canais vivos', h.enabled ? `${h.alive ?? 0} / ${h.checked ?? 0}` : 'desligado'],
    ['Catálogo', fmtAgo(acct.refresh ? acct.refresh.catalogAt : 0)],
    [
      'Guia EPG',
      fmtAgo(acct.refresh ? acct.refresh.lastEpg : 0) +
        (acct.refresh && acct.refresh.epgError ? ' ⚠ fonte fora do ar' : ''),
    ],
    ['Uptime', fmtUptime(acct.uptime)],
  ];
  panelBody.innerHTML = `
    <div class="panel-grid">
      ${rows
        .map(
          ([k, v]) =>
            `<div class="panel-card"><span>${k}</span><strong>${escapeHTML(String(v))}</strong></div>`
        )
        .join('')}
    </div>
    <div class="panel-actions">
      <button id="paPass" class="ghost">Mudar senha</button>
      <button id="paRefresh" class="ghost">Atualizar catálogo e guia</button>
      ${
        acct.admin
          ? '<button id="paAdd" class="ghost">Adicionar usuário</button>' +
            '<button id="paDel" class="ghost">Remover usuário</button>'
          : ''
      }
      <button id="paClearHist" class="ghost">Limpar histórico</button>
      <button id="paExport" class="ghost">Exportar M3U</button>
      ${
        acct.admin
          ? '<button id="paBackup" class="ghost">Backup</button>' +
            '<button id="paRestore" class="ghost">Restaurar</button>'
          : ''
      }
      <button id="paLogoutAll" class="ghost danger">Sair de todos os aparelhos</button>
    </div>
    ${
      acct.admin
        ? `<h4>Usuários</h4>
    <div class="panel-users">
      ${(acct.users || [])
        .map(
          (u) =>
            `<span class="pill${u.user === acct.user ? ' me' : ''}">${escapeHTML(u.user)}</span>`
        )
        .join('')}
    </div>`
        : ''
    }
    ${
      hov
        ? `<h4>Saúde dos canais</h4>
    <div class="panel-grid">
      ${healthCards
        .map(
          ([k, v]) =>
            `<div class="panel-card"><span>${k}</span><strong>${escapeHTML(String(v))}</strong></div>`
        )
        .join('')}
    </div>
    ${deadHostRows ? `<div class="panel-sources">${deadHostRows}</div>` : ''}
    <div class="panel-actions">
      <button id="paRecheck" class="ghost">Re-verificar canais agora</button>
      <button id="paSweep" class="ghost">Rever hosts agora</button>
    </div>`
        : ''
    }
    <h4>Gravações${dvr.enabled ? '' : ' (desligadas)'}${
      dvr.enabled && dvr.maxGB
        ? ` <span class="muted">· ${Math.round((dvr.used || 0) / 1048576)} MB de ${dvr.maxGB} GB</span>`
        : ''
    }</h4>
    <div class="panel-sources">
      ${recRows || '<div class="panel-note">nenhuma gravação — use o botão ⏺ no player</div>'}
    </div>
    ${
      acct.admin
        ? `<h4>Listas (fontes)</h4>
    <div class="panel-sources">
      ${
        (srcs.sources || []).length
          ? (srcs.sources || [])
              .map(
                (s) =>
                  `<div class="src-row">
        <label class="chk"><input type="checkbox" data-act="${s.id}"${
                    s.active ? ' checked' : ''
                  }> <span>${escapeHTML(s.name)}</span></label>
        <span class="muted">${s.count} canais</span>
        ${
          s.dead
            ? '<span class="src-dead" title="Todos os canais desta lista estão em um host fora do ar">⚠ sem sinal</span>'
            : s.ratio >= 0.3
            ? `<span class="src-dead" title="${s.deadChannels} de ${s.count} canais em host fora do ar">⚠ ${Math.round(
                s.ratio * 100
              )}% fora do ar</span>`
            : ''
        }
        <button class="ghost tiny" data-ren="${s.id}">Renomear</button>
        <button class="ghost tiny danger" data-rm="${s.id}">Remover</button>
      </div>`
              )
              .join('')
          : '<div class="panel-note">nenhuma lista adicionada — use "Adicionar lista"</div>'
      }
    </div>
    <div class="panel-actions">
      <button id="paAddSrc" class="ghost">Adicionar lista (M3U)</button>
    </div>`
        : ''
    }
    <h4>Controle parental</h4>
    <div class="panel-note">${
      par.configured
        ? par.unlocked
          ? 'PIN ativo · liberado por 30 min'
          : 'PIN ativo · categorias bloqueadas'
        : 'desativado'
    }${
      par.configured && par.blocked.length
        ? ' — bloqueando: ' + par.blocked.map(escapeHTML).join(', ')
        : ''
    }</div>
    <div class="panel-actions">
      <button id="paParSet" class="ghost">${
        par.configured ? 'Alterar PIN/categorias' : 'Ativar PIN'
      }</button>
      ${
        par.configured
          ? par.unlocked
            ? '<button id="paParLock" class="ghost">Bloquear agora</button>'
            : '<button id="paParUnlock" class="ghost">Desbloquear</button>'
          : ''
      }
      ${par.configured ? '<button id="paParOff" class="ghost danger">Desativar</button>' : ''}
    </div>`;

  $('#paPass').onclick = changePasswordFlow;
  $('#paRefresh').onclick = refreshFlow;
  if ($('#paRecheck'))
    $('#paRecheck').onclick = async () => {
      try {
        await fetch('/api/health/recheck', { method: 'POST' });
        toast('re-verificação iniciada em segundo plano');
      } catch {
        toast('falha ao iniciar');
      }
    };
  if ($('#paSweep'))
    $('#paSweep').onclick = async () => {
      try {
        await fetch('/api/health/hosts', { method: 'POST' });
        toast('revisando hosts das listas…');
      } catch {
        toast('falha ao iniciar');
      }
    };
  panelBody.querySelectorAll('[data-rec-play]').forEach((b) => {
    b.onclick = () => {
      const url = b.dataset.recPlay;
      panel.hidden = true;
      play({
        id: 'rec:' + url,
        name: 'Gravação',
        kind: 'movie',
        categories: ['Gravações'],
        streams: [{ url, quality: 'gravação' }],
      });
    };
  });
  panelBody.querySelectorAll('[data-rec-cancel]').forEach((b) => {
    b.onclick = async () => {
      await fetch('/api/dvr/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.recCancel }),
      });
      toast('gravação interrompida');
      openPanel();
    };
  });
  panelBody.querySelectorAll('[data-rec-rm]').forEach((b) => {
    b.onclick = async () => {
      await fetch('/api/dvr/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.recRm, purge: true }),
      });
      openPanel();
    };
  });
  panelBody.querySelectorAll('[data-rec-transcode]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true;
      try {
        const r = await fetch('/api/dvr/transcode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: b.dataset.recTranscode }),
        });
        const d = await r.json().catch(() => ({}));
        toast(r.ok ? 'convertendo para H.264 em segundo plano…' : d.error || 'falha ao converter');
      } catch {
        toast('falha ao converter');
      }
      openPanel();
    };
  });
  if ($('#paAdd')) $('#paAdd').onclick = addUserFlow;
  if ($('#paDel')) $('#paDel').onclick = removeUserFlow;
  if ($('#paAddSrc')) $('#paAddSrc').onclick = importFlow;
  panelBody.querySelectorAll('[data-act]').forEach((c) => {
    c.onchange = async () => {
      await fetch('/api/sources/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: c.dataset.act, active: c.checked }),
      });
      await reload();
      openPanel();
    };
  });
  panelBody.querySelectorAll('[data-ren]').forEach((b) => {
    b.onclick = async () => {
      const name = await openDlg({
        title: 'Renomear lista',
        placeholder: 'nome da lista',
        okLabel: 'OK',
      });
      if (!name) return;
      await fetch('/api/sources/rename', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.ren, name }),
      });
      openPanel();
    };
  });
  panelBody.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = async () => {
      await fetch('/api/sources/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: b.dataset.rm }),
      });
      toast('lista removida');
      await reload();
      openPanel();
    };
  });
  $('#paClearHist').onclick = async () => {
    await fetch('/api/history', { method: 'DELETE' });
    recents = [];
    historyMap = new Map();
    saveLocalHistory();
    toast('histórico apagado');
    openPanel();
  };
  $('#paExport').onclick = exportFlow;
  if ($('#paBackup')) $('#paBackup').onclick = backupFlow;
  if ($('#paRestore')) $('#paRestore').onclick = restoreFlow;
  $('#paParSet').onclick = () => parentalSetFlow(par);
  if ($('#paParLock'))
    $('#paParLock').onclick = async () => {
      await parentalAction({ action: 'lock' });
      toast('conteúdo bloqueado');
      await reload();
      openPanel();
    };
  if ($('#paParUnlock')) $('#paParUnlock').onclick = () => parentalUnlockFlow();
  if ($('#paParOff')) $('#paParOff').onclick = () => parentalDisableFlow();
  $('#paLogoutAll').onclick = async () => {
    await fetch('/api/logout-all', { method: 'POST' });
    location.reload();
  };
}

$('#btnAccount').onclick = openPanel;

async function changePasswordFlow() {
  const old = await openDlg({
    title: 'Senha atual',
    okLabel: 'OK',
    inputType: 'password',
    placeholder: '••••••',
  });
  if (!old) return;
  const next = await openDlg({
    title: 'Nova senha (min. 6)',
    okLabel: 'OK',
    inputType: 'password',
    placeholder: '••••••',
  });
  if (!next) return;
  try {
    const r = await fetch('/api/pass', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old, next }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    toast('senha alterada');
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

async function addUserFlow() {
  const user = await openDlg({ title: 'Novo usuário', okLabel: 'OK', placeholder: 'usuario' });
  if (!user) return;
  const pass = await openDlg({
    title: 'Senha (min. 6)',
    okLabel: 'OK',
    inputType: 'password',
    placeholder: '••••••',
  });
  if (!pass) return;
  try {
    const r = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, pass }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    toast('usuário adicionado: ' + user);
    if (!panel.hidden) openPanel();
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

async function removeUserFlow() {
  const users = await (await fetch('/api/users')).json().catch(() => ({ users: [] }));
  const list = users.users || [];
  if (!list.length) return toast('nenhum outro usuário');
  const target = await openDlg({
    title: 'Remover usuário',
    choices: list.map((u) => ({ label: u.user, value: u.user })),
  });
  if (!target) return;
  try {
    const r = await fetch('/api/users?user=' + encodeURIComponent(target), { method: 'DELETE' });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    toast('usuário removido: ' + target);
    if (!panel.hidden) openPanel();
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

const m3uDlg = $('#m3uDlg');

async function exportFlow() {
  try {
    const r = await fetch('/api/m3u-token');
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.token) throw new Error(d.error || 'HTTP ' + r.status);
    const url =
      d.url || location.origin + '/api/m3u?kind=all&token=' + encodeURIComponent(d.token);
    $('#m3uUrl').value = url;
    let lhost = '';
    try {
      lhost = new URL(url).hostname;
    } catch {}
    const local =
      lhost === 'localhost' || lhost === '127.0.0.1' || lhost === '::1' || /^100\.115\./.test(lhost);
    $('#m3uHelp').textContent = local
      ? 'Atenção: você abriu em "' + location.host + '". A TV não alcança esse endereço — abra pelo IP da rede (ex.: http://192.168.x.x:8090) e gere o link de novo.'
      : 'Escaneie o QR ou copie o link e cole no player da TV (IBO Player, TiviMate, VLC…).';
    const qr = $('#m3uQr');
    qr.hidden = true;
    qr.onload = () => {
      qr.hidden = false;
    };
    qr.onerror = () => {
      qr.hidden = true;
    };
    qr.src =
      'https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=' +
      encodeURIComponent(url);
    m3uDlg.hidden = false;
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

$('#m3uClose').onclick = () => {
  m3uDlg.hidden = true;
};
$('#m3uCopy').onclick = () => copyText($('#m3uUrl').value);
m3uDlg.addEventListener('click', (e) => {
  if (e.target === m3uDlg) m3uDlg.hidden = true;
});

async function backupFlow() {
  try {
    const r = await fetch('/api/backup');
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'HTTP ' + r.status);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'iptv-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('backup baixado');
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

function restoreFlow() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const ok = await openDlg({
      title: 'Restaurar backup',
      help: 'Substitui contas, favoritos, histórico, controle parental e listas pela configuração do arquivo. Continuar?',
      value: f.name,
      okLabel: 'Restaurar',
    });
    if (!ok) return;
    try {
      const text = await f.text();
      const r = await fetch('/api/backup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
      toast(`backup restaurado (${d.users} usuários, ${d.sources} listas)`);
      await reload();
      openPanel();
    } catch (err) {
      toast('falha: ' + err.message);
    }
  };
  inp.click();
}

/* ---------------- controle parental ---------------- */

async function parentalAction(payload) {
  const r = await fetch('/api/parental', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  return d;
}

function openParentalDlg(par) {
  return new Promise((resolve) => {
    const box = $('#parDlg');
    $('#parHelp').textContent = par.configured
      ? 'Deixe o PIN em branco para manter o atual. Marque as categorias a bloquear.'
      : 'Defina um PIN (4+ dígitos) e marque as categorias a bloquear.';
    $('#parPin').value = '';
    $('#parPin2').value = '';
    $('#parPin2').hidden = !!par.configured;
    const blocked = new Set(par.blocked || []);
    $('#parCats').innerHTML = (par.categories || [])
      .map(
        (c) =>
          `<label class="chk"><input type="checkbox" value="${escapeHTML(c)}"${
            blocked.has(c) ? ' checked' : ''
          }> <span>${escapeHTML(c)}</span></label>`
      )
      .join('');
    box.hidden = false;
    $('#parPin').focus();

    const done = (val) => {
      box.hidden = true;
      resolve(val);
    };
    box.onclick = (e) => {
      if (e.target === box) done(null);
    };
    $('#parCancel').onclick = () => done(null);
    $('#parOk').onclick = () => {
      const pin = $('#parPin').value.trim();
      if (pin && pin.length < 4) return toast('o PIN precisa de 4+ dígitos');
      if (!pin && !par.configured) return toast('defina um PIN');
      if (pin && !par.configured && pin !== $('#parPin2').value.trim())
        return toast('os PINs não conferem');
      const sel = [...$('#parCats').querySelectorAll('input:checked')].map((i) => i.value);
      done({ pin, blocked: sel });
    };
  });
}

async function parentalSetFlow(par) {
  const v = await openParentalDlg(par);
  if (!v) return;
  try {
    await parentalAction({ action: 'set', pin: v.pin, blocked: v.blocked });
    toast('controle parental salvo' + (v.blocked.length ? ` (${v.blocked.length} categoria[s])` : ''));
    await reload();
    openPanel();
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

async function parentalUnlockFlow() {
  const pin = await openDlg({
    title: 'PIN do controle parental',
    okLabel: 'Desbloquear',
    inputType: 'password',
    placeholder: '••••',
  });
  if (!pin) return;
  try {
    await parentalAction({ action: 'unlock', pin });
    toast('conteúdo liberado por 30 min');
    await reload();
    openPanel();
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

async function parentalDisableFlow() {
  const pin = await openDlg({
    title: 'Desativar controle parental',
    help: 'Informe o PIN para confirmar.',
    okLabel: 'Desativar',
    inputType: 'password',
    placeholder: '••••',
  });
  if (!pin) return;
  try {
    await parentalAction({ action: 'disable', pin });
    toast('controle parental desativado');
    await reload();
    openPanel();
  } catch (err) {
    toast('falha: ' + err.message);
  }
}

/* ---------------- timer de sono ---------------- */

const SLEEP_OPTS = [0, 15, 30, 60, 90];
let sleepIdx = 0;
let sleepTimer = null;
const SLP_KEY = 'iptvlivre.sleep';
const btnSleep = $('#btnSleep');

function clearSleep() {
  if (sleepTimer) { clearTimeout(sleepTimer); sleepTimer = null; }
  localStorage.removeItem(SLP_KEY);
}

btnSleep.onclick = () => {
  if (sleepTimer) clearSleep();
  sleepIdx = (sleepIdx + 1) % SLEEP_OPTS.length;
  const min = SLEEP_OPTS[sleepIdx];
  if (!min) {
    btnSleep.textContent = '⏱ off';
    return toast('timer de sono desligado');
  }
  btnSleep.textContent = '⏱ ' + min + 'min';
  toast('desligando em ' + min + 'min');
  localStorage.setItem(SLP_KEY, String(min));
  sleepTimer = setTimeout(() => {
    toast('timer de sono: desligando');
    Player.close();
    btnSleep.textContent = '⏱ off';
    sleepIdx = 0;
    localStorage.removeItem(SLP_KEY);
  }, min * 60e3);
};
const savedSleep = Number(localStorage.getItem(SLP_KEY) || 0);
if (SLEEP_OPTS.includes(savedSleep) && savedSleep > 0) {
  sleepIdx = SLEEP_OPTS.indexOf(savedSleep);
  btnSleep.textContent = '⏱ ' + savedSleep + 'min';
  sleepTimer = setTimeout(() => {
    toast('timer de sono: desligando');
    Player.close();
    btnSleep.textContent = '⏱ off';
    sleepIdx = 0;
    localStorage.removeItem(SLP_KEY);
  }, savedSleep * 60e3);
}

/* ---------------- relogio ---------------- */

const clockEl = document.getElementById('clock');
const plClockEl = document.getElementById('plClock');
function tickClock() {
  const now = new Date();
  if (clockEl)
    clockEl.textContent = now.toLocaleTimeString('pt-BR', {
      hour: '2-digit',
      minute: '2-digit',
    });
  if (plClockEl) plClockEl.textContent = now.toLocaleTimeString('pt-BR');
}
tickClock();
setInterval(tickClock, 1000);

/* ---------------- dialogo inline ---------------- */

const dlg = $('#dlg');
const dlgInput = $('#dlgInput');
let dlgResolve = null;

function openDlg({ title, help = '', value = '', okLabel = 'OK', placeholder = '', choices = null, inputType = 'text' }) {
  $('#dlgTitle').textContent = title;
  $('#dlgHelp').textContent = help;
  $('#dlgOk').textContent = okLabel;
  const ch = $('#dlgChoices');
  if (Array.isArray(choices) && choices.length) {
    ch.hidden = false;
    dlgInput.hidden = true;
    ch.innerHTML = '';
    for (const c of choices) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.label;
      b.onclick = () => closeDlg(c.value);
      ch.appendChild(b);
    }
    (ch.querySelector('button') || $('#dlgCancel')).focus();
  } else {
    ch.hidden = true;
    dlgInput.hidden = false;
    dlgInput.value = value;
    dlgInput.placeholder = placeholder;
    dlgInput.type = placeholder.startsWith('http')
      ? 'url'
      : inputType === 'password'
        ? 'password'
        : 'text';
    dlgInput.focus();
    dlgInput.select?.();
  }
  dlg.hidden = false;
  return new Promise((r) => { dlgResolve = r; });
}

function closeDlg(val) {
  if (dlg.hidden) return;
  dlg.hidden = true;
  const r = dlgResolve;
  dlgResolve = null;
  r?.(val);
}

$('#dlgCancel').onclick = () => closeDlg(null);
$('#dlgOk').onclick = () => closeDlg(dlgInput.value.trim());
// clicar no fundo escuro tambem fecha (importante no controle remoto)
dlg.addEventListener('click', (e) => {
  if (e.target === dlg) closeDlg(null);
});
dlgInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  closeDlg(dlgInput.value.trim());
});

function copyText(text) {
  const done = () => toast('URL copiada');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done));
  } else {
    legacyCopy(text, done);
  }
}
function legacyCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch {}
  document.body.removeChild(ta);
}

async function importFlow() {
  const url2 = await openDlg({
    title: 'Adicionar lista (M3U)',
    help: 'Cole a URL HTTP de uma lista .m3u/.m3u8. Ela vira uma fonte que voce pode ativar ou desativar.',
    okLabel: 'Adicionar',
    placeholder: 'http://.../playlist.m3u',
  });
  if (!url2) return;
  const btn = $('#btnImport');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Importando…';
  try {
    const r = await fetch('/api/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url2 }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    toast(`lista "${d.name}" adicionada (${d.count} canais)`);
    await reload();
    if (!panel.hidden) openPanel();
  } catch (err) {
    toast('falha ao importar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

$('#btnImport').onclick = importFlow;

$('#btnExport').onclick = exportFlow;

/* ---------------- boot ---------------- */

// Android TV: o botao Voltar fecha a camada aberta (player/dialogo/painel)
// e so sai do app quando nao ha nada para fechar. Chamado pelo MainActivity.
window.__onAndroidBack = function () {
  if (!dlg.hidden) {
    closeDlg(null);
    return true;
  }
  if (Player.isOpen) {
    Player.close();
    return true;
  }
  if (!egGrid.hidden) {
    closeGrid();
    return true;
  }
  if (!shareDlg.hidden) {
    shareDlg.hidden = true;
    return true;
  }
  if (!m3uDlg.hidden) {
    m3uDlg.hidden = true;
    return true;
  }
  if (!panel.hidden) {
    panel.hidden = true;
    return true;
  }
  const sb = $('#sidebar');
  if (sb.classList.contains('open')) {
    sb.classList.remove('open');
    return true;
  }
  return false;
};

// PWA: registra o service worker (shell offline) o quanto antes
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
  // quando uma versao nova assume o controle, recarrega uma unica vez
  let swRefreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (swRefreshing) return;
    swRefreshing = true;
    location.reload();
  });
}

(async () => {
  if (!(await Login.check())) return; // login.js cuida da tela
  try {
    await Promise.all([loadServerFavs(), loadServerHistory()]);
    await loadMeta();
    await loadItems();
    // link compartilhado (?c=id): sintoniza o canal direto
    const wanted = new URLSearchParams(location.search).get('c');
    if (wanted) {
      const ch = await channelById(wanted);
      if (ch) {
        play(ch);
        history.replaceState(null, '', location.pathname);
      } else {
        toast('canal do link não encontrado');
      }
    }
    // o controle comeca na barra de botoes do topo, sem fazer a grade pular
    focusChips(0);
  } catch (err) {
    grid.innerHTML =
      '<p style="color:#8b98b0;text-align:center;padding:40px">Falha ao carregar o catálogo: ' +
      escapeHTML(err.message) +
      '</p>';
  }
})();