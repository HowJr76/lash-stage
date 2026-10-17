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
  remoteAudio: $('remoteAudio'), kitStat: $('kitStat'),
  testBtn: $('testBtn'), testCard: $('testCard'),
  testStepNum: $('testStepNum'), testStepName: $('testStepName'),
  testInstr: $('testInstr'), testLines: $('testLines'),
  testNext: $('testNext'), testSkip: $('testSkip'), testEnd: $('testEnd'),
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
  if (kit.active && (pkt.type === 'stage.state' || pkt.type === 'playback.started' ||
      pkt.type === 'playback.stopped' || pkt.type === 'intent.say')) {
    kitEv('pkt', { pkt_type: pkt.type, state: pkt.state || undefined,
                   turn_id: pkt.turn_id, clause_idx: pkt.clause_idx,
                   reason: pkt.reason });
  }
  switch (pkt.type) {
    case 'clock.pong': kitOnPong(pkt); break;
    case 'rec.ack': kitOnAck(pkt); break;
    case 'rec.stored': kitOnStored(pkt); break;
    case 'timing.stored': kitOnTimingStored(pkt); break;
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
    if (track.kind === 'audio' && participant.identity === cfg.agentIdentity) {
      track.attach(els.remoteAudio);
      kitRemoteTrack(track);
    }
  });
  room.on('disconnected', () => { teardown('Disconnected from the server.'); });
  await room.connect(cfg.url, token);
  connected = true;
  setConn('on', 'connected to ' + cfg.url);
  if (room.remoteParticipants && [...room.remoteParticipants.values()].some((p) => p.identity === cfg.agentIdentity)) agentJoined();
  try { await room.startAudio(); } catch (e) {}
  await room.localParticipant.setMicrophoneEnabled(true);
  startLevelMeter();
  kitStart().catch(() => {});
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
  testFinish('hangup');
  kitStop().catch(() => {});
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
  // Ground-truth kit first, while the data channel is still up:
  // stop the recording, ship the final slices + timing bundle,
  // and give the worker a bounded window to confirm storage.
  await kitFinish().catch(() => {});
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

/* ========================= guided test mode =========================
 * TEST-PROTOCOL.md v1.1 (Howard, 2026-10-16): the same 8 maneuvers
 * every session, so sessions are comparable and the session report
 * can segment by maneuver. This SUPERSEDES the protocol's spoken
 * "Test N" headers as the segmentation mechanism (the header is
 * still shown on the card and still said — it now also exists as
 * data): each step activation logs a `test_step` event into the
 * kit timing bundle AND sends it live on the data channel, and
 * plays a short beep through the speaker as an acoustic begin
 * marker — his mic hears it, so the beep is present in the
 * as-heard recording and in the server-side audio, anchoring the
 * step boundary on every clock at once.
 * Manual advance only (Next / Skip / End Test) — no
 * transcript-matching auto-advance in this version. */

const TEST_NUM_WORDS = ['one', 'two', 'three', 'four',
                        'five', 'six', 'seven', 'eight'];
