# Filtre RTL-SDR du serveur

Cette copie conserve l'exécutable AbracaDABra 4.3.0 et son pilote RTL-SDR d'origine.
`rtlsdr_original.dll` est une copie inchangée de `librtlsdr.dll` de la distribution.
La nouvelle `librtlsdr.dll` transmet 126 exports au pilote et adapte uniquement
`rtlsdr_set_center_freq`. Après une syntonisation réussie, en mode `--cli`, elle
appelle `rtlsdr_set_and_get_tuner_bandwidth(dev, 1530000, &applied, 1)`.
L'application graphique demande cette même largeur par son réglage automatique.
L'appel intervient après la syntonisation, nécessaire au fonctionnement du pilote.

Le journal indique la largeur demandée, la largeur appliquée et le code résultat.
Sur la clé testée, le pilote annonce 1550000 Hz appliqués. Le FIR annoncé à
2400 kHz est une autre étape de filtrage et n'est pas modifié par ce réglage.

Le code source et la liste complète des exports sont dans ce dossier.
Compilation avec Zig 0.14.1 (Windows x86_64), depuis le répertoire de travail :

```text
zig cc -target x86_64-windows-gnu -shared -nostdlib -fno-stack-protector -O2 -isystem <zig>/lib/libc/include/any-windows-any -Wl,--entry,DllMain filter.c filter.def -lkernel32 -o librtlsdr.dll
```

Les sommes SHA-256 des binaires sont dans `sha256.json`.
L'application installée dans Downloads n'est pas modifiée.
Pour revenir au serveur précédent, arrêter le serveur, remplacer uniquement
la valeur `exe` de son `config.json` par celle de `config-before-filter.json`,
puis redémarrer. Ne pas restaurer tout le fichier si des réglages ont changé
depuis la sauvegarde.
