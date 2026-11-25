# FATONTINE CASH — Application Desktop Windows

Application de gestion de tontines **hors-ligne** pour Windows, conçue pour l'administratrice Fatima (Côte d'Ivoire).
Interface Liquid Glass (navy / or / perle), données stockées sur le PC, sauvegardes chiffrées, reçus PDF et partage WhatsApp.

---

## 1. Installer l'application (utilisatrice)

### Option A — Installateur (recommandé)

1. Télécharger `FATONTINE-CASH-Setup-1.0.0.exe` (dans `dist/` après un build, ou dans les **Releases** GitHub).
2. Double-cliquer sur le fichier.
3. Windows peut afficher « Application inconnue » (l'application n'est pas signée par un certificat payant) :
   cliquer sur **Informations complémentaires → Exécuter malgré tout**.
4. Choisir le dossier d'installation → **Installer**.
5. Lancer **FATONTINE CASH** depuis le bureau ou le menu Démarrer.

L'application fonctionne **100 % hors-ligne** : aucune connexion Internet n'est nécessaire.
Les mises à jour de l'application **ne suppriment jamais** les données des membres et des cotisations.

### Option B — Version portable

`FATONTINE-CASH-Portable-1.0.0.exe` : un seul fichier, aucune installation.
Pratique pour une clé USB, mais les données restent enregistrées sur le PC utilisé
(`%APPDATA%\FATONTINE_CASH`), pas sur la clé.

---

## 2. Où sont enregistrées les données ?

