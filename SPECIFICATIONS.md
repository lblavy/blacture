# Spécifications fonctionnelles

Statut : cadrage initial. « Confirmé » correspond au besoin retenu ; « proposition » doit être expérimenté ou validé ; « ouvert » nécessite un arbitrage avant réalisation. Les identifiants Fxx servent aux tests et au backlog.

## 1. Bibliothèque et import

**F01 — Bibliothèque (confirmé).** Afficher les ouvrages importés avec leur titre, état (non commencé, partiel, terminé), progression et disponibilité locale. Chaque ouvrage possède une progression indépendante. Permettre de sélectionner un ouvrage, d'importer un fichier et de retrouver les ouvrages synchronisés. Distinguer retirer une copie locale et supprimer un ouvrage/données partagés ; les règles de suppression sont ouvertes, avec confirmation explicite pour toute suppression distante.

**F02 — Import (confirmé).** Accepter un fichier Markdown enrichi autonome, éventuellement volumineux. Extraire le contenu éditorial, la hiérarchie, les identifiants, le texte chinois/Unicode, les notes et leurs appels, les références, les tableaux, les images intégrées et les liens internes. Préserver l'ordre et le contenu, sans réécriture ni modification de la source. Signaler les constructions non prises en charge et les pertes potentielles ; ne pas présenter un import incomplet comme réussi. L'import doit être annulable ou récupérable sans ouvrage partiellement visible (modalité à définir).

Le lecteur ne dépend pas du format source et ne suppose aucune profondeur de sommaire ni nombre fixe de chapitres. Les textes sans titres, sections vides, titres répétés, niveaux sautés, contenu avant le premier titre et références croisées doivent être pris en compte. Pas d'import PDF, EPUB ou HTML séparé en V1 ; ne pas reconstruire la mise en page PDF à l'identique.

**F03 — Éditions (objectif confirmé, modalités ouvertes).** Pouvoir réimporter une édition d'un ouvrage sans perdre silencieusement le suivi. Identifier les contenus inchangés, conserver leurs états et indiquer les contenus modifiés/ambigus/non migrables. Éviter les rapprochements hasardeux par titre seul. Les modalités de remplacement, conservation des versions, réconciliation et confirmation de migration sont à définir avant mise en œuvre. Une solution simple de migration suffit en V1 ; aucune gestion éditoriale complexe.

## 2. Lecture et navigation

**F04 — Lecture (confirmé).** Présentation HTML responsive, adaptée à Windows et Android. Affichage lisible des notes, tableaux et images, caractères chinois, liens entre sections et accès au retour après consultation d'une note ou d'un renvoi. Ajuster au minimum la taille du texte ; largeur, interligne, thème clair/sombre et autres réglages sont des propositions à prioriser. Les éléments de mise en page papier (pagination fixe, en-têtes, sauts) ne sont pas exigés. Ne charger que les contenus utiles à l'écran ; préserver l'état en naviguant dans de très grands ouvrages.

**F05 — Sommaire (confirmé).** Arborescence de profondeur variable, dépliable, avec accès direct à chaque entrée et état lu/partiel/non lu. Le contenu propre d'une section parente doit être accessible et comptabilisé, même si elle a des enfants. Ne pas confondre le sommaire éditorial fourni avec le contenu à lire ; politique d'exclusion des éléments de navigation à définir à l'import. L'ordre canonique de lecture est celui du contenu importé.

**F06 — Deux reprises (confirmé).** Enregistrer indépendamment par ouvrage :

- « Dernière consultation » : revenir au dernier emplacement consulté, y compris si déjà lu.
- « Continuer ma progression » : aller au premier passage non lu dans l'ordre de l'ouvrage, y compris à l'intérieur d'une section partielle. Si tout est lu, afficher un état terminé et ne pas choisir arbitrairement une position.

Les libellés sont provisoires. Exemple : chapitres 1–29 terminés, chapitre 30 entamé, retour au chapitre 7 ; la première action mène au chapitre 7, la seconde au premier passage non lu du 30. La consultation du chapitre 7 ne réinitialise pas la progression. Proposition : depuis une section partielle du sommaire, offrir aussi une reprise au premier passage non lu de cette section, sans supprimer l'accès direct à son début.

## 3. Progression

**F07 — Détection automatique (confirmé dans son principe).** Mesurer les unités de contenu réellement visibles et mémoriser les passages parcourus de manière cumulative. Il s'agit d'une approximation de lecture, pas d'une preuve de compréhension. Ne pas assimiler un déplacement de scroll, un saut via un lien ou une fin de section affichée à la lecture du contenu intermédiaire. Suspendre le comptage quand la fenêtre est en arrière-plan, masquée ou l'appareil verrouillé. Éviter les incréments dus à des notifications, à un chargement ou à un écran laissé ouvert sur du contenu non visible.

