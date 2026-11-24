# Backlog initial

Tous les items sont à faire. Le Tech Lead conserve les statuts (`À faire`, `En cours`, `En validation`, `Bloqué`, `Terminé`) et ajoute pour les items actifs les décisions, preuves et blocages utiles. Un item ne devient pas Terminé sur la seule base d'une intention ou d'un build. Voir `QUALITY.md`. Les étapes sont des résultats fonctionnels vérifiables, pas des micro-tâches imposant une approbation à chaque changement.

## B00 — Faisabilité et choix techniques
**Statut : À faire — prochaine mission, étude uniquement.**

- Examiner en lecture seule les vrais Markdown des trois ouvrages (chemins à fournir), inventaire structures, HTML, ancres, notes, images, tailles, conventions et cas limites. Ne pas inventer de détails non observés.
- Comparer Tauri Windows/Android et Tauri Windows + Capacitor Android, stockage local, accès fichiers, rendu, OAuth Google Drive et testabilité native. Vérifier compatibilité des outils réellement disponibles, coûts/efforts, SDK et émulateur. Vérifier les autorisations OAuth et la synchronisation entre clients, sans créer de compte/projet ni demander de secrets.
- Proposer le modèle interne, la stratégie de découpage et les premières règles d'identifiants. Identifier les risques de perte éditoriale, volumétrie, synchronisation et sécurité.
- Proposer les contrôles locaux de qualité, la chaîne TDD et E2E ; identifier ceux potentiellement coûteux et alternatives. Ne pas installer d'outils lourds, ne pas créer l'application.

**Acceptation :** rapport de faisabilité concis avec faits vérifiés, limites, recommandation argumentée, décisions à prendre et plan de validation. Mettre à jour `ARCHITECTURE.md` en distinguant propositions et décisions ; si les sources ne sont pas fournies, marquer l'analyse corpus en attente. Accord du propriétaire sur la stack avant B01.

## B01 — Fondations techniques et assurance qualité
**Statut : À faire ; dépend de B00.**

- Initialiser le projet minimal, dépendances verrouillées, scripts locaux et outils de contrôle applicables ; documenter prérequis.
- Vérifier le fonctionnement des profils Codex et le workflow TDD/revue/QA sur une modification simple.
- Établir un contrôle rapide unique qui retourne une erreur si une gate échoue. Vérifier qu'un échec volontaire de test/lint/couverture est effectivement détecté ; retirer la modification de démonstration ensuite.
- Prouver build et lancement Windows et Android (application minimale) ; réaliser un premier smoke test E2E natif automatisé sur Windows et évaluer/mettre en place Android selon coût convenu. Ne pas attendre la fin du projet pour découvrir un blocage plateforme.

**Acceptation :** instructions reproductibles, commande qualité réellement fonctionnelle, preuves de build et de smoke tests distinctes par plateforme, limites/alternatives Android documentées. Aucune infrastructure lourde.

## B02 — Importateur et modèle interne (F01–F03, Q01/Q11/Q12)
**Statut : À faire ; dépend de B01.**

- Valider dialecte pris en charge, schémas, identités et règles de normalisation ; implémenter l'import et la persistance atomique avec tests de référence.
- Produire fragments HTML sûrs, ressources extraites, liens et manifeste hiérarchique. Tester sections sans titres, parents avec contenu propre, titres en double et structures différentes du DDJ.
- Comparer un extrait réel au Markdown et au rendu attendu, mesurer l'import complet (80 Mo si disponible), documenter pertes/limites, temps et mémoire. Préparer les ancres et métadonnées nécessaires aux migrations ultérieures, sans développer un moteur de versionnement disproportionné.

**Acceptation :** importer un ouvrage synthétique et un extrait DDJ sans perte de contenu non expliquée ; import interrompu récupérable ; manifeste utilisable, sécurité de base vérifiée ; benchmark du gros ouvrage ou blocage explicite.

## B03 — Bibliothèque et lecteur local (F01/F04/F05/F10, Q01/Q06/Q07)
**Statut : À faire ; dépend de B02.**

- Bibliothèque, choix d'ouvrage, sommaire dynamique, affichage HTML responsive par fragment, notes et renvois, retour navigation, taille du texte.
- Persistance locale et lecture sans compte/réseau ; gérer documents absents et états d'erreur. Tester confort sur Windows et Android avec un vrai ouvrage et une structure différente.

