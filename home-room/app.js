/* Home Room — client core.
 *
 * One conversation with Lash: voice streamed over LiveKit, the approved
 * animated loops rendered locally, and every control/playback signal
 * riding the say/show/state data-channel contract from the build plan:
 *
 *   envelope: { v:1, type, room_id, turn_id, seq, t_send }
 *   intent.say        { clause_idx, text, word_marks? }       agent -> client
 *   playback.started  { clause_idx, play_pos_ms }             agent -> client
 *   playback.stopped  { played_ms, spoken_until_word, reason } agent -> client
 *   stage.state       { state: listening|thinking|speaking, focus }
 *   turn.endpoint     { participant_id, final, text }         either way
 *   session.control   { cmd: leave|mute_agent, by }           either way
 *   user.text         { text }  client-originated typed text (extension,
 *                               documented in README.md)
 *
 * The SAME handlePacket() entry point serves the live LiveKit data
 * callback and the built-in simulation driver (sim.js, ?sim=1), so what
 * is verified locally without a server is the real code path.
 */

'use strict';

/* ============================== config ============================== */

const qs = new URLSearchParams(location.search);
const SIM = qs.has('sim');

const cfg = {
  room: qs.get('room') || 'home-room',
  url: qs.get('url') || localStorage.getItem('hr-url') || '',
  ts: qs.get('ts') || localStorage.getItem('hr-ts') || '',
  token: qs.get('token') || '',
  identity: 'howard',
  agentIdentity: 'agent:lash',
};
let seqOut = 0;

const $ = (id) => document.getElementById(id);
const els = {
  medallion: $('medallion'), pill: $('presencePill'), status: $('statusLine'),
  connDot: $('connDot'), connText: $('connText'),
  threadWrap: $('threadWrap'), thread: $('thread'), threadEmpty: $('threadEmpty'),
  talk: $('talkBtn'), mute: $('muteBtn'), type: $('typeBtn'), end: $('endBtn'),
  composer: $('composer'), typeInput: $('typeInput'), send: $('sendBtn'),
  levelFill: $('levelFill'), levelState: $('levelState'),
  sheet: $('sheet'), inUrl: $('inUrl'), inTs: $('inTs'), inToken: $('inToken'),
  sheetErr: $('sheetErr'), sheetGo: $('sheetGo'), sheetCancel: $('sheetCancel'),
  remoteAudio: $('remoteAudio'),
};

/* ==================== face machine (stage v9.2 port) ====================
 * The visible loop is RESOLVED from real signals at every event, never
 * advanced by timers: talk (exactly while a line is playing) > thinking
 * > greeting > idle/listening. Entry in-points (FACE_SPAN), a 200 ms
 * crossfade, and a 1.6 s minimum hold keep switching from reading as
 * random — the mechanics Howard approved on the stage, unchanged.
 * Clips: idle=lash-face (listening portrait), talk=lash-talk,
 * work=lash-work (thinking), make=lash-make (greeting). */

const FACE_SPAN = {
  idle: { i: 2.5, o: 7.5 },
  talk: { i: 2.0, o: 7.9 },
  work: { i: 0.5, o: 7.9 },
  make: { i: 0.0, o: 7.9 },
};
const FACE_VIDS = { idle: 'faceIdle', talk: 'faceTalk', work: 'faceWork', make: 'faceMake' };
const FACE_FADE_MS = 200;
const FACE_MIN_HOLD_MS = 1600;
const GREET_MS = 6000;

let playing = false;          // a speech line is playing right now
let faceThinking = false;     // the brain is composing (stage.state)
let stageState = null;        // last stage.state value
let greetingUntil = 0;
let agentPresent = false;
let selfSpeaking = false;     // local mic activity above threshold

let faceVisible = null;
let faceShownAt = 0;
let faceHoldTimer = null;

function faceResolve() {
  if (playing) return 'talk';
  if (faceThinking) return 'work';
  if (Date.now() < greetingUntil) return 'make';
  return 'idle';
}
function faceRefresh() { faceShow(faceResolve()); }

