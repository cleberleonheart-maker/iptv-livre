import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '..', 'public');

function loadPlayer() {
  const html = readFileSync(join(pub, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://localhost/',
  });
  const { window } = dom;

  const listeners = [];
  const proto = window.HTMLElement.prototype;
  const orig = proto.addEventListener;
  proto.addEventListener = function (type, ...rest) {
    listeners.push({ id: this.id, type });
    return orig.call(this, type, ...rest);
  };

  const src = readFileSync(join(pub, 'js', 'player.js'), 'utf8');
  const script = window.document.createElement('script');
  script.textContent = src;
  window.document.body.appendChild(script);

  return { window, listeners, close: () => window.close() };
}

/* Regressao: o IIFE de player.js ja teve o `return` no meio do arquivo, o que
   tornava os addEventListener das linhas seguintes codigo morto. Este teste
   garante que os botoes do player recebem handler de clique. */
test('player.js anexa handler de clique em CC/Cast/Tela cheia/Qualidade', (t) => {
  const { listeners, close } = loadPlayer();
  t.after(close);
  const clickTargets = new Set(
    listeners.filter((l) => l.type === 'click').map((l) => l.id)
  );
  for (const id of ['btnCC', 'btnCast', 'btnFs', 'btnQual']) {
    assert.ok(clickTargets.has(id), `botao #${id} sem listener de clique`);
  }
});

test('player.js expoe a API Player com open/close', (t) => {
  const { window, close } = loadPlayer();
  t.after(close);
  assert.equal(window.eval('typeof Player'), 'object');
  assert.equal(window.eval('typeof Player.open'), 'function');
  assert.equal(window.eval('typeof Player.close'), 'function');
});

/* Canais livres as vezes servem MPEG-TS cru (video/mp2t) sem manifesto HLS.
   O hls.js nao entende isso e o canal ficava "sem sinal". Este teste garante
   que uma fonte video/mp2t e entregue ao mpegts.js. */
test('fonte video/mp2t e tocada pelo mpegts.js (nao hls.js)', async (t) => {
  const { window, close } = loadPlayer();
  t.after(close);

  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.load = () => {};
  window.Hls = { isSupported: () => true };

  let created = null;
  window.mpegts = {
    isSupported: () => true,
    Events: { ERROR: 'error' },
    ErrorTypes: { NETWORK_ERROR: 'NetworkError' },
    createPlayer: (media, cfg) => {
      created = { media, cfg };
      return {
        on() {},
        attachMediaElement() {},
        load() {},
        play: () => Promise.resolve(),
        destroy() {},
      };
    },
  };

  window.fetch = (url) =>
    Promise.resolve(
      String(url).startsWith('/proxy')
        ? { headers: { get: () => 'video/mp2t' }, body: { cancel: () => Promise.resolve() } }
        : { ok: false, json: () => Promise.resolve({}) }
    );

  window.Player = window.eval('Player');
  window.Player.open(
    {
      id: 'GloboplayNovelas.br',
      name: 'Globoplay Novelas',
      country: 'BR',
      categories: [],
      streams: [{ url: 'http://host:14455', quality: '1080p' }],
    },
    () => {}
  );

  await new Promise((r) => setTimeout(r, 50));
  assert.ok(created, 'mpegts.createPlayer deveria ter sido chamado');
  assert.equal(created.media.type, 'mpegts');
  assert.equal(created.media.isLive, true);
  assert.equal(
    created.media.url,
    'http://localhost/proxy?u=' + encodeURIComponent('http://host:14455')
  );
});

/* Regressao do OSD da programacao: a barra aparece ao abrir o canal, o botao
   "Ver programacao completa" abre o dialogo (que antes ficava ATRAS do player,
   z-index 90 < player 100, parecendo morto), e a barra se esconde sozinha
   depois de alguns segundos. */
