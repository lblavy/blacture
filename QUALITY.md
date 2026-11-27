# Qualité, tests et validation locale

Les contrôles de Blacture sont des scripts locaux versionnés et exécutables par Codex. Une commande rapide sert à la boucle TDD. Les audits, E2E et mesures disposent de commandes distinctes. Tout ajustement significatif des seuils ou exclusions requiert un arbitrage du propriétaire.

## 1. Clean Code et TDD

Code lisible, responsabilités cohérentes, noms explicites, fonctions simples, types stricts, erreurs traitées et dépendances maîtrisées. SOLID et DRY avec discernement : ne pas créer une abstraction pour un besoin imaginaire, ne pas dupliquer une règle métier. Préférer le code pur pour la progression et la fusion, injecter les dépendances réellement nécessaires aux tests (horloge, I/O, transport). Éviter état global mutable, logique métier enfouie dans l'UI et exceptions avalées. Commenter les raisons ou contraintes non évidentes, pas le code trivial.

Pour tout comportement nouveau ou corrigé : écrire un test qui échoue pour la bonne raison (RED), implémenter le minimum (GREEN), refactoriser avec tests verts (REFACTOR). Les tests vérifient des comportements, pas les détails d'implémentation ; tester limites, erreurs et scénarios de régression. TDD pragmatique pour UI visuelle, prototypes jetables, configuration et intégrations système : une preuve adaptée est acceptable, sans prétendre que du TDD a été réalisé lorsqu'il ne l'a pas été. Les prototypes ne deviennent pas du code de production sans validation.

## 2. Quality Gates rapides et obligatoires

| Indicateur | Seuil initial | Portée / mesure |
|---|---:|---|
| Couverture lignes | ≥ 90 % | Code applicatif maintenu, global |
| Couverture branches | ≥ 85 % | Code applicatif maintenu, global |
| Couverture lignes métier critique | ≥ 95 % | Progression, fusion/sync, migration des éditions, règles d'intégrité |
| Duplication | ≤ 3 % | Code applicatif maintenu, mesure tokenisée selon outil |
| Complexité cyclomatique | ≤ 10 | Par fonction ou méthode, selon analyseur |
| Complexité cognitive | ≤ 15 | Par fonction ou méthode, selon analyseur |
| Lint | 0 erreur, 0 avertissement | Code et configuration concernés |
| Typage / compilation | 0 erreur | Langages et plateformes concernés par le changement |
| Formatage | 0 écart | Fichiers soumis aux règles de formatage |
| Tests rapides | 0 échec | Unitaires et intégration locale ; aucun test obligatoire ignoré silencieusement |
| Dépendances | 0 vulnérabilité élevée/critique connue non traitée | Dépendances distribuées et risques dev pertinents ; documenter les exceptions |

Mesurer le code effectivement maintenu, y compris les fichiers non importés par les tests. Documenter précisément inclusions/exclusions et version de l'outil. Exclure seulement les dépendances externes, fichiers générés et fixtures qui ne sont pas du code applicatif ; les tests, scripts et configurations restent soumis aux contrôles adaptés. Ne pas exclure du code métier faute de test. Séparer les métriques par langage si les outils ne produisent pas une mesure comparable ; ne pas diluer un module critique avec du code plus simple. Aucune règle universelle sur le nombre de lignes d'une méthode ou d'un fichier : les signalements doivent mener à un jugement de lisibilité. Pas de refactoring artificiel destiné uniquement à améliorer un score.

Si une métrique n'est pas disponible à coût raisonnable (par exemple complexité cognitive d'un langage secondaire), documenter la limite, proposer une alternative et demander validation avant d'alléger le contrôle. Ne pas inventer de score, modifier les seuils, masquer des avertissements ou utiliser des exclusions pour passer la gate.

## 3. Outillage local validé

| Contrôle | Outils et preuve attendue |
|---|---|
| TypeScript | TypeScript strict, Prettier, ESLint et SonarJS local pour les deux complexités, jscpd pour la duplication, Vitest et V8 pour les tests unitaires, d'intégration et la couverture. Inclure les fichiers non importés et vérifier le périmètre critique dès son introduction. Provoquer puis retirer des échecs de test, couverture, seuils et règles. |
| Dépendances et secrets | Audits des dépendances aux changements et jalons. Gitleaks en local, historique accessible, index, diff suivi et fichiers non suivis candidats. Conserver une sortie expurgée. Les fichiers privés ignorés restent hors de ce contrôle. |
| Tests ciblés | Mutation et propriétés aux jalons métier pertinents. StrykerJS et fast-check sont des candidats. Ajouter une suite web ou une dépendance UI quand un scénario en a besoin. |

Pour un contrôle disproportionné, présenter le coût observé, les défauts couverts, l'alternative et le risque résiduel. Documenter les parcours manuels avec versions, étapes et preuve. Toute dérogation durable demande un accord.

