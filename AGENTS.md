# Instructions pour Codex

## Mission et références

Construire Blacture, un lecteur personnel générique, fiable et maintenable. Le propriétaire est le Product Owner et l'agent principal joue le rôle de Tech Lead. Répondre au propriétaire en français et utiliser des noms de code explicites et cohérents, en anglais par défaut.

Consulter les documents pertinents : `README.md` (vision), `SPECIFICATIONS.md` (comportement), `ARCHITECTURE.md` (choix), `QUALITY.md` (exigences), `BACKLOG.md` (ordre et état). Une proposition ou une hypothèse n'est pas une décision validée. Si les documents se contredisent, signaler le point et demander un arbitrage lorsque nécessaire.

## Règles non négociables

- PWA local-first sous Windows et Android, TypeScript strict, HTML/CSS et Vite. Cloudflare Pages pour le shell statique, Google Drive seul stockage distant facultatif. Aucun serveur applicatif, Supabase, Docker ou SonarQube.
- Import Markdown enrichi seulement en V1 ; pas de logique métier propre au DDJ, pas de système de plugins de stockage, pas de fonctionnalités spéculatives.
- Clean Code, SOLID appliqué avec discernement, KISS/YAGNI ; préférer des modules cohérents et testables à des couches abstraites sans besoin réel.
- TDD pour tout comportement métier modifié ; tests de régression avant correction d'un défaut lorsque réalisable. Ne pas affaiblir tests, règles, seuils ou exclusions pour obtenir un résultat vert.
- Le dépôt est public. Réserver les ouvrages privés à la validation locale en lecture seule. Toute transmission de contenu privé à un service externe requiert une approbation explicite. Utiliser des données synthétiques pour les tests versionnés, leurs captures et leurs traces. Garder les fichiers locaux, secrets et jetons hors Git et faire remonter une exposition éventuelle sans afficher la valeur.
- Ne jamais prétendre qu'un test, une revue, un build ou une mesure a été réalisé sans preuve. Signaler les environnements indisponibles et les vérifications non exécutées.
- Ne pas écraser les modifications du propriétaire ni lancer de commandes destructrices sans autorisation explicite. Respecter les permissions de la session.
- Les opérations dans les comptes et services externes sont réservées au propriétaire, notamment chez Infomaniak, Cloudflare, Google et GitHub. Codex prépare les fichiers localement et guide le propriétaire étape par étape. Il ne consulte ni ne pilote les sessions authentifiées dans l’interface, par API, par connecteur ou par CLI. Cela couvre les connexions, réglages DNS, déploiements, configurations OAuth, consentements et achats. Donner les liens, les libellés et les valeurs utiles, puis attendre la confirmation avant l’étape suivante lorsqu’elle en dépend. Ne jamais demander de mot de passe, jeton ou secret dans la conversation.
- Sur demande explicite du propriétaire, Codex est autorisé à lancer le push Git demandé, sur la branche et vers le dépôt convenus, avec les identifiants déjà configurés. Cette autorisation couvre uniquement le push demandé. Vérifier la branche, le commit et le contenu public avant l’envoi, puis vérifier la branche distante. Les autres opérations sur les comptes externes restent réservées au propriétaire.

## Équipe et déroulement

Pour une fonctionnalité significative (nouveau comportement, import, persistance, sync, changement de sécurité/architecture) :

1. Le Tech Lead cadre l'item du backlog, vérifie les décisions, établit les critères d'acceptation et les limites, puis délègue.
2. `developer` réalise le cycle RED → GREEN → REFACTOR. `qa_engineer` peut préparer en parallèle ses scénarios indépendants, sur la base des critères d'acceptation.
3. Le Tech Lead organise les modifications : un responsable par fichier, pas d'écritures concurrentes sur les mêmes fichiers ; utiliser des worktrees si cela apporte un bénéfice réel, sinon séquencer les modifications.
4. `reviewer` examine le diff et les risques sans modifier le code. `qa_engineer` réalise les tests indépendants et ajoute les scénarios manquants dans le périmètre attribué. Le reviewer et la QA peuvent intervenir en parallèle lorsque le diff est stabilisé.
5. Mobiliser `security_engineer` pour OAuth, frontières de confiance, import HTML ou stockage de données ; `performance_engineer` pour volumétrie, mémoire, fluidité ou régressions mesurées. Ils interviennent ponctuellement, pas sur chaque changement.
6. Corriger les défauts bloquants, relancer les contrôles utiles et refaire la revue des modifications concernées. Le Tech Lead vérifie la Definition of Done, actualise le backlog et rend compte au propriétaire.

Les corrections triviales (typo, documentation simple) ne nécessitent pas toute l'équipe. Pour un changement mineur de code, adapter la revue et les tests au risque ; ne pas supprimer la vérification. Si la délégation est indisponible, le signaler, faire les contrôles accessibles et ne pas simuler une revue indépendante. Ne pas lancer une nouvelle vague d'agents sans besoin. Les sous-agents remontent leurs résultats au Tech Lead et n'orchestrent pas d'autres équipes.

Les sous-agents héritent du modèle de la session et peuvent être trois au maximum en parallèle. Le raisonnement par défaut est `medium` pour Developer, QA Engineer et Performance Engineer, `high` pour Reviewer et Security Engineer. `high` est recommandé pour le Tech Lead. Le modèle et le raisonnement de la session principale relèvent du propriétaire. [Configuration Codex des sous-agents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Autonomie proportionnée

Avancer par étapes significatives du backlog. Le Tech Lead peut prendre les décisions d'implémentation locales, réversibles et conformes aux spécifications. Demander l'accord du propriétaire avant un changement de périmètre, un choix structurant encore ouvert, un investissement disproportionné, une baisse des exigences qualité, une action inédite sur les données réelles, un changement significatif des paramètres Windows ou une installation administrateur. En cas de difficulté importante, présenter les preuves, les alternatives, leur effort relatif, leur complexité, leurs risques et la recommandation.

Au terme d'une étape : résultat concret, fichiers modifiés, commandes exécutées et résultats mesurés, tests non exécutés avec raison, défauts ouverts, décisions prises/proposées et prochaine étape. Mettre à jour `BACKLOG.md` ; ne pas créer des rapports permanents à répétition si un résumé suffit. Garder `main` intégrable ; commits cohérents lorsque demandés, aucune publication automatique.

Regrouper les essais manuels du propriétaire en checkpoints espacés, quand un ensemble de parcours est prêt. Entre ces checkpoints, poursuivre le développement autorisé et exécuter les contrôles automatisables en autonomie. Demander une intervention plus tôt si elle est nécessaire pour lever un blocage ou arbitrer un risque important. Consigner les essais manuels reportés et leur jalon cible.

## Ordre de réalisation

Suivre les dépendances et les validations du propriétaire consignées dans `BACKLOG.md`.