function faceShow(name) {
  if (!agentPresent) { // away: dimmed poster, all clips parked
    for (const id of Object.values(FACE_VIDS)) {
      const el = $(id);
      el.style.opacity = '0';
      try { el.pause(); } catch (e) {}
    }
    faceVisible = null;
    return;
  }
  if (!FACE_VIDS[name]) name = 'idle';
  if (name === faceVisible) {
    if (faceHoldTimer) { clearTimeout(faceHoldTimer); faceHoldTimer = null; }
    return;
  }
  const now = performance.now();
  const cur = faceVisible;
  // Talking enters/leaves with playback exactly; thinking takes the
  // face from idle/greeting without waiting out a hold.
  const preempt = !cur || name === 'talk' || cur === 'talk' || name === 'work';
  if (!preempt && now - faceShownAt < FACE_MIN_HOLD_MS) {
    if (!faceHoldTimer) {
      faceHoldTimer = setTimeout(() => {
        faceHoldTimer = null;
        faceRefresh();
      }, FACE_MIN_HOLD_MS - (now - faceShownAt) + 20);
    }
    return;
  }
  if (faceHoldTimer) { clearTimeout(faceHoldTimer); faceHoldTimer = null; }
  const inEl = $(FACE_VIDS[name]);
  if (!inEl) return;
  const outEl = cur ? $(FACE_VIDS[cur]) : null;
  faceVisible = name;
  faceShownAt = now;
  if (inEl._fadeT) { clearTimeout(inEl._fadeT); inEl._fadeT = null; }
  try { inEl.currentTime = FACE_SPAN[name].i; } catch (e) {}
  inEl.style.display = 'block';
  inEl.dataset.shown = '1';
  void inEl.offsetWidth; // reflow so the fade runs from opacity 0
  inEl.style.opacity = '1';
  const p = inEl.play(); if (p && p.catch) p.catch(() => {});
  if (outEl && outEl !== inEl) {
    delete outEl.dataset.shown;
    outEl.style.opacity = '0';
    if (outEl._fadeT) clearTimeout(outEl._fadeT);
    outEl._fadeT = setTimeout(() => {
      if (outEl.dataset.shown !== '1') {
        outEl.style.display = 'none';
        try { outEl.pause(); } catch (e) {}
      }
    }, FACE_FADE_MS + 60);
  }
}

// Window every clip to its FACE_SPAN while it is the visible one.
for (const [k, id] of Object.entries(FACE_VIDS)) {
  const el = $(id);
  el.addEventListener('timeupdate', () => {
    if (faceVisible !== k) return;
    const sp = FACE_SPAN[k];
    if (el.currentTime >= sp.o || el.currentTime < sp.i - 0.05) {
      try { el.currentTime = sp.i; } catch (e) {}
    }
  });
}

/* ============================ presence ============================ */

function presenceNow() {
  if (!agentPresent) return 'away';
  if (playing) return 'speaking';
  if (faceThinking) return 'thinking';
  if (selfSpeaking || stageState === 'listening') return 'listening';
  return 'available';
}
const PRESENCE_LABEL = {
  away: 'Away', available: 'Available', listening: 'Listening',
  thinking: 'Thinking', speaking: 'Speaking',
};
const STATUS_TEXT = {
  away: 'Lash is not in the room.',
  available: 'Lash is here. Say something, or type instead.',
  listening: 'Lash is listening…',
  thinking: 'Lash is thinking…',
  speaking: 'Lash is speaking…',
};
function refreshPresence() {
  const p = presenceNow();
  els.pill.dataset.p = p;
  els.pill.textContent = PRESENCE_LABEL[p];
  els.status.textContent = connected || SIM ? STATUS_TEXT[p]
    : 'Not connected yet — tap Talk when you\'re ready.';
  els.medallion.classList.toggle('away', p === 'away');
  faceRefresh();
}

/* ============================= thread =============================
 * One thread for voice and text. Model entries are persisted to
 * localStorage so the conversation survives reloads; a session's End
 * folds a divider into the same thread. */

