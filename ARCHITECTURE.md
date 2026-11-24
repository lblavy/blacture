# Architecture et décisions techniques

## Décisions retenues

| Sujet | Décision |
|---|---|
| Produit | Application personnelle, local-first, sans SaaS ni serveur applicatif |
| Plateformes | Windows et Android, applications installables, code partagé autant que raisonnable |
| Rendu | HTML responsive, indépendant de la pagination PDF |
| Import | Markdown enrichi autonome en V1, format interne commun extensible |
| Stockage distant | Google Drive uniquement, facultatif, compte personnel de chaque utilisateur |
| Stockage local | Fichiers pour ressources/contenus ; SQLite envisagé pour les états et métadonnées |
| Développement | Scripts et outils locaux, pas de Docker, SonarQube ni serveur CI obligatoire |
| Distribution | Installation personnelle ; publication et commercialisation reportées |

Ne pas préparer une abstraction de fournisseur de stockage multiple. Une séparation simple des responsabilités entre code métier, accès local et client Drive suffit. Ne pas ajouter de dépendances à Supabase ou Railway. Pas de choix définitif de framework avant B00.

## Composants logiques (orientation, pas structure de dossiers imposée)

```text
Markdown enrichi (source inchangée)
  -> Importateur -> modèle interne + contenu HTML + ressources
                          |
              stockage local fichiers / métadonnées
                          |
          lecteur UI <-> progression / navigation
                          |
             journal local des modifications
                          |
                   synchronisation Drive
```

Le domaine ne dépend pas du DOM, du SDK Google ou de SQLite pour ses calculs purs. Le moteur de progression accepte des observations produites par l'interface ; l'horloge, la persistance et le transport sont contrôlables en test. Ne pas multiplier les couches/interfaces sans bénéfice concret. Import et lecture doivent fonctionner sans authentification Google.

## Stack à étudier (B00)

Comparer Tauri 2 Windows + Android et Tauri Windows + Capacitor Android ; envisager une autre solution uniquement avec avantage démontré (maintenabilité, tests, OAuth, fichier volumineux). Interface TypeScript/HTML/CSS pressentie, framework UI à choisir au plus simple. Vérifier l'accès aux fichiers, SQLite, stockage sécurisé, rendu WebView, APIs de cycle de vie, OAuth natif et capacité à exécuter les vrais tests E2E sur Windows et Android. Mesurer le coût des toolchains, notamment Rust/Android SDK, émulateur et plugins. Vérifier les versions et la documentation réelle ; ne pas présumer qu'une API desktop fonctionne sur mobile.

## Import et représentation des ouvrages

- Format interne commun versionné : manifeste du livre (identité, édition, métadonnées, ordre), arbre de sections, blocs de lecture, destinations de liens, ressources. Les noms exacts et schémas sont ouverts.
- Identifiants stables : exploiter les ancres existantes si uniques ; sinon stratégie déterministe et testée. Distinguer identité du livre, de l'édition et des unités ; ne pas utiliser une position pixel ou un numéro de page comme identité durable. Empreintes de contenu utiles pour une migration prudente.
- Découper le HTML en fragments adaptés ; ne pas rendre un document de 80 Mo en un seul DOM. Extraire les images intégrées (encodage à vérifier), éviter les duplications inutiles, charger à la demande. Préserver l'ordre, le contenu des sections parentes et les liens entre fragments.
- Parser réellement les structures Markdown/HTML, pas de découpage fragile par regex seul. Documenter le dialecte pris en charge, diagnostics, cas ambigus et écarts au PDF. Benchmark de l'import réel avant toute optimisation complexe. Si le parser charge le fichier entier et que les mesures restent acceptables, inutile de construire un parser streaming maison.
- Stocker les ressources et fragments sur disque, avec chemins portables et identités validées ; l'écriture temporaire puis la publication atomique du manifeste évitent un état partiel. Vérifier empreintes/intégrité des transferts selon le risque. SQLite (si retenu) pour bibliothèque, états et journal ; transactions et migrations de schéma testées. Ne jamais synchroniser directement un fichier SQLite ouvert.