**Acceptation :** importer, ouvrir, naviguer, consulter notes/images/tableaux et relancer sans réseau ; rendu et fluidité mesurés. Pas de dépendance cloud.

## B04 — Progression automatique et manuelle (F06–F09, Q02–Q07)
**Statut : À faire ; dépend de B03.**

- Arbitrer granularité, visibilité, seuils (8 s et 95 % expérimentaux), contenu pertinent, agrégation et propagation manuelle. Prototyper avant de figer. Écrire tests déterministes et cas limites.
- Implémenter suivi partiel, états, pourcentages, corrections manuelles persistantes et retour au mode auto ; deux actions de reprise séparées.
- Vérifier indépendance de la résolution, changements typographiques, consultation non linéaire, réouverture après interruption et comportement en arrière-plan.

**Acceptation :** scénario 7/30 reproduit en E2E ; lecture partielle et états parents exacts selon règles convenues ; une dévalidation ne se recochera pas immédiatement ; couverture critique conforme. Mutation/property testing ciblés si validés.

## B05 — Applications installables et hors ligne (F10, Q07/Q10/Q14)
**Statut : À faire ; dépend de B03/B04 ; validation native amorcée dès B01.**

- Finaliser build/package Windows et APK Android, fichiers privés et stockage local durable, gestion du cycle de vie, mode hors ligne et restauration de l'état.
- Éprouver le parcours de lecture sur exécutable Windows et émulateur/téléphone Android. Documenter installation locale, exécution des tests et limites. Pas de publication publique.

**Acceptation :** les deux applications sont installables, lisent un ouvrage local et conservent la progression après redémarrage ; tests natifs pertinents exécutés ou dérogation explicite. Les fonctions nécessitant un téléchargement distant seront validées en B06.

## B06 — Synchronisation Google Drive (F11/F12, Q08–Q10/Q12/Q13)
**Statut : À faire ; dépend de B04/B05.**

- Confirmer choix OAuth/scopes et structure des fichiers Drive ; configurer accès de test avec accord. Valider la fusion et les conflits (position, correction, suppression, version), en particulier entre appareils hors ligne.
- Synchroniser ouvrages et ressources séparément des données de lecture ; télécharger ouvrages, gérer files d'attente, état visible, reconnexion, retry, intégrité et changement de compte. Tester d'abord avec transport simulé, puis réel.
- Revue sécurité ciblée, tests de convergence, de rejouabilité et d'interruption, test avec deux appareils/profils isolés et Drive réel.

**Acceptation :** importer une fois puis récupérer sur second appareil, lire 30 et 35 hors ligne, retrouver les deux états après sync, préserver corrections et positions selon règles ; aucun retransfert complet lors d'une simple progression. OAuth vérifié sur les deux plateformes et données locales disponibles même sans Drive.

## B07 — Éditions, récupération et stabilisation (F03/F14, Q11/Q13)
**Statut : À faire ; dépend de B02/B06.**

- Valider la politique de nouvelle version, suppression, export/restauration et récupération. Implémenter le minimum utile, avec confirmation et absence de perte silencieuse. Tester deux versions et reprise après panne.
- Tester les trois ouvrages DDJ complets et un ouvrage non DDJ, profils Windows/Android ; comparer les budgets de performance et corriger les régressions. Exécuter suite de validation et contrôles ciblés renforcés.
- Mettre à jour guide d'utilisation et de développement ; inventorier limites restantes.

**Acceptation :** lecteur utilisable quotidiennement, conservation des données vérifiée, résultats de qualité et performance consignés, installation documentée. Aucune promesse de publication.

## À arbitrer ultérieurement (pas d'implémentation automatique)

- Signets/surlignages/notes personnelles et synchronisation (F13) ; priorité V1 à confirmer, indépendamment des notes éditoriales déjà obligatoires.
- Téléchargement sélectif, recherche plein texte, thèmes avancés et préférences supplémentaires.
- Import EPUB/PDF ou autres formats ; uniquement si besoin confirmé.
- Distribution Google Play, mises à jour automatiques, CI distante ; hors périmètre actuel.

## Suivi des décisions et des preuves

À la fin de chaque item, ajouter un court bilan sous l'item : date, résultat, critères vérifiés, commandes et résultats chiffrés, revues, contrôles non exécutés et raisons, limites et décision suivante. Ne pas dupliquer les spécifications ni stocker de logs volumineux dans Git.