const TEST_STEPS = [
  { name: 'Cold open',
    instr: 'Wait for the room to settle. Say the header, let my reply finish, then say:',
    lines: ['Testing — can you hear me?'] },
  { name: 'Short exchanges',
    instr: 'Say the header first. Then ask each line, one at a time, waiting for each answer to finish:',
    lines: ['What time is it in Chicago right now?',
            "One word only: what's the capital of Norway?",
            'Count from one to five, slowly.'] },
  { name: 'The long-answer cut',
    instr: 'Say the header first. Then ask the question, and let two clauses of my answer play before cutting in:',
    lines: ['Explain how a bill becomes law — take your time.'],
    cut: { trigger: 'Let two clauses play, then say:',
           line: "Stop — new question: what's the weather doing tomorrow?" } },
  { name: 'The deep cut',
    instr: 'Say the header first. Then ask the question, and cut in almost immediately:',
    lines: ['Tell me the story of how this room got built — start at the beginning.'],
    cut: { trigger: 'After two or three words, say:',
           line: 'Hold on — what time is it?' } },
  { name: 'Rapid-fire',
    instr: 'Say the header first. Then ask all three with minimal gaps — don\'t wait for full answers:',
    lines: ["What's two plus two?", 'And times three?', 'And minus five?'] },
  { name: 'The pause',
    instr: 'Say the header first. Ask the question; after my answer, stay silent a full 10 seconds, then say the last line:',
    lines: ['Tell me something interesting about Philadelphia.', 'Still there?'] },
  { name: 'Typed turn', typed: true,
    instr: 'Say the header first. Then use Type Instead for this one — type it, don\'t say it:',
    lines: ['Typed test — reply with one sentence.'] },
  { name: 'Sign-off',
    instr: 'Say the header, then the line — then tap End to hang up:',
    lines: ["That's the test, thank you."] },
];
const testMode = { active: false, step: -1 };
let beepCtx = null;

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
          .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function testBeep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (kit.ctx && kit.ctx.state === 'running') ? kit.ctx
      : (beepCtx || (beepCtx = new AC()));
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine'; osc.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.45, t0 + 0.015);
    g.gain.setValueAtTime(0.45, t0 + 0.115);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.15);
    osc.connect(g); g.connect(ctx.destination);
    osc.start(t0); osc.stop(t0 + 0.17);
  } catch (e) { /* the visual card + bundle event still mark it */ }
}

function testRender() {
  const s = TEST_STEPS[testMode.step];
  els.testStepNum.textContent =
    'STEP ' + (testMode.step + 1) + ' OF ' + TEST_STEPS.length;
  els.testStepName.textContent = s.name;
  els.testInstr.textContent = s.instr;
  const L = [];
  L.push('<div class="tline hdr"><span class="tlabel">First say the ' +
         'header — then wait for my reply to finish</span>&ldquo;Test ' +
         TEST_NUM_WORDS[testMode.step] + '&rdquo;</div>');
  for (const line of s.lines) {
    L.push('<div class="tline">&ldquo;' + escapeHtml(line) + '&rdquo;</div>');
  }
  if (s.cut) {
    L.push('<div class="tline cut"><span class="tlabel">' +
           escapeHtml(s.cut.trigger) + '</span>&ldquo;' +
           escapeHtml(s.cut.line) + '&rdquo;</div>');
  }
  els.testLines.innerHTML = L.join('');
  if (s.typed && !els.composer.classList.contains('open')) els.type.click();
}

function testMark(how) {
  const s = TEST_STEPS[testMode.step];
  const payload = { step: testMode.step + 1, step_name: s.name,
                    how, client_ts: Date.now(),
                    perf_t: kit.session
                      ? Math.round(kitNow() * 10) / 10 : null };
  if (kit.session) kitEv('test_step', payload);
  publishPacket(Object.assign({ type: 'test.step' }, payload));
  testBeep();
}

function testAdvance(how) {
  testMode.step += 1;
  if (testMode.step >= TEST_STEPS.length) { testFinish('completed'); return; }
  testRender();
  testMark(how);
}

function testStart() {
  if (testMode.active) return;
  if (!connected && !SIM) {
    setStatus('Join the room first (Talk), then start the test.');
    return;
  }
  testMode.active = true; testMode.step = -1;
  els.testBtn.classList.add('on');
  els.testCard.hidden = false;
  testAdvance('start');
}

function testFinish(reason) {
  if (!testMode.active) return;
  if (kit.session) kitEv('test_end', { reason });
  if (connected) publishPacket({ type: 'test.end', reason, client_ts: Date.now() });
  testMode.active = false; testMode.step = -1;
  els.testCard.hidden = true;
  els.testBtn.classList.remove('on');
}

els.testBtn.addEventListener('click', () => {
  if (testMode.active) testFinish('toggled-off'); else testStart();
});
els.testNext.addEventListener('click', () => { if (testMode.active) testAdvance('next'); });
els.testSkip.addEventListener('click', () => { if (testMode.active) testAdvance('skip'); });
els.testEnd.addEventListener('click', () => testFinish('ended'));

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

