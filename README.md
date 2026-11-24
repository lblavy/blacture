# Lecteur numérique personnel

Projet personnel de lecteur d'ouvrages structurés, local-first, pour Windows et Android. Le nom commercial reste à définir.

## Objectif

Lire confortablement des ouvrages personnels sur plusieurs appareils, y compris hors connexion, sans perdre la progression lors de consultations non linéaires. L'application distingue le dernier emplacement consulté du premier passage restant à lire. Elle suit les passages parcourus et agrège leur état dans un sommaire hiérarchique et dans la bibliothèque.

## Périmètre initial

- Import de fichiers Markdown enrichis autonomes (HTML intégré, identifiants, images, notes, liens et tableaux).
- Bibliothèque locale, lecture HTML responsive, navigation hiérarchique de profondeur variable, recherche de confort typographique.
- Progression automatique et partielle, validation/dévalidation manuelle, deux modes de reprise distincts.
- Applications Windows et Android, fonctionnement hors ligne et synchronisation facultative via le Google Drive personnel de l'utilisateur.
- Architecture extensible pour les formats d'importation, mais aucun import EPUB/PDF ni second backend distant en V1.

Les trois ouvrages du Dao De Jing sont un corpus de validation, pas un modèle imposé au lecteur. Le plus gros Markdown fait environ 80 Mo, avec images incorporées ; son PDF de référence fait 251 Mo pour 7 864 pages. Les sources éditoriales ne doivent jamais être modifiées par le lecteur. La chaîne de publication PDF reste indépendante.

## Documentation de référence

| Fichier | Rôle |
|---|---|
| [AGENTS.md](AGENTS.md) | Consignes de travail et orchestration de Codex |
| [SPECIFICATIONS.md](SPECIFICATIONS.md) | Comportements attendus, décisions et questions ouvertes |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Contraintes, pistes techniques et arbitrages |
| [QUALITY.md](QUALITY.md) | TDD, seuils, stratégie de test et Definition of Done |
| [BACKLOG.md](BACKLOG.md) | Étapes, critères d'acceptation et suivi |
| [samples/README.md](samples/README.md) | Corpus de test local et confidentialité |
| [scripts/README.md](scripts/README.md) | Contrats des futures commandes de validation locale |

## Démarrage

Ce dépôt contient initialement le cadrage et les profils d'agents, pas encore l'application ni les outils de build. La première mission de Codex est l'étape B00 du backlog : étude de faisabilité et recommandation de stack, sur les vrais Markdown si disponibles. Ne pas démarrer la réalisation sans validation de cette étape par le propriétaire.

Les dépendances, commandes d'installation et de lancement seront documentées ici après validation de la stack. Aucun serveur, Docker, SonarQube ni service d'analyse distant n'est requis. La publication sur Google Play et toute commercialisation sont hors périmètre actuel.
