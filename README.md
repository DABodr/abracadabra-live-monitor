# AbracaDABra Live Monitor — Portable 0.1 (préversion)

Interface web communautaire pour AbracaDABra. Projet indépendant, non officiel.

## Utiliser le ZIP sur Windows x64

1. Télécharger et extraire la distribution officielle **AbracaDABra 4.3.0 Windows** : https://github.com/KejPi/AbracaDABra/releases/tag/v4.3.0
2. Vérifier que la clé RTL-SDR fonctionne dans AbracaDABra, puis fermer le logiciel pour libérer la clé.
3. Extraire **tout le ZIP** Live Monitor dans un dossier accessible en écriture, par exemple Documents. Ne pas lancer depuis le ZIP ni placer dans Program Files.
4. Ouvrir `Live-Monitor.exe`, cliquer sur **Démarrer**, puis choisir l'exécutable AbracaDABra de la distribution originale.
5. Une copie indépendante du récepteur est créée dans `data/receiver`. L'installation originale reste inchangée. Le filtre RTL-SDR est adapté uniquement pour les binaires dont les empreintes correspondent à la version testée.
6. Cliquer sur **Ouvrir l'interface**. Sur un téléphone connecté au même réseau, utiliser l'adresse réseau indiquée dans la fenêtre. Si Windows demande une autorisation réseau, autoriser le réseau privé de confiance.
7. Pour arrêter : bouton **Arrêter**, ou fermer la fenêtre. La réduire laisse le serveur actif.

Python n'est pas nécessaire sur le PC destinataire. Conserver le dossier `_internal` à côté de l'exécutable. Aucun démarrage automatique ni modification du pare-feu n'est effectué.

Les ports 7979 (interface) et 17979 (récepteur local) doivent être libres. Un serveur existant n'est jamais arrêté par ce lanceur. Une seule application peut utiliser la clé à la fois. Le démarrage est volontaire : ouvrir l'exécutable ne lance pas automatiquement la réception.

## Données et réseau

Favoris, multiplex, réglages et logos choisis sont stockés dans `data`. Le ZIP initial ne contient aucune donnée de réception ni adresse personnelle. Avant de redistribuer votre copie, supprimer `data` **après arrêt** du serveur, ou partager le ZIP original intact.

L'interface est partagée : tout appareil autorisé sur le réseau peut changer la réception ou les réglages. Cette préversion ne propose pas d'authentification ni de TLS. Elle est destinée à un réseau local de confiance ; ne pas ouvrir directement le port sur Internet. L'accès extérieur avec authentification reste un chantier distinct.

La recherche de logos utilise Internet (RadioDNS via DNS Google, Radio Browser, sites des radios). Les images sont chargées à la demande et ne sont pas incluses dans le paquet. Les logos et marques restent la propriété de leurs titulaires.

## Limites de cette préversion

Version validée sur le poste de développement ; un essai complet sur un deuxième PC Windows, avec une autre clé, est encore requis avant une version publique stable. Le réglage de gain correspond au tuner RTL-SDR testé ; les autres récepteurs ne sont pas validés. Le programme n'est pas signé numériquement. Il n'inclut pas AbracaDABra ni ses pilotes : ils proviennent de l'installation choisie par l'utilisateur.

## Construire depuis les sources

Windows x64, Python 3.13 avec Tkinter :

```powershell
python -m pip install -r requirements-build.txt
./build.ps1
```

La sortie est `dist/Live-Monitor-Windows-x64.zip`. Le code du filtre et sa commande de compilation Zig sont dans `filter/README.md`. Le binaire fourni correspond à `filter/sha256.json`.

## Publication GitHub ultérieure

Ne publier que ce dossier source, en respectant `.gitignore`, jamais les données du serveur personnel ni `data/receiver`. Choisir la licence du code propre au projet et identifier son auteur avant publication ; aucune licence de ce code n'est encore attribuée. Les notices des dépendances sont dans `THIRD-PARTY`. Examiner les droits d'utilisation du logo DAB+ avant publication publique, ou le remplacer par une identité graphique originale. Aucun dépôt GitHub n'a encore été créé.