test('EPG: barra abre, botao abre o dialogo e a barra auto-esconde', async (t) => {
  const { window, close } = loadPlayer();
  t.after(close);

  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.load = () => {};
  window.Hls = { isSupported: () => true };
  window.mpegts = {
    isSupported: () => true,
    Events: { ERROR: 1 },
    ErrorTypes: { NETWORK_ERROR: 1 },
    createPlayer: () => ({
      on() {}, attachMediaElement() {}, load() {},
      play: () => Promise.resolve(), destroy() {},
    }),
  };

  let dlgOpened = 0;
  let closeDlgFn = null;
  window.openDlg = () => {
    dlgOpened++;
    return new Promise((resolve) => { closeDlgFn = resolve; });
  };

  const programmes = [];
  for (let i = 0; i < 20; i++) {
    programmes.push({
      start: new Date(Date.now() + (i - 1) * 3600e3).toISOString(),
      stop: new Date(Date.now() + i * 3600e3).toISOString(),
      title: 'Programa ' + i,
    });
  }
  window.fetch = (url) => {
    const u = String(url);
    if (u.startsWith('/proxy')) {
      return Promise.resolve({ headers: { get: () => 'video/mp2t' }, body: { cancel: () => Promise.resolve() } });
    }
    if (u.includes('/api/epg/guide')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ programmes }) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
  };

  const api = window.eval('Player');
  api.open(
    { id: 'X.br', name: 'X', country: 'BR', categories: [], streams: [{ url: 'http://1.2.3.4:5555', quality: '1080p' }] },
    () => {}
  );
  await new Promise((r) => setTimeout(r, 150));

  const epgEl = window.document.getElementById('plEpg');
  assert.equal(epgEl.hidden, false, 'barra de programacao deveria aparecer ao abrir o canal');
  const btn = window.document.getElementById('btnFullEpg');
  assert.ok(btn, 'botao "Ver programacao completa" deveria existir para >4 programas');

  btn.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(dlgOpened, 1, 'clicar no botao deveria abrir o dialogo');

  closeDlgFn(null); // simula o usuario fechando o dialogo
  await new Promise((r) => setTimeout(r, 30));

  // o dialogo (.dlg) precisa ficar ACIMA do player (.player) para ser visivel
  const css = readFileSync(join(pub, 'css', 'style.css'), 'utf8');
  const dlgZ = Number((css.match(/\.dlg \{[\s\S]*?z-index:\s*(\d+)/) || [])[1]);
  const playerZ = Number((css.match(/\.player \{[\s\S]*?z-index:\s*(\d+)/) || [])[1]);
  assert.ok(dlgZ > playerZ, `.dlg z-index (${dlgZ}) deveria ser maior que .player (${playerZ})`);

  await new Promise((r) => setTimeout(r, 8200));
  assert.equal(epgEl.hidden, true, 'barra deveria se esconder sozinha apos alguns segundos');

  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(epgEl.hidden, false, 'qualquer tecla deveria trazer a barra de volta');
});

/* Series locais (/media/...) sao mesma origem e nao podem passar pelo /proxy
   (o assertPublicUrl rejeita IP privado/local). O player precisa tocar a URL
   direta, sem mascarar como ?u=. */
test('URL /media e tocada direto, sem /proxy', async (t) => {
  const { window, close } = loadPlayer();
  t.after(close);

  window.HTMLMediaElement.prototype.play = () => Promise.resolve();
  window.HTMLMediaElement.prototype.load = () => {};
  window.Hls = { isSupported: () => true };
  window.mpegts = {
    isSupported: () => true,
    Events: { ERROR: 1 },
    ErrorTypes: { NETWORK_ERROR: 1 },
    createPlayer: () => ({
      on() {}, attachMediaElement() {}, load() {},
      play: () => Promise.resolve(), destroy() {},
    }),
  };

  const proxyCalls = [];
  window.fetch = (url) => {
    proxyCalls.push(String(url));
    return Promise.resolve({ headers: { get: () => '' }, body: { cancel: () => Promise.resolve() } });
  };

  window.Player = window.eval('Player');
  window.Player.open(
    {
      id: '~lib-x',
      name: 'Minha Serie S01E01',
      country: null,
      categories: ['Séries'],
      streams: [{ url: '/media/Minha%20Serie/S01E01.mp4', quality: null }],
    },
    () => {}
  );

  await new Promise((r) => setTimeout(r, 100));
  const video = window.document.getElementById('video');
  assert.ok(video.src.includes('/media/Minha%20Serie/S01E01.mp4'), `fonte deveria ser a URL direta (era ${video.src})`);
  assert.ok(!video.src.includes('/proxy'), 'URL local nao pode passar pelo /proxy');
  assert.ok(!proxyCalls.some((u) => u.includes('/proxy')), 'nao deveria sondar o /proxy para arquivo .mp4');
});