const THREAD_KEY = 'hr-thread-' + cfg.room;
let threadModel = [];
try { threadModel = JSON.parse(localStorage.getItem(THREAD_KEY) || '[]'); } catch (e) { threadModel = []; }
const turns = new Map(); // turn_id -> { entry, clauses: Map(clause_idx -> clause) }

function saveThread() {
  try { localStorage.setItem(THREAD_KEY, JSON.stringify(threadModel.slice(-300))); } catch (e) {}
}
function stickScroll() {
  const w = els.threadWrap;
  const nearBottom = w.scrollHeight - w.scrollTop - w.clientHeight < 140;
  requestAnimationFrame(() => { if (nearBottom) w.scrollTop = w.scrollHeight; });
}
function timeLabel(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function renderEntry(entry) {
  let node;
  if (entry.kind === 'sys') {
    node = document.createElement('div');
    node.className = 'sys' + (entry.divider ? ' divider' : '');
    node.textContent = entry.text;
  } else {
    node = document.createElement('div');
    node.className = 'msg ' + (entry.who === 'me' ? 'me' : 'lash');
    node.dataset.entryId = entry.id;
    const body = document.createElement('span');
    body.className = 'body';
    node.appendChild(body);
    const chips = document.createElement('div');
    chips.className = 'chips';
    node.appendChild(chips);
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = (entry.who === 'me' ? 'You' : 'Lash') + ' · ' + timeLabel(entry.ts);
    node.appendChild(meta);
    paintBubble(entry, node);
  }
  els.thread.appendChild(node);
  entry._node = node;
  return node;
}
function paintBubble(entry, node) {
  const body = node.querySelector('.body');
  const chips = node.querySelector('.chips');
  body.textContent = '';
  chips.textContent = '';
  if (entry.clauses && entry.clauses.length) {
    entry.clauses.forEach((c, i) => {
      if (i) body.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      if (c.unheardFrom != null) {
        const words = c.text.split(/\s+/);
        span.appendChild(document.createTextNode(words.slice(0, c.unheardFrom).join(' ')));
        if (c.unheardFrom > 0 && c.unheardFrom < words.length) span.appendChild(document.createTextNode(' '));
        const un = document.createElement('span');
        un.className = 'clause-unheard';
        un.textContent = words.slice(c.unheardFrom).join(' ');
        span.appendChild(un);
      } else {
        span.textContent = c.text;
      }
      body.appendChild(span);
    });
    for (const c of entry.clauses) {
      if (c.cutNote) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = c.cutNote;
        chips.appendChild(chip);
      }
    }
  } else {
    body.textContent = entry.text || '';
  }
}
function addEntry(entry) {
  entry.id = entry.id || 'e' + Math.random().toString(36).slice(2, 9);
  threadModel.push(entry);
  renderEntry(entry);
  els.threadEmpty.style.display = 'none';
  saveThread();
  stickScroll();
  return entry;
}
function addSys(text, divider) { return addEntry({ kind: 'sys', text, divider: !!divider, ts: Date.now() }); }
function bubbleFor(turnId, who) {
  if (turnId && turns.has(turnId)) return turns.get(turnId).entry;
  const entry = addEntry({ kind: 'msg', who, ts: Date.now(), clauses: [], text: '' });
  if (turnId) turns.set(turnId, { entry, clauses: new Map() });
  return entry;
}
// Render persisted thread.
for (const e of threadModel) renderEntry(e);
if (threadModel.length) els.threadEmpty.style.display = 'none';

/* ====================== data-channel contract ====================== */

function wordCount(text) { return (text || '').trim().split(/\s+/).filter(Boolean).length; }

