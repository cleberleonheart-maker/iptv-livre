/* App: catalogo, busca, filtros, favoritos, navegacao por controle remoto. */

const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const empty = $('#empty');

const state = {
  items: [],
  shown: 0,
  page: 60,
  country: 'all',
  category: 'all',
  tab: 'tv',
  kind: 'tv',
  query: '',
};

const FAVS_KEY = 'iptvlivre.favs';

/* ---------------- favoritos ---------------- */

let favs = new Set();
try {
  favs = new Set(JSON.parse(localStorage.getItem(FAVS_KEY) || '[]'));
} catch {}
const saveFavs = () =>
  localStorage.setItem(FAVS_KEY, JSON.stringify([...favs]));

/* Sincroniza com o servidor (mesmos favoritos no APK e no celular).
   localStorage continua sendo o cache offline. */
let favPushTimer;
function pushFavs() {
  clearTimeout(favPushTimer);
  favPushTimer = setTimeout(async () => {
    try {
      await fetch('/api/favs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [...favs] }),
      });
    } catch {}
  }, 400);
}
async function loadServerFavs() {
  try {
    const r = await fetch('/api/favs');
    if (!r.ok) return;
    const d = await r.json();
    favs = new Set(Array.isArray(d.favs) ? d.favs : []);
    saveFavs();
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

function applyHistory(list) {
  recents = list.map((h) => h.id);
  historyMap = new Map(list.map((h) => [h.id, h]));
  saveLocalHistory();
}

async function loadServerHistory() {
  try {
    const r = await fetch('/api/history');
    if (!r.ok) return;
    const d = await r.json();
    if (Array.isArray(d.history)) applyHistory(d.history);
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
  }
  const p = new URLSearchParams();
  p.set('kind', state.kind);
  if (state.country !== 'all') p.set('country', state.country);
  if (state.category !== 'all') p.set('category', state.category);
  if (state.query) p.set('q', state.query);
  p.set('limit', '6000');

  const d = await api('/api/catalog?' + p);
  state.items = d.items;
  if (reset) render(true);
  else render(false);
}

/* ---------------- render ---------------- */

function visible() {
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
    grid.appendChild(cardFor(list[i]));
  }
  state.shown = Math.min(end, list.length);

  empty.hidden = list.length > 0;
  $('#btnMore').parentElement.hidden = state.shown >= list.length;
}

function cardFor(ch) {
  const el = document.createElement('div');
  el.className = 'card' + (favs.has(ch.id) ? ' fav-on' : '') + (ch.kind === 'radio' ? ' is-radio' : '');
  el.tabIndex = 0;
  el.dataset.id = ch.id;

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

function play(ch, el = null) {
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
    { startAt, onProgress: (p) => saveProgress(ch.id, p) }
  );
  updateFavBtn();
}

function toggleFav(id) {
  if (favs.has(id)) favs.delete(id);
  else favs.add(id);
  saveFavs();
  pushFavs();
  toast(favs.has(id) ? '★ adicionado aos favoritos' : '☆ Removido dos favoritos');
  if (state.tab === 'fav') render(true);
  else {
    const el = grid.querySelector(`[data-id="${CSS.escape(id)}"]`);
    if (el) {
      el.classList.toggle('fav-on', favs.has(id));
      el.querySelector('.fav').textContent = favs.has(id) ? '★' : '☆';
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

$('#btnMore').onclick = () => {
  state.page += 60;
  render(false);
};

$('#btnMenu').onclick = () => $('#sidebar').classList.toggle('open');
$('#btnBack').onclick = () => Player.close();
$('#btnFav').onclick = () => Player.channel && toggleFav(Player.channel.id);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Backspace' || e.key === 'BrowserBack') {
    if (dlg.hidden && Player.isOpen) Player.close();
    return; // nunca sobrepoe a digitacao
  }
  if (e.key === 'Escape') {
    if (!dlg.hidden) return closeDlg(null);
    if (Player.isOpen) Player.close();
    else $('#sidebar').classList.remove('open');
    return;
  }
  if (Player.isOpen) {
    if (e.key === 'f' || e.key === 'F') updateFavBtn();
    // setas L/R percorrem os botoes do topo do player no remoto
    const btns = ['btnBack', 'btnQual', 'btnCC', 'btnCast', 'btnSleep', 'btnFav']
      .map((id) => document.getElementById(id))
      .filter((b) => b && !b.hidden && b.offsetParent !== null);
    if (btns.length && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      let i = btns.indexOf(document.activeElement);
      if (i >= 0) i = (i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length;
      else i = e.key === 'ArrowRight' ? 0 : btns.length - 1;
      e.preventDefault();
      btns[i].focus();
    }
    return;
  }
  // navegacao por setas quando o foco esta no grid
  if (!Player.isOpen && document.activeElement?.classList.contains('card')) {
    const cards = [...grid.children];
    const i = cards.indexOf(document.activeElement);
    let n = -1;
    if (e.key === 'ArrowRight') n = i + 1;
    if (e.key === 'ArrowLeft') n = i - 1;
    if (e.key === 'ArrowDown') n = i + Math.floor(grid.clientWidth / 150) || i + 4;
    if (e.key === 'ArrowUp') n = i - 4;
    if (n >= 0 && n < cards.length) {
      e.preventDefault();
      cards[n].focus();
    }
  }
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

  const src = await openDlg({
    title: 'Guia EPG',
    help: 'Escolha o país do guia de programação',
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
    toast(
      `Guia carregado: ${d.channels.toLocaleString('pt-BR')} canais, ${d.programmes.toLocaleString('pt-BR')} programas`
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

/* ---------------- re-verificacao de saude sob demanda ---------------- */

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
        else
          await openDlg({
            title: `Re-verificação: ${dead.length} morto(s) escondido(s)`,
            help: dead.slice(0, 25).map((d, i) => `${i + 1}. ${d.name || d.url} (${d.why})`).join('  |  ') +
              (dead.length > 25 ? `  … e mais ${dead.length - 25}.` : ''),
            okLabel: 'Fechar',
            choices: [{ label: 'Fechar', value: 'ok' }],
          });
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

async function openPanel() {
  panel.hidden = false;
  panelBody.innerHTML = '<p class="muted" style="padding:20px">carregando…</p>';
  let acct = {};
  let par = { configured: false, unlocked: true, blocked: [], categories: [] };
  try {
    [acct, par] = await Promise.all([api('/api/account'), api('/api/parental')]);
  } catch {
    panelBody.innerHTML = '<p class="muted" style="padding:20px">falha ao carregar</p>';
    return;
  }
  const h = acct.health || {};
  const rows = [
    ['Usuário', acct.user || '—'],
    ['Sessões ativas', acct.sessions ?? '—'],
    ['Favoritos', acct.favs ?? '—'],
    ['No histórico', acct.history ?? '—'],
    ['Canais vivos', h.enabled ? `${h.alive ?? 0} / ${h.checked ?? 0}` : 'desligado'],
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
      <button id="paAdd" class="ghost">Adicionar usuário</button>
      <button id="paDel" class="ghost">Remover usuário</button>
      <button id="paClearHist" class="ghost">Limpar histórico</button>
      <button id="paExport" class="ghost">Exportar M3U</button>
      <button id="paLogoutAll" class="ghost danger">Sair de todos os aparelhos</button>
    </div>
    <h4>Usuários</h4>
    <div class="panel-users">
      ${(acct.users || [])
        .map(
          (u) =>
            `<span class="pill${u.user === acct.user ? ' me' : ''}">${escapeHTML(u.user)}</span>`
        )
        .join('')}
    </div>
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
  $('#paAdd').onclick = addUserFlow;
  $('#paDel').onclick = removeUserFlow;
  $('#paClearHist').onclick = async () => {
    await fetch('/api/history', { method: 'DELETE' });
    recents = [];
    historyMap = new Map();
    saveLocalHistory();
    toast('histórico apagado');
    openPanel();
  };
  $('#paExport').onclick = exportFlow;
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

async function exportFlow() {
  const exportUrl = location.origin + '/api/m3u?kind=all';
  const v = await openDlg({
    title: 'Exportar M3U',
    help: 'Use esta URL no VLC, Kodi ou TiviMate de outro aparelho:\n' + exportUrl,
    value: exportUrl,
    okLabel: 'Copiar',
  });
  if (v) copyText(v);
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

$('#btnImport').onclick = async () => {
  const url2 = await openDlg({
    title: 'Importar M3U',
    help: 'Cole a URL HTTP de uma lista .m3u/.m3u8. Ela e adicionada junto ao catalogo.',
    okLabel: 'Importar',
    placeholder: 'http://.../playlist.m3u',
  });
  if (!url2) return;
  const btn = $('#btnImport');
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Importando…';
  try {
    const r = await fetch('/api/import?url=' + encodeURIComponent(url2));
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
    toast(`importadas ${d.count} entrada(s) com sucesso`);
    await reload();
  } catch (err) {
    toast('falha ao importar: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
};

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
  } catch (err) {
    grid.innerHTML =
      '<p style="color:#8b98b0;text-align:center;padding:40px">Falha ao carregar o catálogo: ' +
      escapeHTML(err.message) +
      '</p>';
  }
})();