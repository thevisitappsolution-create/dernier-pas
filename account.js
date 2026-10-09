/* Lastep : comptes joueurs.
 * Sans compte, on joue normalement (tout reste sur l'appareil).
 * Avec un compte, la progression et l'économie sont gardées sur le serveur Supabase :
 *  - on retrouve sa partie sur un autre téléphone, une tablette ou le web ;
 *  - les pièces, objets, réfs, pouvoirs et Premium sont vérifiés par le serveur (prix officiels, gains plafonnés par jour) ;
 *  - les achats en argent réel sont liés au compte.
 * L'appareil envoie seulement ce qui a changé ; le serveur répond avec l'état officiel, que l'appareil adopte.
 */
(function () {
  const URL = 'https://yabdzxowwgtlixomgbhe.supabase.co';
  const KEY = 'sb_publishable_bsHXhzA3Q_eFkhHHoMpBYQ_N5cj6brL';
  // Données d'économie (gérées par le serveur) et données propres à l'appareil : jamais envoyées dans la « progression »
  const ECON = ['coins', 'owned', 'refs', 'pw', 'premium', 'accQ', 'accBase', 'uid'];
  let sb = null, timer = null, busy = false, again = false, lastLog = 0;
  const client = () => sb || (window.supabase && window.supabase.createClient ? (sb = window.supabase.createClient(URL, KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'lastep-auth' } })) : null);

  const A = { user: null, ready: false, syncing: false, err: '', step: 'email', email: '', lastSync: 0 };
  const q = () => (P.accQ = P.accQ || { loot: [], pwbuy: {}, pwuse: {} });

  function progressOf() {
    const o = {};
    for (const k in P) if (!ECON.includes(k)) o[k] = P[k];
    return o;
  }
  // l'état officiel venu du serveur
  function adopt(acc, keepLocal) {
    if (!acc) return;
    const sent = A.sent || null;
    // ce qui a changé pendant l'envoi est gardé et partira au prochain envoi
    const extra = sent ? (P.coins || 0) - sent.coins : 0;
    P.accBase = { coins: acc.coins, owned: acc.owned.slice(), refs: acc.refs.slice() };
    P.coins = Math.max(0, acc.coins + extra);
    P.owned = [...new Set([...acc.owned, ...(sent ? (P.owned || []).filter(x => !sent.owned.includes(x)) : [])])];
    P.refs = [...new Set([...acc.refs, ...(sent ? (P.refs || []).filter(x => !sent.refs.includes(x)) : [])])];
    if (acc.pw && typeof acc.pw === 'object') {
      const pw = JSON.parse(JSON.stringify(acc.pw)), Q = q();
      for (const k in Q.pwuse) if (pw[k]) pw[k].n = Math.max(0, (pw[k].n || 0) - Q.pwuse[k]);
      for (const k in Q.pwbuy) { const b = Q.pwbuy[k]; pw[k] = pw[k] || { n: 0, u: 0 }; pw[k].n += 15 * (b.pack || 0); if (b.gold) pw[k].u = Math.max(Date.now(), pw[k].u || 0) + b.gold * 7 * 864e5; }
      P.pw = Object.assign({}, P.pw || {}, pw);
    }
    P.premium = !!(acc.premium_until && new Date(acc.premium_until).getTime() > Date.now());
    if (acc.uid) P.uid = acc.uid;
    if (!keepLocal && acc.progress && Object.keys(acc.progress).length) {
      for (const k in acc.progress) if (!ECON.includes(k)) P[k] = acc.progress[k];
    }
    try { localStorage.setItem(P_KEY, JSON.stringify(P)); } catch (e) {}
  }

  async function sync() {
    const db = client(); if (!db || !A.user) return;
    if (busy) { again = true; return; }
    busy = true; A.syncing = true;
    const base = P.accBase || { coins: P.coins || 0, owned: [], refs: [] }, Q = q();
    const owned = (P.owned || []).filter(x => !base.owned.includes(x) && !Q.loot.includes(x));
    const loot = Q.loot.filter(x => !base.owned.includes(x));
    const refs = (P.refs || []).filter(x => !base.refs.includes(x));
    const pwbuy = { ...Q.pwbuy }, pwuse = { ...Q.pwuse };
    A.sent = { coins: P.coins || 0, owned: (P.owned || []).slice(), refs: (P.refs || []).slice() };
    const delta = (P.coins || 0) - base.coins;
    Q.loot = []; Q.pwbuy = {}; Q.pwuse = {};
    try {
      const { data, error } = await db.rpc('lastep_sync', { p_delta: delta, p_owned: owned, p_loot: loot, p_refs: refs, p_pwbuy: pwbuy, p_pwuse: pwuse, p_progress: progressOf() });
      if (error) throw error;
      adopt(data, true); A.err = ''; A.lastSync = Date.now();
    } catch (e) {
      // on remet en file ce qui n'est pas parti
      Q.loot = [...new Set([...loot, ...Q.loot])];
      for (const k in pwbuy) { const b = Q.pwbuy[k] = Q.pwbuy[k] || { pack: 0, gold: 0 }; b.pack += pwbuy[k].pack || 0; b.gold += pwbuy[k].gold || 0; }
      for (const k in pwuse) Q.pwuse[k] = (Q.pwuse[k] || 0) + pwuse[k];
      A.err = String((e && e.message) || e);
      if (/not_enough_coins/.test(A.err)) { await refresh(); }
    } finally {
      A.sent = null; busy = false; A.syncing = false;
      try { localStorage.setItem(P_KEY, JSON.stringify(P)); } catch (e) {}
      if (typeof render === 'function' && typeof view !== 'undefined' && view !== 'game') render();
      if (again) { again = false; setTimeout(sync, 300); }
    }
  }
  // relit l'état officiel (après un achat en argent réel, ou en cas de désaccord)
  async function refresh() {
    const db = client(); if (!db || !A.user) return;
    const { data } = await db.from('lastep_accounts').select('*').eq('user_id', A.user.id).maybeSingle();
    if (data) { const Q = q(); Q.loot = []; Q.pwbuy = {}; Q.pwuse = {}; adopt(data, true); if (typeof render === 'function') render(); }
  }
  function dirty() {
    if (!A.user) return;
    clearTimeout(timer); timer = setTimeout(sync, 4000);
  }
  let opening = null;
  async function onSignedIn(user) {
    if (A.user && A.user.id === user.id) return opening;
    A.user = user; A.email = user.email || A.email; A.step = 'in';
    return (opening = openAccount(user));
  }
  async function openAccount(user) {
    const db = client();
    try {
      // compte déjà existant : c'est sa partie qui compte ; sinon on crée le compte avec la partie de cet appareil
      const prev = await db.from('lastep_accounts').select('*').eq('user_id', user.id).maybeSingle();
      const fresh = !(prev && prev.data);
      const { data, error } = fresh ? await db.rpc('lastep_account_open', { p_uid: P.uid, p_progress: progressOf(), p_coins: P.coins || 0, p_owned: P.owned || [], p_refs: P.refs || [] }) : prev;
      if (error) throw error;
      P.accQ = { loot: [], pwbuy: {}, pwuse: {} };
      adopt(data, !!fresh);
      if (!fresh && typeof toast === 'function') toast(T('Partie récupérée depuis ton compte'));
      log('login', { fresh: !!fresh });
    } catch (e) { A.err = String((e && e.message) || e); }
    if (typeof render === 'function') render();
  }

  async function sendCode(email) {
    const db = client(); if (!db) { A.err = T('Connexion impossible pour le moment.'); return false; }
    A.email = String(email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(A.email)) { A.err = T('Adresse e-mail invalide.'); return false; }
    const { error } = await db.auth.signInWithOtp({ email: A.email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname } });
    if (error) { A.err = error.message; return false; }
    A.err = ''; A.step = 'code'; return true;
  }
  async function verify(code) {
    const db = client(); if (!db) return false;
    const { data, error } = await db.auth.verifyOtp({ email: A.email, token: String(code || '').trim(), type: 'email' });
    if (error) { A.err = T('Code incorrect ou expiré.'); return false; }
    A.err = ''; if (data && data.user) await onSignedIn(data.user); return true;
  }
  async function oauth(provider) {
    const db = client(); if (!db) return;
    const { error } = await db.auth.signInWithOAuth({ provider, options: { redirectTo: location.origin + location.pathname } });
    if (error) { A.err = error.message; if (typeof render === 'function') render(); }
  }
  async function signOut() {
    await sync();
    const db = client(); if (db) await db.auth.signOut();
    A.user = null; A.step = 'email'; P.premium = false; delete P.accBase; delete P.accQ;
    try { localStorage.setItem(P_KEY, JSON.stringify(P)); } catch (e) {}
    if (typeof render === 'function') render();
  }
  async function deleteAccount() {
    const db = client(); if (!db || !A.user) return false;
    const { error } = await db.functions.invoke('lastep-account-delete', { method: 'POST' });
    if (error) { A.err = T('La suppression a échoué. Réessaie.'); return false; }
    await db.auth.signOut(); A.user = null; A.step = 'email'; P.premium = false; delete P.accBase; delete P.accQ;
    try { localStorage.setItem(P_KEY, JSON.stringify(P)); } catch (e) {}
    return true;
  }

  // Statistiques : quelques événements anonymes (ouverture, fin de partie, erreurs) pour savoir ce qui marche
  function log(name, data) {
    const db = client(); if (!db) return;
    if (name === 'error' && Date.now() - lastLog < 20000) return; if (name === 'error') lastLog = Date.now();
    const row = { name, device: /^[a-z0-9]{8}$/.test(P.uid || '') ? P.uid : null, data: data || {} };
    if (A.user) row.user_id = A.user.id;
    try { db.from('lastep_events').insert(row).then(() => {}, () => {}); } catch (e) {}
  }
  window.addEventListener('error', (e) => log('error', { m: String(e.message || '').slice(0, 300), f: String(e.filename || '').split('/').pop(), l: e.lineno || 0, v: (window.CONFIG && CONFIG.version) || 0 }));
  window.addEventListener('unhandledrejection', (e) => log('error', { m: String((e.reason && e.reason.message) || e.reason || '').slice(0, 300), v: (window.CONFIG && CONFIG.version) || 0 }));
  document.addEventListener('visibilitychange', () => { if (document.hidden && A.user) sync(); });

  async function start() {
    const db = client(); if (!db) { A.ready = true; return; }
    try {
      db.auth.onAuthStateChange((ev, session) => {
        if (ev === 'SIGNED_IN' && session && session.user && (!A.user || A.user.id !== session.user.id)) onSignedIn(session.user);
        if (ev === 'SIGNED_OUT') { A.user = null; }
      });
      const { data } = await db.auth.getSession(); if (data && data.session && data.session.user) await onSignedIn(data.session.user);
    } catch (e) {}
    A.ready = true;
    log('app_open', { v: (typeof CONFIG !== 'undefined' && CONFIG.version) || 0, lang: typeof LANG !== 'undefined' ? LANG : '', web: !window.Capacitor });
    setInterval(() => { if (A.user && Date.now() - A.lastSync > 60000) sync(); }, 60000);
  }

  window.Acc = Object.assign(A, { start, sync, dirty, refresh, sendCode, verify, oauth, signOut, deleteAccount, log,
    queueLoot: (x) => { if (A.user) q().loot.push(x); },
    queuePwBuy: (k, kind) => { if (!A.user) return; const b = q().pwbuy[k] = q().pwbuy[k] || { pack: 0, gold: 0 }; b[kind] = (b[kind] || 0) + 1; },
    queuePwUse: (k) => { if (A.user) q().pwuse[k] = (q().pwuse[k] || 0) + 1; },
  });
  Object.defineProperty(A, 'on', { get: () => !!A.user });
  setTimeout(start, 50);
})();
