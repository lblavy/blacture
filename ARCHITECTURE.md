# Architecture et décisions techniques

## Décisions retenues le 26/11/2026

| Sujet | Décision |
|---|---|
| Produit et plateformes | Une PWA local-first pour Windows et Android |
| Application | TypeScript strict, HTML, CSS et Vite |
| Rendu et import | HTML responsive et Markdown enrichi autonome en V1, modèle interne commun |
| Distribution | Cloudflare Pages Free, origine canonique `https://blacture.blavy.eu/`, DNS chez Infomaniak |
| Hors ligne | Service Worker pour le shell applicatif. Catalogue, métadonnées et états de lecture dans IndexedDB |
| Contenus et ressources | IndexedDB dans B02. Réévaluer OPFS si un besoin est établi sur appareil réel |
| Synchronisation | Google Drive seul, facultatif. Client Web Google Identity Services, OAuth External, `drive.file` |
| Exploitation | Aucun serveur applicatif, aucun coût supplémentaire. Outils de développement et gates en local |

B01 et B01a ont validé l’installation, le hors-ligne et la persistance du témoin dans les deux environnements réels, ainsi que l’échange d’un témoin synthétique avec Drive. L’importeur, le lecteur et la synchronisation des ouvrages et de la progression relèvent des jalons suivants. Les preuves et l’historique des alternatives figurent dans le [backlog](BACKLOG.md).

## Composants logiques (orientation, pas structure de dossiers imposée)

```text
Markdown enrichi (source inchangée)
  -> Importateur -> modèle interne + contenu HTML + ressources
                          |
              stockage local fragments / métadonnées
                          |
          lecteur UI <-> progression / navigation
                          |
             journal local des modifications
                          |
                   synchronisation Drive
```

Le domaine ne dépend pas du DOM, du SDK Google ou d’IndexedDB pour ses calculs purs. Le moteur de progression accepte des observations produites par l'interface ; l'horloge, la persistance et le transport sont contrôlables en test. Ne pas multiplier les couches/interfaces sans bénéfice concret. Import et lecture doivent fonctionner sans authentification Google.

## Sélection de fichiers et repli Android

Utiliser le sélecteur du navigateur et lire le fichier choisi en tant que `File`. Vérifier sa lecture et l’annulation sur téléphone réel. Garder une UI web simple. Le seul repli envisagé est Capacitor sur Android si une limitation significative propre à ce système est démontrée.

Les prototypes Tauri et MAUI sont conservés et leurs travaux suspendus. Les essais natifs, les outils installés et les refus Smart App Control restent documentés dans B01. Smart App Control demeure actif.

## Corpus et dialecte

### Constats sur les trois Markdown réels en lecture seule

| Ouvrage, par taille croissante | Taille exacte et lignes | Titres Markdown H1 à H6 (avec ID explicite) | Identifiants de destination repérés | Images intégrées | Tableaux Markdown repérés |
|---|---:|---:|---:|---:|---:|
| 1 | 5 731 385 octets, 30 333 lignes | 467 (464) | 5 968 | 35 WebP | 0 |
| 2 | 32 941 480 octets, 150 839 lignes | 6 048 (807) | 28 173 | 1 603 WebP/PNG | 512 |
| 3 | 83 159 585 octets, 396 948 lignes | 10 903 (10 896) | 134 835 | 2 380 WebP/PNG/JPEG | 531 |

Les trois sources sont en UTF-8 sans BOM et contiennent des caractères chinois. Les deux premières utilisent CRLF, la troisième LF. Des titres ATX portent des attributs de type Pandoc `{#identifiant .classe}`. Chaque ouvrage comporte des niveaux sautés et des titres répétés. Le deuxième contient du texte avant le premier titre. Le troisième comporte un intervalle entre titres de près de 0,97 Mo après masquage des images encodées. Le découpage doit tenir compte du volume des blocs, y compris sous un titre parent.