/* ======================= ground-truth kit =======================
 * Howard's directive, 2026-10-16 20:59 ET: every call must produce
 * (1) an actual AUDIO RECORDING of the call as heard on this phone,
 * and (2) CLIENT-SIDE MEASUREMENTS from this app, so true end-to-end
 * lag can be counted to the millisecond against the server traces.
 * This closes Leg 7 of LATENCY-ANATOMY.md ("published track ->
 * audible on his phone: UNMEASURED").
 *
 * What it does, when on:
 *  - Stamps events on a monotonic clock (performance.now): mic
 *    speech segments, Lash-track audio segments (an analyser on the
 *    received stream — first NON-SILENT audio actually rendered,
 *    and its cessation), control-packet receipts, track subscribe.
 *    A mic onset while Lash's audio is live is the barge-in moment.
 *  - Runs a clock-sync ping exchange with the worker over the data
 *    channel, so client stamps can be placed on the server clock
 *    with an honest skew bound (best offset + RTT/2).
 *  - Records a mix — Howard's mic + Lash's track as received here
 *    (post-jitter-buffer: gaps, cuts and all, exactly what the
 *    speaker was fed) — and uploads it in small acked slices over
 *    the data channel DURING the call, so a dead tab loses at most
 *    the last few seconds. MediaRecorder is used where it exists;
 *    on browsers without it (older iOS Safari), a ScriptProcessor
 *    PCM capture at 16 kHz feeds the same upload protocol.
 *  - Emits a timing bundle (JSON, chunked) the worker persists
 *    server-side; the session report is built from it afterwards.
 *
 * On for Howard's room by default; ?kit=0 disables, ?kit=1 forces
 * on for other rooms (harness use). Off = zero behavior change:
 * every pre-kit code path is untouched when the kit is inactive.
 */

const KIT_ON = !SIM && qs.get('kit') !== '0' &&
  (qs.get('kit') === '1' || cfg.room === 'home-room');
const KIT_CHUNK_BYTES = 8000;         // raw bytes per data packet
const KIT_SLICE_MS = 4000;            // recorder timeslice
const KIT_SEG_ON = 0.030, KIT_SEG_OFF = 0.018;
const KIT_SEG_OFF_MS = 220, KIT_SEG_ON_MS = 40;

const kit = {
  active: false, finishing: false, session: null,
  perf0: 0, wall0: 0, events: [], syncs: [], pingN: 0,
  bestSync: null, syncTimer: null, pingTimer: null,
  ctx: null, mix: null, dest: null, micAn: null, remAn: null,
  segRAF: null, segs: null,
  recorder: null, recMime: '', recFormat: '', recSr: 0,
  pcm: null, sliceSeq: 0, slices: {},
  remoteWired: false, remotePresent: false,
  stored: null, timingStored: null, _storedWaiters: [], _timingWaiters: [],
};

function kitStat(txt) { if (els.kitStat) els.kitStat.textContent = txt ? ' · ' + txt : ''; }
function kitNow() { return performance.now() - kit.perf0; }
function kitEv(k, extra) {
  if (!kit.session) return;
  kit.events.push(Object.assign({ k, t: Math.round(kitNow() * 10) / 10 }, extra || {}));
}
function kitB64(bytes) {
  let s = '';
  const CH = 8192;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}