function handlePacket(pkt, fromIdentity) {
  if (!pkt || typeof pkt !== 'object' || !pkt.type) return;
  switch (pkt.type) {
    case 'stage.state': {
      stageState = pkt.state || null;
      faceThinking = pkt.state === 'thinking';
      if (pkt.state === 'speaking') faceThinking = false;
      refreshPresence();
      break;
    }
    case 'intent.say': {
      const entry = bubbleFor(pkt.turn_id, 'lash');
      const t = turns.get(pkt.turn_id);
      const idx = pkt.clause_idx != null ? pkt.clause_idx : entry.clauses.length;
      if (t && !t.clauses.has(idx)) {
        const clause = { idx, text: pkt.text || '', unheardFrom: null, cutNote: null };
        t.clauses.set(idx, clause);
        entry.clauses = [...t.clauses.values()].sort((a, b) => a.idx - b.idx);
        paintBubble(entry, entry._node);
        saveThread(); stickScroll();
      }
      break;
    }
    case 'playback.started': {
      playing = true;
      faceThinking = false;
      refreshPresence();
      break;
    }
    case 'playback.stopped': {
      playing = false;
      const t = pkt.turn_id ? turns.get(pkt.turn_id) : null;
      if (t) {
        const idx = pkt.clause_idx != null ? pkt.clause_idx : Math.max(...t.clauses.keys());
        const clause = t.clauses.get(idx);
        if (clause) {
          const total = wordCount(clause.text);
          const heard = pkt.spoken_until_word;
          if (heard != null && total && heard < total) {
            clause.unheardFrom = heard;
            clause.cutNote = (pkt.reason === 'barge_in' ? 'Interrupted' : 'Cut off')
              + ' — heard ' + heard + ' of ' + total + ' words'
              + (pkt.played_ms != null ? ' · ' + (pkt.played_ms / 1000).toFixed(1) + 's played' : '');
          } else if (pkt.played_ms != null) {
            clause.cutNote = null;
          }
          paintBubble(t.entry, t.entry._node);
          saveThread(); stickScroll();
        }
      }
      refreshPresence();
      break;
    }
    case 'turn.endpoint': {
      if (pkt.final && pkt.text) {
        if (pkt.participant_id && pkt.participant_id !== cfg.agentIdentity) {
          if (!turns.has('u:' + pkt.turn_id)) {
            turns.set('u:' + pkt.turn_id, { entry: null, clauses: new Map() });
            addEntry({ kind: 'msg', who: 'me', ts: Date.now(), text: pkt.text, clauses: null });
          }
        }
      }
      break;
    }
    case 'user.text': {
      const from = fromIdentity || pkt.from;
      if (from && from !== cfg.identity) {
        addEntry({ kind: 'msg', who: from === cfg.agentIdentity ? 'lash' : 'me', ts: Date.now(), text: pkt.text || '', clauses: null });
      }
      break;
    }
    case 'session.control': {
      if (pkt.cmd === 'leave' && (fromIdentity === cfg.agentIdentity || pkt.by === cfg.agentIdentity)) {
        agentPresent = false;
        playing = false; faceThinking = false;
        addSys('Lash left the room.');
        refreshPresence();
      } else if (pkt.cmd === 'mute_agent') {
        addSys('Lash was muted' + (pkt.by ? ' by ' + pkt.by : '') + '.');
      }
      break;
    }
    default:
      break; // unknown contract packets are ignored, never fatal
  }
}

/* ============================ LiveKit ============================ */

let LK = null;
let room = null;
let connected = false;
let muted = false;
let levelCtx = null, levelRAF = null;

async function loadLK() {
  if (LK) return LK;
  try { LK = await import('./vendor/livekit-client.esm.mjs'); }
  catch (e) { LK = await import('https://cdn.jsdelivr.net/npm/livekit-client@2.15.0/dist/livekit-client.esm.mjs'); }
  return LK;
}

function setConn(state, text) {
  els.connDot.className = state === 'on' ? 'on' : state === 'err' ? 'err' : '';
  els.connDot.id = 'connDot';
  els.connText.textContent = text;
}

async function publishPacket(pkt) {
  pkt.v = 1; pkt.room_id = cfg.room; pkt.seq = ++seqOut; pkt.t_send = Date.now();
  if (SIM || !room || !connected) { document.dispatchEvent(new CustomEvent('hr-outbound', { detail: pkt })); return; }
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(pkt));
    await room.localParticipant.publishData(bytes, { reliable: true });
  } catch (e) { /* data lane is best-effort; voice path is authoritative */ }
}