Les destinations mêlent attributs de titres et `id` HTML sur des éléments variés. Les notes éditoriales utilisent notamment `sup` et des liens HTML vers des ancres. Des ancres d'appel servent également de cibles de retour. Aucun appel Markdown de forme `[^…]` n'a été repéré dans les ouvrages. Les deux plus gros contiennent aussi chacun un tableau HTML. Le deuxième compte 782 couples `details`/`summary`. Les attributs de classe, de présentation et `data-*` demandent une vérification de fidélité. Le repérage a identifié un marqueur de sommaire dans le plus gros ouvrage. Valider sa portée et la politique d'exclusion du suivi de lecture sur extraits.

Les images recensées sont intégrées en base64, en syntaxe Markdown ou HTML. Les 2 380 images du plus gros ouvrage occupent 59,32 Mo en base64, environ 44,49 Mo binaires avant déduplication. 388 occurrences y répètent exactement un payload antérieur. Une ligne atteint 1,80 Mo et une image WebP 9,50 mégapixels. Prévoir le coût du décodage à l'affichage en plus du poids sur disque. Les formats et dimensions détectés dans les en-têtes restent candidats aux tests de rendu réels.

Ces chiffres proviennent de plusieurs passes lexicales locales, avec rapprochement des identifiants et des fragments de liens reconnus. Dans ces passes, aucun doublon d'identifiant ou fragment non résolu n'a été détecté. Cela reste à vérifier avec le parseur, notamment après normalisation, assainissement et découpage. La comparaison de rendu sur extrait et la mesure de l'import relèvent de B02.

### Conséquences pour le dialecte proposé

Compléter les fixtures synthétiques après B00 avec des titres à attributs de type Pandoc, notes HTML et retours, `details`/`summary`, tableaux des deux syntaxes et images WebP/PNG/JPEG. Vérifier les attributs éditoriaux utiles avant de définir la liste autorisée. Conserver les destinations de liens lors de la réécriture des identifiants HTML.

## Import et représentation des ouvrages

L'approche de B00 est validée. Confirmer la fidélité sur des extraits représentatifs puis mesurer l'import complet, notamment le pic mémoire sur Android. Si les mesures rendent l'import direct d'un gros ouvrage disproportionné, documenter les alternatives. Une restriction temporaire à l'import Windows, suivie d'une synchronisation vers Android, nécessiterait un arbitrage.