async function kitSha256(buffer) {
  try {
    const h = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (e) { return ''; }
}

/* ------------------------- clock sync ------------------------- */

function kitPing() {
  if (!kit.active) return;
  const rec = { id: ++kit.pingN, t0p: performance.now(), t0w: Date.now() };
  kit.syncs.push(rec);
  publishPacket({ type: 'clock.ping', kit_session: kit.session, id: rec.id, t0w: rec.t0w });
}
function kitOnPong(pkt) {
  const rec = kit.syncs.find((s) => s.id === pkt.id);
  if (!rec) return;
  rec.t1p = performance.now(); rec.t1w = Date.now();
  rec.srv_recv = pkt.srv_recv_ms; rec.srv_send = pkt.srv_send_ms;
  rec.rtt_ms = (rec.t1w - rec.t0w) - (pkt.srv_send_ms - pkt.srv_recv_ms);
  rec.offset_ms = ((pkt.srv_recv_ms - rec.t0w) + (pkt.srv_send_ms - rec.t1w)) / 2;
  rec.bound_ms = Math.max(0, rec.rtt_ms / 2);
  if (!kit.bestSync || rec.rtt_ms < kit.bestSync.rtt_ms) kit.bestSync = rec;
  kitEv('clock_pong', { id: rec.id, rtt_ms: Math.round(rec.rtt_ms),
                        offset_ms: Math.round(rec.offset_ms) });
}

/* --------------------- chunked data sender --------------------- */

async function kitSendChunked(kind, slice, buffer, keep) {
  const bytes = new Uint8Array(buffer);
  const n = Math.max(1, Math.ceil(bytes.length / KIT_CHUNK_BYTES));
  const chunks = [];
  for (let i = 0; i < n; i++) {
    chunks.push(bytes.subarray(i * KIT_CHUNK_BYTES, (i + 1) * KIT_CHUNK_BYTES));
  }
  if (keep) { keep.chunks = chunks; keep.n = n; }
  for (let i = 0; i < n; i++) {
    // NB: the chunk index rides as `cseq` — publishPacket owns the
    // envelope field `seq` and would overwrite ours.
    await publishPacket({ type: kind + '.chunk', kit_session: kit.session,
                          slice, cseq: i, n, b64: kitB64(chunks[i]) });
  }
}

/* ------------------------- recording ------------------------- */

async function kitUploadSlice(buffer) {
  const seq = kit.sliceSeq++;
  const meta = { buf: buffer, bytes: buffer.byteLength,
                 sha: await kitSha256(buffer), acked: false, lastResend: 0 };
  kit.slices[seq] = meta;
  await kitSendChunked('rec', seq, buffer, meta);
  kitEv('rec_slice_sent', { slice: seq, bytes: meta.bytes });
}
function kitOnAck(pkt) {
  if (pkt.kit_session !== kit.session) return;
  const meta = kit.slices[pkt.slice];
  if (!meta) return;
  if (pkt.complete) {
    meta.acked = true; meta.buf = null; meta.chunks = null;
    kitEv('rec_slice_acked', { slice: pkt.slice });
    return;
  }
  // Partial: resend what the worker says is missing, throttled.
  const now = Date.now();
  if (Array.isArray(pkt.missing) && pkt.missing.length && meta.chunks &&
      now - meta.lastResend > 800) {
    meta.lastResend = now;
    (async () => {
      for (const i of pkt.missing) {
        await publishPacket({ type: 'rec.chunk', kit_session: kit.session,
                              slice: pkt.slice, cseq: i, n: meta.n,
                              b64: kitB64(meta.chunks[i]) });
      }
    })();
  }
}
function kitOnStored(pkt) {
  if (pkt.kit_session !== kit.session) return;
  kit.stored = pkt;
  kitStat(pkt.ok ? 'kit: recording saved ✓' : 'kit: recording save FAILED');
  kitEv('rec_stored', { ok: pkt.ok, sha_ok: pkt.sha_ok, bytes: pkt.bytes });
  for (const w of kit._storedWaiters.splice(0)) w(pkt);
}
function kitOnTimingStored(pkt) {
  if (pkt.kit_session !== kit.session) return;
  kit.timingStored = pkt;
  kitEv('timing_stored', { ok: pkt.ok });
  for (const w of kit._timingWaiters.splice(0)) w(pkt);
}
function kitWaitStored(ms) {
  if (kit.stored) return Promise.resolve(kit.stored);
  return new Promise((res) => {
    const to = setTimeout(() => res(null), ms);
    kit._storedWaiters.push((p) => { clearTimeout(to); res(p); });
  });
}
function kitWaitTiming(ms) {
  if (kit.timingStored) return Promise.resolve(kit.timingStored);
  return new Promise((res) => {
    const to = setTimeout(() => res(null), ms);
    kit._timingWaiters.push((p) => { clearTimeout(to); res(p); });
  });
}

function kitPickMime() {
  if (!window.MediaRecorder) return '';
  const cands = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4',
                 'audio/ogg;codecs=opus', 'audio/ogg', ''];
  for (const m of cands) {
    try { if (!m || MediaRecorder.isTypeSupported(m)) return m; } catch (e) {}
  }
  return '';
}