## Synchronisation Google Drive

Orientation : contenus quasi immuables par édition et données de lecture modifiées fréquemment, stockés séparément. Un dossier utilisateur visible pour les ouvrages, et éventuellement `appDataFolder` pour les données applicatives ; choix final à B00/B05 selon droits, portabilité, sauvegarde et comportement multi-clients. Utiliser les scopes minimaux (`drive.file` et éventuellement `drive.appdata`) plutôt qu'un accès global. Vérifier que les clients Windows et Android du même projet retrouvent bien les fichiers et données nécessaires.

Évaluer OAuth selon chaque plateforme : clients appropriés, flux autorisé via navigateur système/SDK natif, PKCE si applicable, redirection correcte, stockage sécurisé des jetons, expiration/renouvellement, révocation et changement de compte. Aucun secret confidentiel embarqué dans le client ni mot de passe Google collecté. Vérifier les contraintes de mode Testing/Production OAuth, sans confondre avec les exigences de publication Google Play. Configurer un projet Google Cloud uniquement avec accord du propriétaire ; les tests réels utilisent un compte/dossier dédié, jamais la bibliothèque personnelle par défaut.

Candidat de fusion : journal local par appareil avec identifiants d'événement uniques, files d'attente persistantes et lots de sync idempotents. Chaque appareil écrit ses propres données, évitant de remplacer simultanément un fichier global partagé. Les observations de passage acquis se fusionnent sans perte ; les corrections explicites, dernières consultations, éditions et suppressions ont des règles distinctes. Attention aux durées cumulées, aux doubles comptages, aux horloges décalées et aux événements reçus dans le désordre. Définir un ordre déterministe et testé, sans promettre de connaître l'ordre réel d'actions hors ligne concurrentes. Compaction/checkpoint uniquement lorsque nécessaire, sans perdre l'état ni les corrections.

Ne pas dépendre d'un transfert à chaque bloc ; regrouper les petites modifications, appliquer reprise après erreur, backoff et contrôle d'intégrité. Prévoir un test avec deux profils locaux isolés et un stockage simulé, complété par une validation sur Drive réel. Évaluer quotas et coûts au niveau d'un usage personnel, pas d'une architecture à grande échelle.

## Sécurité et fiabilité

Le Markdown enrichi et les fichiers Drive sont des entrées non fiables. Assainir le HTML avec une politique explicite (balises/attributs autorisés, URI sûres), empêcher scripts, gestionnaires d'événements, accès natif détourné, traversée de chemins et ressources externes chargées sans consentement. Restreindre permissions WebView/CSP et interfaces natives ; ne pas exécuter de code issu des livres. Tester images data URI valides et malveillantes, SVG et HTML imbriqué selon le dialecte réel. Éviter le réseau pour le rendu local ; ouvrir les liens externes explicitement via mécanisme sûr.

Secrets et jetons hors Git, dans le stockage sécurisé de la plateforme. Pas de logs de contenu privé ni tokens. Journaliser erreurs exploitables, versions de format et état de sync sans télémétrie distante. Les écritures locales, import interrompu, reprise après panne et sauvegarde/restauration doivent être testés.

## Décisions à instruire

| Sujet | Quand |
|---|---|
| Stack, outils, disponibilité E2E Windows/Android, OAuth de faisabilité | B00 |
| Modèle interne, dialecte Markdown, identité stable, découpage et ressources | B00/B02 |
| Métriques de suivi, visibilité, seuils, propagation manuelle et états parents | B04 |
| Politique de fusion, accès Drive, journal, reprise, sécurité OAuth | B00/B06 |
| Migrations d'éditions, suppression et sauvegarde | B02/B07 |
| Notes personnelles, thèmes supplémentaires, téléchargement sélectif | arbitrage produit |

Consigner ici les décisions validées et leurs motifs au fur et à mesure ; pas de système ADR séparé nécessaire.