- Format interne commun versionné : manifeste du livre (identité, édition, métadonnées, ordre), arbre de sections, blocs de lecture, destinations de liens, ressources. Les noms exacts et schémas sont ouverts.
- B02 identifie une édition par empreinte SHA-256 du Markdown normalisé. Le manifeste porte la version du format et peut recevoir l’identité existante d’un ouvrage. Les ancres uniques fournies par la source renforcent la stabilité. Le contexte de section, le contenu et un ordre déterministe distinguent les autres destinations et blocs, indépendamment de l’affichage. Pour les doublons sans ancre, la migration future devra vérifier un appariement indépendant de leur ordre et signaler les ambiguïtés. Les liens encodent la destination interne séparément de l’URL de navigation, y compris pour les retours de note et les renvois entre fragments.
- Évaluer CommonMark avec les extensions requises (candidat TypeScript `remark-gfm`, HTML intégré analysé par `rehype-raw`, assaini via `rehype-sanitize`). Éprouver la prise en charge ciblée des attributs de titre observés. Les blocs HTML peuvent changer l'interprétation du Markdown qu'ils entourent. Conserver les diagnostics de constructions inconnues, d'ancres dupliquées et de ressources manquantes. Un écart éditorial significatif empêche le succès de l'import. [CommonMark, blocs HTML](https://spec.commonmark.org/spec#html-blocks), [remark-gfm](https://github.com/remarkjs/remark-gfm), [rehype-sanitize](https://github.com/rehypejs/rehype-sanitize).
- Découper l'arbre analysé en fragments par section puis par blocs si une section est volumineuse. Conserver le contenu propre de chaque parent et l'ordre canonique. Garder un index compact des destinations et ouvrir seulement le fragment utile et ses ressources. Extraire les images autorisées en binaires adressés par empreinte et contrôler dimensions et taille. Évaluer le parseur complet hors du fil UI sur téléphone. La chaîne texte décodé, AST, HTML et buffers d'images peut multiplier le pic mémoire. Mesurer les copies, le décodage et la mémoire réelle avant d’envisager une extraction anticipée ou un parseur incrémental.

## Stockage local et hors ligne

- Garder le catalogue et les petits états dans IndexedDB. Lire au besoin le fragment de contenu et les ressources qu’il référence. Garder le Service Worker centré sur le shell. Les ouvrages et états restent dans le stockage local de l’origine.
- Éprouver d’abord une publication d’édition atomique dans IndexedDB avec des entrées de catalogue distinctes des fragments. Les ressources, le manifeste et l’entrée de catalogue deviennent visibles ensemble. Après annulation, arrêt ou manque d’espace, un nouvel essai doit être possible et les éditions précédentes rester utilisables. Si les mesures imposent OPFS, publier le pointeur IndexedDB après validation des écritures et récupérer les éléments temporaires au redémarrage.
- Le banc B02 Windows confirme un accès local rapide sous le volume de l’ouvrage de 83,16 Mo. Sur un même fragment avec ses deux images, la médiane de lecture à chaud est de 2,15 ms pour IndexedDB et 3,80 ms pour OPFS. Cette mesure est propre à cet échantillon Windows. IndexedDB permet une seule transaction de publication. Le coût dominant du gros import est l’analyse du Markdown. Le résultat doit encore être confronté à la mémoire du téléphone réel. [Mesures B02](BACKLOG.md#b02--importateur-et-modèle-interne-f01f03-q01q11q12)
- Enregistrer toute future modification de lecture et son état de synchronisation dans une transaction locale. Tester l’arrêt brutal. La persistance accordée par le navigateur réduit le risque d’éviction. La sauvegarde, l’export et la restauration sont traités en B07.

## Lecteur local

Le lecteur charge le manifeste à l’ouverture de l’ouvrage, puis le seul fragment demandé et ses ressources. Le sommaire déplie les branches à la demande et conserve l’accès au contenu propre des sections parentes. Le fragment et la destination du renvoi figurent dans le hash local de navigation. Les retours aux appels s’appuient sur l’historique du navigateur. Cette navigation ne constitue pas un suivi de progression.

La mise à jour de la base IndexedDB de B02 ajoute un magasin de préférences en version 2. Les magasins et enregistrements de catalogue, de manifestes, de fragments et de ressources sont conservés. Le Service Worker sert le shell hors ligne. La préférence de taille du texte et le contenu restent disponibles localement.

B04 ajoute deux magasins en version 3, pour les index de progression par édition et les états de lecture. Le premier accès examine les fragments JSON existants un par un, sans charger leurs binaires, et met en cache les identifiants et poids des blocs pertinents. La lecture du fragment demandé peut commencer pendant la préparation de cet index. Les écritures relisent l’état courant et mettent à jour la progression et le résumé du catalogue dans la même transaction. Les observations, corrections et positions restent distinctes.

## Synchronisation Google Drive

**Orientation validée.** Un client Web Google Identity Services commun aux deux plateformes utilise le modèle de jeton, OAuth External et le seul scope `drive.file`. Le jeton de courte durée reste en mémoire. L’application peut demander un geste pour reprendre la synchronisation après expiration ou relance, limitation acceptée pour V1. La lecture et les écritures locales continuent pendant cette indisponibilité. Le statut local et le statut de synchronisation sont visibles. B01a a vérifié les échanges du témoin dans les deux sens. En B06, éprouver le transfert des éditions et la fusion. [Modèle de jeton GIS](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [scopes Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

- Tester avec des comptes dédiés. En Testing, le projet gère une liste de testeurs et les autorisations Drive expirent après sept jours. En Production External, les utilisateurs admissibles peuvent consentir sans liste nominative ni projet à créer. Avant de retenir la configuration Production, vérifier les exigences de branding de Google, dont le domaine autorisé, la page d'accueil et la politique de confidentialité, ainsi que l'affichage du nom et du logo. `drive.file` est classé non sensible. Des restrictions du compte Google peuvent s'appliquer. La publication OAuth est indépendante de Google Play. Toute configuration Google Cloud requiert l'accord préalable du propriétaire. [Audience OAuth](https://support.google.com/cloud/answer/15549945), [branding](https://support.google.com/cloud/answer/15549049), [vérification OAuth](https://support.google.com/cloud/answer/13463073).
- Séparer la déconnexion locale de la révocation du consentement, qui peut affecter les deux appareils. Vérifier le renouvellement, le changement de compte et l'isolation des données et lots en attente. Évaluer `user.permissionId` comme identifiant Drive du profil local. [Drive about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).
- Envoyer les gros fichiers avec reprise et vérifier leur taille et leur empreinte avant publication locale. Garder les identifiants des créations retentées pour éviter les doublons. Utiliser des lots et des délais croissants en cas de quota ou d'indisponibilité. Le stockage reste celui du compte Drive. Revalider les limites et les éventuels coûts au jalon B06. [Envois](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [téléchargements](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [limites et quotas](https://developers.google.com/workspace/drive/api/guides/limits).
- Pour la fusion, chaque appareil produit des lots immuables aux identifiants uniques, dédupliqués à la réception. Fusionner les unités acquises par union. Une même durée observée et rejouée ne doit compter qu'une fois. Traiter positions et corrections explicites séparément, avec ordre causal local et départage déterministe des écritures concurrentes sans se fier uniquement à l'heure système. Éditions et suppressions demandent une politique explicite. Tester avec transport simulé puis sur deux installations réelles. Reporter la compaction jusqu'à un besoin mesuré.

## Sécurité et fiabilité

Le Markdown enrichi et les fichiers Drive sont des entrées non fiables. Assainir le HTML avec une politique explicite (balises/attributs autorisés, URI sûres), empêcher scripts, gestionnaires d’événements, traversée de chemins et ressources externes chargées sans consentement. Restreindre les sources et autorisations par CSP ; ne pas exécuter de code issu des livres. Tester images data URI valides et malveillantes, SVG et HTML imbriqué selon le dialecte réel. Éviter le réseau pour le rendu local ; ouvrir les liens externes explicitement via mécanisme sûr.

Conserver les jetons GIS uniquement en mémoire. L’identifiant du client OAuth Web est public. Garder le corpus et les jetons hors Git, des logs et des traces. Journaliser les erreurs exploitables, les versions de format et l'état de sync sans télémétrie distante. Tester les écritures locales, l'import interrompu, la reprise après panne et la sauvegarde/restauration.

## Décisions à instruire

| Sujet | Quand |
|---|---|
| Prérequis et preuves PWA | B01 validé sur PC et téléphone |
| Modèle interne, dialecte Markdown, identité stable, découpage et ressources | Inventaire B00 réalisé, validation B02 sur extrait et gros ouvrage. |
| Métriques de suivi, visibilité, seuils, propagation manuelle et états parents | B04 |
| Témoin Drive dans les deux sens, renouvellement | B01a validé. Expérimenter l’accès d’un second utilisateur et préparer Production en B06 |
| Politique de fusion, journal, reprise et sécurité de la synchronisation | B06, après preuve B01a |
| Migrations d'éditions, suppression et sauvegarde | B02/B07 |
| Notes personnelles, thèmes supplémentaires, téléchargement sélectif | arbitrage produit |

Consigner ici les décisions validées et leurs motifs au fur et à mesure ; pas de système ADR séparé nécessaire.
