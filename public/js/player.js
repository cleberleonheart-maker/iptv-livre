/* Player HLS: tenta o hls.js e cai para o nativo quando possivel.
   Cada canal pode ter varias URLs; se uma falhar, tenta a proxima. */

const Player = (() => {
  const video = document.getElementById('video');
  const playerBox = document.getElementById('player');
  const statusEl = document.getElementById('plStatus');
  const epgEl = document.getElementById('plEpg');

  let hls = null;
  let queue = [];
  let current = null;
  let idx = 0;
  let onClose = null;
  let epgChannelId = null;
  let failTimer = null;
  let epgTimer = null;
  let onProgress = null;
  let startAt = 0;

  const proxiedLogo = (url) =>
    url && /^https?:\/\//.test(url) ? '/logo?u=' + encodeURIComponent(url) : url || '';

  function clearFailTimer() {
    if (failTimer) { clearTimeout(failTimer); failTimer = null; }
  }

  // se nada comecar a tocar nesse tempo, considera o link morto e tenta o proximo
  function armFailTimer() {
    clearFailTimer();
    failTimer = setTimeout(() => { if (!playerBox.hidden) onFail(); }, 18000);
  }

  function status(msg, keep = false) {
    // o chrome desenha o icone de "video quebrado" no centro do elemento <video>
    // quando a fonte falha. escondemos o video nesses momentos.
    playerBox.classList.toggle('video-dead', !!msg);
    if (!msg) {
      statusEl.hidden = true;
      return;
    }
    statusEl.textContent = msg;
    statusEl.hidden = false;
  }

  function teardown() {
    if (hls) {
      try { hls.destroy(); } catch {}
      hls = null;
    }
    video.removeAttribute('src');
    video.load();
  }

  /* Radio e audio puro: o elemento de video serve, mas a tela fica
     com a arte da estacao em vez do quadro preto. */
  function isAudio(ch) {
    return ch && ch.kind === 'radio';
  }

  function playUrl(url, audioMode) {
    teardown();
    playerBox.classList.toggle('audio-mode', !!audioMode);
    // mantem o <video> escondido ate o quadro/audio comecar de verdade;
    // isso evita o icone de "midia quebrada" do chrome no meio da tela
    status(audioMode ? 'sintonizando…' : 'carregando…');
    armFailTimer();

    const proxied = '/proxy?u=' + encodeURIComponent(url);

    // Safari / iOS: HLS e audio direto, sem hls.js
    if (video.canPlayType('application/vnd.apple.mpegurl') || audioMode) {
      video.src = proxied;
      video.play().catch(() => {});
      return;
    }

    if (window.Hls && Hls.isSupported()) {
      hls = new Hls({
        lowLatencyMode: true,
        backBufferLength: 90,
        maxBufferLength: 30,
        manifestLoadingMaxRetry: 4,
        manifestLoadingRetryDelay: 1000,
        levelLoadingMaxRetry: 4,
        levelLoadingRetryDelay: 1000,
        fragLoadingMaxRetry: 6,
        fragLoadingRetryDelay: 900,
        enableWorker: true,
      });
      hls.loadSource(proxied);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // nao revela o video ainda: so o evento 'playing' faz isso
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          status('erro de rede, tentando outro servidor…');
          hls.startLoad();
          setTimeout(() => { if (hls) onFail(); }, 6000);
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          status('ajustando o vídeo…');
          hls.recoverMediaError();
        } else {
          onFail();
        }
      });
    } else {
      video.src = proxied;
      video.play().catch(() => {});
    }
  }

  // quando todos os links falham, pede ao servidor uma re-sonda deste canal:
  // se a fonte realmente morreu, ele some da lista em vez de ficar "sem sinal".
  function recheckCurrent() {
    const urls = (queue || []).map((s) => s && s.url).filter(Boolean);
    if (!urls.length) return;
    fetch('/api/health/recheck', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    }).catch(() => {});
  }

  function onFail() {
    clearFailTimer();
    if (idx + 1 < queue.length) {
      idx++;
      status(`tentando link ${idx + 1}/${queue.length}…`);
      setTimeout(() => playUrl(queue[idx].url, isAudio(current)), 600);
    } else {
      // esgotou: limpa a midia para o chrome nao pintar o icone quebrado
      try { hls && hls.destroy(); } catch {}
      hls = null;
      video.removeAttribute('src');
      video.load();
      status(`sem sinal — os ${queue.length} link(s) deste canal falharam. Escolha outro canal.`);
      recheckCurrent();
    }
  }

  video.addEventListener('error', () => {
    if (playerBox.hidden) return;
    if (!video.src && !hls) return;
    onFail();
  });

  // revela o video assim que houver dados: cobre o caso em que o navegador
  // bloqueia o autoplay e o evento 'playing' nunca dispara (senao ficava preto)
  function reveal() {
    clearFailTimer();
    status('');
    // retoma de onde parou (so faz sentido em conteudo com duracao definida)
    if (startAt > 3 && Number.isFinite(video.duration) && video.duration > startAt + 3) {
      try { video.currentTime = startAt; } catch {}
    }
    startAt = 0;
  }
  video.addEventListener('playing', reveal);
  video.addEventListener('canplay', reveal);
  video.addEventListener('loadeddata', reveal);

  // progresso de playback: alimenta o "continuar de onde parou" do servidor
  video.addEventListener('timeupdate', () => {
    if (!onProgress || playerBox.hidden || !current) return;
    const dur = video.duration;
    const live = !Number.isFinite(dur) || dur <= 0;
    onProgress({
      pos: video.currentTime || 0,
      dur: live ? 0 : dur,
      live,
    });
  });

  // arte da estacao: so mostra se a imagem realmente carregar
  const art = document.getElementById('radioArt');
  function showArt(url) {
    art.classList.remove('ready');
    art.style.backgroundImage = '';
    if (!url) return;
    const probe = new Image();
    probe.referrerPolicy = 'no-referrer';
    probe.onload = () => {
      if (!url || url !== (current && current.logo)) return;
      art.style.backgroundImage = `url("${proxiedLogo(url).replace(/["\\)]/g, '')}")`;
      art.classList.add('ready');
    };
    probe.onerror = () => {};
    probe.src = proxiedLogo(url);
  }

  // quando o radio comeca a soar, mostra a arte da estacao
  video.addEventListener('playing', () => {
    if (current && current.kind === 'radio' && current.logo) showArt(current.logo);
  });

  return {
    open(channel, closeCb, opts = {}) {
      current = channel;
      onClose = closeCb;
      queue = channel.streams;
      idx = 0;
      epgChannelId = channel.id;
      onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      startAt = Number(opts.startAt) || 0;
      const audio = isAudio(channel);

      playerBox.hidden = false;
      playerBox.classList.toggle('audio-mode', audio);
      const liveLabel = document.getElementById('plLive');
      liveLabel.hidden = !audio;
      showArt(audio ? channel.logo : '');
      document.getElementById('plEpg').hidden = true;

      document.getElementById('plName').textContent = channel.name;
      document.getElementById('plMeta').textContent =
        [
          channel.country || '—',
          channel.categories.join(', '),
          channel.bitrate ? channel.bitrate + ' kbps' : channel.streams[0]?.quality,
          audio ? 'rádio' : channel.streams.length + ' link(s)',
        ]
          .filter(Boolean)
          .join(' · ');

      if (!audio) showEpg(channel);
      clearSubtitles();
      updatePlayerButtons();
      playUrl(queue[0].url, audio);
      updateQualBtn();
      // foco vai para o X: no controle remoto, achou o X, OK = fechar
      const backBtn = document.getElementById('btnBack');
      if (backBtn) backBtn.focus();
    },
    close() {
      clearFailTimer();
      clearTimeout(epgTimer);
      teardown();
      playerBox.hidden = true;
      playerBox.classList.remove('audio-mode');
      epgEl.hidden = true;
      onProgress = null;
      startAt = 0;
      updateQualBtn();
      updatePlayerButtons();
      if (onClose) onClose();
    },
    get isOpen() { return !playerBox.hidden; },
    get channel() { return current; },
  };

  /* Canais com varios streams distintos mostram um botao de qualidade;
     clicar abre o dialogo (nunca automatico, para nao travar o controle). */
  function distinctStreams(ch) {
    return new Set(
      (ch.streams || []).map((s) => ((s.quality || s.title) || '').toLowerCase().trim())
    );
  }
  function updateQualBtn() {
    const btn = document.getElementById('btnQual');
    if (!btn) return;
    btn.hidden =
      !current || isAudio(current) || !current.streams ||
      current.streams.length < 2 || distinctStreams(current).size < 2;
  }
  document.getElementById('btnQual')?.addEventListener('click', async () => {
    if (!current || isAudio(current)) return;
    const i = await chooseQuality(current);
    if (i != null && Number(i) !== 0) {
      // qualidade trocada: reinicia com o novo primeiro link
      playUrl(queue[0].url, false);
    }
    updateQualBtn();
  });

  /* -------- legendas (.srt/.vtt via /sub) -------- */

  function clearSubtitles() {
    video.querySelectorAll('track').forEach((t) => t.remove());
  }

  function addSubtitle(u) {
    clearSubtitles();
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = 'Legendas';
    track.srclang = 'pt';
    track.default = true;
    track.src = '/sub?u=' + encodeURIComponent(u);
    video.appendChild(track);
    const enable = () => {
      const tt = video.textTracks[video.textTracks.length - 1];
      if (tt) tt.mode = 'showing';
    };
    track.addEventListener('load', enable);
    setTimeout(enable, 800);
    if (window.toast) window.toast('legendas carregadas');
  }

  document.getElementById('btnCC')?.addEventListener('click', async () => {
    if (!current || isAudio(current) || !window.openDlg) return;
    const u = await window.openDlg({
      title: 'Legendas',
      help: 'Cole a URL de um arquivo .srt ou .vtt. O servidor converte para WebVTT.',
      okLabel: 'Carregar',
      placeholder: 'http://.../legenda.srt',
    });
    if (u) addSubtitle(u);
  });

  /* -------- transmitir para a TV (AirPlay / Chromecast) -------- */

  let castReady = false;
  function castAvailable() {
    if (video.webkitShowPlaybackTargetPicker) return true;
    return /Chrome|Chromium|Edg\//.test(navigator.userAgent);
  }

  function loadCastSdk() {
    return new Promise((resolve) => {
      if (window.chrome && window.chrome.cast) return resolve(true);
      window.__onGCastApiAvailable = (ok) => resolve(!!ok);
      const s = document.createElement('script');
      s.src = 'https://www.gstatic.com/cv/js/sdk/4.0.0/cast_sender.js?loadCastFramework=1';
      s.onerror = () => resolve(false);
      document.head.appendChild(s);
    });
  }

  function initCast() {
    try {
      const ctx = cast.framework.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      castReady = true;
    } catch {}
  }

  async function chromeCastPlay(src) {
    // o receiver nao tem o cookie de sessao: usa um token curto emitido pelo servidor
    let castToken = '';
    try {
      const r = await fetch('/api/cast-token');
      if (r.ok) castToken = (await r.json()).token || '';
    } catch {}
    const url = new URL(
      '/proxy?u=' + encodeURIComponent(src) + (castToken ? '&token=' + encodeURIComponent(castToken) : ''),
      location.origin
    ).toString();
    try {
      const ctx = cast.framework.CastContext.getInstance();
      const session = ctx.getCurrentSession() || (await ctx.requestSession());
      const mediaInfo = new chrome.cast.media.MediaInfo(url, 'application/x-mpegurl');
      mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
      mediaInfo.metadata.title = current.name || '';
      await session.loadMedia(new chrome.cast.media.LoadRequest(mediaInfo));
      if (window.toast) window.toast('transmitindo para a TV');
    } catch {
      if (window.toast) window.toast('não foi possível conectar à TV');
    }
  }

  async function startCast() {
    if (!current) return;
    // Safari/iOS: picker nativo de AirPlay
    if (video.webkitShowPlaybackTargetPicker) {
      video.webkitShowPlaybackTargetPicker();
      return;
    }
    const src = queue[idx] ? queue[idx].url : null;
    if (!src) return;
    const ok = await loadCastSdk();
    if (ok && window.chrome && window.chrome.cast) {
      if (!castReady) initCast();
      return chromeCastPlay(src);
    }
    // sem Chromecast/AirPlay: tenta DLNA/UPnP na rede
    return dlnaFlow(src);
  }

  /* DLNA/UPnP: o servidor varre a rede (SSDP) e manda o stream tocar na TV.
     Usado quando o Chromecast nao esta disponivel (ex.: Android TV WebView). */
  async function dlnaFlow(src) {
    if (!window.openDlg || !src || !current) return;
    try {
      const r = await fetch('/api/dlna/discover');
      if (!r.ok) throw new Error('erro ' + r.status);
      const d = await r.json();
      const devices = Array.isArray(d.devices) ? d.devices : [];
      if (!devices.length) {
        if (window.toast) window.toast('nenhuma TV DLNA/UPnP encontrada');
        return;
      }
      const picked = await window.openDlg({
        title: 'Transmitir via DLNA',
        help: current.name,
        choices: devices.map((dev) => ({ label: dev.name, value: JSON.stringify(dev) })),
      });
      if (!picked) return;
      const device = JSON.parse(picked);
      const rep = await fetch('/api/dlna/play', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device, url: src }),
      });
      const out = await rep.json().catch(() => ({}));
      if (rep.ok) {
        if (window.toast) window.toast('transmitindo para ' + (device.name || 'a TV'));
      } else {
        if (window.toast) window.toast('falhou: ' + (out.error || 'não foi possível tocar na TV'));
      }
    } catch {
      if (window.toast) window.toast('não foi possível conectar à TV');
    }
  }

  document.getElementById('btnCast')?.addEventListener('click', startCast);

  function updatePlayerButtons() {
    const cc = document.getElementById('btnCC');
    const cast = document.getElementById('btnCast');
    const fs = document.getElementById('btnFs');
    const audio = isAudio(current);
    if (cc) cc.hidden = !current || audio;
    if (cast) cast.hidden = !current || !castAvailable();
    if (fs) fs.hidden = !current || audio;
  }

  document.getElementById('btnFs')?.addEventListener('click', async () => {
    const playerBox = document.getElementById('player');
    if (!playerBox) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (video.webkitEnterFullscreen && video.webkitSupportsFullscreen) {
        video.webkitEnterFullscreen(); // iOS Safari
      } else if (playerBox.requestFullscreen) {
        await playerBox.requestFullscreen();
      } else if (window.toast) {
        window.toast('tela cheia não disponível neste aparelho');
      }
    } catch {}
  });

  /* Abre o seletor; escolher reordena o queue para o link virar o primeiro.
     Devolve o indice escolhido (ou null se cancelou). */
  async function chooseQuality(channel) {
    if (!window.openDlg || !channel.streams || channel.streams.length < 2) return null;
    const picked = await window.openDlg({
      title: 'Qualidade / link',
      help: channel.name + ' — escolha uma opção (Esc para o padrão)',
      choices: channel.streams.map((s, i) => ({
        label:
          [s.quality, s.title, s.labels && s.labels.length ? s.labels.join(', ') : null]
            .filter(Boolean)
            .join(' · ') ||
          'Link ' + (i + 1),
        value: String(i),
      })),
    });
    if (picked == null) return null;
    const i = Number(picked);
    if (!Number.isInteger(i) || i < 0 || i >= channel.streams.length) return null;
    if (i === 0) return 0;
    queue = [channel.streams[i], ...channel.streams.filter((_, j) => j !== i)];
    channel.streams = queue;
    idx = 0;
    return i;
  }

  async function showEpg(channel) {
    epgEl.hidden = true;
    try {
      const r = await fetch(
        '/api/epg/guide?channel=' + encodeURIComponent(channel.id)
      );
      if (!r.ok) return;
      const d = await r.json();
      const list = d.programmes || [];
      if (!list.length) return;

      // o servidor ja devolve os horarios em ISO
      const now = Date.now();
      const fmt = (iso) =>
        new Date(iso).toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        });

      let nowIdx = list.findIndex((p) => Date.parse(p.stop) > now);
      if (nowIdx < 0) nowIdx = 0;

      const slice = list.slice(Math.max(0, nowIdx - 1), nowIdx + 4);
      epgEl.innerHTML =
        '<div class="now">agora: ' + escapeHtml(list[nowIdx].title) + '</div>' +
        slice
          .map((p) => `<div class="next">${fmt(p.start)} — ${escapeHtml(p.title)}</div>`)
          .join('') +
        (list.length > 4
          ? '<button type="button" class="pl-epoch" id="btnFullEpg">Ver programação completa (' +
            list.length +
            ')</button>'
          : '');
      epgEl.hidden = false;

      epgEl.querySelector('#btnFullEpg')?.addEventListener('click', () => {
        if (!window.openDlg) return;
        const start = Math.max(0, nowIdx - 2);
        const items = list.slice(start, start + 45);
        window.openDlg({
          title: (current ? current.name : '') + ' — programação',
          help: 'Navegue com as setas; OK/Esc fecha.',
          choices: items.map((pr, i) => ({
            label:
              fmt(pr.start) +
              '  ' +
              pr.title +
              (i === nowIdx - start ? '   ← agora' : ''),
            value: null,
          })),
        });
      });

      // mantem o "agora" atualizado enquanto o canal esta aberto
      clearTimeout(epgTimer);
      epgTimer = setTimeout(() => {
        if (!playerBox.hidden && current && !isAudio(current)) showEpg(current);
      }, 5 * 60e3);
    } catch {}
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }
})();