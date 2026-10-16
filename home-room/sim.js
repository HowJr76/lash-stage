/* Home Room — simulation driver (only active with ?sim=1).
 *
 * Feeds the real contract handlers in app.js with synthetic
 * data-channel packets, so the full UI state machine — presence,
 * loops face, thread, playback accounting — can be exercised and
 * verified on this device with no media server behind it. Nothing
 * here fakes a call: no audio path is simulated, and the panel says
 * so on its face. */

'use strict';

const simQs = new URLSearchParams(location.search);
if (simQs.has("sim")) {
  const panel = document.getElementById('simPanel');
  panel.classList.add('open');
  const logEl = document.getElementById('simLog');
  const HR = window.HomeRoom;
  let turnN = 0;
  let speech = null; // { turnId, timer, words }

  function log(kind, obj) {
    const line = document.createElement('div');
    line.textContent = new Date().toLocaleTimeString() + ' ' + kind + ' ' +
      (typeof obj === 'string' ? obj : JSON.stringify(obj));
    logEl.prepend(line);
    while (logEl.children.length > 40) logEl.lastChild.remove();
  }
  function fire(pkt, from) {
    log('in  <-', pkt);
    HR.handlePacket(pkt, from || 'agent:lash');
  }
  document.addEventListener('hr-outbound', (e) => log('out ->', e.detail));
  document.addEventListener('hr-sim-talk', () => fire({ type: 'stage.state', state: 'listening' }));

  function animateLevel(ms) {
    const t0 = performance.now();
    const step = () => {
      const t = (performance.now() - t0) / ms;
      if (t >= 1) { HR.setLevel(0, 'live'); return; }
      HR.setLevel(0.25 + 0.55 * Math.abs(Math.sin(t * 22)) * (1 - t * 0.4), 'live');
      requestAnimationFrame(step);
    };
    step();
  }

  const LINES = [
    { say: ['Good morning, Howard.', 'The rig held all night — watchdogs green, tokens good until tomorrow morning.'],
      heardWords: null },
    { say: ['On the animation question —', 'the honest answer is the framing still changes too much between clips.'],
      heardWords: 4 },
  ];

  const actions = {
    agentJoin() { HR.agentJoined(); log('sys', 'agent joined (greeting window 6s)'); },
    howardSpeaks() {
      animateLevel(1300);
      const id = 'sim-u' + (++turnN);
      setTimeout(() => fire({ type: 'turn.endpoint', turn_id: id, participant_id: 'howard', final: true, text: 'Morning, Lash — how is the rig looking today?' }, 'howard'), 1350);
    },
    lashThinks() { fire({ type: 'stage.state', state: 'thinking', focus: 'howard' }); },
    lashSpeaks() {
      const spec = LINES[turnN % LINES.length];
      const id = 'sim-t' + (++turnN);
      spec.say.forEach((text, i) => fire({ type: 'intent.say', turn_id: id, clause_idx: i, text }));
      fire({ type: 'playback.started', turn_id: id, clause_idx: 0, play_pos_ms: 0 });
      const totalWords = spec.say.join(' ').split(/\s+/).length;
      speech = { turnId: id, words: totalWords, spec };
      speech.timer = setTimeout(() => actions.lashFinishes(), 4200);
    },
    bargeIn() {
      if (!speech) { log('sys', 'barge-in ignored — nothing playing'); return; }
      clearTimeout(speech.timer);
      const total = speech.words;
      const heard = speech.spec.heardWords != null ? speech.spec.heardWords : Math.max(1, Math.floor(total / 3));
      fire({ type: 'playback.stopped', turn_id: speech.turnId, clause_idx: speech.spec.say.length - 1, played_ms: 2300, spoken_until_word: heard, reason: 'barge_in' });
      speech = null;
      animateLevel(900);
      setTimeout(() => fire({ type: 'stage.state', state: 'thinking', focus: 'howard' }), 950);
    },
    lashFinishes() {
      if (!speech) { log('sys', 'finish ignored — nothing playing'); return; }
      clearTimeout(speech.timer);
      fire({ type: 'playback.stopped', turn_id: speech.turnId, clause_idx: speech.spec.say.length - 1, played_ms: 4100, spoken_until_word: speech.words, reason: 'ended' });
      speech = null;
      fire({ type: 'stage.state', state: 'listening' });
    },
    agentAway() {
      fire({ type: 'session.control', cmd: 'leave', by: 'agent:lash' }, 'agent:lash');
    },
    auto() {
      const seq = [
        ['agentJoin', 0], ['howardSpeaks', 1200], ['lashThinks', 3400],
        ['lashSpeaks', 5200], ['bargeIn', 7400], ['lashThinks', 9200],
        ['lashSpeaks', 10800], ['lashFinishes', 15600],
      ];
      log('sys', 'auto-cycle started (~16s)');
      for (const [name, at] of seq) setTimeout(() => actions[name](), at);
    },
  };

  panel.querySelectorAll('button[data-sim]').forEach((b) => {
    b.addEventListener('click', () => actions[b.dataset.sim]());
  });
  log('sys', 'sim driver ready — packets go through the real handlePacket()');
}
