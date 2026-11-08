# AbracaDABra Live Monitor — Portable 0.4.2 (préversion)

Interface web communautaire indépendante et non officielle. Cette version inclut le récepteur AbracaDABra modifié pour les TII et ses DLL compatibles. Python et une installation séparée d’AbracaDABra ne sont pas nécessaires.

## Installation Windows x64

1. Télécharger **Live-Monitor-Windows-x64-0.4.2.zip** depuis [les versions publiées](https://github.com/DABodr/abracadabra-live-monitor/releases/tag/v0.4.2).
2. Extraire **tout le ZIP** dans un dossier accessible en écriture, par exemple Documents. Garder `_internal` à côté de `Live-Monitor.exe`.
3. Brancher une clé RTL-SDR avec son pilote WinUSB déjà installé. Si elle fonctionne dans AbracaDABra, fermer celui-ci pour libérer la clé.
4. Ouvrir `Live-Monitor.exe`, puis cliquer sur **Démarrer** et **Ouvrir l’interface**.
5. Sur un téléphone du même réseau, ouvrir l’adresse réseau indiquée par le lanceur. Si Windows le demande, autoriser l’accès sur le réseau privé de confiance.
6. Pour arrêter, utiliser **Arrêter** ou fermer le lanceur. Le réduire laisse le serveur actif.

Le lanceur crée sa propre copie du récepteur dans `data/receiver-tii-0.4`. Il ne remplace pas une installation existante d’AbracaDABra. Le pilote USB n’est pas installé automatiquement. Voir [les instructions officielles](https://github.com/KejPi/AbracaDABra#Windows) pour une nouvelle clé.

Les ports 7979 et 17979 doivent être libres. Le lanceur ne coupe pas un serveur déjà actif. Une seule application peut utiliser la clé à la fois.

## Mettre à jour une version portable

Arrêter l’ancien lanceur, sauvegarder son dossier `data`, puis extraire le nouveau ZIP dans un nouveau dossier. Copier `data` à côté du nouvel exécutable avant de démarrer. Les favoris, multiplex, archives, logos et réglages sont conservés ; seul le chemin du récepteur est actualisé. Ne pas superposer les dossiers `_internal` de versions différentes.

Pour une installation de développement hors du lanceur portable, les chemins et le démarrage peuvent être différents : ne pas déplacer ses fichiers automatiquement.

## Nouveautes 0.4.2

Voir [les changements de cette version](UPDATES-0.4.2.md).

## Fonctions incluses

- TII, identification des sites, distance, direction, puissance et carte des émetteurs.
- DAB scan unifié, historique SNR, résultats et archives des scans avec TII.
- Informations de réception dans le lecteur, favoris et mosaïque améliorés.
- Mode Bluetooth simplifié et compteur de navigateurs actifs.

Voir [le détail des changements](UPDATES-2026-11-04.md).

La base d’émetteurs n’est pas redistribuée : importer votre CSV dans les réglages, ou utiliser le cache local d’AbracaDABra s’il existe. Les TII détectés restent disponibles sans base ; les noms et positions des sites nécessitent une base compatible.

## Données et réseau

Les données personnelles sont dans `data`. Le ZIP publié ne contient aucun favori, historique, logo téléchargé ni position personnelle. Partager le ZIP original, pas votre dossier d’utilisation.

Cette préversion n’a pas d’authentification ni de TLS. Elle est destinée à un réseau local de confiance. Les navigateurs connectés partagent le même récepteur et peuvent en changer les réglages.

La recherche de logos utilise Internet ; les logos et marques restent la propriété de leurs titulaires. Les tuiles de la carte proviennent d’OpenStreetMap.

## Limites et validation

Le récepteur a été validé localement en réception réelle. Le paquet est contrôlé pour ses DLL, imports Python, fichiers inclus et démarrage isolé du récepteur. Un essai complet sur un deuxième PC reste nécessaire avant une version stable. Le programme n’est pas signé. Les autres familles de récepteurs ne sont pas validées ; la reprise audio après appel sur iPhone reste une limite connue.

## Construire

Windows x64, Python 3.13 avec Tkinter :

```powershell
python -m pip install -r requirements-build.txt
./build.ps1
```

Avant la compilation, placer le runtime de la version publiée dans `receiver-tii/runtime` (depuis `_internal/receiver-tii/runtime` du ZIP), ou le reconstruire avec les sources fournies. Les empreintes sont dans `receiver-tii/runtime-manifest.json`. La sortie est `dist/Live-Monitor-Windows-x64.zip`.

Le paquet séparé [**Receiver-TII-Sources-0.4.zip**](https://github.com/DABodr/abracadabra-live-monitor/releases/download/v0.4.0/Receiver-TII-Sources-0.4.zip) contient le récepteur modifié, les sources des bibliothèques et les indications de compilation. Voir `receiver-tii/README-TII.md` et `THIRD-PARTY`. Les DLL restent remplaçables dans la copie locale du récepteur ; les remplacements doivent être compatibles avec son ABI.

Le code propre au projet n’a pas encore de licence open source attribuée. Les composants tiers gardent leurs licences respectives. Les droits accordés par ces licences, notamment modification et débogage des bibliothèques, restent applicables.