/* PCM fallback (no MediaRecorder — older iOS Safari): tap the mix
 * with a ScriptProcessor, downsample to 16 kHz int16, same slices. */
function kitStartPcmFallback() {
  const ctx = kit.ctx;
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const zero = ctx.createGain(); zero.gain.value = 0;
  kit.mix.connect(proc); proc.connect(zero); zero.connect(ctx.destination);
  const ratio = ctx.sampleRate / 16000;
  let acc = [], accN = 0, carry = [];
  proc.onaudioprocess = (e) => {
    const inp = e.inputBuffer.getChannelData(0);
    const all = carry.concat([...inp]);
    const out = [];
    for (let i = 0; i + ratio < all.length; i += ratio) out.push(all[Math.floor(i)]);
    carry = all.slice(Math.floor((all.length - 1) / ratio) * ratio);
    acc.push(out); accN += out.length;
    if (accN >= 16000 * (KIT_SLICE_MS / 1000)) {
      const flat = new Int16Array(accN);
      let o = 0;
      for (const part of acc) for (const v of part) {
        flat[o++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      }
      acc = []; accN = 0;
      kitUploadSlice(flat.buffer).catch(() => {});
    }
  };
  kit.pcm = { proc, flush: () => {
    proc.onaudioprocess = null;
    try { proc.disconnect(); } catch (e) {}
    if (accN) {
      const flat = new Int16Array(accN);
      let o = 0;
      for (const part of acc) for (const v of part) {
        flat[o++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      }
      return kitUploadSlice(flat.buffer);
    }
    return Promise.resolve();
  } };
  kit.recFormat = 'pcm16'; kit.recSr = 16000; kit.recMime = 'audio/pcm';
}

function kitStartRecorder() {
  const mime = kitPickMime();
  if (mime !== '' || window.MediaRecorder) {
    try {
      const opts = mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 };
      const rec = new MediaRecorder(kit.dest.stream, opts);
      kit.recorder = rec; kit.recMime = rec.mimeType || mime || 'audio/webm';
      kit.recFormat = 'mediarecorder'; kit.recSr = kit.ctx.sampleRate;
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) e.data.arrayBuffer().then((b) => kitUploadSlice(b)).catch(() => {});
      };
      rec.start(KIT_SLICE_MS);
    } catch (e) {
      kitStartPcmFallback();
    }
  } else {
    kitStartPcmFallback();
  }
  kitEv('rec_start', { format: kit.recFormat, mime: kit.recMime, sr: kit.recSr });
  publishPacket({ type: 'rec.begin', kit_session: kit.session,
                  format: kit.recFormat, mime: kit.recMime, sr: kit.recSr });
  kitStat('kit: ● recording');
}

/* --------------------- audio graph + segments --------------------- */

function kitSegState() {
  return { loud: false, loudMs: 0, quietSince: 0, start: 0, peak: 0 };
}
function kitSegTick(name, an, buf, st, extraFn) {
  an.getByteTimeDomainData(buf);
  let peak = 0;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
  const now = kitNow();
  if (peak > KIT_SEG_ON) {
    st.loudMs += 16; st.quietSince = 0;
    st.peak = Math.max(st.peak, peak);
    if (!st.loud && st.loudMs >= KIT_SEG_ON_MS) {
      st.loud = true; st.start = now - st.loudMs;
      kitEv(name + '_seg_start', extraFn ? extraFn() : undefined);
    }
  } else if (peak < KIT_SEG_OFF) {
    st.loudMs = 0;
    if (st.loud) {
      if (!st.quietSince) st.quietSince = now;
      if (now - st.quietSince >= KIT_SEG_OFF_MS) {
        st.loud = false;
        kitEv(name + '_seg_end', { dur_ms: Math.round(now - st.start),
                                   peak: Math.round(st.peak * 1000) / 1000 });
        st.peak = 0; st.quietSince = 0;
      }
    }
  } else { st.quietSince = 0; }
  return st.loud;
}
function kitSegLoop() {
  if (!kit.active || !kit.micAn) return;
  const mBuf = new Uint8Array(kit.micAn.frequencyBinCount);
  const rBuf = kit.remAn ? new Uint8Array(kit.remAn.frequencyBinCount) : null;
  const tick = () => {
    if (!kit.active) return;
    if (kit.micAn) kitSegTick('mic', kit.micAn, mBuf, kit.segs.mic,
      () => ({ during_remote: !!(kit.segs.rem.loud || playing) }));
    if (kit.remAn && rBuf) kitSegTick('remote', kit.remAn, rBuf, kit.segs.rem);
    kit.segRAF = requestAnimationFrame(tick);
  };
  tick();
}

