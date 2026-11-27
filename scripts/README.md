# Développement et contrôles locaux

Depuis la racine, installer les dépendances verrouillées avec `npm ci`. Utiliser Node 24.12+, npm 11.6.2+ et le Chrome déjà installé. `npm run dev` démarre le serveur local. `npm run build` produit le dossier `dist/`. `npm run preview` sert ce build pour vérifier le Service Worker et l’import.

| Commande | Contrôle |
|---|---|
| `npm run quality` | Typage, lint, complexités, formatage, couverture et duplication TypeScript/HTML/CSS. |
| `npm test` | Tests Vitest sans seuil de couverture. |
| `npm run test:e2e` | Build puis parcours Playwright Chrome pour l’import, le lecteur et la réouverture hors ligne, sur des origines loopback isolées. Sous Windows, inclut l’installation et la relance en mode autonome dans un profil temporaire. |
| `npm run quality:audit` | Audit des dépendances npm. |
| `pwsh -NoProfile -File scripts/scan-secrets.ps1` | Gitleaks sur l’historique accessible, l’index, le diff suivi et les fichiers non suivis non ignorés. |

Les seuils et les preuves système figurent dans [QUALITY.md](../QUALITY.md). Lancer une seule couverture à la fois dans le même dossier de rapports. Réserver les parcours Android du sélecteur et de son annulation au téléphone réel. Les mesures de l’émulateur sont consignées à part.

## Distribution PWA

Le propriétaire publie le contenu de `dist/` dans le projet Cloudflare Pages existant. `index.html`, `manifest.webmanifest`, `service-worker.js` et `_headers` doivent se trouver à la racine du déploiement. Utiliser [blacture.blavy.eu](https://blacture.blavy.eu/) pour l’installation et les mises à jour afin de conserver le stockage associé à cette origine.

Dans Chrome, ouvrir cette adresse, puis cliquer sur **Installer Blacture** si l’application le propose, ou utiliser le menu d’installation du navigateur. Relancer depuis l’icône système après l’apparition de **Disponible hors ligne**. **Stockage local** indique l’état de persistance accordé par le navigateur. Lorsqu’une version est prête, **Mettre à jour** recharge l’application après les écritures en cours. Vérifier la reprise de lecture après la mise à jour et hors connexion avec un ouvrage déjà importé.

Lors du premier passage depuis une version antérieure à B05, attendre la fin de l’import avant d’appliquer la mise à jour. L’ancienne version reste chargée jusqu’au premier rechargement.

### Candidat Google Drive B06

Fournir l’identifiant public du client OAuth Web dans `VITE_DRIVE_CLIENT_ID` avant `npm run build` pour activer le panneau Google Drive. Le propriétaire conserve l’origine JavaScript autorisée `https://blacture.blavy.eu`, l’audience External et le seul scope `drive.file`. Le jeton est conservé dans la session du navigateur. [Autorisation Google](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

Le premier téléchargement ou la première synchronisation associe le profil Blacture au compte Google utilisé. **Télécharger** récupère l’ouvrage et sa progression depuis Drive. **Synchroniser l’ouvrage choisi** autorise son envoi et celui de ses modifications de lecture ultérieures. Pour utiliser un autre compte, ouvrir Blacture dans un profil de navigateur distinct. La déconnexion termine la session Google Drive et conserve la bibliothèque locale et l’association.

La base locale passe en version 4. Après ouverture du candidat, rétablir le service à l’aide d’un build compatible v4 si nécessaire. L’archive B05 attend une base v3. Le premier checkpoint Drive utilise un ouvrage fictif sur Windows et Android.

Le prototype B01 reste disponible dans `work/pwa-b01/`. Les ouvrages privés sont sélectionnés en lecture seule et leurs données sont traitées dans le navigateur, sans ajout au build.

Les preuves historiques Tauri, MAUI et Smart App Control sont dans [BACKLOG.md](../BACKLOG.md). La copie locale ignorée `work/tauri-b01/` conserve le shell Tauri, ses scripts et son verrou d’origine. Le projet Rust et Android historique reste dans `src-tauri/`. Les prototypes MAUI et PWA B01 restent dans `work/`.
