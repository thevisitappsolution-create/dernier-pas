// Lastep : fonctionnement hors ligne (le jeu en ligne demande une connexion).
const CACHE = 'lastep-v101';
const FILES = ['./', 'index.html', 'supabase.min.js', 'net-supabase.js', 'party.js', 'account.js', 'native.js', 'lang-en.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'privacy.html', 'cgu.html', ...['arene','aventure-ile','logo-lastep','fond-nuit','coffre-argent-ouvert','coffre-argent','coffre-bois-ouvert','coffre-bois','coffre-legendaire','coffre-or-ouvert','coffre-or','couronne-royale','icone-cadeau','icone-cadenas','icone-calendrier','icone-carte','icone-epees','icone-maison','icone-parchemin','icone-plus','icone-profil','icone-roue','icone-trophee'].map(n => 'assets/web/' + n + '.webp')];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return; // polices, service en ligne : réseau direct
  if (url.pathname.endsWith('.mp3')) return; // musique : lue directement (lecture par morceaux)
  // Réseau d'abord pour la page (mises à jour rapides), cache en secours hors ligne.
  e.respondWith(fetch(req, {cache:'no-cache'}).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res; })
    .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
});
