# Développement et contrôles locaux

Depuis la racine, installer les dépendances verrouillées avec `npm ci`. Utiliser Node 24.12+, npm 11.6.2+ et le Chrome déjà installé. `npm run dev` démarre le serveur local. `npm run build` produit le dossier `dist/`. `npm run preview` sert ce build pour vérifier le Service Worker et l’import.

| Commande | Contrôle |
|---|---|
| `npm run quality` | Typage, lint, complexités, formatage, couverture et duplication TypeScript/HTML/CSS. |
| `npm test` | Tests Vitest sans seuil de couverture. |
| `npm run test:e2e` | Build puis parcours Playwright dans Chrome sur une origine loopback isolée. |
| `npm run quality:audit` | Audit des dépendances npm. |
| `pwsh -NoProfile -File scripts/scan-secrets.ps1` | Gitleaks sur l’historique accessible, l’index, le diff suivi et les fichiers non suivis non ignorés. |

Les seuils et les preuves système figurent dans [QUALITY.md](../QUALITY.md). Lancer une seule couverture à la fois dans le même dossier de rapports. Réserver les parcours Android du sélecteur et de son annulation au téléphone réel. Les mesures de l’émulateur sont consignées à part.

Le propriétaire effectue les opérations de publication sur Cloudflare Pages. Le build B02 est accessible sur l’origine canonique pour les essais Android. Le prototype B01 reste disponible dans `work/pwa-b01/`. Les ouvrages privés sont sélectionnés en lecture seule et leurs données sont traitées dans le navigateur, sans ajout au build.

Les preuves historiques Tauri, MAUI et Smart App Control sont dans [BACKLOG.md](../BACKLOG.md). La copie locale ignorée `work/tauri-b01/` conserve le shell Tauri, ses scripts et son verrou d’origine. Le projet Rust et Android historique reste dans `src-tauri/`. Les prototypes MAUI et PWA B01 restent dans `work/`.