Proposition d'expérimentation : seuil initial de 8 secondes cumulées par unité suffisamment visible (plage discutée 5–10 s) et seuil de complétion initial de 95 % du contenu pertinent d'une section. Ce ne sont pas des règles figées. Définir la granularité, le pourcentage de visibilité, le traitement des blocs plus grands que l'écran, le temps inactif, la pondération selon la quantité de texte et le traitement des images/tableaux/notes. Éviter qu'un grand écran valide artificiellement plus de contenu qu'un petit écran. Les unités doivent rester stables malgré changement de police, d'écran ou de plateforme. Prévoir des tests déterministes avec horloge contrôlable.

**F08 — Agrégation (confirmé).** États non commencé, en cours/partiel, terminé à chaque niveau, livre compris. Progression détaillée des sections partiellement lues conservée et visible (pourcentage ou autre mesure intelligible). Agrégation pondérée par le contenu pertinent, pas seulement par le nombre de titres. Un parent est terminé lorsque son contenu propre et ses descendants pertinents sont terminés. Les unités ne doivent pas être comptées deux fois. Définir le comportement des sections vides ou purement navigatoires.

**F09 — Correction manuelle (confirmé).** Cocher et décocher manuellement les sections et niveaux de la hiérarchie. Une dévalidation ne doit pas être immédiatement annulée par le moteur automatique ; conserver l'état manuel séparé des observations. Proposition : trois modes (auto, forcé lu, forcé non lu) avec action de retour en automatique. Conserver les observations originales. Règles de propagation parent/enfant, contradictions et reprise dans une section forcée non lue à préciser avant implémentation. La reprise doit suivre l'état effectif, même lorsqu'une section est marquée non lue manuellement. Ne pas effacer les notes ou autres données lors d'une correction de progression.

## 4. Fonctionnement hors ligne et synchronisation

**F10 — Local-first (confirmé).** Le lecteur fonctionne sans compte Google ni réseau pour les ouvrages disponibles localement : lecture, navigation, progression, corrections et reprise. Enregistrer durablement et régulièrement les modifications ; restaurer après fermeture/redémarrage. Afficher si un ouvrage ou une section est téléchargé, et permettre de télécharger un ouvrage complet pour le lire hors connexion. Téléchargement sélectif par partie envisagé si utile, pas obligatoire en première réalisation. Un contenu absent localement doit être signalé clairement, sans écran bloqué. Les opérations de lecture ne dépendent pas de la disponibilité du cloud.

**F11 — Google Drive (confirmé).** L'utilisateur peut connecter son propre compte Google, importer une fois puis récupérer les ouvrages et états depuis un second appareil. Pas de compte applicatif central. Synchroniser automatiquement par lots raisonnables, notamment à la reprise, lors de modifications et à la reconnexion, avec action manuelle de synchronisation et états visibles (hors ligne, en attente, synchronisé, erreur). Éviter les transferts du livre complet lors d'une simple progression. Gérer annulation, échecs, quota, stockage plein, interruption, jeton expiré et déconnexion. Le lecteur local reste fonctionnel. Isoler les données de comptes différents ; ne jamais mélanger leurs contenus sans décision explicite.

**F12 — Conflits (confirmé dans son principe).** Deux appareils peuvent lire hors ligne simultanément. Fusionner les observations sans perdre les passages acquis ; dédupliquer les événements et préserver les corrections manuelles. Les dernières consultations sont des positions, pas des maxima de progression. Définir un ordre de résolution déterministe pour positions et corrections concurrentes, gérer les horloges décalées et signaler les conflits non résolubles. Exemple : A lit 30 et B lit 35 hors ligne, après sync les deux passages sont lus partout. Une répétition de sync ne doit pas changer le résultat ni dupliquer les données. Les suppressions et éditions concurrentes demandent une règle explicite.

## 5. Fonctions complémentaires et limites

**F13 — Signets, surlignages, notes personnelles (envisagé).** La discussion a identifié leur intérêt et leur synchronisation ; le détail et leur priorité V1 restent ouverts. Distinguer notes éditoriales importées (F02/F04, obligatoires) et annotations créées par l'utilisateur. Prévoir des ancres stables, une fonction d'export/récupération et une stratégie de migration si retenues. Ne pas construire un éditeur de documents.

**F14 — Sauvegarde et récupération (orientation retenue).** Permettre à l'utilisateur de récupérer ses ouvrages et données de lecture dans des formats documentés. Définir une procédure simple d'export/restauration et de récupération après désinstallation ou corruption. Pas de télémétrie obligatoire ni collecte centralisée.

Hors périmètre : SaaS, collaboration, partage social, magasin de livres, DRM, IA embarquée, éditeur Markdown, publication Play Store, iOS/macOS, hébergement propre et backends distants multiples. Toute extension nécessite un accord explicite.
