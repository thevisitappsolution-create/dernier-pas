# Lastep : guide de publication

Ce qui est déjà prêt dans le projet, et ce qu'il te reste à faire dans les consoles (Supabase, Apple, Google, RevenueCat, AdMob). Les étapes sont dans l'ordre.

## Déjà prêt

- **Comptes** : connexion par code e-mail (Apple et Google prêts à activer), sauvegarde de la partie sur le serveur, reprise sur un autre appareil, suppression du compte depuis le Profil.
- **Économie vérifiée par le serveur** : prix officiels, gains plafonnés à 3000 pièces par jour, objets de coffre plafonnés à 6 par jour. Modifier son téléphone ne rapporte plus rien.
- **Achats en argent réel** : fonction serveur `lastep-revenuecat` qui crédite Premium et les coffres de pièces, une seule fois par transaction.
- **Statistiques et plantages** : table `lastep_events` (ouverture, fin de partie, achats, erreurs).
- **Appli des stores** : projet Capacitor dans `store/` (Android et iOS générés), ponts achats et pubs dans `native.js`, icônes et écrans de démarrage.
- **Pages légales** : `privacy.html` et `cgu.html` (champs `[À COMPLÉTER]` à remplir).
- **Accès administrateur** : désactivé automatiquement dans l'appli des stores.

## Avancement (9 octobre 2026)

