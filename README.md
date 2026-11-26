# Calendrier — Full Calendar sans Obsidian

Webapp légère (installable sur l'écran d'accueil Android) qui lit et modifie
directement les notes d'événements du plugin Obsidian **Full Calendar**
(et **Full Calendar Remastered**) stockées sur **OneDrive**.

- **Agenda à défilement infini**, vers le passé comme vers le futur, plus les vues **Jour / 3 jours / Semaine / Mois** (balayage gauche-droite pour changer de période).
- **Séparateurs de semaine** dans l'agenda, avec une mini-icône de calendrier (mois + semaine du mois en surbrillance) et un **+** à côté de chaque jour.
- **Dates d'ajout et de modification** des notes dans la fiche, et tri « Récemment ajoutés / modifiés » dans la recherche.
- **Réglages** : onglets affichés et onglet au démarrage, thème, taille du texte (appli et notes), week-ends, numéros de semaine, plage horaire, nombre de lignes en vue Mois, durée et calendrier par défaut, glisser-déposer (avec ou sans confirmation, ou désactivé).
- Glisser-déposer avec **confirmation** et bouton Annuler. Toucher un jour en vue Mois crée un événement.
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
- **Assistant IA** (bouton ✦ en haut) : tu écris des consignes pour Claude, chacune devient une note dans
  `_IA/consignes/` du coffre (dossier réglable). Chaque soir, une tâche planifiée Claude les traite, met à jour leur
  statut (*En file*, *Question pour toi*, *Fait*) et écrit sa réponse sous un titre `## Claude` : elle s'affiche dans l'appli.
  Tu peux répondre à une question, retirer une consigne pas encore traitée, ou partir d'un événement
  (« Demander à l'IA » dans sa fiche : la note est jointe en lien). L'appli ne fait que créer des notes, jamais
  les modifier : pas de conflit possible avec la tâche du soir.
- Thème clair ou sombre automatique. Le bouton retour d'Android ferme les fenêtres.
- Aucun serveur. L'appli parle directement à OneDrive depuis ton navigateur.

## Onglet Notes (note du jour)

Les notes sont un **onglet comme Agenda, Jour ou Mois**, dans la même appli et la même barre du bas.
Mêmes boutons en haut (‹ › pour changer de jour, toucher le titre pour choisir une date, pastille du jour pour revenir
à aujourd'hui, assistant IA, synchro, menu), plus un bouton **Lecture / Modifier**.
- **Raccourci** : appui long sur l'icône → « Notes du jour » ouvre directement l'onglet Notes
  (glissé sur l'écran d'accueil, il donne une icône Notes séparée). L'ancienne adresse `/notes/` y mène aussi.
- **Réglages communs** : un seul écran (section *Notes du jour*), on y choisit aussi les onglets affichés
  et l'onglet au démarrage (ou « le dernier ouvert »). Les anciens réglages de l'appli Notes sont repris automatiquement.

- Ouvre **la note quotidienne d'Obsidian** (aujourd'hui par défaut), curseur à la fin, prête à écrire.
  Dossier, format du nom et modèle sont **repris des réglages d'Obsidian** (*Notes quotidiennes* ou *Periodic Notes*),
  dates en français (`YYYY-MM-DD dddd` → `2026-11-26 jeudi`).
- Si la note n'existe pas, elle est préparée à partir du modèle (`{{date}}`, `{{date:FORMAT}}`, `{{time}}`, `{{title}}`,
  `{{yesterday}}`, `{{tomorrow}}`, `{{date+1d}}`…) et **créée seulement quand tu écris**.
  Les modèles Templater (`<% … %>`) ne sont pas exécutés.
- **Enregistrement automatique** (1 s après la frappe). Le frontmatter est conservé tel quel et masqué.
  Les listes et cases à cocher se prolongent avec Entrée.
- **Hors ligne** : le texte reste sur le téléphone et part au retour du réseau.
- **Modifiée ailleurs en même temps** (Obsidian sur le PC) : si chacun a seulement ajouté à la fin, les deux ajouts sont
  gardés ; sinon l'appli demande laquelle garder (l'autre reste dans l'historique des versions de OneDrive).
  Si la note du jour a été créée ailleurs entre-temps, ton texte est ajouté à la fin.
- Jour précédent / suivant, choix d'une date en touchant le titre, mode **Lecture** (cases cochables).
- **Assistant IA** : le même que pour l'agenda (`_IA/consignes/`, `source: notes` depuis cet onglet).
  Bouton trombone pour joindre la note du jour ; sélectionne un passage puis **« Envoyer à l'IA »**
  pour l'envoyer cité dans la consigne, avec la note en lien.

## Onglet Coffre (tout le coffre Obsidian)

Un « Obsidian en ligne » branché sur OneDrive, pensé pour l'ordinateur (s'adapte au téléphone).
- **Arborescence** du coffre à gauche (dossiers `.obsidian`, `.trash`… masqués), note à droite.
- **Lecture** (Markdown, propriétés, cases à cocher, tableaux, blocs de code, images `![[photo.png|200]]`,
  notes intégrées `![[note]]`) et **modification** (Ctrl+E), enregistrement automatique avec contrôle des conflits.
- **Liens `[[…]]` cliquables** : ouvrent la note, ou la créent si elle n'existe pas (comme Obsidian). Liens absents en plus pâle.
- **Rétroliens** sous chaque note, **recherche** dans les noms et le contenu de tout le coffre (sans accents).
- **Créer** (Ctrl+N), **renommer** (en modifiant le titre), **supprimer** (corbeille OneDrive), ouvrir dans Obsidian.
- ‹ › en haut : note précédente / suivante (aussi Alt+← / Alt+→). Ctrl+O : chercher.
- La première ouverture lit tout le coffre ; ensuite seules les notes modifiées sont retéléchargées
  (API « delta » de OneDrive). Le texte est gardé dans le navigateur (IndexedDB) : recherche instantanée, lecture hors ligne.
- Pas (encore) de vue graphe, de plugins ni d'aperçu en direct pendant la frappe. Renommer une note ne met pas à jour
  les liens qui pointent vers elle (l'appli indique combien il y en a).

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
Tests : `node tests/md.test.mjs && node tests/extra.test.mjs && node tests/daily.test.mjs`.

- `js/md.js` : lecture et écriture du format Full Calendar.
- `js/graph.js` : accès OneDrive (Microsoft Graph).
- `js/auth.js` : connexion OAuth (PKCE).
- `js/nlp.js` : saisie rapide en français.
- `js/markdown.js` : rendu des notes et cases à cocher.
- `js/assist.js` : format des notes de consigne pour l'assistant IA.
- `js/vault.js` : onglet Coffre (arborescence, lecture/édition, liens, rétroliens, recherche).
- `js/notes.js` / `js/daily.js` : onglet Notes (note quotidienne) et format des notes quotidiennes d'Obsidian.
- `js/app.js` : interface (FullCalendar 6, fourni dans `vendor/`, licence MIT).
