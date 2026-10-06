/* Lastep · Partie à 4
 * Plateau 6×6, jusqu'à 4 joueurs (humains, ordinateurs, ou les deux), UN pion et DEUX sauts chacun.
 * Mêmes règles qu'à deux : 1 à 3 cases en ligne droite, les cases s'usent.
 * Un joueur qui ne peut plus bouger à son tour est éliminé. Le dernier debout gagne.
 * Modes : sur ce téléphone (avec ou sans ordinateurs) et salle privée entre amis (code ou lien).
 * Réglages choisis par simulation (400 parties par variante) : avec 1 pion et 2 sauts, la partie dure
 * autant de coups qu'avec 2 pions (~45, environ 10 par joueur) mais chaque tour offre deux fois moins
 * de choix : on joue plus vite, l'attente entre ses tours est plus courte, et on voit plus de sauts.
 * (La partie rapide avec des inconnus existe dans le code mais n'est pas proposée pour l'instant.)
 * En ligne, l'hôte arbitre la partie et envoie l'état à tout le monde.
 */
(function () {
  'use strict';
  const N = 6, TURN_MS = 25000, QUICK_WAIT = 20000, SLOTS = 6;
  const SEATC = ['#2ef2ff', '#ff3dd8', '#b6ff3b', '#ffd75e'];
  const START = [[30], [0], [5], [35]]; // un pion par coin : bas-gauche, haut-gauche, haut-droite, bas-droite (sens horaire)
  const JUMPS = 2;
  const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  const BOTKEYS = ['easy', 'lumi', 'braise', 'medium', 'prof', 'hard', 'expert'];
  const RANKPTS = [null, 5, 2, 0], RANKCOINS = [10, 5, 2, 0];
  const roomCode = () => String(1000 + Math.floor(Math.random() * 9000)); // 4 chiffres : se dit à voix haute
  const rid = (n = 5) => { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  const esc4 = (s) => (typeof esc === 'function' ? esc(s) : String(s));
  const tr = (s) => (typeof T === 'function' ? T(s) : s);

  let PT = null;      // état de la partie
  let NET = null;     // réseau
  let UI = { stage: 'menu', sel: null, seats: null, err: '', bubbles: {} };
  let root = null, tick = null, aiTimer = null;

  /* ---------- Règles ---------- */
  function newBoard() {
    const c = Array(N * N).fill(0);
    const q = []; for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) q.push(Math.random() < 0.45 ? 2 : 1);
    const rot = (r, k) => [k, N - 1 - r];
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) {
      let rr = r, kk = k; const v = q[r * 3 + k];
      for (let t = 0; t < 4; t++) { c[rr * N + kk] = v; [rr, kk] = rot(rr, kk); }
    }
    for (const i of [14, 15, 20, 21]) c[i] = Math.random() < 0.5 ? 3 : 2; // centre plus solide
    for (const s of START) for (const i of s) c[i] = 2;
    return c;
  }
  function occupied(pawns) { const o = new Set(); pawns.forEach(p => p.forEach(i => o.add(i))); return o; }
  function gen(st, s) {
    const out = [], occ = occupied(st.pawns);
    (st.pawns[s] || []).forEach((pos, k) => {
      const r0 = Math.floor(pos / N), c0 = pos % N;
      for (const [dr, dc] of DIRS) {
        let crossed = false;
        for (let d = 1; d <= 3; d++) {
          const r = r0 + dr * d, c = c0 + dc * d; if (r < 0 || c < 0 || r >= N || c >= N) break;
          const i = r * N + c;
          if (occ.has(i) || st.cells[i] === 0) { if (!st.J[s] || crossed) break; crossed = true; continue; }
          out.push([k, i, crossed ? 1 : 0]);
        }
      }
    });
    return out;
  }
  function applyMove(st, s, m) {
    const from = st.pawns[s][m[0]];
    st.cells[from]--; st.pawns[s][m[0]] = m[1]; if (m[2]) st.J[s]--;
    return from;
  }
  const visibleSum = (st) => { const occ = occupied(st.pawns); return st.cells.reduce((a, v, i) => a + (occ.has(i) ? 0 : v), 0); };
  const clone = (st) => ({ cells: st.cells.slice(), pawns: st.pawns.map(p => p.slice()), J: st.J.slice(), alive: st.alive.slice() });

  /* ---------- Ordinateur : garder de la place, en retirer aux autres ---------- */
  function aiPick(st, s, noise = 2) {
    const ms = gen(st, s); if (!ms.length) return null;
    let best = null, bv = -1e9;
    for (const m of ms) {
      const x = clone(st); applyMove(x, s, m);
      const mine = gen(x, s).length; let v = 3 * mine;
      for (let o = 0; o < 4; o++) if (o !== s && x.alive[o]) { const n = gen(x, o).length; v -= n; if (n === 0) v += 30; }
      if (mine === 0) v -= 200;
      if (m[2]) v -= 4;
      v += Math.random() * noise;
      if (v > bv) { bv = v; best = m; }
    }
    return best;
  }

  /* ---------- Déroulement (côté arbitre : partie locale ou hôte) ---------- */
  function newGame(seats) {
    const alive = seats.map(s => s.kind !== 'off');
    PT = {
      id: rid(6), cells: newBoard(), pawns: START.map((p, i) => alive[i] ? p.slice() : []), J: [JUMPS, JUMPS, JUMPS, JUMPS], alive, place: [],
      seats: seats.map(s => ({ ...s })), turn: -1, moves: 0, last: null, msg: '', over: false, winner: null, deadline: 0, timeouts: [0, 0, 0, 0], pts: null, ver: 0,
    };
    UI.stage = 'game'; UI.sel = null; UI.bubbles = {};
    try { if (typeof MUSIC !== 'undefined' && MUSIC.el) MUSIC.el.currentTime = 0; if (typeof musicStart === 'function') musicStart(); } catch (e) {}
    nextTurn(true);
  }
  function aliveSeats() { return [0, 1, 2, 3].filter(i => PT.alive[i]); }
  function eliminate(s, why) {
    PT.alive[s] = false; PT.place.push(s); PT.pawns[s] = [];
    PT.msg = `${PT.seats[s].name} ${tr(why === 'afk' ? 'est éliminé (absent).' : 'est bloqué : éliminé !')}`;
    try { sfx.fall(); } catch (e) {}
  }
  function nextTurn(first) {
    if (PT.over) return;
    let s = first ? 3 : PT.turn;
    for (let guard = 0; guard < 8; guard++) {
      if (aliveSeats().length <= 1) return finish();
      s = (s + 1) % 4;
      if (!PT.alive[s]) continue;
      if (!gen(PT, s).length) { eliminate(s); continue; }
      PT.turn = s; PT.deadline = Date.now() + TURN_MS; PT.ver++;
      UI.sel = null;
      const ks = [...new Set(gen(PT, s).map(m => m[0]))]; if (ks.length === 1) UI.sel = ks[0];
      broadcast(); draw(); scheduleBot();
      return;
    }
    finish();
  }
  function scheduleBot() {
    clearTimeout(aiTimer);
    if (!PT || PT.over || PT.turn < 0) return;
    const seat = PT.seats[PT.turn];
    if (seat.kind === 'ai') { const ver = PT.ver; aiTimer = setTimeout(() => { if (PT && PT.ver === ver && !PT.over) { const m = aiPick(PT, PT.turn); if (m) play(PT.turn, m); } }, 650 + Math.random() * 600); }
  }
  function play(s, m) {
    if (!PT || PT.over || s !== PT.turn) return false;
    const ok = gen(PT, s).some(x => x[0] === m[0] && x[1] === m[1] && x[2] === m[2]); if (!ok) return false;
    const from = applyMove(PT, s, m);
    PT.last = { s, from, to: m[1], jump: m[2] }; PT.moves++; PT.msg = m[2] ? `${PT.seats[s].name} ${tr('utilise son saut ↷')}` : '';
    PT.timeouts[s] = 0;
    try { sfx.move(); if (PT.cells[from] === 0) setTimeout(() => sfx.fall(), 200); if (m[2]) sfx.jump(); } catch (e) {}
    nextTurn(false);
    return true;
  }
  function finish() {
    clearTimeout(aiTimer);
    const left = aliveSeats(); PT.over = true; PT.winner = left.length ? left[0] : PT.place[PT.place.length - 1];
    const rank = [PT.winner, ...PT.place.slice().reverse().filter(x => x !== PT.winner)];
    const vs = visibleSum(PT);
    PT.rank = rank; PT.pts = {}; rank.forEach((s, i) => { PT.pts[s] = i === 0 ? 10 + vs : RANKPTS[i] ?? 0; });
    PT.msg = `${PT.seats[PT.winner].name} ${tr('fait le dernier pas !')}`; PT.ver++;
    try { sfx.round(); } catch (e) {}
    reward(); broadcast(); draw();
  }
  function reward() {
    const me = mySeat(); if (me == null || !PT.rank) return;
    const r = PT.rank.indexOf(me); if (r < 0) return;
    try { P.coins = (P.coins || 0) + RANKCOINS[r]; saveP(); } catch (e) {}
  }
  function onTick() {
    if (!PT || PT.over) { drawTimer(); return; }
    drawTimer();
    if (!isReferee() || PT.turn < 0) return;
    if (Date.now() > PT.deadline) {
      const s = PT.turn, seat = PT.seats[s];
      PT.timeouts[s]++;
      if (seat.kind === 'remote' && PT.timeouts[s] >= 3) { eliminate(s, 'afk'); return nextTurn(false); }
      const m = aiPick(PT, s, 6); if (m) play(s, m); else nextTurn(false);
    }
  }

  /* ---------- Réseau (hôte = arbitre) ---------- */
  const isReferee = () => !NET || NET.host;
  function mySeat() {
    if (!PT && !NET) return null;
    if (NET) return NET.seat;
    // partie locale : le premier humain est le propriétaire du téléphone
    const seats = (PT && PT.seats) || UI.seats || []; const i = seats.findIndex(s => s.kind === 'human'); return i < 0 ? null : i;
  }
  function packState() {
    return { id: PT.id, cells: PT.cells, pawns: PT.pawns, J: PT.J, alive: PT.alive, place: PT.place, seats: PT.seats.map(s => ({ kind: s.kind === 'remote' ? 'remote' : s.kind, name: s.name, skin: s.skin })),
      turn: PT.turn, moves: PT.moves, last: PT.last, msg: PT.msg, over: PT.over, winner: PT.winner, rank: PT.rank, pts: PT.pts, left: Math.max(0, PT.deadline - Date.now()), ver: PT.ver };
  }
  function broadcast() {
    if (!NET || !NET.host || !PT) return;
    const st = packState();
    for (const s in NET.conns) { try { NET.conns[s].send({ t: 'st', st, you: +s }); } catch (e) {} }
  }
  function lobbyMsg() { return { t: 'lobby', seats: NET.seats.map(s => s && { kind: s.kind, name: s.name, skin: s.skin }), code: NET.code, quick: NET.quick, wait: NET.quick ? Math.max(0, NET.startAt - Date.now()) : 0 }; }
  function sendLobby() { if (!NET || !NET.host) return; const m = lobbyMsg(); for (const s in NET.conns) { try { NET.conns[s].send({ ...m, you: +s }); } catch (e) {} } draw(); }
  function meSeat() { return { kind: 'human', name: P.name, skin: P.skin }; }

  function hostRoom(code, quick, slot) {
    leaveNet();
    const id = quick ? 'lastep-q4-' + slot : 'lastep-r4-' + code;
    NET = { host: true, seat: 0, code, quick: !!quick, slot, conns: {}, seats: [meSeat(), null, null, null], peer: null, started: false, startAt: Date.now() + QUICK_WAIT };
    UI.stage = 'lobby'; UI.err = ''; draw();
    let peer; try { peer = new Peer(id); } catch (e) { UI.err = tr('Connexion impossible pour le moment.'); draw(); return; }
    const me = NET; me.peer = peer;
    peer.on('open', () => { if (NET === me) { me.ready = true; draw(); } });
    peer.on('error', (err) => {
      if (NET !== me) return;
      if (err && err.type === 'unavailable-id') { try { peer.destroy(); } catch (e) {} if (quick) joinRoom(id, true, slot); else hostRoom(roomCode(), false); return; }
      if (!me.started) { UI.err = tr('Connexion au service en ligne impossible. Vérifie ta connexion internet.'); draw(); }
    });
    peer.on('connection', (c) => {
      if (NET !== me) { try { c.close(); } catch (e) {} return; }
      c.on('data', (d) => hostData(me, c, d));
      c.on('close', () => hostLost(me, c));
      c.on('open', () => { if (me.started || me.seats.every(Boolean)) { try { c.send({ t: 'full' }); } catch (e) {} setTimeout(() => { try { c.close(); } catch (e) {} }, 300); } });
    });
  }
  function hostData(me, c, d) {
    if (NET !== me || !d || typeof d !== 'object') return;
    if (d.t === 'hello') {
      if (me.started) return;
      const s = me.seats.findIndex(x => !x); if (s < 0) { try { c.send({ t: 'full' }); } catch (e) {} return; }
      me.seats[s] = { kind: 'remote', name: cleanName(d.nm), skin: cleanSkin(d.sk) }; me.conns[s] = c; c._seat = s;
      try { sfx.msg(); } catch (e) {}
      sendLobby();
      if (me.quick && me.seats.every(Boolean)) startOnline();
      return;
    }
    const s = c._seat; if (s == null) return;
    if (d.t === 'mv' && Array.isArray(d.m) && PT && PT.turn === s) play(s, [d.m[0] | 0, d.m[1] | 0, d.m[2] ? 1 : 0]);
    if (d.t === 'chat') { const id = String(d.id || ''); if (typeof phText === 'function' && phText(id)) { showBubble(s, id); relay({ t: 'chat', s, id }, s); } }
  }
  function relay(msg, except) { if (!NET) return; for (const s in NET.conns) if (+s !== except) { try { NET.conns[s].send(msg); } catch (e) {} } }
  function hostLost(me, c) {
    if (NET !== me) return; const s = c._seat; if (s == null) return;
    delete me.conns[s];
    if (!me.started) { me.seats[s] = null; sendLobby(); return; }
    if (PT && !PT.over && PT.seats[s]) { PT.seats[s].kind = 'ai'; PT.seats[s].name += ' 🤖'; PT.msg = `${PT.seats[s].name} ${tr('a quitté : l\'ordinateur le remplace.')}`; PT.ver++; broadcast(); draw(); if (PT.turn === s) scheduleBot(); }
  }
  function startOnline() {
    const me = NET; if (!me || !me.host || me.started) return;
    me.started = true;
    const used = new Set(); const seats = me.seats.map((s) => {
      if (s) return s;
      let k; do { k = BOTKEYS[Math.floor(Math.random() * BOTKEYS.length)]; } while (used.has(k) && used.size < BOTKEYS.length); used.add(k);
      return { kind: 'ai', name: BOTS[k].name, skin: BOTS[k].skin };
    });
    try { me.peer.disconnect(); } catch (e) {} // la file se libère pour une autre partie
    newGame(seats);
  }
  function joinRoom(hostId, quick, slot) {
    leaveNet();
    NET = { host: false, seat: null, code: quick ? '' : hostId.replace('lastep-r4-', ''), quick: !!quick, slot, conn: null, peer: null };
    UI.stage = 'lobby'; UI.err = ''; UI.lobby = null; draw();
    const me = NET; let peer; try { peer = new Peer(); } catch (e) { UI.err = tr('Connexion impossible pour le moment.'); draw(); return; }
    me.peer = peer;
    const fail = (msg) => { if (NET !== me) return; if (quick) { quickMatch(slot + 1); return; } UI.err = msg; draw(); };
    me.timer = setTimeout(() => { if (NET === me && me.seat == null) fail(tr('Aucune partie avec ce code. Vérifie le code, et que ton ami a toujours l\'écran ouvert.')); }, 12000);
    peer.on('open', () => {
      if (NET !== me) return;
      const c = me.conn = peer.connect(hostId, { reliable: true });
      c.on('open', () => { try { c.send({ t: 'hello', nm: P.name, sk: P.skin, uid: P.uid }); } catch (e) {} });
      c.on('data', (d) => guestData(me, d));
      c.on('close', () => { if (NET !== me) return; if (PT && !PT.over) { PT.msg = tr('L\'hôte a quitté la partie.'); PT.over = true; PT.winner = null; draw(); } else if (!PT) fail(tr('La connexion a échoué. Réessaie.')); });
    });
    peer.on('error', (err) => { if (NET !== me) return; if (err && err.type === 'peer-unavailable') fail(tr('Aucune partie avec ce code. Vérifie le code, et que ton ami a toujours l\'écran ouvert.')); else if (me.seat == null) fail(tr('Connexion au service en ligne impossible. Vérifie ta connexion internet.')); });
  }
  function guestData(me, d) {
    if (NET !== me || !d || typeof d !== 'object') return;
    if (d.t === 'full') { if (me.quick) { const s = me.slot; quickMatch(s + 1); } else { UI.err = tr('Cette salle est complète ou la partie a déjà commencé.'); draw(); } return; }
    if (typeof d.you === 'number') { me.seat = d.you; clearTimeout(me.timer); }
    if (d.t === 'lobby') { UI.lobby = d; UI.lobbyAt = Date.now(); UI.stage = 'lobby'; draw(); return; }
    if (d.t === 'st' && d.st) {
      const st = d.st, isNew = !PT || PT.id !== st.id;
      const prev = PT;
      PT = { ...st, deadline: Date.now() + (st.left || 0), timeouts: [0, 0, 0, 0] };
      if (isNew) { UI.stage = 'game'; UI.bubbles = {}; try { if (typeof MUSIC !== 'undefined' && MUSIC.el) MUSIC.el.currentTime = 0; musicStart(); } catch (e) {} }
      if (prev && !isNew && st.moves === prev.moves + 1) { try { sfx.move(); } catch (e) {} }
      if (st.over && !(prev && prev.over)) { try { sfx.round(); } catch (e) {} reward(); }
      UI.sel = null; if (PT.turn === me.seat && !PT.over) { const ks = [...new Set(gen(PT, me.seat).map(m => m[0]))]; if (ks.length === 1) UI.sel = ks[0]; }
      draw(); return;
    }
    if (d.t === 'chat') showBubble(d.s, d.id);
  }
  function quickMatch(slot) {
    slot = slot || 0;
    if (slot >= SLOTS) { hostRoom('', true, 'x' + rid(8)); return; } // files pleines : on ouvre sa propre table
    hostRoom('', true, slot);
  }
  function leaveNet() {
    if (!NET) return; const n = NET; NET = null;
    clearTimeout(n.timer);
    try { n.conn && n.conn.close(); } catch (e) {}
    for (const s in (n.conns || {})) { try { n.conns[s].close(); } catch (e) {} }
    try { n.peer && n.peer.destroy(); } catch (e) {}
  }

  /* ---------- Chat en phrases ---------- */
  function sendPhrase(id) {
    const s = mySeat(); if (s == null) return;
    showBubble(s, id);
    if (NET && NET.host) relay({ t: 'chat', s, id }, -1);
    else if (NET && NET.conn) { try { NET.conn.send({ t: 'chat', id }); } catch (e) {} }
    UI.chat = false; draw();
  }
  function showBubble(s, id) {
    const tx = typeof phText === 'function' ? phText(id) : null; if (!tx) return;
    UI.bubbles[s] = { tx, until: Date.now() + 3000 }; try { sfx.msg(); } catch (e) {} draw();
    setTimeout(draw, 3100);
  }

  /* ---------- Affichage ---------- */
  const CSS = `
#pt4{position:fixed;inset:0;z-index:70;background:radial-gradient(60% 40% at 0% 0%,#ff3dd833,transparent 70%),radial-gradient(60% 40% at 100% 100%,#2ef2ff2e,transparent 70%),#07060f;color:#f3f0ff;display:flex;flex-direction:column;padding:calc(10px + env(safe-area-inset-top)) 14px calc(14px + env(safe-area-inset-bottom));overflow-y:auto;font-family:var(--display,system-ui)}
#pt4 .bar{display:flex;align-items:center;gap:10px;margin-bottom:8px}
#pt4 .bar h2{flex:1;margin:0;font-size:1.25rem}
#pt4 .x{width:40px;height:40px;border-radius:12px;border:1px solid #2c2558;background:#15112d;color:inherit;font-size:1.1rem}
#pt4 .rows{display:flex;gap:8px}
#pt4 .pc{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:7px 9px;border-radius:14px;border:2px solid color-mix(in srgb,var(--sc) 35%,transparent);background:#15112d;position:relative}
#pt4 .pc.on{border-color:var(--sc);box-shadow:0 0 16px var(--sc)}
#pt4 .pc.out{opacity:.35}
#pt4 .pc .av{width:36px;flex:none}
#pt4 .pc b{display:block;font-size:.88rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#pt4 .pc small{font-family:var(--mono,monospace);font-size:.68rem;color:#a39cd0}
#pt4 .pc .tm{position:absolute;left:8px;right:8px;bottom:3px;height:3px;border-radius:2px;background:var(--sc);transform-origin:left}
#pt4 .bub{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);background:#fff;color:#0a0718;font-weight:800;font-size:.8rem;padding:6px 10px;border-radius:12px;white-space:nowrap;z-index:3;box-shadow:0 4px 0 #0006}
#pt4 .rows.bottom .bub{bottom:auto;top:calc(100% + 6px)}
#pt4 .bd{position:relative;display:grid;grid-template-columns:repeat(6,1fr);gap:4px;padding:6px;margin:10px auto;width:100%;max-width:min(100%,calc(100dvh - 330px));border-radius:14px;background:linear-gradient(180deg,#120e28,#0d0b1f);box-shadow:0 0 0 1px #8f7bff55,0 0 30px #8f7bff40}
#pt4 .cl{aspect-ratio:1;border-radius:8px;border:2px solid var(--tc);background:color-mix(in srgb,var(--tc) 14%,#0b0918);color:var(--tc);display:grid;place-items:center;font-weight:800;font-size:clamp(.8rem,4vw,1.3rem);text-shadow:0 0 8px var(--tc);box-shadow:0 0 8px color-mix(in srgb,var(--tc) 60%,transparent),inset 0 0 8px color-mix(in srgb,var(--tc) 40%,transparent);padding:0}
#pt4 .cl.h{border-color:transparent;background:#05040a;box-shadow:none}
#pt4 .cl.t{outline:3px solid #fff;outline-offset:-3px}
#pt4 .cl.tj{outline:3px dashed #b6ff3b;outline-offset:-3px}
#pt4 .cl.fr{box-shadow:0 0 0 2px #ffffff55 inset}
#pt4 .pw{position:absolute;width:calc((100% - 12px) / 6);aspect-ratio:1;transition:left .22s,top .22s,transform .2s;pointer-events:none;display:grid;place-items:center}
#pt4 .pw .rg{position:absolute;inset:12%;border-radius:50%;box-shadow:0 0 0 3px var(--sc),0 0 14px var(--sc)}
#pt4 .pw svg{width:86%;position:relative}
#pt4 .pw.sel{transform:scale(1.15)}
#pt4 .st{text-align:center;min-height:2.6em;font-size:.95rem;margin:2px 0}
#pt4 .acts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
#pt4 .btn{min-height:46px;padding:0 18px;border-radius:14px;border:1px solid #2c2558;background:#15112d;color:inherit;font:inherit;font-weight:700}
#pt4 .btn.pr{background:linear-gradient(90deg,#2ef2ff,#ff3dd8);color:#0a0718;border:0;box-shadow:0 0 18px #2ef2ff66}
#pt4 .big{width:100%;margin-top:10px;text-align:left;display:flex;align-items:center;gap:12px;padding:14px;border-radius:16px;border:1px solid #2c2558;background:#15112d;color:inherit;font:inherit}
#pt4 .big b{display:block;font-size:1.05rem}#pt4 .big small{color:#a39cd0}
#pt4 .big .e{font-size:1.8rem}
#pt4 .seat{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:14px;border:2px solid var(--sc);background:#15112d;margin-top:8px}
#pt4 .seat .av{width:40px;flex:none}#pt4 .seat b{flex:1}
#pt4 .seat select{font:inherit;padding:7px;border-radius:10px;background:#0d0b1f;color:inherit;border:1px solid #2c2558}
#pt4 .code{font-family:var(--mono,monospace);font-size:3.4rem;letter-spacing:.25em;text-align:center;margin:8px 0;color:#2ef2ff;text-shadow:0 0 12px #2ef2ff}
#pt4 input.ci{font:inherit;font-size:1.2rem;letter-spacing:.2em;text-transform:uppercase;padding:10px;border-radius:12px;border:1px solid #2c2558;background:#0d0b1f;color:inherit;width:9ch;text-align:center}
#pt4 .err{color:#ff8a70;text-align:center}
#pt4 .podium{list-style:none;padding:0;margin:8px 0}#pt4 .podium li{display:flex;align-items:center;gap:10px;padding:8px;border-radius:12px;background:#15112d;margin-top:6px;border-left:4px solid var(--sc)}
#pt4 .podium .av{width:34px}#pt4 .podium b{flex:1}
#pt4 .chips{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;margin-top:6px}
#pt4 .chips button{padding:7px 11px;border-radius:999px;border:1px solid #2c2558;background:#15112d;color:inherit;font:inherit;font-size:.82rem}
#pt4 .note{color:#a39cd0;font-size:.85rem;text-align:center}
#pt4 .join4{margin-top:12px;padding:14px;border-radius:16px;border:2px solid #2ef2ff;background:#15112d;box-shadow:0 0 16px #2ef2ff44;text-align:center}
#pt4 .join4 b{display:block;font-size:1.1rem}#pt4 .join4 small{color:#a39cd0}
#pt4 .join4 input{display:block;margin:10px auto 0;width:100%;max-width:260px;font-family:var(--mono,monospace);font-size:2.4rem;letter-spacing:.4em;text-align:center;padding:10px;border-radius:14px;border:1px solid #2c2558;background:#0d0b1f;color:#2ef2ff;text-shadow:0 0 10px #2ef2ff}
#toast,.toast{z-index:90!important}
`;
  function mount() {
    if (root) return root;
    if (!document.getElementById('pt4css')) { const s = document.createElement('style'); s.id = 'pt4css'; s.textContent = CSS; document.head.appendChild(s); }
    root = document.createElement('div'); root.id = 'pt4'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', tr('Partie à 4'));
    document.body.appendChild(root);
    root.addEventListener('click', onClick);
    root.addEventListener('change', onChange);
    root.addEventListener('input', onInput);
    clearInterval(tick); tick = setInterval(onTick, 250);
    return root;
  }
  const av = (skin) => `<div class="av">${pawnSVG(cleanSkin(skin))}</div>`;
  function seatCard(i) {
    const s = PT.seats[i]; if (!s || s.kind === 'off') return `<div class="pc" style="--sc:#444;visibility:hidden"></div>`;
    const on = !PT.over && PT.turn === i, out = !PT.alive[i];
    const b = UI.bubbles[i] && UI.bubbles[i].until > Date.now() ? `<div class="bub">${esc4(UI.bubbles[i].tx)}</div>` : '';
    const tag = s.kind === 'ai' ? tr('Ordinateur') : (NET && NET.seat === i) || (!NET && i === mySeat()) ? tr('Toi') : '';
    return `<div class="pc${on ? ' on' : ''}${out ? ' out' : ''}" style="--sc:${SEATC[i]}">${b}${av(s.skin)}<div style="min-width:0"><b>${esc4(s.name)}</b><small>${out ? '✖ ' + tr('Éliminé') : (PT.J[i] ? '↷'.repeat(PT.J[i]) + ' ' : '') + tag}</small></div>${on ? `<div class="tm" data-tm="${i}"></div>` : ''}</div>`;
  }
  function canAct() {
    if (!PT || PT.over || PT.turn < 0) return false;
    const s = PT.seats[PT.turn];
    if (NET) return NET.seat === PT.turn;
    return s.kind === 'human';
  }
  function drawGame() {
    const my = canAct(), ms = my ? gen(PT, PT.turn) : [];
    const tg = new Map(); if (my && UI.sel != null) ms.filter(m => m[0] === UI.sel).forEach(m => tg.set(m[1], m[2]));
    const cells = PT.cells.map((v, i) => `<button type="button" class="cl${v === 0 ? ' h' : ''}${tg.has(i) ? (tg.get(i) ? ' tj' : ' t') : ''}${PT.last && PT.last.from === i ? ' fr' : ''}" data-c="${i}" style="--tc:${v === 1 ? '#2ef2ff' : v === 2 ? '#ff3dd8' : '#b6ff3b'}" aria-label="${v ? tr('case') + ' ' + v : tr('trou')}">${v || ''}</button>`).join('');
    const pawns = PT.pawns.map((ps, s) => ps.map((pos, k) => {
      const r = Math.floor(pos / N), c = pos % N;
      return `<div class="pw${my && s === PT.turn && UI.sel === k ? ' sel' : ''}" style="--sc:${SEATC[s]};left:calc(6px + ${c} * (100% - 12px) / 6);top:calc(6px + ${r} * (100% - 12px) / 6)"><span class="rg"></span>${pawnSVG(cleanSkin(PT.seats[s].skin))}</div>`;
    }).join('')).join('');
    const turnName = PT.turn >= 0 && PT.seats[PT.turn] ? PT.seats[PT.turn].name : '';
    const many = !NET && PT.seats.filter(x => x.kind === 'human').length > 1;
    const status = PT.over ? '' : my ? (many ? `<b style="color:${SEATC[PT.turn]}">${esc4(turnName)}</b> : ${UI.sel == null ? tr('choisis un pion') : tr('touche une case marquée')}` : (UI.sel == null ? tr('À toi : choisis un pion') : tr('Touche une case marquée'))) : `${tr('Au tour de')} ${esc4(turnName)}…`;
    let end = '';
    if (PT.over) {
      const rows = (PT.rank || []).map((s, i) => `<li style="--sc:${SEATC[s]}"><span>${['🥇', '🥈', '🥉', '4'][i]}</span>${av(PT.seats[s].skin)}<b>${esc4(PT.seats[s].name)}</b><span>+${PT.pts ? PT.pts[s] : 0} pts</span></li>`).join('');
      const me = mySeat(), r = PT.rank ? PT.rank.indexOf(me) : -1;
      end = `<ol class="podium">${rows}</ol>${r >= 0 ? `<p class="note">+${RANKCOINS[r]} ${tr('pièces')}</p>` : ''}<div class="acts">${isReferee() ? `<button class="btn pr" data-a="again">${tr('Rejouer')}</button>` : ''}<button class="btn" data-a="close">${tr('Quitter')}</button></div>`;
    }
    const chat = NET && !PT.over ? `<button class="btn" data-a="chat">💬 ${tr('Chat')}</button>` : '';
    const chips = UI.chat && typeof myPiques === 'function' ? `<div class="chips">${[...myPiques(), ...Object.keys(PHRASES.pol.l), ...Object.keys(PHRASES.enc.l)].map(id => `<button data-a="say" data-v="${id}">${esc4(phText(id))}</button>`).join('')}</div>` : '';
    return `<div class="bar"><button class="x" data-a="close" aria-label="${tr('Quitter')}">✕</button><h2>${tr('Partie à 4')}</h2></div>
      <div class="rows">${seatCard(1)}${seatCard(2)}</div>
      <div class="bd" id="pt4bd">${cells}${pawns}</div>
      <div class="rows bottom">${seatCard(0)}${seatCard(3)}</div>
      <p class="st">${PT.msg ? `<b>${esc4(PT.msg)}</b><br>` : ''}${status}</p>
      ${end}${PT.over ? '' : `<div class="acts">${chat}</div>${chips}`}`;
  }
  function drawMenu() {
    if (!UI.seats) UI.seats = [meSeat(), { kind: 'ai', ...botSeat(1) }, { kind: 'ai', ...botSeat(2) }, { kind: 'ai', ...botSeat(3) }];
    const opt = (i, v, l) => `<option value="${v}" ${UI.seats[i].kind === v ? 'selected' : ''}>${l}</option>`;
    const seatRow = (i) => `<div class="seat" style="--sc:${SEATC[i]}">${av(UI.seats[i].skin || P.skin)}<b>${i === 0 ? esc4(P.name) : UI.seats[i].kind === 'human' ? tr('Joueur') + ' ' + (i + 1) : UI.seats[i].kind === 'ai' ? esc4(UI.seats[i].name) : '—'}</b>${i === 0 ? `<span class="note">${tr('Toi')}</span>` : `<select data-seat="${i}">${opt(i, 'human', tr('Humain'))}${opt(i, 'ai', tr('Ordinateur'))}${opt(i, 'off', tr('Vide'))}</select>`}</div>`;
    return `<div class="bar"><button class="x" data-a="close" aria-label="${tr('Retour')}">✕</button><h2>${tr('Partie à 4')}</h2></div>
      <p class="note">${tr('Jusqu\'à 4 joueurs sur un plateau 6×6, un pion et deux sauts chacun. Bloqué à ton tour : éliminé. Le dernier debout gagne.')}</p>
      <div class="join4"><b>🔑 ${tr('Rejoindre une salle')}</b><small>${tr('Tape le code que ton ami t\'a donné.')}</small>
        <input id="pt4code" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="• • • •" autocomplete="off" aria-label="${tr('Code de la salle')}"></div>
      <button class="big" data-a="room"><span class="e">👥</span><div><b>${tr('Créer une salle')}</b><small>${tr('Tu donnes le code à tes amis, ils le tapent, tu lances.')}</small></div></button>
      <h3 style="margin:18px 0 0">📱 ${tr('Sur ce téléphone')}</h3>
      ${[0, 1, 2, 3].map(seatRow).join('')}
      <button class="btn pr" style="width:100%;margin-top:12px" data-a="local">${tr('Lancer la partie')}</button>`;
  }
  function botSeat(i) { const k = BOTKEYS[[0, 3, 5][i - 1] ?? 0]; return { name: BOTS[k].name, skin: BOTS[k].skin }; }
  function drawLobby() {
    const host = NET && NET.host;
    const seats = host ? NET.seats : (UI.lobby ? UI.lobby.seats : [null, null, null, null]);
    const code = host ? NET.code : (UI.lobby ? UI.lobby.code : NET && NET.code);
    const quick = host ? NET.quick : (UI.lobby && UI.lobby.quick) || (NET && NET.quick);
    const wait = host ? Math.max(0, NET.startAt - Date.now()) : UI.lobby ? Math.max(0, (UI.lobby.wait || 0) - (Date.now() - UI.lobbyAt)) : 0;
    const rows = [0, 1, 2, 3].map(i => { const s = seats && seats[i]; return `<div class="seat" style="--sc:${SEATC[i]}">${s ? av(s.skin) : '<div class="av"></div>'}<b>${s ? esc4(s.name) : `<span class="note">${tr('En attente…')}</span>`}</b>${NET && NET.seat === i ? `<span class="note">${tr('Toi')}</span>` : ''}</div>`; }).join('');
    const n = (seats || []).filter(Boolean).length;
    return `<div class="bar"><button class="x" data-a="close" aria-label="${tr('Retour')}">✕</button><h2>${quick ? tr('Partie rapide') : tr('Salle privée')}</h2></div>
      ${UI.err ? `<p class="err">${esc4(UI.err)}</p>` : ''}
      ${!quick && code ? `<p class="note">${host ? tr('Dis ce code à tes amis : ils le tapent dans Partie à 4.') : tr('Code de la salle')}</p><div class="code">${esc4(String(code).toUpperCase())}</div>${host ? `<div class="acts"><button class="btn" data-a="copy">${tr('Copier le code')}</button><button class="btn" data-a="share">${tr('Partager le lien')}</button></div>` : ''}` : ''}
      ${quick ? `<p class="note" data-wait="1">${tr('Recherche de joueurs…')} ${Math.ceil(wait / 1000)} s · ${tr('ensuite, des ordinateurs complètent la table.')}</p>` : ''}
      ${rows}
      ${host && !quick ? `<button class="btn pr" style="width:100%;margin-top:12px" data-a="start" ${n < 2 ? 'disabled' : ''}>${tr('Lancer la partie')} (${n}/4)</button><p class="note">${tr('Les places vides seront jouées par l\'ordinateur.')}</p>` : ''}
      ${!host && !quick ? `<p class="note">${tr('L\'hôte lance la partie quand tout le monde est là.')}</p>` : ''}`;
  }
  function draw() {
    if (!root) return;
    const st = root.scrollTop;
    root.innerHTML = UI.stage === 'game' && PT ? drawGame() : UI.stage === 'lobby' ? drawLobby() : drawMenu();
    root.scrollTop = st;
    drawTimer();
  }
  function drawTimer() {
    if (!root) return;
    if (UI.stage === 'game' && PT && !PT.over) { const el = root.querySelector('[data-tm]'); if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, (PT.deadline - Date.now()) / TURN_MS))})`; }
    if (UI.stage === 'lobby') {
      const el = root.querySelector('[data-wait]');
      if (el && NET) { const w = NET.host ? Math.max(0, NET.startAt - Date.now()) : UI.lobby ? Math.max(0, (UI.lobby.wait || 0) - (Date.now() - UI.lobbyAt)) : 0; el.textContent = `${tr('Recherche de joueurs…')} ${Math.ceil(w / 1000)} s · ${tr('ensuite, des ordinateurs complètent la table.')}`; }
      if (NET && NET.host && NET.quick && !NET.started && Date.now() > NET.startAt) startOnline();
    }
  }

  /* ---------- Actions ---------- */
  function onCell(i) {
    if (!canAct()) return;
    const s = PT.turn, ms = gen(PT, s);
    const k = PT.pawns[s].indexOf(i);
    if (k >= 0 && ms.some(m => m[0] === k)) { UI.sel = k; draw(); return; }
    if (UI.sel == null) return;
    const m = ms.find(x => x[0] === UI.sel && x[1] === i); if (!m) return;
    if (NET && !NET.host) { try { NET.conn.send({ t: 'mv', m }); } catch (e) {} UI.sel = null; return; }
    play(s, m);
  }
  function onClick(e) {
    const c = e.target.closest('[data-c]'); if (c) { onCell(+c.dataset.c); return; }
    const b = e.target.closest('[data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') return close();
    if (a === 'local') { leaveNet(); const seats = UI.seats.map((s, i) => s.kind === 'human' ? { kind: 'human', name: i === 0 ? P.name : tr('Joueur') + ' ' + (i + 1), skin: i === 0 ? P.skin : { ...P.skin, color: ['azur', 'corail', 'rose', 'or'][i] } } : s.kind === 'ai' ? { kind: 'ai', ...botSeat(i) } : { kind: 'off' });
      if (seats.filter(s => s.kind !== 'off').length < 2) { toast(tr('Il faut au moins 2 joueurs.')); return; } newGame(seats); return; }
    if (a === 'quick') return quickMatch(0);
    if (a === 'room') return hostRoom(roomCode(), false);
    if (a === 'copy') return copyCode();
    if (a === 'start') return startOnline();
    if (a === 'share') return share();
    if (a === 'again') { if (NET && NET.host) { const seats = PT.seats.map(s => ({ ...s })); newGame(seats); } else if (!NET) newGame(PT.seats.map(s => ({ ...s }))); return; }
    if (a === 'chat') { UI.chat = !UI.chat; draw(); return; }
    if (a === 'say') return sendPhrase(b.dataset.v);
  }
  function onInput(e) {
    if (e.target.id !== 'pt4code') return;
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 4); e.target.value = v;
    if (v.length === 4) { e.target.blur(); joinRoom('lastep-r4-' + v, false); }
  }
  async function copyCode() {
    if (!NET || !NET.code) return;
    try { await navigator.clipboard.writeText(NET.code); toast(tr('Code copié')); } catch (e) { toast(tr('Copie impossible')); }
  }
  function onChange(e) {
    const s = e.target.closest('[data-seat]'); if (!s) return;
    const i = +s.dataset.seat, k = s.value;
    UI.seats[i] = k === 'ai' ? { kind: 'ai', ...botSeat(i) } : k === 'human' ? { kind: 'human', skin: { ...P.skin, color: ['azur', 'corail', 'rose', 'or'][i] } } : { kind: 'off' };
    draw();
  }
  async function share() {
    if (!NET || !NET.code) return;
    const url = `${location.origin}${location.pathname}?r4=${NET.code}`, text = `${tr('Viens jouer à 4 sur Lastep ! Code de la salle :')} ${NET.code}`;
    try { if (navigator.share) { await navigator.share({ title: 'Lastep', text, url }); return; } } catch (e) { return; }
    try { await navigator.clipboard.writeText(`${text}\n${url}`); toast(tr('Lien copié')); } catch (e) { toast(tr('Copie impossible')); }
  }
  function open(stage) {
    try { if (typeof leaveOnline === 'function' && typeof net !== 'undefined' && net) leaveOnline(); } catch (e) {}
    mount(); UI.stage = stage || 'menu'; UI.err = ''; draw();
  }
  function close() {
    leaveNet(); clearTimeout(aiTimer); clearInterval(tick); tick = null;
    PT = null; UI = { stage: 'menu', sel: null, seats: null, err: '', bubbles: {} };
    try { musicStop(); } catch (e) {}
    if (root) { root.remove(); root = null; }
    try { render(); } catch (e) {}
  }
  window.Party = {
    open, close,
    joinCode(code) { open('lobby'); joinRoom('lastep-r4-' + String(code).toLowerCase(), false); },
    get state() { return PT; }, get net() { return NET; },
    _gen: gen, _ai: aiPick,
  };
})();