async function kitStart() {
  if (!KIT_ON || kit.active || !connected || !room) return;
  kit.session = 's' + Date.now();
  kit.perf0 = performance.now(); kit.wall0 = Date.now();
  kit.events = []; kit.syncs = []; kit.sliceSeq = 0; kit.slices = {};
  kit.stored = null; kit.timingStored = null;
  kit.segs = { mic: kitSegState(), rem: kitSegState() };
  kit.active = true; kit.finishing = false;
  kitEv('session_start', { ua: navigator.userAgent, room: cfg.room });
  kitStat('kit: syncing…');
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    kit.ctx = new AC();
    try { await kit.ctx.resume(); } catch (e) {}
    kit.mix = kit.ctx.createGain(); kit.mix.gain.value = 1;
    kit.dest = kit.ctx.createMediaStreamDestination();
    kit.mix.connect(kit.dest);
    // Howard's mic: same published track the level meter reads.
    let micTrack = null;
    for (let i = 0; i < 20 && !micTrack; i++) {
      const pub = room.localParticipant.getTrackPublication(LK.Track.Source.Microphone);
      micTrack = pub && pub.track && pub.track.mediaStreamTrack;
      if (!micTrack) await new Promise((r) => setTimeout(r, 150));
    }
    if (micTrack) {
      const src = kit.ctx.createMediaStreamSource(new MediaStream([micTrack]));
      src.connect(kit.mix);
      kit.micAn = kit.ctx.createAnalyser(); kit.micAn.fftSize = 512;
      src.connect(kit.micAn);
    } else {
      kitEv('mic_tap_failed', {});
    }
  } catch (e) {
    kitEv('graph_failed', { err: String(e && e.message || e) });
  }
  kitPing();
  kit.pingTimer = setInterval(kitPing, 30000);
  if (kit.ctx && kit.dest) { kitStartRecorder(); kitSegLoop(); }
  else kitStat('kit: timing only (no recorder)');
  // Late-wire: if the agent's track was subscribed BEFORE the kit
  // graph existed (the usual case — the agent is already in the
  // room publishing when Howard joins), the trackSubscribed hook
  // fired too early and skipped it. Pick the track up now.
  try {
    for (const p of room.remoteParticipants.values()) {
      if (p.identity !== cfg.agentIdentity) continue;
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === 'audio' && pub.track) kitRemoteTrack(pub.track);
      }
    }
  } catch (e) {}
}

function kitRemoteTrack(track) {
  if (!kit.active || !kit.ctx || kit.remoteWired) {
    if (kit.active) kitEv('track_subscribed', { wired: false });
    return;
  }
  try {
    const src = kit.ctx.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
    src.connect(kit.mix);
    kit.remAn = kit.ctx.createAnalyser(); kit.remAn.fftSize = 512;
    src.connect(kit.remAn);
    kit.remoteWired = true; kit.remotePresent = true;
    kitEv('track_subscribed', { wired: true });
  } catch (e) {
    kitEv('track_subscribed', { wired: false, err: String(e && e.message || e) });
  }
}

/* --------------------------- finish --------------------------- */

