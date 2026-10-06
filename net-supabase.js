/* Lastep : jeu en ligne via Supabase Realtime.
 * Ce module remplace PeerJS en gardant la même interface (Peer, peer.connect, conn.send…),
 * pour que le code du jeu n'ait pas à changer. Tous les messages passent par le serveur
 * Supabase : ça marche en 4G comme en Wi-Fi, sans connexion directe entre téléphones.
 *
 * Canaux :
 *   lp:<id>   « adresse » d'un joueur (présence du propriétaire + demandes de connexion)
 *   lc:<cid>  une connexion entre deux joueurs (présence des deux côtés + messages)
 */
(function () {
  const SB_URL = 'https://yabdzxowwgtlixomgbhe.supabase.co';
  const SB_KEY = 'sb_publishable_bsHXhzA3Q_eFkhHHoMpBYQ_N5cj6brL';
  if (!window.supabase || !window.supabase.createClient) return; // pas de module en ligne : peerOK() restera faux

  let client = null;
  const sb = () => client || (client = window.supabase.createClient(SB_URL, SB_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 20 } },
  }));
  const rid = (n = 10) => { const a = 'abcdefghijklmnopqrstuvwxyz0123456789'; let s = ''; for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)]; return s; };
  const later = (fn, ms) => setTimeout(fn, ms);

  class Emitter {
    constructor() { this._h = {}; }
    on(ev, cb) { (this._h[ev] = this._h[ev] || []).push(cb); return this; }
    off(ev, cb) { this._h[ev] = (this._h[ev] || []).filter(x => x !== cb); return this; }
    emit(ev, ...a) { for (const cb of (this._h[ev] || []).slice()) { try { cb(...a); } catch (e) { console.error(e); } } }
  }

  function chan(topic, key) {
    return sb().channel(topic, { config: { presence: { key }, broadcast: { self: false } } });
  }
  function drop(ch) { if (!ch) return; try { ch.untrack && ch.untrack(); } catch (e) {} try { sb().removeChannel(ch); } catch (e) { try { ch.unsubscribe(); } catch (_) {} } }
  function metas(ch) { const st = ch.presenceState() || {}; const out = []; for (const k in st) for (const m of st[k] || []) out.push({ key: k, ...m }); return out; }

  /* ---------- Connexion entre deux joueurs ---------- */
  class Conn extends Emitter {
    constructor(peer, cid, other, side) {
      super();
      this.peer = other; this.open = false; this.cid = cid; this.side = side; this._p = peer; this._closed = false; this._grace = null;
      this.ch = chan('lc:' + cid, side + '-' + rid(6));
      this.ch.on('broadcast', { event: 'd' }, ({ payload }) => { if (payload && payload.s !== this.side) this.emit('data', payload.d); });
      this.ch.on('broadcast', { event: 'bye' }, ({ payload }) => { if (payload && payload.s !== this.side) this._remoteGone(true); });
      this.ch.on('presence', { event: 'sync' }, () => this._check());
      this.ch.on('presence', { event: 'leave' }, () => this._check(true));
      this.ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') { this.ch.track({ side: this.side, ts: Date.now() }).catch(() => {}); later(() => this._check(), 400); }
        else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !this.open) { this.emit('error', { type: 'network' }); }
      });
      peer._conns.add(this);
    }
    _otherHere() { return metas(this.ch).some(m => m.side && m.side !== this.side); }
    _check(left) {
      if (this._closed) return;
      if (this._otherHere()) {
        if (this._grace) { clearTimeout(this._grace); this._grace = null; }
        if (!this.open) { this.open = true; this.emit('open'); }
      } else if (this.open && left && !this._grace) {
        // petite coupure réseau : on laisse 5 s à l'autre pour revenir avant de fermer
        this._grace = later(() => { this._grace = null; if (!this._otherHere()) this._remoteGone(false); }, 5000);
      }
    }
    _remoteGone() { if (this._closed) return; this._closed = true; this.open = false; drop(this.ch); this._p._conns.delete(this); this.emit('close'); }
    send(data) { if (this._closed) return; this.ch.send({ type: 'broadcast', event: 'd', payload: { s: this.side, d: data } }).catch(() => {}); }
    close() {
      if (this._closed) return;
      const ch = this.ch;
      try { ch.send({ type: 'broadcast', event: 'bye', payload: { s: this.side } }); } catch (e) {}
      this._closed = true; this.open = false; this._p._conns.delete(this);
      later(() => drop(ch), 300);
      this.emit('close');
    }
  }

  /* ---------- Un joueur (une « adresse ») ---------- */
  class Peer extends Emitter {
    constructor(id) {
      super();
      this.id = id || ('r-' + rid(12));
      this.open = false; this.destroyed = false; this._conns = new Set(); this._tok = rid(8); this._ts = Date.now();
      this._listen();
    }
    _listen() {
      const ch = this._own = chan('lp:' + this.id, 'o-' + this._tok);
      ch.on('broadcast', { event: 'req' }, ({ payload }) => {
        if (this.destroyed || !payload || typeof payload.cid !== 'string' || !/^[a-z0-9]{8,20}$/.test(payload.cid)) return;
        if (payload.to && payload.to !== this._tok) return;
        const c = new Conn(this, payload.cid, String(payload.from || ''), 'b');
        this.emit('connection', c);
      });
      ch.on('presence', { event: 'sync' }, () => this._ownerCheck(false));
      let settled = false;
      ch.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          ch.track({ role: 'owner', ts: this._ts, tok: this._tok }).catch(() => {});
          // on laisse la présence se synchroniser avant de décider si l'adresse est libre
          later(() => { if (!settled) { settled = true; this._ownerCheck(true); } }, 1200);
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !this.open && !this.destroyed && !settled) {
          settled = true; this.emit('error', { type: 'network', message: 'Realtime ' + status });
        }
      });
    }
    _ownerCheck(first) {
      if (this.destroyed || !this._own) return;
      const owners = metas(this._own).filter(m => m.role === 'owner' && m.tok);
      const earlier = owners.some(m => m.tok !== this._tok && (m.ts < this._ts || (m.ts === this._ts && m.tok < this._tok)));
      if (earlier) {
        // quelqu'un tient déjà cette adresse
        if (first || (!this._conns.size)) { const ch = this._own; this._own = null; this.open = false; drop(ch); this.emit('error', { type: 'unavailable-id', message: 'ID "' + this.id + '" is taken' }); }
        return;
      }
      if (first && !this.open) { this.open = true; this.emit('open', this.id); }
    }
    connect(target, _opts) {
      const cid = rid(14);
      const c = new Conn(this, cid, target, 'a');
      const look = chan('lp:' + target, 'g-' + rid(8));
      let done = false;
      const fail = () => {
        if (done) return; done = true; drop(look);
        if (!c.open) { c._closed = true; drop(c.ch); this._conns.delete(c); this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + target }); }
      };
      look.subscribe((status) => {
        if (status !== 'SUBSCRIBED') { if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') fail(); return; }
        later(() => {
          if (done) return;
          const owners = metas(look).filter(m => m.role === 'owner' && m.tok).sort((x, y) => x.ts - y.ts || (x.tok < y.tok ? -1 : 1));
          if (!owners.length) { fail(); return; }
          look.send({ type: 'broadcast', event: 'req', payload: { from: this.id, cid, to: owners[0].tok } }).catch(() => {});
          later(() => { if (!done) { done = true; drop(look); } }, 1500);
        }, 1200);
      });
      later(() => { if (!c.open) fail(); }, 10000);
      return c;
    }
    disconnect() { const ch = this._own; this._own = null; this.open = false; drop(ch); }
    reconnect() { if (!this.destroyed && !this._own) { this._ts = Date.now(); this._listen(); } }
    destroy() {
      if (this.destroyed) return; this.destroyed = true;
      for (const c of [...this._conns]) { try { c.close(); } catch (e) {} }
      this.disconnect();
    }
  }
  window.Peer = Peer;
})();