async function fetchToken() {
  if (cfg.token) return cfg.token;
  if (!cfg.ts) throw new Error('No token service set — open Connect and add one, or paste a token.');
  const res = await fetch(cfg.ts.replace(/\/$/, '') + '/token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identity: cfg.identity, room: cfg.room }),
  });
  if (!res.ok) throw new Error('Token service answered ' + res.status);
  const j = await res.json();
  if (j.url && !cfg.url) cfg.url = j.url;
  return j.token;
}

async function connect() {
  if (!cfg.url) throw new Error('No LiveKit server URL set — open Connect first.');
  const token = await fetchToken();
  await loadLK();
  room = new LK.Room({ adaptiveStream: false, dynacast: false });
  room.on('dataReceived', (payload, participant) => {
    try { handlePacket(JSON.parse(new TextDecoder().decode(payload)), participant && participant.identity); }
    catch (e) {}
  });
  room.on('transcriptionReceived', (segments, participant) => {
    for (const s of segments || []) {
      if (s.final) handlePacket({ type: 'turn.endpoint', turn_id: s.id, participant_id: participant && participant.identity, final: true, text: s.text }, participant && participant.identity);
    }
  });
  room.on('participantConnected', (p) => {
    if (p.identity === cfg.agentIdentity) { agentJoined(); }
  });
  room.on('participantDisconnected', (p) => {
    if (p.identity === cfg.agentIdentity) {
      agentPresent = false; playing = false; faceThinking = false;
      addSys('Lash left the room.');
      refreshPresence();
    }
  });
  room.on('trackSubscribed', (track, pub, participant) => {
    if (track.kind === 'audio' && participant.identity === cfg.agentIdentity) track.attach(els.remoteAudio);
  });
  room.on('disconnected', () => { teardown('Disconnected from the server.'); });
  await room.connect(cfg.url, token);
  connected = true;
  setConn('on', 'connected to ' + cfg.url);
  if (room.remoteParticipants && [...room.remoteParticipants.values()].some((p) => p.identity === cfg.agentIdentity)) agentJoined();
  try { await room.startAudio(); } catch (e) {}
  await room.localParticipant.setMicrophoneEnabled(true);
  startLevelMeter();
  els.mute.disabled = false; els.end.disabled = false;
  els.talk.classList.add('live');
  els.talk.innerHTML = 'Live<small>tap to hang back</small>';
  refreshPresence();
}

function agentJoined() {
  if (!agentPresent) {
    agentPresent = true;
    greetingUntil = Date.now() + GREET_MS;
    addSys('Lash is in the room.');
  }
  refreshPresence();
}

function teardown(note) {
  connected = false;
  playing = false; faceThinking = false; selfSpeaking = false;
  stopLevelMeter();
  setLevel(0, 'off');
  if (room) { try { room.disconnect(); } catch (e) {} room = null; }
  els.mute.disabled = true; els.end.disabled = true;
  els.talk.classList.remove('live');
  els.talk.innerHTML = 'Talk<small>join the room</small>';
  setConn('', 'no server connection');
  if (note) setConn('err', note);
  agentPresent = false;
  refreshPresence();
}

async function endSession() {
  await publishPacket({ type: 'session.control', cmd: 'leave', by: cfg.identity });
  addSys('Session ended — the thread keeps everything.', true);
  teardown();
}

/* ========================== mic level meter ========================== */

function setLevel(v, label) {
  els.levelFill.style.width = Math.round(Math.min(1, Math.max(0, v)) * 100) + '%';
  if (label) els.levelState.textContent = label;
  const speaking = v > 0.12 && !muted;
  if (speaking !== selfSpeaking) { selfSpeaking = speaking; refreshPresence(); }
}
function startLevelMeter() {
  stopLevelMeter();
  try {
    const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
    const track = pub && pub.track;
    if (!track || !track.mediaStreamTrack) return;
    const stream = new MediaStream([track.mediaStreamTrack]);
    levelCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = levelCtx.createMediaStreamSource(stream);
    const an = levelCtx.createAnalyser();
    an.fftSize = 256;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const b of buf) peak = Math.max(peak, Math.abs(b - 128) / 128);
      setLevel(muted ? 0 : peak, muted ? 'muted' : 'live');
      levelRAF = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) { setLevel(0, 'n/a'); }
}
function stopLevelMeter() {
  if (levelRAF) cancelAnimationFrame(levelRAF);
  levelRAF = null;
  if (levelCtx) { try { levelCtx.close(); } catch (e) {} levelCtx = null; }
}

