# Contrôles locaux — contrat à implémenter en B01

Aucun script de build ou de qualité opérationnel n'existe encore : la stack applicative reste à valider. Ne pas créer de scripts qui retournent un succès sans exécuter de contrôle. Après B00, implémenter des commandes versionnées, reproductibles et documentées. Préférer le gestionnaire de paquets de la stack et quelques wrappers si nécessaires, sans Docker ni SonarQube.

| Commande indicative (si npm retenu) | Fonction |
|---|---|
| `npm run quality` | Format, lint, typage/compilation applicable, complexité, duplication, tests unitaires/intégration, couverture et gates ; sortie non nulle sur échec |
| `npm run test:unit` | Tests unitaires rapides et déterministes |
| `npm run test:integration` | Intégration locale sans Google réel |
| `npm run test:e2e:web` | Parcours UI communs |
| `npm run test:e2e:windows` | Exécutable Windows réel |
| `npm run test:e2e:android` | Application Android réelle sur émulateur/appareil |
| `npm run test:mutation` | Mutations ciblées, après validation de l'outil |
| `npm run test:performance` | Benchmarks ciblés |
| `npm run quality:audit` | Audit des dépendances, accès réseau si nécessaire |

Les noms sont indicatifs. Vérifier les dépendances requises, retourner un diagnostic clair et un code non nul si une commande obligatoire ne peut pas fonctionner. Aucun faux succès en cas d'environnement absent. Les suites longues et les tests Drive réel se lancent séparément aux jalons concernés. Les audits dépendant du réseau peuvent être séparés de `quality` pour que la boucle TDD reste utilisable hors ligne ; exécuter l'audit aux changements de dépendances et jalons. Les seuils et leur portée sont définis dans `QUALITY.md` ; toute configuration machine devra les refléter, avec test d'échec intentionnel en B01.

Les rapports, traces et captures doivent aller dans les répertoires ignorés par Git. Prévoir nettoyage des processus temporaires et données de test, sans effacer les données personnelles. Documenter les prérequis Windows/Android, les commandes d'installation locales et les alternatives si un outil est trop coûteux.
