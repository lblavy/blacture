# Qualité, tests et validation locale

Objectif : qualité exigeante et vérifiable, proportionnée à un projet personnel. Pas de SonarQube, Docker, service d'analyse distant ou infrastructure de CI obligatoire. Les contrôles seront des scripts locaux versionnés et exécutables par Codex. Les outils exacts seront choisis après la stack (B00/B01). Les seuils ci-dessous sont les valeurs initiales retenues ; tout ajustement significatif doit être discuté avec le propriétaire.

## 1. Clean Code et TDD

Code lisible, responsabilités cohérentes, noms explicites, fonctions simples, types stricts, erreurs traitées et dépendances maîtrisées. SOLID et DRY avec discernement : ne pas créer une abstraction pour un besoin imaginaire, ne pas dupliquer une règle métier. Préférer le code pur pour la progression et la fusion, injecter les dépendances réellement nécessaires aux tests (horloge, I/O, transport). Éviter état global mutable, logique métier enfouie dans l'UI et exceptions avalées. Commenter les raisons ou contraintes non évidentes, pas le code trivial.

Pour tout comportement nouveau ou corrigé : écrire un test qui échoue pour la bonne raison (RED), implémenter le minimum (GREEN), refactoriser avec tests verts (REFACTOR). Les tests vérifient des comportements, pas les détails d'implémentation ; tester limites, erreurs et scénarios de régression. TDD pragmatique pour UI visuelle, prototypes jetables, configuration et intégrations natives : une preuve adaptée est acceptable, sans prétendre que du TDD a été réalisé lorsqu'il ne l'a pas été. Les prototypes ne deviennent pas du code de production sans validation.

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

## 3. Outils envisagés (non imposés avant B00)

| Besoin | Exemple si TypeScript est retenu |
|---|---|
| Tests et couverture | Vitest + coverage V8/Istanbul |
| Lint et complexité | ESLint, règles de complexité, SonarJS (plugin local, pas SonarQube) |
| Typage / format | TypeScript strict, Prettier |
| Duplication | jscpd |
| Mutation | StrykerJS |
| Tests génératifs | fast-check |
| UI web | Testing Library, Playwright |
| E2E desktop réel | WebdriverIO / Tauri WebDriver si compatible |
| E2E Android réel | Appium + UiAutomator2 ou alternative plus simple validée |
| Rust si retenu | cargo fmt, clippy, cargo test ; couverture/analyse à évaluer |
| Dépendances | audit du gestionnaire de paquets et outils équivalents par langage |

Installer le minimum de dépendances pour satisfaire les contrôles. Préférer les scripts npm/équivalents et éventuellement des wrappers PowerShell pour les actions Windows. Utiliser un lockfile, consigner les prérequis et versions, ne pas installer d'outils globaux lourds sans accord. Une CI distante pourra être discutée ultérieurement ; elle n'est pas requise.

## 4. Pyramide de tests

- **Unitaires** : modèle interne, calculs de progression, navigation, agrégation, overrides manuels, résolution de conflits, validation des ancres, logique de migration. Horloge simulée et données déterministes ; aucun accès réseau.
- **Intégration** : importateur réel, fichiers temporaires, base locale réelle, transactions, migrations, sync simulée, erreurs d'I/O, panne et reprise. Simuler Drive au niveau transport pour la majorité des tests ; ne pas simuler ce que le test prétend vérifier.
- **Composants et E2E web** : interaction et rendu responsive, états du sommaire, navigation, accessibilité élémentaire, clavier et tactile. Un viewport mobile ne constitue pas un test Android natif.
- **E2E Windows** : automatiser l'exécutable ou la fenêtre native réelle, sélection de fichier, import, lecture, redémarrage, persistance et fonctionnement hors ligne. Vérifier les limites de l'outil pour dialogues système ; utiliser des solutions ciblées si besoin.
- **E2E Android** : au minimum smoke test de build/install/lancement et parcours critique sur émulateur ou téléphone (fichiers, navigation, pause/reprise, hors ligne, stockage). Chercher l'automatisation via émulateur et ADB/Appium si raisonnable. Tester également un appareil réel pour fluidité/stockage si disponible. Si un scénario natif est trop coûteux à automatiser, proposer un test manuel reproductible et explicite ; accord du propriétaire requis pour déroger durablement.
- **Drive réel** : tests ciblés OAuth, transfert, deux appareils, conflits et reconnexion, via compte/dossier de test autorisé. Pas de dépendance réseau ni d'identifiants réels dans la suite rapide. Ne pas confondre un test simulé et une validation du service réel.

Les agents doivent pouvoir exécuter les scripts eux-mêmes une fois les prérequis présents, récupérer code de sortie, logs et, pour UI, captures/traces sur échec. Protéger les données privées dans les traces. Ne pas utiliser le compte personnel du propriétaire pour des tests destructifs.

## 5. Vérifications renforcées, ciblées et raisonnables

### Mutation testing

Objectif initial : score ≥ 80 % sur le périmètre métier sélectionné, objectif 90 % sur progression et fusion. Mesurer sur les modules critiques aux jalons concernés, pas à chaque commit. Définir précisément les mutants exclus/équivalents, sans masquer des tests faibles. Si l'outil ou le temps d'exécution est disproportionné, proposer un périmètre ciblé ou des tests de limites supplémentaires ; arbitrage avant d'en faire une gate bloquante. Le score n'est pas une mesure globale obligatoire tant que l'outil et son périmètre n'ont pas été validés.

### Property-based testing

Tester notamment l'idempotence de la synchronisation, l'absence de pertes de passages acquis, la convergence déterministe selon la politique retenue, la stabilité des ancres, l'agrégation bornée et cohérente, les doublons et événements hors ordre. Tester les corrections et suppressions séparément de la progression automatique monotone. Enregistrer les seeds des échecs pour reproduction.

### Golden tests et fidélité éditoriale

Fixtures synthétiques versionnées : Markdown simple, enrichi, hiérarchie inhabituelle, notes, images intégrées, tableaux, ancres et caractères chinois. Vérifier le texte normalisé, l'ordre, les images/empreintes, les références et destinations, les diagnostics et la sécurité. Comparer un modèle canonique ou HTML normalisé, pas des snapshots géants et fragiles. Réimporter deux éditions pour vérifier les correspondances et les cas ambigus. Les vrais DDJ restent locaux ; comparer un extrait et mesurer l'ouvrage de 80 Mo. Aucune différence éditoriale non expliquée ne doit être acceptée.

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
| Q14 | Windows et Android natifs : build, lancement et parcours critique, captures/logs en cas d'échec |

## 7. Performances

Objectifs initiaux à mesurer sur appareil de référence (PC Windows et téléphone Android ; émulateur pour fonctionnel, pas pour extrapoler les performances réelles) : démarrage ≤ 2 s, ouverture d'un ouvrage local ≤ 2 s, navigation entre sections locales ≤ 300 ms, enregistrement local de progression ≤ 100 ms, défilement fluide (cible 60 FPS si matériel adapté). Ce sont des objectifs de prototype, pas des gates bloquantes avant établissement d'une baseline. Définir le protocole, les versions, cas froid/chaud, taille des fichiers, médiane/dispersion et mémoire maximale. Mesurer l'import du Markdown de 80 Mo et le pic mémoire avant de fixer des budgets. Détecter les régressions au fil des jalons. Ne pas sur-optimiser en l'absence de mesure.

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
