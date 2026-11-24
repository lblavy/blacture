# Corpus de test

Ne pas committer les ouvrages réels, les PDF de référence, leurs images ou des traductions privées. Les fichiers de test versionnés doivent être synthétiques ou libres de droits et de taille raisonnable. Les échantillons fournis ici sont des exemples génériques artificiels, pas des extraits du DDJ.

## Fichiers synthétiques initiaux

- `simple.md` : texte avant titre, hiérarchie simple, titre répété, section sans contenu propre.
- `enriched.md` : ancres explicites, HTML intégré, notes, tableau, image data URI et Unicode. La syntaxe est un exemple, pas une définition du dialecte des ouvrages réels.

Ajouter après B00 des fixtures reproduisant les conventions réellement observées (notamment cas limites, HTML hostile, deux éditions avec changements), puis les golden tests attendus. Aucun résultat de conversion n'est présupposé.

## Corpus réel (local, non versionné)

Créer `samples/local-paths.md` (ignoré par Git) avec les chemins absolus des trois Markdown et PDF facultatifs pour comparaison visuelle. Les chemins peuvent pointer vers un autre repository ; accès en lecture seule. Exemple :

```text
Ouvrage 1 Markdown : <chemin absolu>
Ouvrage 2 Markdown : <chemin absolu>
Ouvrage 3 Markdown : <chemin absolu>
PDF de référence : <chemins facultatifs>
```

Autre possibilité : placer des copies dans `samples/private/` (ignoré). Ne pas déplacer ou modifier les originaux.

Le plus gros Markdown connu fait environ 80 Mo et contient des images intégrées ; le PDF correspondant fait 251 Mo et 7 864 pages. Utiliser un extrait représentatif pour vérifier la fidélité du rendu et le document complet pour mesurer import, mémoire et ouverture. Ne pas conserver de traces privées dans Git, ni envoyer le corpus vers un service non approuvé. Vérifier `git status` avant tout commit.
