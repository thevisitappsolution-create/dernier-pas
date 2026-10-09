/* Lastep : ponts natifs pour l'appli des stores (Capacitor). Sur le web, ce fichier ne fait rien.
 *  - window.LastepIAP : achats via RevenueCat (Premium, coffres de pièces), liés au compte Supabase du joueur.
 *  - window.LastepAds : pubs AdMob (fin de partie et pubs récompensées), avec le consentement RGPD (UMP) et, sur iPhone, l'autorisation de suivi.
 * Les clés ci-dessous sont à remplir (voir GUIDE-PUBLICATION.md). Tant qu'elles sont vides, les pubs de test de Google s'affichent.
 */
(function () {
  const C = window.Capacitor;
  if (!C || !C.isNativePlatform || !C.isNativePlatform()) return;
  const ios = C.getPlatform() === 'ios';
  const KEYS = {
    revenuecat: { ios: '', android: '' },                       // clés publiques RevenueCat (appl_… / goog_…)
    admob: {                                                    // identifiants de blocs d'annonces AdMob (vides = annonces de test Google)
      inter: { ios: '', android: '' },
      reward: { ios: '', android: '' },
    },
  };
  const TEST = { inter: { ios: 'ca-app-pub-3940256099942544/4411468910', android: 'ca-app-pub-3940256099942544/1033173712' },
                 reward: { ios: 'ca-app-pub-3940256099942544/1712485313', android: 'ca-app-pub-3940256099942544/5224354917' } };
  const P_ = (name) => C.Plugins && C.Plugins[name];
  const unit = (k) => KEYS.admob[k][ios ? 'ios' : 'android'] || TEST[k][ios ? 'ios' : 'android'];
  const isTest = (k) => !KEYS.admob[k][ios ? 'ios' : 'android'];

  /* ---------- Achats ---------- */
  const PRODUCTS = { month: 'lastep_premium_month', year: 'lastep_premium_year' };
  let rcReady = null, rcUser = null;
  function rcInit() {
    if (rcReady) return rcReady;
    const Purchases = P_('Purchases'), key = KEYS.revenuecat[ios ? 'ios' : 'android'];
    rcReady = (Purchases && key) ? Purchases.configure({ apiKey: key }).then(() => true).catch(() => false) : Promise.resolve(false);
    return rcReady;
  }
  async function rcLogin() {
    const Purchases = P_('Purchases'); if (!(await rcInit()) || !window.Acc || !Acc.user) return false;
    if (rcUser !== Acc.user.id) { await Purchases.logIn({ appUserID: Acc.user.id }); rcUser = Acc.user.id; }
    return true;
  }
  async function findPackage(productId) {
    const Purchases = P_('Purchases'); const offerings = await Purchases.getOfferings();
    const all = Object.values((offerings && offerings.all) || {}).flatMap(o => o.availablePackages || []);
    return all.find(p => p.product && (p.product.identifier === productId || p.product.identifier.split(':')[0] === productId));
  }
  window.LastepIAP = {
    // plan : 'month' | 'year' | identifiant produit (ex. lastep_coins_1200). Renvoie true si l'achat est validé.
    async buy(plan) {
      if (!(await rcLogin())) { if (typeof toast === 'function') toast(T('Achats indisponibles pour le moment.')); return false; }
      const id = PRODUCTS[plan] || plan, pkg = await findPackage(id); if (!pkg) return false;
      try { await P_('Purchases').purchasePackage({ aPackage: pkg }); return true; }
      catch (e) { if (e && (e.userCancelled || e.code === '1')) return false; throw e; }
    },
    async restore() { if (!(await rcLogin())) return false; await P_('Purchases').restorePurchases(); if (window.Acc) setTimeout(() => Acc.refresh(), 3000); return true; },
    async prices() {   // prix locaux affichés par le store (ex. « 4,99 € »)
      if (!(await rcInit())) return null; const out = {};
      for (const [k, id] of Object.entries(PRODUCTS)) { const p = await findPackage(id); if (p) out[k] = p.product.priceString; }
      return out;
    },
  };
  // prix réels du store dans la page Premium
  setTimeout(() => { window.LastepIAP.prices().then(pr => { if (pr && typeof CONFIG !== 'undefined') { if (pr.month) CONFIG.premiumPrices.month = pr.month; if (pr.year) CONFIG.premiumPrices.year = pr.year; } }).catch(() => {}); }, 3000);

  /* ---------- Publicités ---------- */
  let adsReady = null;
  function adsInit() {
    if (adsReady) return adsReady;
    const AdMob = P_('AdMob'); if (!AdMob) return (adsReady = Promise.resolve(false));
    adsReady = (async () => {
      try {
        await AdMob.initialize({ initializeForTesting: isTest('inter') });
        if (ios) { try { const st = await AdMob.trackingAuthorizationStatus(); if (st.status === 'notDetermined') await AdMob.requestTrackingAuthorization(); } catch (e) {} }
        try { const ci = await AdMob.requestConsentInfo(); if (ci.isConsentFormAvailable && ci.status === 'REQUIRED') await AdMob.showConsentForm(); } catch (e) {}
        return true;
      } catch (e) { return false; }
    })();
    return adsReady;
  }
  window.LastepAds = {
    // pub de fin de partie : on peut la passer
    async inter() {
      if (!(await adsInit())) return true;
      const AdMob = P_('AdMob');
      try { await AdMob.prepareInterstitial({ adId: unit('inter'), isTesting: isTest('inter') }); await AdMob.showInterstitial(); } catch (e) {}
      return true;
    },
    // pub volontaire : récompense seulement si elle est regardée jusqu'au bout
    async reward() {
      if (!(await adsInit())) return false;
      const AdMob = P_('AdMob');
      try {
        await AdMob.prepareRewardVideoAd({ adId: unit('reward'), isTesting: isTest('reward') });
        const r = await AdMob.showRewardVideoAd();
        return !!(r && (r.amount !== undefined || r.type));
      } catch (e) { return false; }
    },
  };
  setTimeout(adsInit, 2500);

  // le compte change : on relie RevenueCat au même joueur
  setInterval(() => { if (window.Acc && Acc.user && rcUser !== Acc.user.id) rcLogin().catch(() => {}); }, 5000);
})();