| Élément | Emplacement |
|---|---|
| Base de données | `%APPDATA%\FATONTINE_CASH\fatontine-database.json` |
| Sauvegardes automatiques (quotidiennes, 30 max) | `%APPDATA%\FATONTINE_CASH\sauvegardes\` |
| Cache de l'interface | `%APPDATA%\FATONTINE_CASH\Local Storage\` |

Toute modification (groupe, membre, cotisation Wave, bénéficiaire, reçu, journal d'audit)
est écrite immédiatement sur le disque. L'indicateur en haut de la fenêtre affiche
**« Données enregistrées »** ou signale une erreur d'écriture.

### Sauvegarde / Restauration sur clé USB

Bouton **« Sauvegarde / Restauration PC »** dans la barre latérale :

- **Exporter sur clé USB** : crée un fichier `.fatbackup` **chiffré AES-256-GCM**
  (mot de passe de 6 caractères minimum) et **horodaté**. Sans le mot de passe,
  le fichier est illisible — utile pour transporter les données en sécurité.
- **Restaurer une sauvegarde** : sélectionner un `.fatbackup` (ou un `.json`),
  saisir le mot de passe, confirmer. Une copie automatique de la base actuelle est
  créée avant chaque restauration.
- **Sauvegarder maintenant** : écrit immédiatement une copie non chiffrée dans le
  dossier des sauvegardes locales.
- **Ouvrir le dossier** : ouvre `%APPDATA%\FATONTINE_CASH` dans l'Explorateur Windows.

> **Astuce sécurité** : exporter une sauvegarde chiffrée sur clé USB **chaque semaine**
> et conserver la clé dans un endroit sûr. C'est la seule protection contre une panne
> du disque dur ou un vol du PC.

---

## 3. Fonctionnalités

- Gestion des groupes, membres, inscriptions, cotisations (Wave / espèces), bénéficiaires.
- Reçus PDF (format A5) générés en natif via `webContents.printToPDF()` — bouton **Enregistrer PDF**.
- Impression directe du reçu et des rapports.
- Partage WhatsApp du reçu : ouvre WhatsApp Desktop ou WhatsApp Web (`shell.openExternal`).
- Journal d'audit horodaté de toutes les actions sensibles.
- Données chiffrées en transit IPC, isolation du contexte (`contextIsolation: true`,
  `nodeIntegration: false`, `sandbox: true`), fenêtre verrouillée sur l'application locale.

### Sécurité et données personnelles

Les données (dont les scans de CNI) sont stockées **localement** sur le PC de l'administratrice.
L'application applique les principes de la **loi ivoirienne n° 2013-450** sur la protection
des données à caractère personnel (ARTCI) :

- pas de transmission vers un serveur externe ;
- accès protégé par le mot de passe administrateur de l'application ;
- sauvegardes exportées chiffrées (AES-256-GCM, clé dérivée scrypt) ;
- journal d'audit des consultations et modifications.

---

## 4. Développement

### Pré-requis

- Node.js 20 ou supérieur + npm
- Windows (pour le packaging `.exe`)

### Commandes

```bash
npm install          # installe Electron et electron-builder
npm start            # lance l'application en mode développement
npm run build:win    # compile le CSS et génère l'installateur + la version portable dans dist/
npm run build:css    # compile uniquement Tailwind (src/styles/tailwind.build.css)
npm run build:icons  # régénère build/icon.png et build/icon.ico
```

### Structure du projet

```
main.js                     Processus principal Electron (fenêtre, stockage, PDF, WhatsApp)
preload.js                  Pont IPC sécurisé exposé à l'interface (contextBridge)
src/index.html              Interface Liquid Glass (rendu hors-ligne)
src/styles/tailwind.build.css  CSS compilé à partir de src/styles/input.css
src/vendor/                 Polices et Font Awesome embarqués (aucun CDN)
build/icon.ico|png          Icône Windows navy & or
scripts/generate-icons.js   Générateur d'icônes (PNG + ICO multi-résolutions)
.github/workflows/build-exe.yml  CI GitHub Actions (windows-latest)
```

### Données de test et profil de développement

En mode développement, les données vont dans `%APPDATA%\FATONTINE_CASH` (même dossier
que la version installée). Pour repartir de zéro : fermer l'application et renommer ce dossier.

---

## 5. Compilation automatique (GitHub Actions)

Le workflow `.github/workflows/build-exe.yml` compile l'application sur
`windows-latest` à chaque `git push` sur `main` :

1. installe Node et les dépendances (`npm ci`) ;
2. exécute `npm run build:win` ;
3. vérifie la présence de `FATONTINE-CASH-Setup-1.0.0.exe` et `FATONTINE-CASH-Portable-1.0.0.exe` ;
4. publie les deux `.exe` en **artefacts** du run (onglet *Actions*).

### Publier une version officielle

```bash
git tag v1.0.0
git push origin v1.0.0
```

Le workflow crée automatiquement la **Release GitHub** `v1.0.0` et y attache les deux `.exe`.

### Mettre le dépôt en ligne (première publication)

Le dépôt distant est déjà configuré (`origin` → `github.com/ck526438-lgtm/fatontine-cash-desktop`).
S'il reste à pousser le code, s'authentifier une fois puis :

```bash
git remote add origin https://github.com/ck526438-lgtm/fatontine-cash-desktop.git
git push -u origin main
```

Avec GitHub CLI : `gh auth login`, puis `gh repo create fatontine-cash-desktop --private --source=. --remote=origin --push`.
Le workflow démarre automatiquement à la réception du premier `push` sur `main`.

Pour passer à la version suivante (ex. 1.0.1) : mettre à jour `version` dans `package.json`
et les noms de fichiers dans le workflow, puis pousser le tag `v1.0.1`.

---

## 6. Dépannage

| Problème | Solution |
|---|---|
| Windows SmartScreen bloque l'installation | *Informations complémentaires → Exécuter malgré tout* (binaire non signé) |
| « Mot de passe incorrect » lors d'une restauration | Vérifier le mot de passe saisi lors de l'export ; le fichier est chiffré et non récupérable sans lui |
| Les données n'apparaissent pas sur un autre PC | Normal : la base est locale. Utiliser **Exporter sur clé USB** puis **Restaurer** sur l'autre PC |
| WhatsApp ne s'ouvre pas | Installer WhatsApp Desktop, ou accepter l'ouverture de WhatsApp Web dans le navigateur |
| L'indicateur affiche une erreur d'enregistrement | Vérifier l'espace disque, puis **Sauvegarder maintenant** depuis le panneau Sauvegarde |

---

© 2026 FATONTINE CASH — Côte d'Ivoire. Application locale, sans serveur.
