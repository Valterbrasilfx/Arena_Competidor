/* FightScore Pro - núcleo frontend + sincronização online opcional
   Local: localStorage/BroadcastChannel.
   Online: Supabase Realtime Broadcast (sem servidor próprio e sem banco de dados).
   O canal é público; use o room UUID aleatório e não publique o link do operador.
*/
(() => {
  'use strict';
  const STORAGE_KEY = 'jiujitsuScoreboard';
  const ROOM_KEY = 'fightscoreRoomId';
  const CHANNEL_NAME = 'fightscore-pro-local';
  const localChannel = ('BroadcastChannel' in window) ? new BroadcastChannel(CHANNEL_NAME) : null;
  const params = new URLSearchParams(location.search);
  let roomId = params.get('room') || localStorage.getItem(ROOM_KEY) || '';
  if (!roomId) roomId = makeId();
  localStorage.setItem(ROOM_KEY, roomId);

  let cloudClient = null;
  let cloudChannel = null;
  let cloudRole = 'viewer';
  let cloudStatus = 'disabled';
  let heartbeatId = null;
  let statusCallback = null;
  let lastCloudTimestamp = 0;

  function makeId() {
    return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() :
      'room-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 14);
  }

  function config() { return window.FIGHTSCORE_CONFIG || {}; }
  function isCloudConfigured() {
    const c = config();
    return !!(c.SUPABASE_URL && c.SUPABASE_ANON_KEY &&
      !String(c.SUPABASE_URL).includes('COLE_AQUI') &&
      !String(c.SUPABASE_ANON_KEY).includes('COLE_AQUI'));
  }
  function setCloudStatus(status, error) {
    cloudStatus = status;
    if (typeof statusCallback === 'function') statusCallback(status, error || null);
    window.dispatchEvent(new CustomEvent('fightscore:connection', { detail: { status, error: error || null } }));
  }

  function defaultState() {
    return {
      version: 3,
      fightId: makeId(),
      atleta1: { nome: 'ATLETA AZUL', equipe: '', inscricao: '', foto: '', pontos: 0, vantagens: 0, punicoes: 0 },
      atleta2: { nome: 'ATLETA BRANCO', equipe: '', inscricao: '', foto: '', pontos: 0, vantagens: 0, punicoes: 0 },
      categoria: '',
      tempoTotalSegundos: 300,
      tempoRestanteSegundos: 300,
      cronometroRodando: false,
      cronometroTerminaEm: null,
      lutaFinalizada: false,
      ultimoVencedor: null,
      nomeVencedor: null,
      equipeVencedor: null,
      comoTerminou: null,
      timestampAtualizacao: Date.now()
    };
  }

  function normalizeState(input) {
    const base = defaultState();
    if (!input || typeof input !== 'object') return base;
    const s = { ...base, ...input };
    s.atleta1 = { ...base.atleta1, ...(input.atleta1 || {}) };
    s.atleta2 = { ...base.atleta2, ...(input.atleta2 || {}) };
    ['pontos', 'vantagens', 'punicoes'].forEach(k => {
      s.atleta1[k] = Math.max(0, Number(s.atleta1[k]) || 0);
      s.atleta2[k] = Math.max(0, Number(s.atleta2[k]) || 0);
    });
    s.tempoTotalSegundos = Math.max(1, Number(s.tempoTotalSegundos) || 300);
    s.tempoRestanteSegundos = Math.max(0, Number(s.tempoRestanteSegundos) || 0);
    return s;
  }

  function read() {
    try { return normalizeState(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
    catch (err) { console.error('FightScore: não foi possível ler os dados.', err); return defaultState(); }
  }

  function emitLocal(state) {
    if (localChannel) localChannel.postMessage({ type: 'STATE', state });
    window.dispatchEvent(new CustomEvent('fightscore:state', { detail: state }));
  }

  function sendCloudState(state) {
    if (!cloudChannel || cloudStatus !== 'SUBSCRIBED' || cloudRole !== 'operator') return;
    cloudChannel.send({ type: 'broadcast', event: 'state', payload: { state, sentAt: Date.now() } })
      .catch(err => console.warn('FightScore: falha ao enviar estado online.', err));
  }

  function publish(state) {
    const clean = normalizeState(state);
    clean.timestampAtualizacao = Date.now();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(clean)); }
    catch (err) { console.error('FightScore: falha ao salvar dados.', err); }
    emitLocal(clean);
    sendCloudState(clean);
    return clean;
  }

  function applyRemoteState(input) {
    if (!input || typeof input !== 'object') return;
    const incoming = normalizeState(input);
    const stamp = Number(incoming.timestampAtualizacao) || Date.now();
    if (stamp < lastCloudTimestamp) return;
    lastCloudTimestamp = stamp;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(incoming)); }
    catch (err) { console.warn('FightScore: não foi possível guardar cópia local.', err); }
    emitLocal(incoming);
  }

  function subscribe(callback) {
    let lastSnapshot = null;
    const emitIfChanged = state => {
      const normalized = normalizeState(state);
      const comparable = { ...normalized };
      const snapshot = JSON.stringify(comparable);
      if (snapshot === lastSnapshot) return;
      lastSnapshot = snapshot;
      callback(normalized);
    };
    const handler = event => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try { emitIfChanged(JSON.parse(event.newValue)); } catch (_) {}
      }
    };
    const channelHandler = event => {
      if (event.data && event.data.type === 'STATE') emitIfChanged(event.data.state);
    };
    const localHandler = event => emitIfChanged(event.detail);
    window.addEventListener('storage', handler);
    window.addEventListener('fightscore:state', localHandler);
    if (localChannel) localChannel.addEventListener('message', channelHandler);
    emitIfChanged(read());
    const pollId = window.setInterval(() => {
      try { emitIfChanged(read()); } catch (err) { console.error('FightScore: erro ao sincronizar.', err); }
    }, 250);
    return () => {
      window.clearInterval(pollId);
      window.removeEventListener('storage', handler);
      window.removeEventListener('fightscore:state', localHandler);
      if (localChannel) localChannel.removeEventListener('message', channelHandler);
    };
  }

  function initRealtime(role = 'viewer', onStatus) {
    cloudRole = role;
    statusCallback = onStatus || statusCallback;
    if (!isCloudConfigured()) {
      setCloudStatus('NOT_CONFIGURED');
      return false;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      setCloudStatus('SDK_ERROR');
      return false;
    }
    if (cloudChannel) return true;
    const c = config();
    try {
      cloudClient = window.supabase.createClient(c.SUPABASE_URL, c.SUPABASE_ANON_KEY, {
        realtime: { params: { eventsPerSecond: 20 } }
      });
      const topic = `fightscore:${roomId}`;
      cloudChannel = cloudClient.channel(topic, {
        config: { private: false, broadcast: { self: false } }
      });
      cloudChannel
        .on('broadcast', { event: 'state' }, message => {
          const state = message && message.payload && message.payload.state;
          if (state) applyRemoteState(state);
        })
        .on('broadcast', { event: 'request-state' }, () => {
          if (cloudRole === 'operator') sendCloudState(read());
        })
        .subscribe(status => {
          setCloudStatus(status);
          if (status === 'SUBSCRIBED') {
            if (cloudRole === 'operator') {
              sendCloudState(read());
              if (heartbeatId) clearInterval(heartbeatId);
              // Heartbeat também entrega o estado a um OBS que acabou de conectar.
              heartbeatId = window.setInterval(() => sendCloudState(read()), 1000);
            } else {
              cloudChannel.send({ type: 'broadcast', event: 'request-state', payload: { requestedAt: Date.now() } });
            }
          }
        });
      return true;
    } catch (err) {
      console.error('FightScore: erro ao iniciar conexão online.', err);
      setCloudStatus('CHANNEL_ERROR', err);
      return false;
    }
  }

  function remaining(state, now = Date.now()) {
    if (!state.cronometroRodando || !state.cronometroTerminaEm) return Math.max(0, state.tempoRestanteSegundos);
    return Math.max(0, Math.ceil((state.cronometroTerminaEm - now) / 1000));
  }
  function update(mutator) {
    const state = read();
    state.tempoRestanteSegundos = remaining(state);
    if (state.cronometroRodando && state.tempoRestanteSegundos <= 0) {
      state.cronometroRodando = false;
      state.cronometroTerminaEm = null;
      state.lutaFinalizada = true;
    }
    mutator(state);
    return publish(state);
  }
  function formatTime(seconds) {
    const n = Math.max(0, Number(seconds) || 0);
    return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }
  function start() {
    return update(s => {
      if (s.lutaFinalizada || s.tempoRestanteSegundos <= 0) return;
      s.cronometroRodando = true;
      s.cronometroTerminaEm = Date.now() + s.tempoRestanteSegundos * 1000;
    });
  }
  function pause() { return update(s => { s.cronometroRodando = false; s.cronometroTerminaEm = null; }); }
  function setTime(seconds) {
    return update(s => {
      if (s.lutaFinalizada) return;
      s.tempoRestanteSegundos = Math.max(0, s.tempoRestanteSegundos + Number(seconds || 0));
      if (s.cronometroRodando) s.cronometroTerminaEm = Date.now() + s.tempoRestanteSegundos * 1000;
      if (s.tempoRestanteSegundos === 0) { s.cronometroRodando = false; s.cronometroTerminaEm = null; s.lutaFinalizada = true; }
    });
  }
  function resetFight() {
    const old = read();
    const fresh = defaultState();
    fresh.atleta1 = { ...fresh.atleta1, nome: old.atleta1.nome, equipe: old.atleta1.equipe, inscricao: old.atleta1.inscricao, foto: old.atleta1.foto };
    fresh.atleta2 = { ...fresh.atleta2, nome: old.atleta2.nome, equipe: old.atleta2.equipe, inscricao: old.atleta2.inscricao, foto: old.atleta2.foto };
    fresh.categoria = old.categoria;
    fresh.tempoTotalSegundos = old.tempoTotalSegundos;
    fresh.tempoRestanteSegundos = old.tempoTotalSegundos;
    return publish(fresh);
  }

  function getRoomUrl(page) {
    const url = new URL(page, location.href);
    url.searchParams.set('room', roomId);
    return url.href;
  }

  window.FightScore = {
    STORAGE_KEY, ROOM_KEY, roomId, defaultState, read, publish, subscribe, update,
    remaining, formatTime, start, pause, setTime, resetFight, initRealtime,
    getCloudStatus: () => cloudStatus,
    getRoomUrl
  };
})();
