# Blacture

Lecteur personnel d'ouvrages structurés, local-first, pour Windows et Android. Le dépôt est public. Les ouvrages de validation restent dans le dossier local ignoré par Git.

## Objectif

Lire confortablement des ouvrages personnels sur plusieurs appareils, y compris hors connexion, sans perdre la progression lors de consultations non linéaires. L'application distingue le dernier emplacement consulté du premier passage restant à lire. Elle suit les passages parcourus et agrège leur état dans un sommaire hiérarchique et dans la bibliothèque.

## Périmètre initial

- Import de fichiers Markdown enrichis autonomes (HTML intégré, identifiants, images, notes, liens et tableaux).
- Bibliothèque locale, lecture HTML responsive, navigation hiérarchique de profondeur variable, recherche de confort typographique.
- Progression automatique et partielle, validation/dévalidation manuelle, deux modes de reprise distincts.
- PWA installable sur Windows et Android, fonctionnement hors ligne et synchronisation facultative via le Google Drive personnel de l'utilisateur.
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
| [scripts/README.md](scripts/README.md) | Prérequis et commandes de validation locale |

## Démarrage

La stack validée utilise TypeScript strict, HTML/CSS et Vite. La PWA est prévue sur [blacture.blavy.eu](https://blacture.blavy.eu/), avec Cloudflare Pages et un Service Worker. B01/B01a ont validé le socle avec un prototype synthétique. L’importeur applicatif est réalisé en B02. Les [commandes locales](scripts/README.md) et le [backlog](BACKLOG.md) décrivent les preuves et travaux en cours.

La connexion à Drive est facultative. L'objectif est qu'un utilisateur qui reçoit Blacture puisse autoriser l'accès à son propre Drive avec son compte Google. La publication publique de l'application, y compris sur Google Play, reste hors périmètre.
