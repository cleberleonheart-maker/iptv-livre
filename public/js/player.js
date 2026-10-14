/* Player HLS: tenta o hls.js e cai para o nativo quando possivel.
   Cada canal pode ter varias URLs; se uma falhar, tenta a proxima. */

const Player = (() => {
  const video = document.getElementById('video');
  const playerBox = document.getElementById('player');
  const statusEl = document.getElementById('plStatus');
  const epgEl = document.getElementById('plEpg');

  let hls = null;
  let mpegtsPlayer = null;
  let gen = 0;
  const kindCache = new Map();
  let queue = [];
  let current = null;
  let idx = 0;
  let rounds = 0;
  let mediaErrors = 0;
  let onClose = null;
  let failTimer = null;
  let epgTimer = null;
  let epgHideTimer = null;
  let epgHasContent = false;
  let onProgress = null;
  let onEnded = null;
  let startAt = 0;
  let currentUrl = '';
  let transcodeTried = false;
  let transcodeMode = false;
  let alternativesTried = false;
  let noVideoTicks = 0; // eslint-disable-line no-unused-vars
  // timeshift: buffer HLS gravado no servidor para rebobinar/pausar ao vivo
  const timeshift = { id: null, playlist: '', active: false };

  // fontes ao vivo publicas oscilam: da uma segunda passada pelos links antes de desistir
  const MAX_ROUNDS = 1;

  const proxiedLogo = (url) =>
    url && /^https?:\/\//.test(url) ? '/logo?u=' + encodeURIComponent(url) : url || '';

  function clearFailTimer() {
    if (failTimer) { clearTimeout(failTimer); failTimer = null; }
  }

  // se nada comecar a tocar nesse tempo, considera o link morto e tenta o proximo
  function armFailTimer(delay = 18000) {
    clearFailTimer();
    failTimer = setTimeout(() => { if (!playerBox.hidden) onFail(); }, delay);
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
    gen++;
    if (hls) {
      try { hls.destroy(); } catch {}
      hls = null;
    }
    if (mpegtsPlayer) {
      try { mpegtsPlayer.destroy(); } catch {}
      mpegtsPlayer = null;
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
    resetStall();
    mediaErrors = 0;
    currentUrl = url;
    transcodeTried = false;
    transcodeMode = false;
    noVideoTicks = 0;
    timeshift.active = !!timeshift.playlist && url === timeshift.playlist;
    playerBox.classList.toggle('audio-mode', !!audioMode);
    // mantem o <video> escondido ate o quadro/audio comecar de verdade;
    // isso evita o icone de "midia quebrada" do chrome no meio da tela
    status(audioMode ? 'sintonizando…' : 'carregando…');
    armFailTimer();

    // arquivos da biblioteca local (/media) sao mesmos de origem: nao passam
    // pelo /proxy nem pelo assertPublicUrl (que rejeita IP privado/local).
    const direct = url.startsWith('/') || url.startsWith(location.origin);
    const proxied = direct ? url : '/proxy?u=' + encodeURIComponent(url);

    // Safari / iOS: HLS e audio direto, sem hls.js
    if (video.canPlayType('application/vnd.apple.mpegurl') || audioMode) {
      video.src = proxied;
      video.play().catch(() => {});
      return;
    }

    if (!window.Hls || !Hls.isSupported()) {
      video.src = proxied;
      video.play().catch(() => {});
      return;
    }

    // O hls.js so entende manifesto HLS. Muitos canais livres servem
    // MPEG-TS cru (video/mp2t) sem playlist — nisso o hls.js falha e o canal
    // aparece "sem sinal" mesmo estando no ar. Detecta o tipo e usa o motor
    // certo (mpegts.js para TS cru).
    const myGen = gen;
    detectKind(url, proxied).then((kind) => {
      if (myGen !== gen) return;
      if (kind === 'mpegts') playMpegts(proxied);
      else if (kind === 'native') {
        video.src = proxied;
        video.play().catch(() => {});
      } else {
        playHls(proxied);
      }
    });
  }

  // pista pelo sufixo da URL (evita sondagem quando o tipo e obvio)
  function guessFromUrl(url) {
    try {
      const p = new URL(url, location.href).pathname.toLowerCase();
      if (/\.m3u8?$/.test(p)) return 'hls';
      if (/\.ts$/.test(p)) return 'mpegts';
      if (/\.(mp4|webm|ogg|mkv|m4a|mp3|aac)$/.test(p)) return 'native';
    } catch {}
    return null;
  }

  // sonda o /proxy pelo Content-Type e decide o motor. Cacheia por URL.
  async function detectKind(url, proxied) {
    const guess = guessFromUrl(url);
    if (guess) return guess;
    if (kindCache.has(url)) return kindCache.get(url);
    let kind = 'hls';
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const r = await fetch(proxied, { signal: ctrl.signal });
      clearTimeout(timer);
      const ct = String(r.headers.get('content-type') || '').toLowerCase();
      if (ct.includes('mpegurl')) kind = 'hls';
      else if (ct.includes('mp2t') || ct.includes('mpeg-ts')) kind = 'mpegts';
      else if (ct.startsWith('video/') || ct.startsWith('audio/')) kind = 'native';
      try { if (r.body) await r.body.cancel(); } catch {}
    } catch {}
    kindCache.set(url, kind);
    return kind;
  }

  /* Codecs de video que este navegador nao decodifica via MSE (ex.: MPEG-2,
     comum em alguns provedores livres). Nesses casos o hls.js toca so o audio
     e o servidor precisa reencodar para H.264. */
  function videoNeedsTranscode(codec) {
    if (!codec) return false;
    const map = {
      h264: 'avc1.42E01E',
      hevc: 'hvc1.1.6.L93.B0',
      vp9: 'vp09.00.10.08',
      vp8: 'vp8',
      av1: 'av01.0.04M.08',
    };
    const mse = map[codec];
    if (!mse) return true; // desconhecido (MPEG-2/VC1/MPEG-4): sempre reencoda
    return !(
      window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="' + mse + '"')
    );
  }

  /* O canal esta tocando audio mas sem imagem (codec de video nao suportado):
     pergunta o codec ao servidor e, se preciso, cai para o /transcode. */
  async function tryTranscode() {
    if (transcodeTried || !currentUrl) return;
    transcodeTried = true;
    const myGen = gen;
    let info = null;
    try {
      const r = await fetch('/api/probe?u=' + encodeURIComponent(currentUrl));
      if (r.ok) info = await r.json();
    } catch {}
    if (myGen !== gen || playerBox.hidden) return;
    if (info && info.ok && videoNeedsTranscode(info.video)) {
      if (info.transcode) {
        playTranscode();
        return;
      }
      status(
        `este canal usa ${info.video}, sem suporte neste navegador. ` +
          'O servidor está sem reencode — tente pelo app de TV/IBO.'
      );
      return;
    }
    // nao era problema de codec: segue o fluxo normal de falha
    onFail();
  }

  function playTranscode() {
    teardown();
    resetStall();
    mediaErrors = 0;
    noVideoTicks = 0;
    transcodeTried = true;
    transcodeMode = true;
    playerBox.classList.remove('audio-mode');
    status('reencodando o canal (MPEG-2 → H.264)…');
    armFailTimer(30000);
    video.src = '/transcode?u=' + encodeURIComponent(currentUrl);
    video.play().catch(() => {});
  }

  function playHls(proxied) {
    hls = new Hls({
      // modo de baixa latencia "caça" a borda ao vivo e costuma esgotar o
      // buffer em links livres instáveis: deixa desligado e acumula buffer
      lowLatencyMode: false,
      backBufferLength: 90,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      liveSyncDurationCount: 3,
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
      updateAudioBtn();
      video.play().catch(() => {});
    });
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        // tenta recompor o MESMO link por alguns segundos; se a playback
        // voltar, o 'reveal' cancela o timer. senao, troca de link.
        status('erro de rede, tentando outro servidor…');
        hls.startLoad();
        armFailTimer(8000);
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        // fonte com trilho de video malformado (sem SPS/PPS no inicio do
        // segmento): tenta recuperar algumas vezes; se nao adianta, reinicia
        // o stream do zero (onFail) para nao ficar em tela preta com audio.
        mediaErrors++;
        if (mediaErrors > 3) {
          tryTranscode();
        } else {
          status('ajustando o vídeo…');
          hls.recoverMediaError();
        }
      } else {
        onFail();
      }
    });
  }

  // MPEG-TS cru (video/mp2t): alimenta o <video> via MSE pelo mpegts.js.
  function playMpegts(proxied) {
    if (!window.mpegts || !mpegts.isSupported()) {
      // sem MSE/TS: ultima tentativa no elemento nativo
      video.src = proxied;
      video.play().catch(() => {});
      return;
    }
    mediaErrors = 0;
    // o worker do mpegts.js nao resolve URL relativa ("/proxy?..."): precisa
    // ser absoluta, senao ele morre com "Failed to parse URL".
    const abs = new URL(proxied, location.origin).toString();
    mpegtsPlayer = mpegts.createPlayer(
      { type: 'mpegts', isLive: true, url: abs },
      // sem "latency chasing": ele re-busca para diminuir o atraso e isso faz
      // o video "pausar" de propósito a cada poucos segundos em links lentos
      { enableWorker: true, liveBufferLatencyChasing: false, lazyLoad: false }
    );
    mpegtsPlayer.on(mpegts.Events.ERROR, (errorType) => {
      if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
        status('erro de rede, tentando outro servidor…');
        armFailTimer(8000);
      } else {
        onFail();
      }
    });
    mpegtsPlayer.attachMediaElement(video);
    mpegtsPlayer.load();
    mpegtsPlayer.play().catch(() => {});
  }

  // quando todos os links falham, pede ao servidor uma re-sonda deste canal
  // e consulta o diagnostico: se a fonte morreu, explica o motivo ao usuario
  // em vez de deixar so "sem sinal".
  async function streamStatus(u) {
    try {
      const r = await fetch('/api/stream-status?u=' + encodeURIComponent(u));
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  async function diagnoseCurrent(target) {
    const urls = (queue || []).map((s) => s && s.url).filter(Boolean);
    if (!urls.length) return;
    try {
      await fetch('/api/health/recheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls }),
      });
    } catch {
      return;
    }
    if (playerBox.hidden || current !== target) return;
    const d = await streamStatus(urls[0]);
    if (!d || playerBox.hidden || current !== target) return;
    if (d.dead) {
      const extra = d.hostDead ? ' (provedor fora do ar)' : '';
      status(`sem sinal — ${d.label || d.why || 'fonte indisponível'}${extra}. Tente outro canal.`);
    } else {
      status('sem sinal — a fonte não respondeu agora. Tente outro canal.');
    }
  }

  // busca no servidor outros links para o MESMO canal (outra fonte/host) e,
  // se houver, adiciona ao queue e tenta de novo
  async function tryAlternatives(target) {
    if (!target || !target.id) return false;
    const tried = (queue || []).map((s) => s && s.url).filter(Boolean);
    let data = null;
    try {
      const r = await fetch(
        '/api/alternatives?id=' + encodeURIComponent(target.id) + '&exclude=' + encodeURIComponent(tried.join(','))
      );
      if (!r.ok) return false;
      data = await r.json();
    } catch {
      return false;
    }
    if (playerBox.hidden || current !== target) return false;
    const alts = (data && data.alternatives ? data.alternatives : []).filter(
      (a) => a && a.url && !tried.includes(a.url)
    );
    if (!alts.length) return false;
    queue.push(...alts);
    idx = queue.length - alts.length;
    rounds = 0;
    status(`tentando ${alts.length} link(s) alternativo(s)…`);
    playUrl(queue[idx].url, isAudio(current));
    return true;
  }

  async function onFail() {
    clearFailTimer();
    if (idx + 1 < queue.length) {
      idx++;
      status(`tentando link ${idx + 1}/${queue.length}…`);
      setTimeout(() => playUrl(queue[idx].url, isAudio(current)), 600);
      return;
    }
    if (rounds < MAX_ROUNDS) {
      rounds++;
      idx = 0;
      status('sem sinal, tentando de novo…');
      setTimeout(() => playUrl(queue[0].url, isAudio(current)), 1500);
      return;
    }
    // esgotou os links deste canal: procura alternativos em outras fontes
    if (!alternativesTried) {
      alternativesTried = true;
      status('sem sinal — procurando outro link para este canal…');
      if (await tryAlternatives(current)) return;
    }
    // limpa a midia para o chrome nao pintar o icone quebrado
    try { hls && hls.destroy(); } catch {}
    hls = null;
    video.removeAttribute('src');
    video.load();
    status(`sem sinal — os ${queue.length} link(s) deste canal não responderam. Analisando…`);
    diagnoseCurrent(current);
  }

  video.addEventListener('error', () => {
    if (playerBox.hidden) return;
    if (transcodeMode) {
      clearFailTimer();
      status('não consegui reencodar este canal agora. Tente outro.');
      return;
    }
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

  // episódio terminou: deixa o app decidir se toca o próximo automaticamente
  video.addEventListener('ended', () => {
    if (!onEnded || playerBox.hidden) return;
    onEnded();
  });

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

  /* Vigia de stall: alguns feeds morrem em silencio (a fonte para de mandar
     fragmentos sem disparar erro no HLS). Se ao vivo o video nao avanca por
     15s, considera o link morto e tenta o proximo automaticamente. */
  let lastTime = 0;
  let stallTicks = 0;
  function resetStall() {
    lastTime = video.currentTime || 0;
    stallTicks = 0;
  }
  setInterval(() => {
    if (playerBox.hidden || !current || video.paused || video.ended) return;
    const t = video.currentTime || 0;
    if (t === lastTime) {
      stallTicks++;
      const live = !Number.isFinite(video.duration) || video.duration <= 0;
      if (live && stallTicks >= 3) {
        stallTicks = 0;
        status('sem progresso, tentando outro link…');
        onFail();
      }
    } else {
      lastTime = t;
      stallTicks = 0;
    }
  }, 5000);

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

  const api = {
    open(channel, closeCb, opts = {}) {
      current = channel;
      onClose = closeCb;
      queue = channel.streams;
      idx = 0;
      rounds = 0;
      alternativesTried = false;
      onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
      onEnded = typeof opts.onEnded === 'function' ? opts.onEnded : null;
      startAt = Number(opts.startAt) || 0;
      const audio = isAudio(channel);

      playerBox.hidden = false;
      playerBox.classList.toggle('audio-mode', audio);
      const liveLabel = document.getElementById('plLive');
      liveLabel.hidden = !audio;
      showArt(audio ? channel.logo : '');
      document.getElementById('plEpg').hidden = true;
      epgHasContent = false;
      clearTimeout(epgHideTimer);

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
      updateAudioBtn();
      updateCatchupBtn();
      updateDvrBtn();
      updateTsBtn();
      // foco vai para o X: no controle remoto, achou o X, OK = fechar
      const backBtn = document.getElementById('btnBack');
      if (backBtn) backBtn.focus();
    },
    close() {
      clearFailTimer();
      clearTimeout(epgTimer);
      clearTimeout(epgHideTimer);
      epgHasContent = false;
      teardown();
      playerBox.hidden = true;
      playerBox.classList.remove('audio-mode');
      epgEl.hidden = true;
      onProgress = null;
      onEnded = null;
      startAt = 0;
      updateQualBtn();
      updateAudioBtn();
      updateCatchupBtn();
      updateDvrBtn();
      stopTimeshift();
      updateTsBtn();
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

  /* Canais HLS com varias faixas de audio (multi-idioma / "áudio 2"): o hls.js
     expoe hls.audioTracks e deixa trocar sem recarregar o stream. */
  function updateAudioBtn() {
    const btn = document.getElementById('btnAudio');
    if (!btn) return;
    const tracks = (hls && hls.audioTracks) || [];
    const show = tracks.length > 1 && !!current && !isAudio(current);
    btn.hidden = !show;
    if (show) {
      const i = Number.isInteger(hls.audioTrack) ? hls.audioTrack : 0;
      btn.textContent = '🔊 ' + (i + 1) + '/' + tracks.length;
    }
  }
  document.getElementById('btnAudio')?.addEventListener('click', () => {
    if (!hls || !hls.audioTracks || hls.audioTracks.length < 2) return;
    const n = hls.audioTracks.length;
    hls.audioTrack = ((Number(hls.audioTrack) || 0) + 1) % n;
    const name = (hls.audioTracks[hls.audioTrack] || {}).name || '';
    if (window.toast) window.toast('áudio: ' + (name || hls.audioTrack + 1 + '/' + n));
    updateAudioBtn();
  });

  /* ------- catch-up (ver do início) e gravação (DVR) ------- */

  function hasCatchup() {
    return !!(current && (current.streams || []).some((s) => s && s.catchup && s.catchup.source));
  }
  function updateCatchupBtn() {
    const btn = document.getElementById('btnCatchup');
    if (btn) btn.hidden = !hasCatchup();
  }
  document.getElementById('btnCatchup')?.addEventListener('click', async () => {
    if (!hasCatchup() || !window.openDlg) return;
    const pick = await window.openDlg({
      title: 'Ver do início',
      help: 'Comece a assistir do ponto escolhido. Depende do provedor oferecer catch-up.',
      choices: [
        { label: '15 minutos atrás', value: 15 },
        { label: '30 minutos atrás', value: 30 },
        { label: '1 hora atrás', value: 60 },
        { label: '2 horas atrás', value: 120 },
      ],
    });
    const minutes = Number(pick);
    if (!minutes) return;
    const id = current.id || current.channel;
    try {
      const r = await fetch('/api/catchup?id=' + encodeURIComponent(id) + '&minutes=' + minutes);
      const d = await r.json();
      if (r.ok && d && d.url) {
        playUrl(d.url, false);
        if (window.toast) window.toast('catch-up: ' + minutes + ' min atrás');
      } else if (window.toast) {
        window.toast('catch-up indisponível neste canal');
      }
    } catch {
      if (window.toast) window.toast('falha no catch-up');
    }
  });

  function updateDvrBtn() {
    const btn = document.getElementById('btnRecord');
    if (btn) btn.hidden = !current || isAudio(current);
  }
  document.getElementById('btnRecord')?.addEventListener('click', async () => {
    if (!current || isAudio(current) || !window.openDlg) return;
    const id = current.id || current.channel;
    const pick = await window.openDlg({
      title: 'Gravar ' + (current.name || 'canal'),
      help: 'A gravação roda no servidor e fica disponível na sua biblioteca.',
      choices: [
        { label: '30 minutos', value: 30 },
        { label: '1 hora', value: 60 },
        { label: '2 horas', value: 120 },
        { label: '3 horas', value: 180 },
      ],
    });
    const minutes = Number(pick);
    if (!minutes) return;
    try {
      const r = await fetch('/api/dvr', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: id, name: current.name, duration: minutes }),
      });
      const d = await r.json();
      if (r.ok) {
        if (window.toast) window.toast('gravando por ' + minutes + ' min');
      } else if (window.toast) {
        window.toast(d.error || 'não foi possível gravar');
      }
    } catch {
      if (window.toast) window.toast('falha ao gravar');
    }
  });

  /* -------- timeshift (buffer do canal ao vivo no servidor) -------- */

  function updateTsBtn() {
    const btn = document.getElementById('btnTs');
    if (!btn) return;
    const show =
      !!current && !isAudio(current) && (timeshift.active || /^https?:\/\//.test(currentUrl));
    btn.hidden = !show;
    if (show) btn.textContent = timeshift.active ? 'AO VIVO' : '⏪';
  }

  async function stopTimeshift() {
    if (timeshift.id) {
      try {
        await fetch('/api/timeshift/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: timeshift.id }),
        });
      } catch {}
    }
    timeshift.id = null;
    timeshift.playlist = '';
    timeshift.active = false;
  }

  document.getElementById('btnTs')?.addEventListener('click', async () => {
    if (!current || isAudio(current)) return;
    // voltar ao vivo
    if (timeshift.active) {
      await stopTimeshift();
      playUrl(queue[idx].url, false);
      updateTsBtn();
      return;
    }
    const src = queue[idx] && queue[idx].url;
    if (!src || !/^https?:\/\//.test(src)) {
      if (window.toast) window.toast('timeshift indisponível neste canal');
      return;
    }
    status('iniciando timeshift…');
    try {
      const r = await fetch('/api/timeshift', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ u: src }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.playlist) {
        status('');
        if (window.toast) window.toast(d.error || 'timeshift indisponível');
        return;
      }
      // espera o gravador produzir o primeiro trecho do playlist
      for (let i = 0; i < 20; i++) {
        try {
          const p = await fetch(d.playlist, { cache: 'no-store' });
          if (p.ok && p.status === 200) break;
        } catch {}
        await new Promise((res) => setTimeout(res, 800));
      }
      timeshift.id = d.id;
      timeshift.playlist = d.playlist;
      timeshift.active = true;
      playUrl(d.playlist, false);
      updateTsBtn();
      if (window.toast) window.toast('timeshift ativo — rebobine na barra do vídeo');
    } catch {
      status('');
      if (window.toast) window.toast('falha ao iniciar timeshift');
    }
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
    const enable = () => {
      const tt = video.textTracks[video.textTracks.length - 1];
      if (tt) tt.mode = 'showing';
    };
    track.addEventListener('load', enable);
    track.addEventListener('error', () => {
      if (window.toast) window.toast('falha ao carregar as legendas');
    });
    video.appendChild(track);
    setTimeout(enable, 800);
    if (window.toast) window.toast('legendas carregadas');
    rememberSub(u);
  }

  const CACHE_SUBS = 'iptv.subs';

  function getRecentSubs() {
    try {
      const list = JSON.parse(localStorage.getItem(CACHE_SUBS) || '[]');
      return Array.isArray(list) ? list.filter((r) => r && r.url) : [];
    } catch {
      return [];
    }
  }

  function rememberSub(url) {
    try {
      const list = getRecentSubs().filter((r) => r.url !== url);
      list.unshift({ url, at: Date.now() });
      localStorage.setItem(CACHE_SUBS, JSON.stringify(list.slice(0, 5)));
    } catch {}
  }

  function subLabel(url) {
    try {
      const name = decodeURIComponent(
        new URL(url).pathname.split('/').filter(Boolean).pop() || url
      );
      return name.length > 42 ? name.slice(0, 39) + '…' : name;
    } catch {
      return url;
    }
  }

  function askSubUrl() {
    return window.openDlg({
      title: 'Legendas',
      help: 'Cole a URL de um arquivo .srt ou .vtt. O servidor converte para WebVTT.',
      okLabel: 'Carregar',
      placeholder: 'http://.../legenda.srt',
    });
  }

  document.getElementById('btnCC')?.addEventListener('click', async () => {
    if (!current || isAudio(current) || !window.openDlg) return;
    const recents = getRecentSubs();
    let u;
    if (recents.length) {
      const pick = await window.openDlg({
        title: 'Legendas',
        help: 'Escolha uma legenda recente ou adicione uma URL nova.',
        choices: [
          ...recents.map((r) => ({ label: subLabel(r.url), value: r.url })),
          { label: 'Adicionar URL…', value: '__new__' },
        ],
      });
      if (pick === '__new__') u = await askSubUrl();
      else u = pick;
    } else {
      u = await askSubUrl();
    }
    if (u) addSubtitle(u);
  });

  /* -------- transmitir para a TV (AirPlay / Chromecast) -------- */

  let castReady = false;
  function castAvailable() {
    if (video.webkitShowPlaybackTargetPicker) return true;
    // no app Android TV a propria TV e o destino: nao ha o que transmitir
    if (/\bwv\b/.test(navigator.userAgent)) return false;
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

  /* A barra de programacao aparece ao abrir o canal e some sozinha depois de
     alguns segundos (como o OSD da TV). Qualquer tecla/clique a traz de volta. */
  const EPG_HIDE_MS = 8000;

  function dlgOpen() {
    const d = document.getElementById('dlg');
    return !!d && !d.hidden;
  }

  function armEpgHide() {
    clearTimeout(epgHideTimer);
    if (!epgHasContent) return;
    epgHideTimer = setTimeout(() => {
      if (dlgOpen()) return; // nao esconde por baixo de um dialogo
      epgEl.hidden = true;
    }, EPG_HIDE_MS);
  }

  function revealEpgBar() {
    if (!epgHasContent || playerBox.hidden || dlgOpen()) return;
    epgEl.hidden = false;
    armEpgHide();
  }

  document.addEventListener('keydown', revealEpgBar, true);
  playerBox.addEventListener('click', revealEpgBar);
  playerBox.addEventListener('mousemove', revealEpgBar);

  async function showEpg(channel) {
    epgEl.hidden = true;
    epgHasContent = false;
    clearTimeout(epgHideTimer);
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
      const off = Math.max(0, nowIdx - 1);
      epgEl.innerHTML =
        '<div class="now">agora: ' +
        escapeHtml(list[nowIdx].title) +
        ' <button type="button" class="pl-rec" data-rec="' +
        nowIdx +
        '" title="gravar agora">⏺</button></div>' +
        slice
          .map((p, i) => {
            const gi = off + i;
            const past = Date.parse(p.stop) <= now;
            return `<div class="next">${fmt(p.start)} — ${escapeHtml(p.title)}${
              past ? '' : ` <button type="button" class="pl-rec" data-rec="${gi}" title="gravar">⏺</button>`
            }</div>`;
          })
          .join('') +
        (list.length > 4
          ? '<button type="button" class="pl-epoch" id="btnFullEpg">Ver programação completa (' +
            list.length +
            ')</button>'
          : '');
      epgEl.hidden = false;
      epgHasContent = true;
      armEpgHide();

      epgEl.querySelectorAll('[data-rec]').forEach((b) => {
        b.onclick = (ev) => {
          ev.stopPropagation();
          const p = list[Number(b.dataset.rec)];
          if (p) scheduleFromProgram(p);
        };
      });

      epgEl.querySelector('#btnFullEpg')?.addEventListener('click', async () => {
        if (!window.openDlg) return;
        const start = Math.max(0, nowIdx - 2);
        const items = list.slice(start, start + 45);
        const picked = await window.openDlg({
          title: (current ? current.name : '') + ' — programação',
          help: 'Escolha um programa para gravar. Navegue com as setas.',
          choices: items.map((pr, i) => ({
            label:
              fmt(pr.start) + '  ' + pr.title + (start + i === nowIdx ? '   ← agora' : ''),
            value: start + i,
          })),
        });
        if (picked != null) {
          const p = list[picked];
          if (p) {
            const yes = await window.openDlg({
              title: 'Gravar programa?',
              help: p.title + '  (' + fmt(p.start) + '–' + fmt(p.stop) + ')',
              choices: [
                { label: 'Gravar', value: 'y' },
                { label: 'Cancelar', value: 'n' },
              ],
            });
            if (yes === 'y') scheduleFromProgram(p);
          }
        }
        armEpgHide();
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

  // start/stop podem vir como ISO ou epoch; nunca deixa virar NaN (o servidor
  // trataria como "agora" e gravaria o programa atual).
  function epgEpoch(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e11 ? n : n * 1000;
    const d = Date.parse(v);
    return Number.isNaN(d) ? NaN : d;
  }

  async function scheduleFromProgram(p) {
    if (!current) return;
    const id = current.id || current.channel;
    const start = epgEpoch(p.start);
    const end = epgEpoch(p.stop);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      if (window.toast) window.toast('horário do programa inválido');
      return;
    }
    if (!(end > Date.now())) {
      if (window.toast) window.toast('esse programa já terminou');
      return;
    }
    try {
      const post = (force) =>
        fetch('/api/dvr', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ channel: id, name: p.title, start, end, force: !!force }),
        });
      let r = await post(false);
      let d = await r.json().catch(() => ({}));
      // choque de agenda: deixa o usuario decidir (ex.: ja ha gravacoes nesse horario)
      if (!r.ok && d.canForce && window.confirm(d.error + '. Agendar assim mesmo?')) {
        r = await post(true);
        d = await r.json().catch(() => ({}));
      }
      if (window.toast)
        window.toast(r.ok ? 'gravando: ' + p.title : d.error || 'não foi possível agendar');
    } catch {
      if (window.toast) window.toast('falha ao agendar gravação');
    }
  }

  return api;
})();