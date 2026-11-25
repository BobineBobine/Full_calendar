# Calendrier — Full Calendar sans Obsidian

Webapp légère (installable sur l'écran d'accueil Android) qui lit et modifie
directement les notes d'événements du plugin Obsidian **Full Calendar**
(et **Full Calendar Remastered**) stockées sur **OneDrive**.

- Vues **Liste / Jour / 3 jours / Semaine / Mois**, balayage gauche-droite pour changer de période.
- **Recherche** dans les titres et le contenu des notes, sans tenir compte des accents, avec mots surlignés.
  Les événements à venir sont listés avant les passés.
- **Fiche événement** : la note est mise en forme, et on peut **cocher les cases** directement depuis la fiche.
  Boutons Modifier, Dupliquer, Voir le jour, Ouvrir dans Obsidian et Supprimer.
- **Saisie rapide** : « Dîner Alex demain 20h », « Réunion lundi 14h-15h30 », « Anniv le 12 mars »…
  La date et l'heure sont reconnues et retirées du titre.
- **Créer / modifier / supprimer**, avec possibilité d'annuler une suppression.
  Glisser-déposer en vue Jour, 3 jours ou Semaine.
- **Afficher ou masquer chaque calendrier** (bouton réglages en haut à droite).
- Événements ponctuels, sur plusieurs jours (`endDate`) et récurrents (`daysOfWeek`, `startRecur`, `endRecur`, `skipDates`).
- Même format de fichier que le plugin : `2026-11-25 Titre.md` et `(Every W) Titre.md`.
  Le corps de la note et les propriétés inconnues sont conservés.
- Les calendriers, couleurs, premier jour de la semaine et vue par défaut sont importés depuis la config du plugin (`data.json`).
- Cache local : ouverture instantanée et lecture hors ligne. Seules les notes modifiées sont retéléchargées.
- Thème clair ou sombre automatique. Le bouton retour d'Android ferme les fenêtres.
- Aucun serveur. L'appli parle directement à OneDrive depuis ton navigateur.

## Mise en place (une seule fois)

### 1. Héberger l'appli (GitHub Pages)

1. Sur GitHub : **Settings → Pages**.
2. *Source* : **Deploy from a branch**, branche `main` (ou la branche de travail), dossier `/ (root)`.
3. L'adresse s'affiche, par exemple `https://bobinebobine.github.io/Full_calendar/`.

> GitHub Pages gratuit exige un dépôt **public**. Le code ne contient aucune donnée
> personnelle : tes réglages et ton agenda restent dans ton navigateur et sur ton OneDrive.

### 2. Enregistrer l'application Microsoft (≈ 10 min)

1. Va sur <https://entra.microsoft.com> (ou portal.azure.com) avec ton compte Microsoft perso.
   - Si on te demande de créer un annuaire ou un compte Azure gratuit, accepte. C'est gratuit et sans carte pour cet usage.
2. **Applications → Inscriptions d'applications → Nouvelle inscription**.
   - Nom : `Calendrier`.
   - Types de comptes : **Comptes Microsoft personnels uniquement**.
   - URI de redirection : plateforme **Application monopage (SPA)**, valeur = l'adresse
     GitHub Pages **exacte**, avec le `/` final (ex. `https://bobinebobine.github.io/Full_calendar/`).
3. Valide, puis copie l'**ID d'application (client)**.
4. *(Facultatif)* **Autorisations d'API** : `Files.ReadWrite` et `offline_access` sont demandées
   automatiquement à la première connexion. Il n'y a rien à ajouter.

### 3. Configurer l'appli sur le téléphone

1. Ouvre l'adresse dans **Chrome**, puis menu ⋮ → **Ajouter à l'écran d'accueil**.
2. L'écran Réglages s'ouvre :
   1. Colle l'**ID d'application**.
   2. **Se connecter** et accepter l'accès OneDrive.
   3. **Chercher mes coffres**, ou saisir le chemin du coffre dans OneDrive (ex. `OBSIDIAN/Mon coffre`).
   4. **Importer la config Full Calendar** : les calendriers et couleurs du plugin sont repris.
   5. **Enregistrer**.

## Bon à savoir

- **Connexion** : Microsoft limite les sessions des applis web à 24 h. Ensuite, l'appli se
  reconnecte toute seule, en un aller-retour invisible si ton compte est resté connecté dans Chrome.
- **Synchro** : au lancement, au retour sur l'appli (après 1 min) et via le bouton ⟳.
- **Conflits** : si une note a été modifiée ailleurs entre-temps, l'enregistrement est refusé
  et l'appli resynchronise. Rien n'est écrasé.
- **Suppression** : la note part dans la corbeille OneDrive (récupérable).
- **Récurrents** : on les modifie depuis l'éditeur (toute la série). Le glisser-déposer n'est
  disponible que pour les événements ponctuels.
- Les règles `rrule` avancées n'affichent que la première occurrence.
- **Widget** : une webapp ne peut pas créer de widget Android. Le raccourci sur l'écran d'accueil
  ouvre directement la vue Liste de la semaine.

## Développement

Aucune étape de build. Pour lancer en local : `python3 -m http.server`.
Tests : `node tests/md.test.mjs && node tests/extra.test.mjs`.

- `js/md.js` : lecture et écriture du format Full Calendar.
- `js/graph.js` : accès OneDrive (Microsoft Graph).
- `js/auth.js` : connexion OAuth (PKCE).
- `js/nlp.js` : saisie rapide en français.
- `js/markdown.js` : rendu des notes et cases à cocher.
- `js/app.js` : interface (FullCalendar 6, fourni dans `vendor/`, licence MIT).
