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
          if (occ.has(i) || st.cells[i] === 0) { if (!st.J[s]) break; crossed = true; continue; }
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

  /* ---------- Partie en manches ---------- */
  // Une manche par joueur : chacun commence une fois. Classement de la partie : manches gagnées, puis points.
  // Égalité parfaite : plusieurs vainqueurs. Points d'une manche : 10 / 5 / 2 / 0 selon la place,
  // + bonus cases : le vainqueur prend la somme des cases restantes jusqu'à 10 ; s'il en reste moins de 10, le 2e reçoit la différence.
  const RPTS = [10, 5, 2, 0];
  const stopped = () => !PT || PT.over || PT.rOver;

  /* ---------- Mode folie : les mêmes pouvoirs qu'en duel ---------- */
  // Vestiaire de 10 s avant la 1re manche (2 emplacements, Saut + Saut par défaut), chaque emplacement sert une fois par manche.
  // Pousser, Inversion (attaques), Poids lourd, Mur (défenses automatiques), Mine (posée à côté, invisible après 5 s : le pion qui marche dessus perd la manche).
  const PRE_MS = 10000, MINE_SEE = 5000;
  const PWE = { jump: '🦘', push: '💥', swap: '🔄', heavy: '🏋️', wall: '🧱', mine: '💣' };
  const pwName = (k) => tr((typeof PW !== 'undefined' && PW[k]) ? PW[k].n : k);
  const slotsOf4 = (s) => (PT && PT.sl && Array.isArray(PT.sl[s])) ? PT.sl[s] : ['jump', 'jump'];
  const clean4 = (x) => (typeof cleanSlots === 'function' ? cleanSlots(x) : ['jump', 'jump']);
  const powN4 = (s, k) => k === 'jump' ? ((PT && PT.J && PT.J[s]) || 0) : ((PT && PT.pl && PT.pl[s] && PT.pl[s][k]) || 0);
  const can = (s, k) => !!(PT && PT.fol && !PT.pre && !stopped() && powN4(s, k) > 0);
  function spend(s, k) {
    if (k !== 'jump') PT.pl[s][k] = Math.max(0, powN4(s, k) - 1);
    PT.used = PT.used || [{}, {}, {}, {}]; PT.used[s] = { ...(PT.used[s] || {}), [k]: 1 };
  }
  const nb = (i) => { const r = Math.floor(i / N), c = i % N, out = []; for (const [dr, dc] of DIRS) { const rr = r + dr, cc = c + dc; if (rr >= 0 && cc >= 0 && rr < N && cc < N) out.push({ i: rr * N + cc, dr, dc }); } return out; };
  const seatAt = (st, i) => st.pawns.findIndex(p => p.includes(i));
  const mineAt4 = (i) => (PT.mines || []).find(m => m.i === i);
  function pushTargets(st, s) {
    const out = []; if (!can(s, 'push')) return out; const a = st.pawns[s] && st.pawns[s][0]; if (a == null) return out;
    for (const n of nb(a)) { const o = seatAt(st, n.i); if (o < 0 || o === s) continue;
      const r = Math.floor(n.i / N) + n.dr, c = n.i % N + n.dc; if (r < 0 || c < 0 || r >= N || c >= N) continue;
      const c2 = r * N + c; if (seatAt(st, c2) >= 0) continue; out.push({ a, b: n.i, c: c2, o }); }
    return out;
  }
  function swapTargets(st, s) {
    const out = []; if (!can(s, 'swap')) return out; const a = st.pawns[s] && st.pawns[s][0]; if (a == null) return out;
    for (const n of nb(a)) { const o = seatAt(st, n.i); if (o >= 0 && o !== s) out.push({ a, b: n.i, o }); }
    return out;
  }
  function mineTargets(st, s) {
    if (!can(s, 'mine')) return []; const a = st.pawns[s] && st.pawns[s][0]; if (a == null) return [];
    return nb(a).map(n => n.i).filter(i => st.cells[i] > 0 && seatAt(st, i) < 0 && !(st.mines || []).some(m => m.i === i));
  }
  const evN = () => PT.round + ':' + PT.moves + ':' + rid(3);
  function heavy(s, o, at, a, kind) {
    if (powN4(o, 'heavy') <= 0) return false;
    spend(o, 'heavy'); PT.msg = `🏋️ ${PT.seats[o].name} ${tr('est un poids lourd : rien ne bouge, le pouvoir est perdu !')}`; PT.ev = { k: 'heavy', by: s, vic: o, at, a, kind, n: evN() };
    try { sfx.round(); } catch (e) {} return true;
  }
  function endAct(s) { PT.timeouts[s] = 0; PT.moves++; nextTurn(false); return true; }
  function pushAct(s, b) {
    if (stopped() || s !== PT.turn) return false; const tg = pushTargets(PT, s).find(x => x.b === b); if (!tg) return false;
    spend(s, 'push'); if (heavy(s, tg.o, b, tg.a, 'push')) return endAct(s);
    PT.cells[tg.a]--; PT.pawns[s][0] = tg.b; PT.last = { s, from: tg.a, to: tg.b, jump: 0 };
    if (PT.cells[tg.c] === 0) { eliminate(tg.o, 'push'); PT.msg = `💥 ${PT.seats[s].name} ${tr('pousse')} ${PT.seats[tg.o].name} ${tr('dans le vide : éliminé !')}`; PT.ev = { k: 'push', by: s, vic: tg.o, a: tg.a, b: tg.b, c: tg.c, at: tg.c, dead: 1, n: evN() }; }
    else { PT.pawns[tg.o][0] = tg.c; PT.msg = `💥 ${PT.seats[s].name} ${tr('pousse')} ${PT.seats[tg.o].name} !`; PT.ev = { k: 'push', by: s, vic: tg.o, a: tg.a, b: tg.b, c: tg.c, at: tg.c, n: evN() }; mineHit(tg.o, tg.c); }
    try { sfx.wizz(); } catch (e) {} return endAct(s);
  }
  function swapAct(s, b) {
    if (stopped() || s !== PT.turn) return false; const tg = swapTargets(PT, s).find(x => x.b === b); if (!tg) return false;
    spend(s, 'swap'); if (heavy(s, tg.o, b, tg.a, 'swap')) return endAct(s);
    PT.cells[tg.a]--; PT.pawns[s][0] = tg.b; PT.last = { s, from: tg.a, to: tg.b, jump: 0 }; const dead = PT.cells[tg.a] === 0;
    if (dead) { eliminate(tg.o, 'push'); PT.msg = `🔄 ${PT.seats[s].name} ${tr('échange sa place avec')} ${PT.seats[tg.o].name}… ${tr('qui tombe dans le trou !')}`; }
    else { PT.pawns[tg.o][0] = tg.a; PT.msg = `🔄 ${PT.seats[s].name} ${tr('échange sa place avec')} ${PT.seats[tg.o].name} !`; }
    PT.ev = { k: 'swap', by: s, vic: tg.o, a: tg.a, b: tg.b, at: b, dead, n: evN() }; try { sfx.jump(); } catch (e) {} return endAct(s);
  }
  function mineAct(s, i) {
    if (stopped() || s !== PT.turn || !mineTargets(PT, s).includes(i)) return false;
    spend(s, 'mine'); const id = evN(); (PT.mines = PT.mines || []).push({ i, by: s, life: 2, id });
    PT.msg = `💣 ${PT.seats[s].name} ${tr('pose une mine… regarde bien, elle disparaît dans 5 secondes !')}`; PT.ev = { k: 'minep', by: s, at: i, n: id };
    try { sfx.jump(); } catch (e) {} return endAct(s);
  }
  // un pion arrive sur une mine : il saute, son joueur perd la manche
  function mineHit(s, i) {
    const m = mineAt4(i); if (!m) return false;
    PT.mines = PT.mines.filter(x => x !== m); eliminate(s, 'mine'); PT.ev = { k: 'mine', by: s, vic: s, at: i, n: evN() };
    try { vibrate([80, 40, 120]); } catch (e) {} return true;
  }
  // Mur : sauter par-dessus un joueur qui a un Mur est refusé (tour perdu)
  function wallStop(s, m) {
    if (!PT.fol || !m[2]) return false;
    const f = PT.pawns[s][m[0]], dr = Math.sign(Math.floor(m[1] / N) - Math.floor(f / N)), dc = Math.sign(m[1] % N - f % N);
    for (let i = f + dr * N + dc; i !== m[1]; i += dr * N + dc) { const o = seatAt(PT, i);
      if (o >= 0 && o !== s && powN4(o, 'wall') > 0) { spend(o, 'wall'); PT.J[s] = Math.max(0, PT.J[s] - 1); PT.msg = `🧱 ${PT.seats[o].name} ${tr('a un mur : impossible de sauter par-dessus !')}`; PT.ev = { k: 'wall', by: s, at: i, from: f, to: m[1], n: evN() }; try { sfx.round(); } catch (e) {} endAct(s); return true; } }
    return false;
  }
  // l'inventaire de chaque joueur baisse une fois par pouvoir et par partie (sur son propre téléphone)
  function invSync() {
    const me = mySeat(); if (me == null || !PT || !PT.fol || !PT.used || !PT.used[me]) return;
    UI.inv = UI.inv && UI.inv.id === PT.mid ? UI.inv : { id: PT.mid, k: {} };
    for (const k in PT.used[me]) if (!UI.inv.k[k]) { UI.inv.k[k] = 1; if (k !== 'jump') { try { pwUse(k); } catch (e) {} } }
  }
  const pwOK = (k) => k === 'jump' || (typeof pwHas === 'function' && pwHas(k));
  function ldSend(sel) {
    const s = clean4((sel || []).filter(pwOK)); UI.ldDone = s; UI.ldSel = null;
    if (NET && !NET.host) { try { NET.conn.send({ t: 'ld', s }); } catch (e) {} }
    else if (PT) { PT.sl[mySeat()] = s; preCheck(); }
    draw();
  }
  // l'arbitre lance la 1re manche quand tous les humains ont choisi, ou au bout de 10 s
  function preCheck() {
    if (!PT || !PT.pre || !isReferee()) return;
    const ready = PT.seats.every((x, i) => !PT.inGame[i] || x.kind === 'ai' || PT.sl[i]);
    if (ready || Date.now() >= PT.preEnd) { PT.sl = PT.sl.map((x, i) => x || ['jump', 'jump']); PT.pre = false; startRoundPlay(); }
    else { PT.ver++; broadcast(); draw(); }
  }
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
  function newGame(seats, first, fol) {
    const inGame = seats.map(s => s.kind !== 'off');
    PT = {
      id: rid(6), mid: rid(6), seats: seats.map(s => ({ ...s })), inGame, first: first || 0, fol: !!fol,
      round: 0, R: inGame.filter(Boolean).length, wins: [0, 0, 0, 0], score: [0, 0, 0, 0], hist: [], sl: [null, null, null, null], used: [{}, {}, {}, {}],
      over: false, rOver: false, pre: false, preEnd: 0, nextAt: 0, ver: 0,
    };
    PT.mid = PT.id;
    UI.stage = 'game'; UI.sel = null; UI.bubbles = {}; UI.wz = null; UI.wzLeft = 3; UI.wzLast = 0; UI.ldDone = null; UI.ldSel = fol ? [] : null; UI.mine = false;
    try { if (typeof MUSIC !== 'undefined' && MUSIC.el) MUSIC.el.currentTime = 0; if (typeof musicStart === 'function') musicStart(); } catch (e) {}
    startRound();
  }
  function startRound() {
    PT.round++;
    const alive = PT.inGame.slice(), act = [0, 1, 2, 3].filter(i => alive[i]);
    Object.assign(PT, { cells: newBoard(), pawns: START.map((p, i) => alive[i] ? p.slice() : []), alive, place: [], J: [JUMPS, JUMPS, JUMPS, JUMPS], pl: [{}, {}, {}, {}], mines: [],
      turn: -1, moves: 0, last: null, msg: '', ev: null, rOver: false, winner: null, rank: null, pts: null, sum: 0, deadline: 0, timeouts: [0, 0, 0, 0] });
    PT.startSeat = act[(PT.first + PT.round - 1) % act.length];   // chacun commence une manche
    UI.sel = null; UI.mine = false;
    if (PT.fol && PT.round === 1) { PT.pre = true; PT.preEnd = Date.now() + PRE_MS; PT.J = [0, 0, 0, 0]; PT.ver++; broadcast(); draw(); return; }
    startRoundPlay();
  }
  function startRoundPlay() {
    if (PT.fol) { PT.pl = [0, 1, 2, 3].map(s => { const o = {}; for (const k of slotsOf4(s)) o[k] = (o[k] || 0) + 1; return o; }); PT.J = [0, 1, 2, 3].map(s => PT.pl[s].jump || 0); }
    PT.msg = `${tr('Manche')} ${PT.round}/${PT.R} · ${PT.seats[PT.startSeat].name} ${tr('commence')}`;
    nextTurn(true);
  }
  function aliveSeats() { return [0, 1, 2, 3].filter(i => PT.alive[i]); }
  function eliminate(s, why) {
    PT.alive[s] = false; PT.place.push(s); PT.pawns[s] = []; PT.mines = (PT.mines || []).filter(m => m.by !== s);
    PT.msg = `${PT.seats[s].name} ${tr(why === 'afk' ? 'est éliminé (absent).' : why === 'mine' ? 'marche sur une mine : éliminé !' : why === 'push' ? 'est éliminé !' : 'est bloqué : éliminé !')}`;
    try { sfx.fall(); } catch (e) {}
  }
  const canAnything = (s) => gen(PT, s).length || (PT.fol && (pushTargets(PT, s).length || swapTargets(PT, s).length || mineTargets(PT, s).length));
  function nextTurn(first) {
    if (stopped()) return;
    let s = first ? (PT.startSeat + 3) % 4 : PT.turn;
    for (let guard = 0; guard < 8; guard++) {
      if (aliveSeats().length <= 1) return finish();
      s = (s + 1) % 4;
      if (!PT.alive[s]) continue;
      if (PT.mines && PT.mines.length) { for (const m of PT.mines) if (m.by === s) m.life--; PT.mines = PT.mines.filter(m => m.life > 0); }   // la mine disparaît au 2e tour de son poseur
      if (!canAnything(s)) { eliminate(s); continue; }
      PT.turn = s; PT.deadline = Date.now() + TURN_MS; PT.ver++;
      UI.sel = null; UI.mine = false;
      const ks = [...new Set(gen(PT, s).map(m => m[0]))]; if (ks.length === 1) UI.sel = ks[0];
      broadcast(); draw(); scheduleBot();
      return;
    }
    finish();
  }
  function scheduleBot() {
    clearTimeout(aiTimer);
    if (stopped() || PT.turn < 0) return;
    const seat = PT.seats[PT.turn];
    if (seat.kind === 'ai') { const ver = PT.ver; aiTimer = setTimeout(() => { if (PT && PT.ver === ver && !stopped()) { const m = aiPick(PT, PT.turn); if (m) play(PT.turn, m); else nextTurn(false); } }, 650 + Math.random() * 600); }
  }
  function play(s, m) {
    if (stopped() || s !== PT.turn) return false;
    const ok = gen(PT, s).some(x => x[0] === m[0] && x[1] === m[1] && x[2] === m[2]); if (!ok) return false;
    if (wallStop(s, m)) return true;
    const from = applyMove(PT, s, m);
    PT.last = { s, from, to: m[1], jump: m[2] }; PT.moves++; PT.msg = m[2] ? `${PT.seats[s].name} ${tr('utilise son saut ↷')}` : '';
    PT.timeouts[s] = 0; PT.ev = null;
    try { sfx.move(); if (PT.cells[from] === 0) setTimeout(() => sfx.fall(), 200); if (m[2]) sfx.jump(); } catch (e) {}
    mineHit(s, m[1]);
    nextTurn(false);
    return true;
  }
  // fin de manche : places, points, bonus cases
  function finish() {
    clearTimeout(aiTimer);
    const left = aliveSeats(), w = left.length ? left[0] : PT.place[PT.place.length - 1];
    const rank = [w, ...PT.place.slice().reverse().filter(x => x !== w)];
    const vs = visibleSum(PT), bonus = Math.min(10, vs), pts = {};
    rank.forEach((s, i) => { pts[s] = RPTS[i] ?? 0; });
    pts[w] += bonus; if (bonus < 10 && rank[1] != null) pts[rank[1]] += 10 - bonus;
    rank.forEach(s => { PT.score[s] += pts[s]; }); PT.wins[w]++;
    PT.winner = w; PT.rank = rank; PT.pts = pts; PT.sum = vs; PT.hist.push({ w, pts, sum: vs }); PT.rOver = true;
    if (PT.round >= PT.R) matchEnd();
    else { PT.nextAt = Date.now() + 8000; PT.msg = `${PT.seats[w].name} ${tr('remporte la manche')} ${PT.round} !`; }
    PT.ver++;
    try { sfx.round(); } catch (e) {}
    broadcast(); draw();
  }
  function matchEnd() {
    const seats = [0, 1, 2, 3].filter(i => PT.inGame[i]).sort((a, b) => PT.wins[b] - PT.wins[a] || PT.score[b] - PT.score[a]);
    const top = seats.filter(i => PT.wins[i] === PT.wins[seats[0]] && PT.score[i] === PT.score[seats[0]]);
    PT.final = seats; PT.champs = top; PT.over = true;
    const solo = !(!NET && PT.seats.filter(x => x.kind === 'human').length > 1);
    PT.msg = top.length > 1 ? `${top.map(i => PT.seats[i].name).join(' & ')} ${tr('sont vainqueurs ex aequo !')}` : top[0] === mySeat() && solo ? tr('Tu remportes la partie !') : `${PT.seats[top[0]].name} ${tr('remporte la partie !')}`;
    reward();
    try { if (mySeat() != null && typeof badge === 'function') badge('fete'); } catch (e) {}
  }
  function nextRound() { if (!PT || !isReferee() || !PT.rOver || PT.over) return; startRound(); }
  function reward() {
    const me = mySeat(); if (me == null || !PT.final) return;
    const r = PT.champs.includes(me) ? 0 : PT.final.indexOf(me); if (r < 0) return;
    try { P.coins = (P.coins || 0) + RANKCOINS[r]; saveP(); } catch (e) {}
  }
  function onTick() {
    if (!PT || PT.over) { drawTimer(); return; }
    drawTimer();
    if (PT.pre) { if (isReferee() && Date.now() >= PT.preEnd) preCheck(); else if (UI.ldSel && Date.now() >= PT.preEnd) ldSend(UI.ldSel); return; }
    if (PT.rOver) { if (isReferee() && Date.now() >= PT.nextAt) nextRound(); return; }
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
      turn: PT.turn, moves: PT.moves, last: PT.last, msg: PT.msg, fol: PT.fol, ev: PT.ev, used: PT.used, sl: PT.sl, pl: PT.pl, mines: PT.mines || [], over: PT.over, rOver: PT.rOver, winner: PT.winner, rank: PT.rank, pts: PT.pts, sum: PT.sum,
      mid: PT.mid, inGame: PT.inGame, round: PT.round, R: PT.R, wins: PT.wins, score: PT.score, hist: PT.hist, final: PT.final, champs: PT.champs, first: PT.first, startSeat: PT.startSeat,
      pre: PT.pre, preLeft: PT.pre ? Math.max(0, PT.preEnd - Date.now()) : 0, nextLeft: PT.rOver ? Math.max(0, PT.nextAt - Date.now()) : 0, left: Math.max(0, PT.deadline - Date.now()), ver: PT.ver };
  }
  function broadcast() {
    invSync();
    if (!NET || !NET.host || !PT) return;
    const st = packState();
    for (const s in NET.conns) { try { NET.conns[s].send({ t: 'st', st, you: +s }); } catch (e) {} }
  }
  function lobbyMsg() { return { t: 'lobby', seats: NET.seats.map(s => s && { kind: s.kind, name: s.name, skin: s.skin }), code: NET.code, quick: NET.quick, fol: !NET.quick && !!UI.fol, wait: NET.quick ? Math.max(0, NET.startAt - Date.now()) : 0 }; }
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
    if (d.t === 'push' && PT) pushAct(s, d.b | 0);
    if (d.t === 'swap' && PT) swapAct(s, d.b | 0);
    if (d.t === 'mine' && PT) mineAct(s, d.i | 0);
    if (d.t === 'ld' && PT && PT.fol && PT.pre) { PT.sl[s] = clean4(d.s); preCheck(); }
    if (d.t === 'chat') { const id = String(d.id || ''); if (typeof phText === 'function' && phText(id)) { showBubble(s, id); relay({ t: 'chat', s, id }, s); } }
    if (d.t === 'wz' && WZE[d.k] && PT && PT.seats[d.to | 0]) { const m = { t: 'wz', f: s, to: d.to | 0, k: d.k }; relay(m, s); gotWz(m.f, m.to, m.k); }
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
    newGame(seats, 0, !me.quick && !!UI.fol);
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
      PT = { ...st, deadline: Date.now() + (st.left || 0), preEnd: Date.now() + (st.preLeft || 0), nextAt: Date.now() + (st.nextLeft || 0), timeouts: [0, 0, 0, 0] };
      if (isNew) { UI.stage = 'game'; UI.bubbles = {}; UI.wz = null; UI.wzLeft = 3; UI.wzLast = 0; UI.ldDone = null; UI.ldSel = st.fol && st.pre ? [] : null; try { if (typeof MUSIC !== 'undefined' && MUSIC.el) MUSIC.el.currentTime = 0; musicStart(); } catch (e) {} }
      if (prev && !isNew && st.moves === prev.moves + 1) { try { if (st.ev && st.ev.k === 'push') { sfx.wizz(); if (st.ev.dead) vibrate([120, 60, 200]); } else if (st.ev && st.ev.k === 'minep') sfx.jump(); else if (st.ev && (st.ev.k === 'heavy' || st.ev.k === 'wall')) sfx.round(); else sfx.move(); } catch (e) {} }
      if (st.rOver && !(prev && prev.rOver && prev.round === st.round)) { try { sfx.round(); } catch (e) {} }
      if (st.over && !(prev && prev.over)) reward();
      if (!st.pre) UI.ldSel = null;
      invSync(); UI.mine = false;
      UI.sel = null; if (PT.turn === me.seat && !PT.over) { const ks = [...new Set(gen(PT, me.seat).map(m => m[0]))]; if (ks.length === 1) UI.sel = ks[0]; }
      draw(); return;
    }
    if (d.t === 'chat') showBubble(d.s, d.id);
    if (d.t === 'wz' && WZE[d.k]) gotWz(d.f | 0, d.to | 0, d.k);
  }
  function quickMatch(slot) {
    slot = slot || 0;
    if (slot >= SLOTS) { hostRoom('', true, 'x' + rid(8)); return; } // files pleines : on ouvre sa propre table
    hostRoom('', true, slot);
  }
  function leaveNet() {
    try { window.Voice && Voice.leave(); } catch (e) {}
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


  /* ---------- Vocal : seulement dans les salles privées (entre amis, avec le code) ---------- */
  const VOK = () => !!(window.Voice && Voice.supported());
  function voiceRoom() { return NET && !NET.quick && NET.code && NET.seat != null ? String(NET.code) : null; }
  function voiceBar() {
    if (!VOK() || !voiceRoom()) return '';
    if (!Voice.active) return `<button class="btn vbtn" data-a="voice">🎙️ ${tr('Rejoindre le vocal')}</button>`;
    return `<button class="btn vbtn on${Voice.muted ? ' mu' : ''}" data-a="vmute">${Voice.muted ? '🔇 ' + tr('Micro coupé') : '🎙️ ' + tr('Micro ouvert')}</button><button class="btn vbtn" data-a="voff" aria-label="${tr('Quitter le vocal')}">📴</button>`;
  }
  const vIcon = (i) => { const v = VOK() && Voice.seatState(i); return !v ? '' : v.deaf ? '🔕 ' : v.muted ? '🔇 ' : '🎙️ '; };
  const vTalk = (i) => { const v = VOK() && Voice.seatState(i); return v && v.talk ? ' talk' : ''; };
  let vBound = false;
  function voiceJoin() {
    const room = voiceRoom(); if (!room) return;
    if (!vBound && window.Voice) { vBound = true; Voice.on(() => { if (root) draw(); }); }
    Voice.join(room, NET.seat, P.name).then(() => { toast(tr('Vocal activé : tes amis t\'entendent')); draw(); })
      .catch((e) => { toast(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? tr('Micro refusé : autorise le micro dans les réglages du téléphone.') : tr('Vocal indisponible sur cet appareil.')); });
  }

  /* ---------- Taquineries : toucher le nom d'un joueur → wizz, toc toc ou haha ---------- */
  const WZE = { wizz: '⚡', toc: '✊', haha: '😂' }, WZN = { wizz: 'Wizz', toc: 'Toc toc', haha: 'Haha' };
  function sendWz(to, k) {
    const me = mySeat(); if (to == null || me == null || !PT || PT.over) return;
    if (typeof myBlock === 'function' && myBlock()) { toast(tr('Tu as bloqué les taquineries : tu ne peux pas en envoyer.')); return; }
    if (UI.wzLeft <= 0) { toast(tr('Plus de taquineries pour cette partie.')); return; }
    const wait = 8000 - (Date.now() - (UI.wzLast || 0)); if (wait > 0) { toast(`${tr('Attends')} ${Math.ceil(wait / 1000)} s`); return; }
    UI.wzLeft--; UI.wzLast = Date.now(); UI.wz = null;
    try { toast(WZ_SENT[k]); } catch (e) {}
    if (NET && NET.host) relay({ t: 'wz', f: me, to, k }, -1);
    else if (NET && NET.conn) { try { NET.conn.send({ t: 'wz', to, k }); } catch (e) {} }
    gotWz(me, to, k);
    // un ordinateur réagit… et répond parfois
    const ts = PT.seats[to];
    if (ts && ts.kind === 'ai' && typeof BOTS === 'object') {
      const bot = Object.values(BOTS).find(x => x.name === ts.name);
      if (bot && bot.hit) setTimeout(() => { if (!PT) return; UI.bubbles[to] = { tx: bot.hit[Math.floor(Math.random() * bot.hit.length)], until: Date.now() + 3000 }; draw(); setTimeout(draw, 3100); }, 700);
      if (Math.random() < 0.35) setTimeout(() => { if (PT && !PT.over && PT.alive[to]) gotWz(to, me, ['wizz', 'toc', 'haha'][Math.floor(Math.random() * 3)]); }, 2600);
    }
    draw();
  }
  function gotWz(f, to, k) {
    if (!PT) return;
    UI.hit = { s: to, k, until: Date.now() + 900 }; draw(); setTimeout(draw, 950);
    const root = document.getElementById('pt4');
    const burst = (n) => { if (!root) return; for (let i = 0; i < n; i++) { const e = document.createElement('div'); e.className = 'wzfly'; e.textContent = WZE[k]; e.style.left = (10 + Math.random() * 80) + '%'; e.style.top = (20 + Math.random() * 60) + '%'; e.style.animationDelay = (i * 90) + 'ms'; root.appendChild(e); setTimeout(() => e.remove(), 1400); } };
    if (to !== mySeat()) { burst(2); return; }
    if (typeof myBlock === 'function' && myBlock()) return;
    const who = PT.seats[f] ? PT.seats[f].name : '';
    try { toast(`${who} ${tr("t'envoie")} ${WZ_GOT[k]} !`); } catch (e) {}
    try { if (k === 'wizz') { sfx.wizz(); vibrate([90, 50, 90, 50, 90]); } else if (k === 'haha') { sfx.laugh(); vibrate([40, 60, 40, 60, 40]); } else { sfx.knock ? sfx.knock() : sfx.wizz(); vibrate([60, 80, 60, 80, 60]); } } catch (e) {}
    if (root && k === 'wizz') { root.classList.remove('wzshake'); void root.offsetWidth; root.classList.add('wzshake'); }
    burst(k === 'haha' ? 6 : 4);
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
#pt4 .pc.talk,#pt4 .seat.talk{box-shadow:0 0 0 3px #b6ff3b,0 0 22px #b6ff3b;border-color:#b6ff3b}
#pt4 .vbtn.on{border-color:#b6ff3b;color:#d8ff9a}
#pt4 .vbtn.mu{border-color:#ff4f6d;color:#ffb3c0}
#pt4 .pc.tap{cursor:pointer}
#pt4 .pc.tap::after{content:"⚡";position:absolute;top:-7px;right:-5px;font-size:.75rem;width:20px;height:20px;display:grid;place-items:center;border-radius:50%;background:#15112d;border:1px solid var(--sc)}
#pt4 .wzpop{position:absolute;left:0;right:0;top:calc(100% + 6px);z-index:5;display:flex;gap:6px;align-items:center;padding:6px;border-radius:14px;background:#0b0820;border:2px solid var(--sc);box-shadow:0 8px 24px #000c}
#pt4 .wzpop button{flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;padding:7px 2px;border-radius:10px;border:0;background:#241c55;color:#fff;font-size:1.3rem;cursor:pointer;box-shadow:inset 0 -3px 0 #0006}
#pt4 .wzpop button span{font-size:.62rem;font-weight:800}
#pt4 .wzpop small{position:absolute;right:8px;top:-18px;font-size:.62rem;color:#a39cd0}
#pt4 .rows.bottom .wzpop{top:auto;bottom:calc(100% + 6px)}
#pt4 .pc.hit-wizz{animation:wzsh .5s}
#pt4 .pc.hit-toc{animation:wzknock .6s}
#pt4 .pc.hit-haha{animation:wzhaha .7s}
@keyframes wzsh{20%,60%{transform:translateX(-6px)}40%,80%{transform:translateX(6px)}}
@keyframes wzknock{0%,100%{transform:scale(1)}20%,60%{transform:scale(.92)}40%,80%{transform:scale(1.04)}}
@keyframes wzhaha{0%,100%{transform:rotate(0)}25%{transform:rotate(-5deg)}75%{transform:rotate(5deg)}}
#pt4.wzshake{animation:wzsh .6s}
#pt4 .wzfly{position:fixed;z-index:80;font-size:2.6rem;pointer-events:none;animation:wzfly 1.3s ease-out both}
@keyframes wzfly{0%{transform:scale(0) rotate(-20deg);opacity:0}25%{transform:scale(1.3) rotate(8deg);opacity:1}100%{transform:translateY(-60px) scale(1);opacity:0}}
#pt4 .bub{position:absolute;left:50%;transform:translateX(-50%);bottom:calc(100% + 6px);background:#fff;color:#0a0718;font-weight:800;font-size:.8rem;padding:6px 10px;border-radius:12px;white-space:nowrap;z-index:3;box-shadow:0 4px 0 #0006}
#pt4 .rows:not(.bottom) .bub{bottom:auto;top:calc(100% + 6px)}
#pt4 .rows:not(.bottom) .pc:first-child .bub,#pt4 .rows.bottom .pc:first-child .bub{left:8px;transform:none}
#pt4 .rows:not(.bottom) .pc:last-child .bub,#pt4 .rows.bottom .pc:last-child .bub{left:auto;right:8px;transform:none}
#pt4 .rows.bottom .bub{bottom:auto;top:calc(100% + 6px)}
#pt4 *,#pt4 *::before,#pt4 *::after{box-sizing:border-box}
#pt4 .bd{position:relative;display:grid;grid-template-columns:repeat(6,1fr);gap:4px;padding:6px;margin:10px auto;width:100%;max-width:min(100%,calc(100dvh - 330px));border-radius:14px;background:linear-gradient(180deg,#120e28,#0d0b1f);box-shadow:0 0 0 1px #8f7bff55,0 0 30px #8f7bff40}
#pt4 .cl{aspect-ratio:1;border-radius:8px;border:2px solid var(--tc);background:color-mix(in srgb,var(--tc) 14%,#0b0918);color:var(--tc);display:grid;place-items:center;font-weight:800;font-size:clamp(.8rem,4vw,1.3rem);text-shadow:0 0 8px var(--tc);box-shadow:0 0 8px color-mix(in srgb,var(--tc) 60%,transparent),inset 0 0 8px color-mix(in srgb,var(--tc) 40%,transparent);padding:0}
#pt4 .cl.h{border-color:transparent;background:#05040a;box-shadow:none}
#pt4 .cl{position:relative}
#pt4 .cl.pu::after{content:"";position:absolute;inset:2px;border-radius:8px;border:3px solid #ff3dd8;box-shadow:0 0 12px #ff3dd8;animation:pt4pu .8s ease-in-out infinite;pointer-events:none;z-index:3}
@keyframes pt4pu{50%{opacity:.4;transform:scale(.88)}}
#pt4 .cl.dt{outline:3px solid #ffb02e;outline-offset:-3px}
#pt4 .cl.sw::after{content:"🔄";position:absolute;top:-6px;right:-4px;font-size:.85rem;z-index:5;animation:pt4pu .8s ease-in-out infinite;pointer-events:none}
#pt4 .pwt{display:inline-grid;place-items:center;width:18px;height:18px;margin-left:2px;border-radius:6px;background:#ffffff18;font-size:.7rem;vertical-align:middle}#pt4 .pwt.off{opacity:.3;filter:grayscale(1)}
#pt4 .cl .dy{position:absolute;inset:0;display:grid;place-items:center;font-size:1.3rem;filter:drop-shadow(0 0 5px #ff6b2e);pointer-events:none}
#pt4 .cl .dy i{position:absolute;right:2px;bottom:1px;font-style:normal;font-size:.6rem;font-weight:900;background:#ff3b3b;color:#fff;border-radius:6px;padding:0 4px}
#pt4 .hvq{margin:6px 0;padding:10px;border-radius:14px;border:2px solid #ffd75e88;background:#ffd75e18;display:grid;gap:4px;text-align:center}
#pt4 .fol{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:12px;padding:10px 12px;border-radius:14px;border:2px solid #ff3dd855;background:#ff3dd814}
#pt4 .fol span{display:grid;gap:2px}#pt4 .fol small{opacity:.75;font-size:.75rem}
#pt4 .cl.t{outline:3px solid #fff;outline-offset:-3px}
#pt4 .cl.tj{outline:3px dashed #b6ff3b;outline-offset:-3px}
#pt4 .cl.fr{box-shadow:0 0 0 2px #ffffff55 inset}
#pt4 .bd.spot .cl:not(.t):not(.tj):not(.me){filter:brightness(.32) saturate(.5);transition:filter .25s}
#pt4 .bd.spot .pw:not(.mine){filter:brightness(.4) saturate(.6)}
#pt4 .bd.spot .cl.t,#pt4 .bd.spot .cl.tj{box-shadow:0 0 16px var(--tc),inset 0 0 12px var(--tc);animation:p4glow 1.1s ease-in-out infinite alternate}
#pt4 .pw.mine .rg{animation:p4ring 1s ease-in-out infinite alternate}
@keyframes p4glow{from{filter:brightness(1)}to{filter:brightness(1.45)}}
@keyframes p4ring{from{box-shadow:0 0 0 3px var(--sc),0 0 10px var(--sc)}to{box-shadow:0 0 0 5px var(--sc),0 0 26px var(--sc)}}
@media (prefers-reduced-motion:reduce){#pt4 .bd.spot .cl.t,#pt4 .bd.spot .cl.tj,#pt4 .pw.mine .rg{animation:none}}
#pt4 .pw{position:absolute;width:calc((100% - 32px) / 6);aspect-ratio:1;transition:left .22s,top .22s,transform .2s;pointer-events:none;display:grid;place-items:center}
#pt4 .pw .rg{position:absolute;inset:12%;border-radius:50%;box-shadow:0 0 0 3px var(--sc),0 0 14px var(--sc)}
#pt4 .pw svg{width:86%;position:relative}
#pt4 .pw.sel{transform:scale(1.15)}
#pt4 .st{text-align:center;min-height:2.6em;font-size:.95rem;margin:2px 0}
#pt4 .acts{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
#pt4 .btn{min-height:46px;padding:0 18px;border-radius:14px;border:1px solid #2c2558;background:#15112d;color:inherit;font:inherit;font-weight:700}
#pt4 .btn:disabled{opacity:.4;filter:grayscale(.6)}
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
    const on = !stopped() && !PT.pre && PT.turn === i, out = !PT.alive[i];
    const b = UI.bubbles[i] && UI.bubbles[i].until > Date.now() ? `<div class="bub">${esc4(UI.bubbles[i].tx)}</div>` : '';
    const tag = s.kind === 'ai' ? tr('Ordinateur') : (NET && NET.seat === i) || (!NET && i === mySeat()) ? tr('Toi') : '';
    const me = mySeat(), tap = !PT.over && !out && i !== me && me != null;
    const pop = UI.wz === i ? `<div class="wzpop">${['wizz', 'toc', 'haha'].map(k => `<button type="button" data-a="wz" data-v="${k}">${WZE[k]}<span>${tr(WZN[k])}</span></button>`).join('')}${VOK() && Voice.seatState(i) ? `<button type="button" data-a="vdeaf">${Voice.seatState(i).deaf ? '🔊' : '🔕'}<span>${Voice.seatState(i).deaf ? tr('Réécouter') : tr('Couper sa voix')}</span></button>` : ''}<small>${UI.wzLeft > 0 ? UI.wzLeft + '/3' : tr('Plus de taquineries')}</small></div>` : '';
    return `<div class="pc${on ? ' on' : ''}${out ? ' out' : ''}${tap ? ' tap' : ''}${vTalk(i)}${UI.hit && UI.hit.s === i && UI.hit.until > Date.now() ? ' hit-' + UI.hit.k : ''}" style="--sc:${SEATC[i]}"${tap ? ` data-a="seat" data-v="${i}" role="button" aria-label="${tr('Taquiner')} ${esc4(s.name)}"` : ''}>${b}${pop}${av(s.skin)}<div style="min-width:0"><b>${esc4(s.name)}</b><small>${PT.R > 1 ? `🏆${PT.wins[i]} · ${PT.score[i]} · ` : ''}${out ? '✖ ' + tr('Éliminé') : vIcon(i) + (PT.J[i] ? '↷'.repeat(PT.J[i]) + ' ' : '') + powIcons(i) + ' ' + tag}</small></div>${on ? `<div class="tm" data-tm="${i}"></div>` : ''}</div>`;
  }
  function powIcons(i) {
    if (!PT.fol || PT.pre) return ''; const sl = slotsOf4(i).filter(k => k !== 'jump'); if (!sl.length) return '';
    if (i !== mySeat()) return `<span class="pwt${sl.some(k => powN4(i, k) > 0) ? '' : ' off'}">⚡</span>`;
    return [...new Set(sl)].map(k => `<span class="pwt${powN4(i, k) > 0 ? '' : ' off'}">${PWE[k]}</span>`).join('');
  }
  function canAct() {
    if (stopped() || PT.pre || PT.turn < 0) return false;
    const s = PT.seats[PT.turn];
    if (NET) return NET.seat === PT.turn;
    return s.kind === 'human';
  }
  // Le plateau est tourné pour que TON coin soit toujours en bas à gauche (comme à Ludo King)
  const rotCCW = (i) => { const r = Math.floor(i / N), c = i % N; return (N - 1 - c) * N + r; };
  const rotCW = (i) => { const r = Math.floor(i / N), c = i % N; return c * N + (N - 1 - r); };
  function viewRot() { const m = mySeat(); return m == null || m < 0 ? 0 : m; }
  const toView = (i, k) => { for (let n = 0; n < k; n++) i = rotCCW(i); return i; };
  const fromView = (d, k) => { for (let n = 0; n < k; n++) d = rotCW(d); return d; };
  const secs = (t) => Math.max(0, Math.ceil((t - Date.now()) / 1000));
  const mineSeen = (m) => { UI.mseen = UI.mseen || {}; if (UI.mseen[m.id] == null) { UI.mseen[m.id] = Date.now(); setTimeout(draw, MINE_SEE + 60); } return Date.now() - UI.mseen[m.id] < MINE_SEE; };
  function standings(final) {
    const order = final ? PT.final : [0, 1, 2, 3].filter(i => PT.inGame[i]).sort((a, b) => PT.wins[b] - PT.wins[a] || PT.score[b] - PT.score[a]);
    return `<ol class="podium">${order.map((s, i) => `<li style="--sc:${SEATC[s]}"><span>${final ? (PT.champs.includes(s) ? '🥇' : ['🥇', '🥈', '🥉', '4'][i]) : i + 1}</span>${av(PT.seats[s].skin)}<b>${esc4(PT.seats[s].name)}</b><span>🏆 ${PT.wins[s]} · ${PT.score[s]} pts</span></li>`).join('')}</ol>`;
  }
  function drawGame() {
    const my = canAct(), ms = my ? gen(PT, PT.turn) : [], rot = viewRot();
    const sel = UI.sel != null ? UI.sel : (my && PT.pawns[PT.turn] && PT.pawns[PT.turn].length === 1 ? 0 : null);
    const tg = new Map(); if (my && sel != null && !UI.mine) ms.filter(m => m[0] === sel).forEach(m => tg.set(m[1], m[2]));
    const mine = new Set(my ? PT.pawns[PT.turn] : []);
    const fol = my && PT.fol && !PT.pre, pu = new Set(fol ? pushTargets(PT, PT.turn).map(x => x.b) : []), sw = new Set(fol ? swapTargets(PT, PT.turn).map(x => x.b) : []);
    const dt = new Set(fol && UI.mine ? mineTargets(PT, PT.turn) : []), dmap = new Set((PT.mines || []).filter(mineSeen).map(m => m.i));
    const cells = Array.from({ length: N * N }, (_, d) => fromView(d, rot)).map((i) => { const v = PT.cells[i]; return `<button type="button" class="cl${v === 0 ? ' h' : ''}${mine.has(i) ? ' me' : ''}${tg.has(i) ? (tg.get(i) ? ' tj' : ' t') : ''}${PT.last && PT.last.from === i ? ' fr' : ''}${pu.has(i) ? ' pu' : ''}${dt.has(i) ? ' dt' : ''}${sw.has(i) ? ' sw' : ''}" data-c="${i}" style="--tc:${v === 1 ? '#2ef2ff' : v === 2 ? '#ff3dd8' : '#b6ff3b'}" aria-label="${v ? tr('case') + ' ' + v : tr('trou')}">${v || ''}${dmap.has(i) ? `<span class="dy">💣</span>` : ''}</button>`; }).join('');
    const pawns = PT.pawns.map((ps, s) => ps.map((pos, k) => {
      const vp = toView(pos, rot), r = Math.floor(vp / N), c = vp % N;
      if (FXH4.has(pos)) return '';
      return `<div class="pw${my && s === PT.turn && sel === k ? ' sel' : ''}${my && s === PT.turn ? ' mine' : ''}" style="--sc:${SEATC[s]};left:calc(6px + ${c} * ((100% - 32px) / 6 + 4px));top:calc(6px + ${r} * ((100% - 32px) / 6 + 4px))"><span class="rg"></span>${pawnSVG(cleanSkin(PT.seats[s].skin))}</div>`;
    }).join('')).join('');
    const turnName = PT.turn >= 0 && PT.seats[PT.turn] ? PT.seats[PT.turn].name : '';
    const many = !NET && PT.seats.filter(x => x.kind === 'human').length > 1;
    const status = PT.pre ? `🎽 ${tr('Vestiaire : choisis tes pouvoirs')}` : stopped() ? '' : my ? (UI.mine ? tr('Touche une case libre collée à ton pion pour poser la mine.') : many ? `<b style="color:${SEATC[PT.turn]}">${esc4(turnName)}</b> : ${UI.sel == null ? tr('choisis un pion') : tr('touche une case marquée')}` : (UI.sel == null ? tr('À toi : choisis un pion') : tr('Touche une case marquée'))) : `${tr('Au tour de')} ${esc4(turnName)}…`;
    let end = '';
    if (PT.over) {
      const me = mySeat(), r = PT.champs && PT.champs.includes(me) ? 0 : PT.final ? PT.final.indexOf(me) : -1;
      end = `<p class="note">${tr('Classement de la partie : manches gagnées, puis points.')}</p>${standings(true)}${r >= 0 ? `<p class="note">+${RANKCOINS[r]} ${tr('pièces')}</p>` : ''}<div class="acts">${isReferee() ? `<button class="btn pr" data-a="again">${tr('Revanche')}</button>` : ''}<button class="btn" data-a="close">${tr('Quitter')}</button></div>`;
    } else if (PT.rOver) {
      const rows = (PT.rank || []).map((s, i) => `<li style="--sc:${SEATC[s]}"><span>${['🥇', '🥈', '🥉', '4'][i]}</span>${av(PT.seats[s].skin)}<b>${esc4(PT.seats[s].name)}</b><span>+${PT.pts ? PT.pts[s] : 0} pts</span></li>`).join('');
      end = `<p class="note">${tr('Manche')} ${PT.round}/${PT.R} · ${tr('cases restantes :')} ${PT.sum} (${tr('bonus jusqu\'à 10')})</p><ol class="podium">${rows}</ol><p class="note">${tr('Classement')}</p>${standings(false)}
        <div class="acts">${isReferee() ? `<button class="btn pr" data-a="next">${tr('Manche suivante')} (<span data-next>${secs(PT.nextAt)}</span> s)</button>` : `<p class="note">${tr('Manche suivante dans')} <span data-next>${secs(PT.nextAt)}</span> s</p>`}</div>`;
    }
    const chat = NET && !PT.over ? `<button class="btn" data-a="chat">💬 ${tr('Chat')}</button>` : '';
    const me4 = mySeat();
    const pows = PT.fol && !PT.pre && !stopped() && me4 != null && PT.inGame[me4] ? [...new Set(slotsOf4(me4))].filter(k => k !== 'jump').map(k => { const n = powN4(me4, k), on = k === 'mine' && UI.mine, dis = n <= 0 || (k === 'mine' && (!my || !mineTargets(PT, me4).length)); return `<button class="btn${on ? ' pr' : ''}" data-a="${k === 'mine' ? 'pwmine' : 'pwinfo'}" data-v="${k}" ${dis ? 'disabled' : ''}>${PWE[k]} ${pwName(k)}${n > 1 ? ' ×' + n : ''}</button>`; }).join('') : '';
    let hvq = '';
    if (PT.pre && UI.ldSel) {
      const L = UI.ldSel, slot = (n) => L[n] ? `<button class="btn pr" data-a="ldel" data-v="${n}">${PWE[L[n]]} ${pwName(L[n])}</button>` : `<button class="btn" disabled>? ${tr('Emplacement')} ${n + 1}</button>`;
      const ob = (k) => { const has = pwOK(k), dis = !has || L.length >= 2 || (k === 'mine' && L.includes('mine')); return `<button class="btn" data-a="ladd" data-v="${k}" ${dis ? 'disabled' : ''}>${PWE[k]} ${pwName(k)}</button>`; };
      hvq = `<div class="hvq">🎽 <b>${tr('Vestiaire')} · <span data-pre>${secs(PT.preEnd)}</span> s</b><small>${tr('Choisis 2 pouvoirs. Le même peut être pris deux fois (sauf la Mine). Chacun sert une fois par manche. Sans choix : Saut + Saut.')}</small><div class="acts">${slot(0)}${slot(1)}</div><div class="acts">${(typeof PW_SLOT !== 'undefined' ? PW_SLOT : ['jump']).map(ob).join('')}</div><div class="acts"><button class="btn pr" data-a="ldok">${L.length ? tr('Prêt !') : tr('Prêt (Saut + Saut)')}</button></div></div>`;
    } else if (UI.pick != null && my) hvq = `<div class="hvq"><b>${tr('Que veux-tu faire ?')}</b><div class="acts"><button class="btn pr" data-a="pp" data-v="push">💥 ${tr('Pousser')}</button><button class="btn pr" data-a="pp" data-v="swap">🔄 ${tr('Inverser')}</button><button class="btn" data-a="pp" data-v="x">${tr('Annuler')}</button></div></div>`;
    else if (PT.pre) hvq = `<div class="hvq"><b>${tr('La partie commence dans')} <span data-pre>${secs(PT.preEnd)}</span> s</b>${UI.ldDone ? `<small>${tr('Ton équipement :')} ${UI.ldDone.map(k => PWE[k]).join(' ')}</small>` : ''}</div>`;
    const chips = UI.chat && typeof myPiques === 'function' ? `<div class="chips">${[...myPiques(), ...(typeof myRefs === 'function' ? myRefs().map(id => 'r' + id) : []), ...Object.keys(PHRASES.pol.l), ...Object.keys(PHRASES.enc.l)].map(id => `<button data-a="say" data-v="${id}">${esc4(phText(id))}</button>`).join('')}</div>` : '';
    return `<div class="bar"><button class="x" data-a="close" aria-label="${tr('Quitter')}">✕</button><h2>${tr('Partie à 4')}${PT.fol ? ' · 🤪' : ''} <small class="note">${tr('Manche')} ${PT.round}/${PT.R}</small></h2></div>${hvq}
      <div class="rows">${seatCard((rot + 1) % 4)}${seatCard((rot + 2) % 4)}</div>
      <div class="bd${my && !stopped() ? ' spot' : ''}" id="pt4bd">${cells}${pawns}</div>
      <div class="rows bottom">${seatCard(rot)}${seatCard((rot + 3) % 4)}</div>
      <p class="st">${PT.msg ? `<b>${esc4(PT.msg)}</b><br>` : ''}${status}</p>
      ${end}${PT.over ? (voiceBar() ? `<div class="acts">${voiceBar()}</div>` : '') : `${pows ? `<div class="acts">${pows}</div>` : ''}<div class="acts">${chat}${voiceBar()}</div>${chips}`}`;
  }
  function drawMenu() {
    if (!UI.seats) UI.seats = [meSeat(), { kind: 'ai', ...botSeat(1) }, { kind: 'ai', ...botSeat(2) }, { kind: 'ai', ...botSeat(3) }];
    const opt = (i, v, l) => `<option value="${v}" ${UI.seats[i].kind === v ? 'selected' : ''}>${l}</option>`;
    const seatRow = (i) => `<div class="seat" style="--sc:${SEATC[i]}">${av(UI.seats[i].skin || P.skin)}<b>${i === 0 ? esc4(P.name) : UI.seats[i].kind === 'human' ? tr('Joueur') + ' ' + (i + 1) : UI.seats[i].kind === 'ai' ? esc4(UI.seats[i].name) : '—'}</b>${i === 0 ? `<span class="note">${tr('Toi')}</span>` : `<select data-seat="${i}">${opt(i, 'human', tr('Humain'))}${opt(i, 'ai', tr('Ordinateur'))}${opt(i, 'off', tr('Vide'))}</select>`}</div>`;
    return `<div class="bar"><button class="x" data-a="close" aria-label="${tr('Retour')}">✕</button><h2>${tr('Partie à 4')}</h2></div>
      <p class="note">${tr('Jusqu\'à 4 joueurs sur un plateau 6×6, un pion et deux sauts chacun. Bloqué à ton tour : éliminé. Une manche par joueur (chacun commence une fois) : le dernier debout gagne la manche, le plus de manches gagnées remporte la partie.')}</p>
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
    const rows = [0, 1, 2, 3].map(i => { const s = seats && seats[i]; return `<div class="seat${vTalk(i)}" style="--sc:${SEATC[i]}">${s ? av(s.skin) : '<div class="av"></div>'}<b>${s ? vIcon(i) + esc4(s.name) : `<span class="note">${tr('En attente…')}</span>`}</b>${NET && NET.seat === i ? `<span class="note">${tr('Toi')}</span>` : ''}</div>`; }).join('');
    const n = (seats || []).filter(Boolean).length;
    return `<div class="bar"><button class="x" data-a="close" aria-label="${tr('Retour')}">✕</button><h2>${quick ? tr('Partie rapide') : tr('Salle privée')}</h2></div>
      ${UI.err ? `<p class="err">${esc4(UI.err)}</p>` : ''}
      ${!quick && code ? `<p class="note">${host ? tr('Dis ce code à tes amis : ils le tapent dans Partie à 4.') : tr('Code de la salle')}</p><div class="code">${esc4(String(code).toUpperCase())}</div>${host ? `<div class="acts"><button class="btn" data-a="copy">${tr('Copier le code')}</button><button class="btn" data-a="share">${tr('Partager le lien')}</button></div>` : ''}` : ''}
      ${quick ? `<p class="note" data-wait="1">${tr('Recherche de joueurs…')} ${Math.ceil(wait / 1000)} s · ${tr('ensuite, des ordinateurs complètent la table.')}</p>` : ''}
      ${rows}
      ${voiceBar() ? `<div class="acts">${voiceBar()}</div><p class="note">${tr('Facultatif : parlez-vous pendant la partie, même chacun chez soi. Rien n\'est enregistré.')}</p>` : ''}
      ${host && !quick ? `<label class="fol"><span>🤪 <b>${tr('Mode folie')}</b><small>${tr('Vestiaire de 10 s, puis Saut, Pousser, Inversion, Poids lourd, Mur et Mine. Pour rire, sans classement.')}</small></span><input type="checkbox" id="pt4fol" ${UI.fol ? 'checked' : ''}></label>` : !host && UI.lobby && UI.lobby.fol ? `<p class="note">🤪 ${tr('Mode folie activé par l\'hôte')}</p>` : ''}
      ${host && !quick ? `<button class="btn pr" style="width:100%;margin-top:12px" data-a="start" ${n < 2 ? 'disabled' : ''}>${tr('Lancer la partie')} (${n}/4)</button><p class="note">${tr('Les places vides seront jouées par l\'ordinateur.')}</p>` : ''}
      ${!host && !quick ? `<p class="note">${tr('L\'hôte lance la partie quand tout le monde est là.')}</p>` : ''}`;
  }
  // animations des pouvoirs, les mêmes qu'en duel (tout le monde les voit)
  const FXH4 = new Set();
  const FXCTX4 = { cell: (i) => root && root.querySelector(`#pt4bd [data-c="${i}"]`), skin: (p) => pawnSVG(cleanSkin(PT.seats[p].skin)), hide: FXH4, redraw: () => draw() };
  function draw() {
    if (!root) return;
    const st = root.scrollTop;
    root.innerHTML = UI.stage === 'game' && PT ? drawGame() : UI.stage === 'lobby' ? drawLobby() : drawMenu();
    root.scrollTop = st;
    drawTimer();
    if (UI.stage === 'game' && PT && PT.ev && PT.ev.n && PT.ev.n !== UI.evSeen) { UI.evSeen = PT.ev.n; const ev = PT.ev; if (typeof powAnim === 'function') requestAnimationFrame(() => powAnim(ev, FXCTX4)); }
  }
  function drawTimer() {
    if (!root) return;
    if (UI.stage === 'game' && PT && !PT.over) { const el = root.querySelector('[data-tm]'); if (el) el.style.transform = `scaleX(${Math.max(0, Math.min(1, (PT.deadline - Date.now()) / TURN_MS))})`;
      root.querySelectorAll('[data-pre]').forEach(x => { x.textContent = secs(PT.preEnd); }); root.querySelectorAll('[data-next]').forEach(x => { x.textContent = secs(PT.nextAt); }); }
    if (UI.stage === 'lobby') {
      const el = root.querySelector('[data-wait]');
      if (el && NET) { const w = NET.host ? Math.max(0, NET.startAt - Date.now()) : UI.lobby ? Math.max(0, (UI.lobby.wait || 0) - (Date.now() - UI.lobbyAt)) : 0; el.textContent = `${tr('Recherche de joueurs…')} ${Math.ceil(w / 1000)} s · ${tr('ensuite, des ordinateurs complètent la table.')}`; }
      if (NET && NET.host && NET.quick && !NET.started && Date.now() > NET.startAt) startOnline();
    }
  }

  /* ---------- Actions ---------- */
  const send = (msg) => { try { NET.conn.send(msg); } catch (e) {} };
  function onCell(i) {
    if (!canAct()) return;
    const s = PT.turn, ms = gen(PT, s), remote = NET && !NET.host;
    if (PT.fol) {
      if (UI.mine) { UI.mine = false; if (mineTargets(PT, s).includes(i)) { if (remote) send({ t: 'mine', i }); else mineAct(s, i); } else draw(); return; }
      const pu = pushTargets(PT, s).some(x => x.b === i), sw = swapTargets(PT, s).some(x => x.b === i);
      if (pu && sw) { UI.pick = i; draw(); return; }
      if (pu) { if (remote) send({ t: 'push', b: i }); else pushAct(s, i); return; }
      if (sw) { if (remote) send({ t: 'swap', b: i }); else swapAct(s, i); return; }
    }
    const k = PT.pawns[s].indexOf(i);
    if (k >= 0 && ms.some(m => m[0] === k)) { UI.sel = k; draw(); return; }
    if (UI.sel == null && PT.pawns[s].length === 1) UI.sel = 0;
    if (UI.sel == null) return;
    const m = ms.find(x => x[0] === UI.sel && x[1] === i); if (!m) return;
    if (remote) { send({ t: 'mv', m }); UI.sel = null; return; }
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
    if (a === 'again') { const nf = ((PT.first || 0) + 1) % 4, fl = PT.fol; if (NET && NET.host) { const seats = PT.seats.map(s => ({ ...s })); newGame(seats, nf, fl); } else if (!NET) newGame(PT.seats.map(s => ({ ...s })), nf, fl); return; }
    if (a === 'chat') { UI.chat = !UI.chat; draw(); return; }
    if (a === 'next') return nextRound();
    if (a === 'pwmine') { if (canAct() && can(PT.turn, 'mine')) { UI.mine = !UI.mine; draw(); } return; }
    if (a === 'pwinfo') { const k = b.dataset.v; if (typeof PW !== 'undefined' && PW[k]) toast(`${PWE[k]} ${tr(PW[k].d)}`); return; }
    if (a === 'pp') { const i = UI.pick, k = b.dataset.v; UI.pick = null; if (i == null || !canAct() || k === 'x') { draw(); return; } if (NET && !NET.host) send({ t: k, b: i }); else if (k === 'push') pushAct(PT.turn, i); else swapAct(PT.turn, i); return; }
    if (a === 'ladd') { const k = b.dataset.v, L = UI.ldSel; if (L && L.length < 2 && pwOK(k) && !(k === 'mine' && L.includes('mine'))) L.push(k); draw(); return; }
    if (a === 'ldel') { if (UI.ldSel) UI.ldSel.splice(+b.dataset.v, 1); draw(); return; }
    if (a === 'ldok') { if (UI.ldSel) ldSend(UI.ldSel); return; }
    if (a === 'say') return sendPhrase(b.dataset.v);
    if (a === 'voice') return voiceJoin();
    if (a === 'vmute') { Voice.toggleMute(); return; }
    if (a === 'voff') { Voice.leave(); draw(); return; }
    if (a === 'vdeaf') { e.stopPropagation(); Voice.toggleDeaf(UI.wz); UI.wz = null; draw(); return; }
    if (a === 'wz') { e.stopPropagation(); return sendWz(UI.wz, b.dataset.v); }
    if (a === 'seat') { const i = +b.dataset.v; UI.wz = UI.wz === i ? null : i; draw(); return; }
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
    if (e.target.id === 'pt4fol') { UI.fol = e.target.checked; if (NET && NET.host) sendLobby(); else draw(); return; }
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
    const played = !!(PT && (PT.over || PT.moves > 0));
    leaveNet(); clearTimeout(aiTimer); clearInterval(tick); tick = null;
    PT = null; UI = { stage: 'menu', sel: null, seats: null, err: '', bubbles: {} };
    try { musicStop(); } catch (e) {}
    if (root) { root.remove(); root = null; }
    try { render(); } catch (e) {}
    if (played) { try { if (typeof adInter === 'function') adInter(); } catch (e) {} }   // pub de fin de partie, comme en duel
  }
  window.Party = {
    open, close,
    joinCode(code) { open('lobby'); joinRoom('lastep-r4-' + String(code).toLowerCase(), false); },
    get state() { return PT; }, get net() { return NET; },
    _gen: gen, _ai: aiPick,
    _t: { newGame: (...a) => { mount(); newGame(...a); }, play: (...a) => play(...a), push: (...a) => pushAct(...a), swap: (...a) => swapAct(...a), mine: (...a) => mineAct(...a), next: () => nextRound(), ld: (x) => ldSend(x), pre: () => preCheck(), targets: (k, s) => (k === 'push' ? pushTargets : k === 'swap' ? swapTargets : mineTargets)(PT, s) },
  };
})();