/* ============================= controls ============================= */

els.talk.addEventListener('click', async () => {
  if (SIM) { document.dispatchEvent(new CustomEvent('hr-sim-talk')); return; }
  if (connected) { teardown(); return; }
  if (!cfg.url || (!cfg.ts && !cfg.token)) { openSheet(); return; }
  els.talk.disabled = true;
  setConn('', 'connecting…');
  try { await connect(); }
  catch (e) { setConn('err', 'connect failed'); els.status.textContent = String(e.message || e); }
  els.talk.disabled = false;
});

els.mute.addEventListener('click', async () => {
  muted = !muted;
  els.mute.classList.toggle('on', muted);
  els.mute.innerHTML = muted ? 'Muted<small>tap to unmute</small>' : 'Mute<small>mic on</small>';
  if (muted) setLevel(0, 'muted'); else if (connected) setLevel(0, 'live');
  if (room && connected) {
    try { await room.localParticipant.setMicrophoneEnabled(!muted); } catch (e) {}
  }
});

els.type.addEventListener('click', () => {
  const open = els.composer.classList.toggle('open');
  els.type.classList.toggle('on', open);
  if (open) els.typeInput.focus();
});

async function sendTyped() {
  const text = els.typeInput.value.trim();
  if (!text) return;
  els.typeInput.value = '';
  addEntry({ kind: 'msg', who: 'me', ts: Date.now(), text, clauses: null });
  await publishPacket({ type: 'user.text', text });
  // The brain hears typed text exactly like an utterance final.
  await publishPacket({ type: 'turn.endpoint', participant_id: cfg.identity, final: true, text });
}
els.send.addEventListener('click', sendTyped);
els.typeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTyped(); }
});

els.end.addEventListener('click', () => { if (connected || SIM) endSession(); });

/* ========================== connect sheet ========================== */

function openSheet(errText) {
  els.inUrl.value = cfg.url; els.inTs.value = cfg.ts; els.inToken.value = cfg.token;
  els.sheetErr.textContent = errText || '';
  els.sheet.classList.add('open');
}
function closeSheet() { els.sheet.classList.remove('open'); }
els.sheetCancel.addEventListener('click', closeSheet);
els.sheetGo.addEventListener('click', async () => {
  cfg.url = els.inUrl.value.trim();
  cfg.ts = els.inTs.value.trim();
  cfg.token = els.inToken.value.trim();
  localStorage.setItem('hr-url', cfg.url);
  localStorage.setItem('hr-ts', cfg.ts);
  if (!cfg.url) { els.sheetErr.textContent = 'A LiveKit server URL is required.'; return; }
  if (!cfg.ts && !cfg.token) { els.sheetErr.textContent = 'Add a token service URL or paste a token.'; return; }
  closeSheet();
  els.talk.click();
});
// Long-press the connection row to reopen the sheet.
$('connRow').addEventListener('click', () => { if (!connected) openSheet(); });

/* ============================== boot ============================== */

if (SIM) {
  setConn('on', 'simulation mode — no server');
  els.mute.disabled = false; els.end.disabled = false;
  els.talk.classList.add('live');
  els.talk.innerHTML = 'Sim live<small>demo driver below</small>';
}
refreshPresence();

/* Handle for the sim driver and for verification tooling. */
window.HomeRoom = {
  handlePacket, publishPacket, setLevel, agentJoined,
  state: () => ({
    presence: presenceNow(), faceVisible, playing, thinking: faceThinking,
    agentPresent, connected, threadEntries: threadModel.length,
  }),
  cfg,
};
