/* Lastep : chat vocal des salles privées à 4 (entre amis uniquement, jamais en partie rapide).
 * La voix passe directement d'un téléphone à l'autre (WebRTC), rien n'est enregistré.
 * Supabase Realtime sert seulement à mettre les téléphones en relation (canal « lv-<code de la salle> »).
 * Pour les réseaux qui bloquent les liaisons directes, on pourra ajouter un relais : window.LASTEP_TURN = [{urls, username, credential}].
 */
(function () {
  const SB_URL = 'https://yabdzxowwgtlixomgbhe.supabase.co';
  const SB_KEY = 'sb_publishable_bsHXhzA3Q_eFkhHHoMpBYQ_N5cj6brL';
  const ICE = () => [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }, ...(window.LASTEP_TURN || [])];
  const rid = () => Math.random().toString(36).slice(2, 10);
  let db = null;
  const client = () => db || (window.supabase && window.supabase.createClient ? (db = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } })) : null);

  let V = null;            // session vocale en cours
  const listeners = new Set();
  const emit = () => listeners.forEach(f => { try { f(); } catch (e) {} });

  function supported() { return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.RTCPeerConnection); }

  async function join(room, seat, name) {
    if (V) return true;
    if (!supported()) throw new Error('unsupported');
    const c = client(); if (!c) throw new Error('offline');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const me = { id: rid(), seat, name };
    V = { room, me, stream, muted: false, peers: {}, info: {}, deaf: new Set(), ch: null, ac: null, levels: {}, speaking: {}, timer: null };
    const ses = V;
    // niveau sonore : on sait qui parle
    try { ses.ac = new (window.AudioContext || window.webkitAudioContext)(); if (ses.ac.state === 'suspended') ses.ac.resume(); } catch (e) { ses.ac = null; }
    meter(ses, 'me', stream);
    const ch = ses.ch = c.channel('lv-' + room, { config: { presence: { key: me.id, enabled: true }, broadcast: { self: false } } });
    ch.on('broadcast', { event: 'sig' }, ({ payload }) => { if (V === ses && payload && payload.to === me.id) onSignal(ses, payload); });
    ch.on('presence', { event: 'sync' }, () => { if (V === ses) syncPeers(ses); });
    ch.subscribe((st) => { if (st === 'SUBSCRIBED' && V === ses) ch.track({ seat, name, muted: false }); });
    ses.timer = setInterval(() => tickLevels(ses), 160);
    duck(true); emit();
    return true;
  }

  function others(ses) {
    const st = ses.ch.presenceState() || {}, out = {};
    for (const k in st) { if (k === ses.me.id) continue; const m = (st[k] || [])[0]; if (m) out[k] = m; }
    return out;
  }
  function syncPeers(ses) {
    const o = others(ses);
    ses.info = o;
    for (const id in o) if (!ses.peers[id] && ses.me.id < id) connect(ses, id, true);     // le plus petit identifiant appelle : pas de collision
    for (const id in ses.peers) if (!o[id]) dropPeer(ses, id);
    emit();
  }
  function send(ses, to, d) { try { ses.ch.send({ type: 'broadcast', event: 'sig', payload: { to, from: ses.me.id, d } }); } catch (e) {} }
  function connect(ses, id, caller) {
    const pc = new RTCPeerConnection({ iceServers: ICE() });
    const p = ses.peers[id] = { pc, audio: null, state: 'new', queue: [] };
    ses.stream.getTracks().forEach(t => pc.addTrack(t, ses.stream));
    pc.onicecandidate = (e) => { if (e.candidate) { const c = e.candidate; send(ses, id, { cand: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } }); } };
    pc.onconnectionstatechange = () => { p.state = pc.connectionState; if (pc.connectionState === 'failed') { dropPeer(ses, id); if (ses.me.id < id && V === ses) setTimeout(() => { if (V === ses && ses.info[id] && !ses.peers[id]) connect(ses, id, true); }, 1500); } emit(); };
    pc.ontrack = (e) => {
      const s = e.streams[0] || new MediaStream([e.track]);
      if (!p.audio) { p.audio = document.createElement('audio'); p.audio.autoplay = true; p.audio.setAttribute('playsinline', ''); p.audio.style.display = 'none'; document.body.appendChild(p.audio); }
      p.audio.srcObject = s; p.audio.muted = ses.deaf.has(id); p.audio.play().catch(() => {});
      meter(ses, id, s);
    };
    if (caller) pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => send(ses, id, { sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } })).catch(() => {});
    return p;
  }
  async function onSignal(ses, msg) {
    const id = msg.from, d = msg.d || {};
    let p = ses.peers[id];
    try {
      if (d.sdp) {
        if (d.sdp.type === 'offer') { if (p) dropPeer(ses, id); p = connect(ses, id, false); }
        if (!p) return;
        await p.pc.setRemoteDescription(d.sdp);
        for (const c of p.queue.splice(0)) { try { await p.pc.addIceCandidate(c); } catch (e) {} }
        if (d.sdp.type === 'offer') { const a = await p.pc.createAnswer(); await p.pc.setLocalDescription(a); send(ses, id, { sdp: { type: p.pc.localDescription.type, sdp: p.pc.localDescription.sdp } }); }
      } else if (d.cand && p) {
        if (p.pc.remoteDescription) { try { await p.pc.addIceCandidate(d.cand); } catch (e) {} } else p.queue.push(d.cand);
      }
    } catch (e) {}
  }
  function dropPeer(ses, id) {
    const p = ses.peers[id]; if (!p) return;
    try { p.pc.close(); } catch (e) {}
    if (p.audio) { try { p.audio.srcObject = null; p.audio.remove(); } catch (e) {} }
    delete ses.peers[id]; delete ses.levels[id]; delete ses.speaking[id];
  }
  function meter(ses, key, stream) {
    if (!ses.ac) return;
    try { const src = ses.ac.createMediaStreamSource(stream), an = ses.ac.createAnalyser(); an.fftSize = 512; src.connect(an); ses.levels[key] = { an, buf: new Uint8Array(an.fftSize), hot: 0 }; } catch (e) {}
  }
  function tickLevels(ses) {
    if (V !== ses) return;
    let changed = false;
    for (const k in ses.levels) {
      const L = ses.levels[k]; L.an.getByteTimeDomainData(L.buf);
      let sum = 0; for (let i = 0; i < L.buf.length; i++) { const v = (L.buf[i] - 128) / 128; sum += v * v; }
      const rms = Math.sqrt(sum / L.buf.length);
      const mutedSrc = k === 'me' ? ses.muted : (ses.info[k] && ses.info[k].muted) || ses.deaf.has(k);
      L.hot = !mutedSrc && rms > 0.035 ? 4 : Math.max(0, L.hot - 1);     // petite traîne : l'anneau ne clignote pas entre deux mots
      const sp = L.hot > 0;
      if (!!ses.speaking[k] !== sp) { ses.speaking[k] = sp; changed = true; }
    }
    if (changed) emit();
  }
  function duck(on) {
    try { if (typeof MUSIC !== 'undefined' && MUSIC.gain && typeof AC !== 'undefined' && AC) { const g = MUSIC.gain.gain; g.cancelScheduledValues(AC.currentTime); g.setValueAtTime(g.value, AC.currentTime); g.linearRampToValueAtTime(on ? 0.12 : 0.4, AC.currentTime + 0.6); } } catch (e) {}
  }
  function leave() {
    const ses = V; if (!ses) return; V = null;
    clearInterval(ses.timer);
    for (const id in ses.peers) dropPeer(ses, id);
    try { ses.stream.getTracks().forEach(t => t.stop()); } catch (e) {}
    try { ses.ch.untrack(); } catch (e) {}
    try { client().removeChannel(ses.ch); } catch (e) { try { ses.ch.unsubscribe(); } catch (_) {} }
    try { ses.ac && ses.ac.close(); } catch (e) {}
    duck(false); emit();
  }
  function toggleMute() {
    if (!V) return; V.muted = !V.muted;
    V.stream.getAudioTracks().forEach(t => { t.enabled = !V.muted; });
    try { V.ch.track({ seat: V.me.seat, name: V.me.name, muted: V.muted }); } catch (e) {}
    emit();
  }
  function seatId(seat) { if (!V) return null; for (const id in V.info) if (V.info[id].seat === seat) return id; return null; }
  function toggleDeaf(seat) {
    const id = seatId(seat); if (!V || !id) return;
    if (V.deaf.has(id)) V.deaf.delete(id); else V.deaf.add(id);
    const p = V.peers[id]; if (p && p.audio) p.audio.muted = V.deaf.has(id);
    emit();
  }
  // état d'un siège pour l'affichage : null (pas dans le vocal) ou {talk, muted, deaf, live}
  function seatState(seat) {
    if (!V) return null;
    if (seat === V.me.seat) return { me: true, talk: !!V.speaking.me, muted: V.muted, deaf: false, live: true };
    const id = seatId(seat); if (!id) return null;
    const p = V.peers[id];
    return { talk: !!V.speaking[id], muted: !!V.info[id].muted, deaf: V.deaf.has(id), live: !!p && p.state === 'connected' };
  }
  window.Voice = { supported, join, leave, toggleMute, toggleDeaf, seatState, on: (f) => listeners.add(f), off: (f) => listeners.delete(f),
    get active() { return !!V; }, get muted() { return !!(V && V.muted); }, get room() { return V && V.room; }, _debug: () => V };
})();