- [x] E-mail `contact@lastep.app` (OVH Zimbra, sur l'iPhone) + alias `dev@lastep.app`
- [x] Envoi des codes de connexion via Resend (`noreply@lastep.app`), modèles Supabase en français (`supabase/email-code.html`)
- [x] Jeu en ligne sur https://lastep.app (GitHub Pages, HTTPS), Supabase Site URL et Redirect URLs à jour
- [x] CGU et confidentialité complètes (111 Solutions, RCS Bobigny 108 006 552, TVA FR92108006552), médiateur CM2C jusqu'au 09/10/2029
- [x] Ligne pro OVH +33 9 72 17 52 15 (MicroSIP) : numéro public des stores
- [x] D-U-N-S 287896383
- [ ] Apple Developer : demande envoyée (Kbis fourni), en attente de validation puis paiement 99 €
- [ ] Google Play Console : compte créé (Organisation « 111 Solutions »), site validé (TXT Search Console dans la zone DNS, ne pas supprimer), identité en cours de vérification, puis validation des téléphones
- [ ] AdMob → RevenueCat et produits → builds → fiches → tests privés → publication

## 1. Supabase (15 min)

Dans le tableau de bord Supabase du projet `yabdzxowwgtlixomgbhe` :

1. **Authentication › URL Configuration**
   - *Site URL* : l'adresse du jeu web (ta page GitHub Pages ou ton futur domaine).
   - *Redirect URLs* : ajoute la même adresse, plus `capacitor://localhost` et `https://localhost`.
2. **Authentication › Email Templates › Magic Link** : ajoute la ligne `Ton code Lastep : {{ .Token }}` pour que le joueur reçoive un code à 6 chiffres en plus du lien.
3. **Authentication › SMTP** : branche un vrai service d'envoi (Resend, Brevo…). L'envoi intégré de Supabase est limité à quelques e-mails par heure et ne suffit pas pour un lancement.
4. **Edge Functions › Secrets** : crée `REVENUECAT_WEBHOOK_AUTH` avec une longue valeur secrète au hasard. Tu la recopieras dans RevenueCat (étape 3).
5. Plus tard, pour Apple et Google : **Authentication › Providers**, puis passe `oauth: {apple:true, google:true}` dans `CONFIG` (index.html). Apple exige « Se connecter avec Apple » dès que Google est proposé.

## 2. Comptes développeur

- **Apple Developer** : 99 $ par an. Crée l'app dans App Store Connect avec l'identifiant `app.lastep.jeu`.
- **Google Play Console** : 25 $ une seule fois. Attention : un compte personnel récent doit faire un test fermé avec 12 testeurs pendant 14 jours avant de pouvoir publier. Prévois tes testeurs tôt.
- **Une structure pour encaisser** (micro-entreprise ou société) : les stores versent l'argent sur un compte bancaire professionnel ou personnel déclaré.

## 3. RevenueCat (achats, 30 min)

1. Crée un projet, puis une app iOS et une app Android.
2. Crée les produits dans App Store Connect et Google Play, avec exactement ces identifiants :
   - abonnements : `lastep_premium_month` (4,99 €), `lastep_premium_year` (49,99 €), dans un même groupe d'abonnement ;
   - consommables : `lastep_coins_500` (0,99 €), `lastep_coins_1200` (1,99 €), `lastep_coins_3500` (4,99 €), `lastep_coins_8000` (9,99 €) ;
   - « Sans pub », achat unique non renouvelé (Apple : « Non-Renewing Subscription ») : `lastep_noads_3m` (1,99 €), `lastep_noads_6m` (4,99 €), `lastep_noads_12m` (6,99 €).
3. Dans RevenueCat, importe ces produits, crée l'accès « premium » relié aux deux abonnements, l'accès « noads » relié aux trois produits « Sans pub », et une offre par défaut qui contient les 9 produits.
4. **Integrations › Webhooks** :
   - URL : `https://yabdzxowwgtlixomgbhe.supabase.co/functions/v1/lastep-revenuecat`
   - Authorization : la valeur du secret `REVENUECAT_WEBHOOK_AUTH`.
5. Copie les deux clés publiques (`appl_…` et `goog_…`) dans `native.js` (`KEYS.revenuecat`).

## 4. AdMob (pubs, 20 min)

1. Crée une app iOS et une app Android, puis pour chacune un bloc « Interstitiel » et un bloc « Avec récompense ».
2. Remplace les identifiants de test :
   - blocs d'annonces : `native.js` (`KEYS.admob`) ;
   - identifiant d'application Android : `store/android/app/src/main/AndroidManifest.xml` ;
   - identifiant d'application iOS : `store/ios/App/App/Info.plist` (`GADApplicationIdentifier`) et `store/capacitor.config.json`.
3. **Confidentialité et messages** : crée le message RGPD (obligatoire en Europe) et le message iOS de transparence du suivi. L'appli les affiche toute seule.
4. Mets le fichier `app-ads.txt` fourni par AdMob à la racine du site du jeu.

## 5. Construire l'appli

```bash
cd store
npm install
npm run android    # ouvre Android Studio : Build › Generate Signed Bundle (.aab)
npm run ios        # ouvre Xcode (Mac obligatoire) : Product › Archive
```

Sans Mac, un service de compilation en ligne (Codemagic, Ionic Appflow) construit la version iOS à partir du dépôt.

À chaque mise à jour du jeu, `npm run sync` recopie la version web dans les deux applis.

## 6. Fiches des stores

- **Visuels** : captures d'écran (téléphone et tablette), icône 1024 px (`icon-1024.png`), courte vidéo du mode folie.
- **Classification** : questionnaire d'âge (IARC chez Google, classification Apple). Le jeu contient des achats intégrés et des publicités.
- **Confidentialité** : formulaire « Sécurité des données » chez Google et étiquettes de confidentialité chez Apple. Les réponses sont dans `privacy.html` : e-mail (compte), identifiant de jeu, achats, statistiques d'usage, données publicitaires (AdMob).
- **Liens** : `privacy.html`, `cgu.html` et un lien de suppression du compte (Profil › Compte).
- **Compte de démonstration** : Apple le demande pour la vérification. Crée un compte avec une adresse à toi et donne le code d'accès dans les notes.

## 7. Avant d'envoyer

- [ ] Remplir les `[À COMPLÉTER]` de `cgu.html` et `privacy.html`, et l'adresse de contact (`contact@exemple.fr` partout).
- [ ] Clés RevenueCat et identifiants AdMob définitifs.
- [ ] Augmenter `version` dans `CONFIG` (index.html) et `lastep-vXX` dans `sw.js`.
- [ ] Tester un achat en mode bac à sable (Apple) et en test interne (Google).
- [ ] Tester la connexion sur deux appareils, puis la suppression du compte.
- [ ] Une partie en ligne entre un téléphone et le web.

## Entretien

- **Statistiques** : supprimer une fois par mois les événements de plus de 13 mois (comme le promet la politique de confidentialité), depuis l'éditeur SQL de Supabase :
  `delete from public.lastep_events where created_at < now() - interval '13 months';`
- **Nouvelle saison de pouvoirs** : ajouter le pouvoir dans `PW_ON` (index.html). Fantôme, Mur, Saut et Vision sont déjà codés.
- **Fichiers SQL du serveur** : `supabase/01_comptes.sql` et `supabase/02_prix.sql`. Si tu changes un prix dans la boutique, mets aussi à jour la table `lastep_prices`.