Préparer les parcours manuels sur un build éprouvé et les regrouper par checkpoint. Exécuter les régressions automatisées avant le checkpoint pour réserver le temps du propriétaire aux vérifications qui demandent son appareil ou son compte.

### Preuves PWA sur Windows et Android

- Automatiser les parcours web critiques avec Playwright sur le Chrome installé, depuis les ressources de production servies en loopback. Couvrir import, diagnostics, annulation, persistance et relance hors ligne.
- Compléter sur téléphone Android réel pour l’installation depuis Chrome, le sélecteur de fichier système et son annulation, le tactile, l’arrêt et le redémarrage. Conserver étapes, versions et preuve. Les temps mesurés sur émulateur restent séparés.
- En B05, revérifier l’installation, une navigation hors ligne et la persistance des données métier après redémarrage sur les deux cibles. Les preuves du témoin B01 figurent dans le backlog. [Navigateurs Playwright](https://playwright.dev/docs/browsers)
- Le test Windows B05 installe et relance la PWA via Chrome DevTools Protocol avec un profil isolé. Il vérifie le mode autonome, un nouveau processus Chrome, le serveur local arrêté et la conservation des données. Le lancement depuis l’icône système et le parcours Android réel restent au checkpoint. [Domaine PWA du protocole Chrome](https://chromedevtools.github.io/devtools-protocol/tot/PWA/)

## 4. Pyramide de tests

- **Unitaires** : modèle interne, calculs de progression, navigation, agrégation, overrides manuels, résolution de conflits, validation des ancres, logique de migration. Horloge simulée et données déterministes ; aucun accès réseau.
- **Intégration** : importateur réel, fichiers temporaires, base locale réelle, transactions, migrations, sync simulée, erreurs d'I/O, panne et reprise. Simuler Drive au niveau transport pour la majorité des tests ; ne pas simuler ce que le test prétend vérifier.
- **Composants et E2E web** : interaction et rendu responsive, états du sommaire, navigation, accessibilité élémentaire, clavier et tactile. Un viewport mobile vérifie uniquement le rendu et les interactions simulées.
- **E2E Windows** : Playwright sur Chrome. Compléter sur l’application installée pour les interactions système, le redémarrage et le hors-ligne.
- **E2E Android** : tests web reproductibles et validations du vrai sélecteur, du cycle de vie et du stockage sur téléphone. Automatiser sur appareil lorsque l’environnement le permet.
- **Drive réel** : tests ciblés OAuth, transfert, deux appareils, conflits et reconnexion, via compte/dossier de test autorisé. Pas de dépendance réseau ni d'identifiants réels dans la suite rapide. Ne pas confondre un test simulé et une validation du service réel.

Les agents doivent pouvoir exécuter les scripts eux-mêmes une fois les prérequis présents, récupérer code de sortie, logs et, pour UI, captures/traces sur échec. Protéger les données privées dans les traces. Ne pas utiliser le compte personnel du propriétaire pour des tests destructifs.

## 5. Vérifications renforcées, ciblées et raisonnables

### Mutation testing

Objectif initial : score ≥ 80 % sur le périmètre métier sélectionné, objectif 90 % sur progression et fusion. Mesurer sur les modules critiques aux jalons concernés, pas à chaque commit. Définir précisément les mutants exclus/équivalents, sans masquer des tests faibles. Si l'outil ou le temps d'exécution est disproportionné, proposer un périmètre ciblé ou des tests de limites supplémentaires ; arbitrage avant d'en faire une gate bloquante. Le score n'est pas une mesure globale obligatoire tant que l'outil et son périmètre n'ont pas été validés.

### Property-based testing

Tester notamment l'idempotence de la synchronisation, l'absence de pertes de passages acquis, la convergence déterministe selon la politique retenue, la stabilité des ancres, l'agrégation bornée et cohérente, les doublons et événements hors ordre. Tester les corrections et suppressions séparément de la progression automatique monotone. Enregistrer les seeds des échecs pour reproduction.

### Golden tests et fidélité éditoriale

Fixtures synthétiques versionnées : Markdown simple, enrichi, hiérarchie inhabituelle, notes, images intégrées, tableaux, ancres et caractères chinois. Vérifier le texte normalisé, l'ordre, les images/empreintes, les références et destinations, les diagnostics et la sécurité. Comparer un modèle canonique ou HTML normalisé, pas des snapshots géants et fragiles. Réimporter deux éditions pour vérifier les correspondances et les cas ambigus. Les vrais DDJ restent locaux ; comparer un extrait et mesurer l'ouvrage de 80 Mo. Aucune différence éditoriale non expliquée ne doit être acceptée.

L'inventaire B00 justifie des cas combinant attributs de titres de type Pandoc, appels et retours de notes en HTML, `details`/`summary`, tableaux Markdown et HTML et images WebP/PNG/JPEG. Vérifier qu'un renvoi traverse les fragments et revient au point d'appel après assainissement. Tester les payloads d'image identiques et les limites de décodage avec des données synthétiques.

## 6. Scénarios de validation de référence

| ID | Scénario et résultat attendu |
|---|---|
| Q01 | Import synthétique + corpus réel : contenu, structure, notes, liens et images préservés ; erreurs explicites |
| Q02 | Lecture avec temps contrôlé : avant/après seuil, cumul, visibilité partielle, arrière-plan, saut et bloc très long |
| Q03 | Lire 1–29, commencer 30, consulter 7 : dernière consultation = 7 ; prochaine lecture = premier passage non lu de 30 |
| Q04 | Parcours non linéaire, parent avec contenu propre, arbre profond : états et pourcentages cohérents |
| Q05 | Cocher/décocher, revenir en auto, interaction parent/enfant : comportement conforme, persistance après redémarrage |
| Q06 | Changement de police, taille d'écran et plateforme : mêmes unités de lecture, reprise correcte |
| Q07 | Hors ligne et arrêt brutal : ouvrage disponible, état persistant ; reprise sans corruption |
| Q08 | Deux profils lisent des portions différentes hors ligne, reconnectent : fusion sans perte, répétition idempotente |
| Q09 | Conflits de correction/position, événements hors ordre, horloges décalées : résolution déterministe documentée |
| Q10 | Téléchargement/import interrompu, disque plein, Drive indisponible, token expiré : erreur explicite et récupération |
| Q11 | Nouvelle édition : conservation des unités inchangées ; unités modifiées ou ambiguës signalées |
| Q12 | Markdown hostile, URL dangereuse, chemin invalide, permissions insuffisantes : pas d'exécution ni accès non prévu |
| Q13 | Changement de compte, restauration/ export : données isolées, progression récupérable selon la politique retenue |
| Q14 | PWA Windows et Android : build, lancement depuis l’icône, parcours hors ligne et persistance après redémarrage |

## 7. Performances

Objectifs initiaux à mesurer sur appareil de référence (PC Windows et téléphone Android ; émulateur pour fonctionnel, pas pour extrapoler les performances réelles) : démarrage ≤ 2 s, ouverture d'un ouvrage local ≤ 2 s, navigation entre sections locales ≤ 300 ms, enregistrement local de progression ≤ 100 ms, défilement fluide (cible 60 FPS si matériel adapté). Ce sont des objectifs de prototype, pas des gates bloquantes avant établissement d'une baseline. Définir le protocole, les versions, cas froid/chaud, taille des fichiers, médiane/dispersion et mémoire maximale. Mesurer l'import du Markdown de 80 Mo et le pic mémoire avant de fixer des budgets. Détecter les régressions au fil des jalons. Ne pas sur-optimiser en l'absence de mesure.

**Protocole B02.** Mesurer lecture, parsing, extraction et écriture sur extrait puis sur l’ouvrage de 83,16 Mo. Consigner pic de mémoire observé et méthode d’échantillonnage, volume importé et gain de déduplication. Mesurer l’accès au catalogue, au fragment et à ses ressources, et la réactivité du fil UI. Relever les processus Chrome concernés sur Windows et, si l’accès le permet, leur mémoire sur téléphone Android réel. Consigner les conditions et limites de chaque mesure. Répéter les tests d’ouverture/navigation en B03.

## 8. Definition of Done

Un item significatif ne passe à Terminé que si :

- [ ] Critères d'acceptation vérifiés et comportement conforme aux spécifications.
- [ ] Cycle TDD réalisé pour les comportements concernés (ou exception explicite et vérification alternative).
- [ ] Tests rapides, contrôle de types, formatage, lint, duplication, complexité et couverture applicables réussis.
- [ ] Tests E2E, intégration, sécurité et performance pertinents pour le risque exécutés ; résultats mesurés et traçables.
- [ ] Revue indépendante et QA indépendante effectuées pour les fonctionnalités significatives ; défauts bloquants corrigés et retestés.
- [ ] Aucun risque élevé non accepté, aucune régression connue non traitée.
- [ ] Documentation et backlog à jour, modifications limitées au périmètre.

Pour les vérifications indisponibles : distinguer PAS EXÉCUTÉ, BLOQUÉ, NON APPLICABLE (avec raison), ÉCHEC et RÉUSSI. Un test non exécuté n'est jamais vert. Si un test obligatoire est bloqué, conserver l'item en validation ou obtenir une dérogation explicite avec alternative et risque. Les tests longs sont exécutés aux jalons pertinents, pas tous à chaque modification. Les contrôles ne nécessitent pas une CI ou une approbation humaine à chaque commit.
