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
- À l’import, reconnaître les conteneurs Markdown délimités par des lignes `:::` avec des classes et identifiants entre accolades, dans les paragraphes à la racine. Les conteneurs appariés passent par le même assainissement que le HTML éditorial. Préserver le code et les délimiteurs ambigus, ainsi que les marqueurs intégrés aux listes et citations. Le correctif s’applique lors d’un nouvel import. La mise à jour du rendu d’une édition déjà stockée doit préserver la progression et relève de B07. [Syntaxe des conteneurs Pandoc](https://pandoc.org/MANUAL.html#extension-fenced_divs)
- Découper l'arbre analysé en fragments par section puis par blocs si une section est volumineuse. Conserver le contenu propre de chaque parent et l'ordre canonique. Garder un index compact des destinations et ouvrir seulement le fragment utile et ses ressources. Extraire les images autorisées en binaires adressés par empreinte et contrôler dimensions et taille. Évaluer le parseur complet hors du fil UI sur téléphone. La chaîne texte décodé, AST, HTML et buffers d'images peut multiplier le pic mémoire. Mesurer les copies, le décodage et la mémoire réelle avant d’envisager une extraction anticipée ou un parseur incrémental.

## Stockage local et hors ligne

- Garder le catalogue et les petits états dans IndexedDB. Lire au besoin le fragment de contenu et les ressources qu’il référence. Garder le Service Worker centré sur le shell. Les ouvrages et états restent dans le stockage local de l’origine.
- Éprouver d’abord une publication d’édition atomique dans IndexedDB avec des entrées de catalogue distinctes des fragments. Les ressources, le manifeste et l’entrée de catalogue deviennent visibles ensemble. Après annulation, arrêt ou manque d’espace, un nouvel essai doit être possible et les éditions précédentes rester utilisables. Si les mesures imposent OPFS, publier le pointeur IndexedDB après validation des écritures et récupérer les éléments temporaires au redémarrage.
- Le banc B02 Windows confirme un accès local rapide sous le volume de l’ouvrage de 83,16 Mo. Sur un même fragment avec ses deux images, la médiane de lecture à chaud est de 2,15 ms pour IndexedDB et 3,80 ms pour OPFS. Cette mesure est propre à cet échantillon Windows. IndexedDB permet une seule transaction de publication. Le coût dominant du gros import est l’analyse du Markdown. Le résultat doit encore être confronté à la mémoire du téléphone réel. [Mesures B02](BACKLOG.md#b02--importateur-et-modèle-interne-f01f03-q01q11q12)
- Enregistrer toute future modification de lecture et son état de synchronisation dans une transaction locale. Tester l’arrêt brutal. La persistance accordée par le navigateur réduit le risque d’éviction. La sauvegarde, l’export et la restauration sont traités en B07.

Le manifeste conserve son identifiant, sa portée et son URL de démarrage à la racine de l’origine canonique. Le Service Worker prépare une version complète du shell avant activation. Un téléchargement invalide laisse la version active disponible. Quand une version attend, l’application propose de l’appliquer et attend la fin de l’import courant et des écritures du lecteur avant de recharger. Les ouvrages, la progression et les préférences restent dans IndexedDB.

Dans la bibliothèque, le panneau **Stockage local** indique si le navigateur confirme la persistance. L’utilisateur peut la demander depuis ce panneau. La suppression des données du site ou du profil peut toujours effacer le contenu. Conserver les fichiers Markdown sources pour réimporter si nécessaire. [Persistance du stockage](https://web.dev/articles/persistent-storage)

## Lecteur local

Le lecteur charge le manifeste à l’ouverture de l’ouvrage, puis le seul fragment demandé et ses ressources. Le sommaire déplie les branches à la demande et conserve l’accès au contenu propre des sections parentes. Le fragment et la destination du renvoi figurent dans le hash local de navigation. Les retours aux appels s’appuient sur l’historique du navigateur. Cette navigation ne constitue pas un suivi de progression.

La mise à jour de la base IndexedDB de B02 ajoute un magasin de préférences en version 2. Les magasins et enregistrements de catalogue, de manifestes, de fragments et de ressources sont conservés. Le Service Worker sert le shell hors ligne. La préférence de taille du texte et le contenu restent disponibles localement.

B04 ajoute deux magasins en version 3, pour les index de progression par édition et les états de lecture. Le premier accès examine les fragments JSON existants un par un, sans charger leurs binaires, et met en cache les identifiants et poids des blocs pertinents. La lecture du fragment demandé peut commencer pendant la préparation de cet index. Les écritures relisent l’état courant et mettent à jour la progression et le résumé du catalogue dans la même transaction. Les observations, corrections et positions restent distinctes.

## Sauvegarde d’un ouvrage

L’export B07 prend un instantané en lecture seule dans IndexedDB. Le fichier `.blacture` réunit le paquet d’édition versionné, la progression et ses événements, ainsi que les images binaires. L’inspection valide le paquet et les images et contrôle la structure des données de lecture. Les opérations d’export et d’inspection se déroulent dans le navigateur.

Le format 1 commence par 80 octets. La signature ASCII `BLACBK01` est suivie des longueurs du JSON d’édition et du JSON de lecture, chacune sur 32 bits big-endian, puis de leurs empreintes SHA-256 brutes sur 32 octets chacune. Suivent les deux JSON encodés en UTF-8. Le JSON de lecture contient `progress` et `events`. Les images se suivent dans l’ordre lexicographique de leurs identifiants SHA-256. Le paquet d’édition contient leur taille et leur format. L’archive se termine après le dernier octet de la dernière image.

IndexedDB v5 conserve la sauvegarde de la dernière édition remplacée. Le remplacement publie le nouvel ouvrage et son suivi dans la même transaction que la sauvegarde de l’édition sortante. L’empreinte du Markdown reste dans le manifeste et l’identité de la révision dépend aussi du rendu. Les correspondances fiables migrent automatiquement. Les consultations sans position de bloc fiable et les cas ambigus restent dans la sauvegarde. Avant un deuxième remplacement, l’interface invite à exporter la précédente sauvegarde pour la conserver.

La restauration dans une bibliothèque sans cet ouvrage vérifie les références de lecture et publie l’édition et sa progression dans une seule transaction. Les événements restaurés utilisent leurs identifiants d’origine pour dédupliquer ceux qui sont déjà présents lors d’une synchronisation Drive. Un journal créé après retrait, restauration ou remplacement reçoit une nouvelle identité. Les journaux existants conservent la leur.

Une révision conserve le titre de l’ouvrage, l’empreinte de la nouvelle source et l’identifiant de l’édition remplacée. Son identité dépend du prédécesseur et du rendu. Un paquet Drive v2 signale la révision et protège les profils B06 contre son installation prématurée. Les paquets ordinaires gardent leur format v1. Le téléchargement d’un successeur direct demande confirmation, valide le contenu et les lots Drive avant la transaction et conserve la copie locale remplacée en sauvegarde. Une révision téléchargée commence à envoyer les lectures locales sur autorisation explicite de synchronisation.

La liste Drive retient la dernière version d’une chaîne ou son prochain successeur pour l’appareil. Les révisions de la même source pour un même ouvrage partagent une empreinte, même si une édition intermédiaire est restée locale. Les références déclarées dans Drive sont contrôlées lors de l’adoption. Les anciens paquets révèlent ces identités dans leur en-tête, lu sur un maximum de 16 Kio. Un appareil peut avancer par étapes déjà publiées. Lorsque des sources distinctes ont été remplacées successivement sans publication intermédiaire, l’adoption directe par un appareil plus ancien reste limitée à la filiation vérifiable.

Un même passage peut hériter sur deux appareils d’une partie des mêmes lectures. Pour le suivi hérité, les lots v2 fusionnent la plus longue durée par passage et réunissent les zones parcourues. Deux durées anciennes dont les historiques se chevauchent peuvent donc laisser une partie du cumul dans les sauvegardes. Les observations de la nouvelle révision s’ajoutent ensuite par identifiant d’événement. Les corrections héritées se combinent par section. Les corrections et positions enregistrées sur la nouvelle édition priment sur les données héritées.

## Synchronisation Google Drive

**Orientation validée.** Un client Web Google Identity Services commun aux deux plateformes utilise le modèle de jeton, OAuth External et le seul scope `drive.file`. Le jeton de courte durée reste en mémoire. L’application peut demander un geste pour reprendre la synchronisation après expiration ou relance, limitation acceptée pour V1. La lecture et les écritures locales continuent pendant cette indisponibilité. Le statut local et le statut de synchronisation sont visibles. B01a a vérifié les échanges du témoin dans les deux sens. En B06, éprouver le transfert des éditions et la fusion. [Modèle de jeton GIS](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [scopes Drive](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

- Tester avec des comptes dédiés. En Testing, le projet gère une liste de testeurs et les autorisations Drive expirent après sept jours. En Production External, les utilisateurs admissibles peuvent consentir sans liste nominative ni projet à créer. Avant de retenir la configuration Production, vérifier les exigences de branding de Google, dont le domaine autorisé, la page d'accueil et la politique de confidentialité, ainsi que l'affichage du nom et du logo. `drive.file` est classé non sensible. Des restrictions du compte Google peuvent s'appliquer. La publication OAuth est indépendante de Google Play. Toute configuration Google Cloud requiert l'accord préalable du propriétaire. [Audience OAuth](https://support.google.com/cloud/answer/15549945), [branding](https://support.google.com/cloud/answer/15549049), [vérification OAuth](https://support.google.com/cloud/answer/13463073).
- Séparer la déconnexion locale de la révocation du consentement, qui peut affecter les deux appareils. Vérifier le renouvellement, le changement de compte et l'isolation des données et lots en attente. Évaluer `user.permissionId` comme identifiant Drive du profil local. [Drive about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get).
- Envoyer les gros fichiers avec reprise et vérifier leur taille et leur empreinte avant publication locale. Garder les identifiants des créations retentées pour éviter les doublons. Utiliser des lots et des délais croissants en cas de quota ou d'indisponibilité. Le stockage reste celui du compte Drive. Revalider les limites et les éventuels coûts au jalon B06. [Envois](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [téléchargements](https://developers.google.com/workspace/drive/api/guides/manage-downloads), [limites et quotas](https://developers.google.com/workspace/drive/api/guides/limits).
- Pour la fusion, chaque appareil produit des lots immuables aux identifiants uniques, dédupliqués à la réception. Fusionner les unités acquises par union. Une même durée observée et rejouée ne doit compter qu'une fois. Traiter positions et corrections explicites séparément, avec ordre causal local et départage déterministe des écritures concurrentes sans se fier uniquement à l'heure système. Éditions et suppressions demandent une politique explicite. Tester avec transport simulé puis sur deux installations réelles. Reporter la compaction jusqu'à un besoin mesuré.

La projection B06 testée en simulation lit des lots JSON versionnés qui déclarent l’édition, l’appareil et l’empreinte SHA-256 de l’arbre de lecture. L’ordre des sections, des fragments et des blocs, ainsi que leurs poids, entrent dans cette empreinte. Une même source Markdown peut produire un autre index après évolution de l’importeur. Dans ce cas, refuser la fusion préserve les acquis locaux en attendant une règle de migration. L’identifiant déclaré par un lot sert à dédupliquer ses événements. L’isolation des comptes repose sur la session Drive et la séparation des données au stockage, à éprouver au raccordement.

**Candidat B06 soumis au checkpoint.** IndexedDB v4 ajoute le journal des événements et les réceptions. La mise à jour du catalogue et de la progression partage la transaction du journal. Une horloge reçue hors des limites d’adoption est rejetée avant écriture. Les fichiers Drive distinguent le paquet d’édition, les ressources binaires adressées par empreinte et les lots de progression versionnés. L’envoi confirme les ressources avant de publier le paquet. À la réception, le worker contrôle le paquet avant stockage. Une autre empreinte d’index bloque la fusion. Un curseur par édition fixe les limites du lot en attente avant transfert. Les tickets isolés par compte conservent l’identifiant réservé et l’adresse de reprise tant que l’envoi est en cours. Un fichier confirmé et ensuite supprimé n’est pas recréé automatiquement.

Le premier échange associe la bibliothèque locale à l’identité Drive `user.permissionId` de ce profil navigateur. La connexion seule valide le compte et le téléchargement se limite à la réception. L’action de synchronisation sur un ouvrage ouvre le suivi des modifications de cet ouvrage. Un second compte utilise un profil séparé. Cette modalité d’association reste à valider par le propriétaire avant l’essai réel. [Identité Drive](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)

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