async function kitSendBundle(partial) {
  const bundle = {
    v: 1, session: kit.session, room: cfg.room,
    started_wall_ms: kit.wall0, perf0: kit.perf0,
    ua: navigator.userAgent,
    rec: { format: kit.recFormat, mime: kit.recMime, sr: kit.recSr,
           slices: kit.sliceSeq, remote_present: kit.remotePresent },
    sync: { pings: kit.syncs, best: kit.bestSync },
    events: kit.events, partial: !!partial,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(bundle));
  const sha = await kitSha256(bytes.buffer);
  await kitSendChunked('timing', 0, bytes.buffer, null);
  await publishPacket({ type: 'timing.end', kit_session: kit.session,
                        sha, bytes: bytes.length });
  kitEv('bundle_sent', { bytes: bytes.length, partial: !!partial });
  return bundle;
}

async function kitFinish() {
  if (!kit.active || kit.finishing) return;
  kit.finishing = true;
  kitStat('kit: uploading…');
  if (kit.pingTimer) { clearInterval(kit.pingTimer); kit.pingTimer = null; }
  kitPing();
  // Stop the recorder; the final slice uploads from ondataavailable.
  try {
    if (kit.recorder && kit.recorder.state !== 'inactive') {
      await new Promise((res) => {
        kit.recorder.onstop = () => res();
        try { kit.recorder.stop(); } catch (e) { res(); }
        setTimeout(res, 3000);
      });
    } else if (kit.pcm) { await kit.pcm.flush(); }
  } catch (e) {}
  // Give slice acks a short window to settle, then declare the end.
  await new Promise((r) => setTimeout(r, 700));
  const sliceMeta = Object.keys(kit.slices).sort((a, b) => a - b).map((k) => ({
    slice: +k, bytes: kit.slices[k].bytes, sha: kit.slices[k].sha,
    acked: kit.slices[k].acked,
  }));
  await publishPacket({ type: 'rec.end', kit_session: kit.session,
                        format: kit.recFormat, mime: kit.recMime, sr: kit.recSr,
                        slices: sliceMeta });
  kitEv('rec_end_sent', { slices: sliceMeta.length });
  await kitSendBundle(false);
  const stored = await kitWaitStored(12000);
  const tstored = await kitWaitTiming(4000);
  kitEv('finish', { stored_ok: !!(stored && stored.ok),
                    timing_ok: !!(tstored && tstored.ok) });
  kit.active = false;
  if (kit.segRAF) cancelAnimationFrame(kit.segRAF);
  if (kit.ctx) { try { kit.ctx.close(); } catch (e) {} kit.ctx = null; }
}

async function kitStop() {
  // Teardown path (Talk toggle / disconnect): best-effort only —
  // ship what we have, marked partial, never block the hangup.
  if (!kit.active || kit.finishing) return;
  kit.finishing = true;
  if (kit.pingTimer) { clearInterval(kit.pingTimer); kit.pingTimer = null; }
  try {
    if (kit.recorder && kit.recorder.state !== 'inactive') kit.recorder.stop();
    else if (kit.pcm) await kit.pcm.flush();
  } catch (e) {}
  await new Promise((r) => setTimeout(r, 500));
  try { await kitSendBundle(true); } catch (e) {}
  kit.active = false;
  if (kit.segRAF) cancelAnimationFrame(kit.segRAF);
  if (kit.ctx) { try { kit.ctx.close(); } catch (e) {} kit.ctx = null; }
}

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
  kit: () => ({
    on: KIT_ON, active: kit.active, session: kit.session,
    events: kit.events.length, syncs: kit.syncs.length,
    kinds: kit.events.reduce((m, e) => ((m[e.k] = (m[e.k] || 0) + 1), m), {}),
    best: kit.bestSync, recMime: kit.recMime, recFormat: kit.recFormat,
    slices: Object.keys(kit.slices).length,
    acked: Object.values(kit.slices).filter((s) => s.acked).length,
    stored: kit.stored, timingStored: kit.timingStored,
  }),
  test: () => ({ active: testMode.active, step: testMode.step + 1,
                 name: testMode.step >= 0
                   ? TEST_STEPS[testMode.step].name : null }),
  cfg,
};
