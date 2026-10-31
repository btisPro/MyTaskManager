# MyTaskManager — Référentiel des fonctionnalités

Ce fichier liste **toutes les fonctionnalités** de l'application. Il sert de checklist de non-régression : chaque fois que du code est modifié, vérifier que chaque point reste fonctionnel.

---

## 1. Structure des données

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 1.1 | Modèle de tâche | `{ id, text, clicks, notes, children[] }` — tous les champs toujours présents | `app.js › migrateTask` |
| 1.2 | Migration automatique | Tâches anciennes (champs manquants) migrées au chargement | `app.js › migrateTask` |
| 1.3 | Id unique | Basé sur `Date.now()` + index pour éviter les collisions | `app.js › makeTask` |
| 1.4 | Arborescence infinie | `children[]` imbriqués sans limite de profondeur | Structure récursive |
| 1.5 | Champ `clicks` | Toujours présent (migration), incrémenté au clic, mais non affiché | `app.js › handleClick` |
| 1.6 | Champ `updatedAt` | Ajouté par `ensureTimestamps()` avant chaque sync, utilisé pour last-write-wins | `sync.js › ensureTimestamps` |

---

## 2. Persistance locale (localStorage)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 2.1 | Sauvegarde des tâches | `rootTasks` sérialisé en JSON sous la clé `"tasks"` | `app.js › saveTasks` |
| 2.2 | Chargement au démarrage | Lecture + migration au `loadTasks()` | `app.js › loadTasks` |
| 2.3 | Corbeille persistée | Clé `"trash"` — tableau `{ task, parentId, deletedAt }[]` | `app.js › saveTrash / loadTrash` |
| 2.4 | PurgedIds persistés | Clé `"purgedIds"` — tableau `{ id, purgedAt }[]`, TTL 60 jours | `app.js › savePurgedIds / loadPurgedIds` |
| 2.5 | Largeur sidebar persistée | Clé `"sidebarWidth"` en px | `app.js › resizeHandle` |
| 2.6 | État replié sidebar persisté | Clé `"sidebarCollapsed"` (booléen) | `app.js › applySidebarState` |
| 2.7 | Nœuds arbre repliés persistés | Clé `"treeCollapsed"` — dictionnaire `{ [taskId]: boolean }` | `app.js › treeCollapsed` |

---

## 3. Interface — Layout

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 3.1 | Layout 2 colonnes | Sidebar gauche + zone contenu droite | `index.html / style.css` |
| 3.2 | Sidebar repliable | Bouton ☰ (topbar) bascule, bouton ✕ (sidebar) force le repli | `app.js › sidebarToggle / sidebarClose` |
| 3.3 | Sidebar redimensionnable | Poignée glissable à la souris **et** au toucher | `app.js › resizeHandle` |
| 3.4 | Responsive mobile | Sidebar masquée automatiquement après navigation sur écran ≤ 640 px | `app.js › navigateToTask, rootRow click` |
| 3.5 | 3 vues exclusives | `listView` / `detailView` / `searchView` — une seule visible à la fois | `app.js › showList / showDetail / showSearch` |
| 3.6 | Topbar fixe | Logo, bouton ☰, champ recherche, statut sync, bouton corbeille | `index.html` |

---

## 4. Vue Liste (listView)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 4.1 | Affichage de la liste | Rendu de `rootTasks` dans `<ul#taskList>` | `app.js › renderList / buildTaskItem` |
| 4.2 | Numéro de rang | Badge `#N` affiché à gauche de chaque tâche | `app.js › buildTaskItem › rank` |
| 4.3 | Badge sous-tâches | Nombre d'enfants directs affiché à droite de l'icône 📋 ; masqué si 0 | `app.js › buildTaskItem › subBadge` |
| 4.4 | Icône 📋 colorée | Colorée si la tâche a des notes ou des sous-tâches (`has-content`) | `app.js › buildTaskItem › noteIcon` |
| 4.5 | Bouton ✕ suppression | Déplace la tâche en corbeille (suppression douce) | `app.js › buildTaskItem › del` |
| 4.6 | Ajout tâche racine | Champ + bouton "Ajouter" ou touche Entrée | `app.js › addBtn / taskInput` |
| 4.7 | Nouvelle tâche en tête | `unshift` → priorité maximale par défaut | `app.js › addBtn` |

---

## 5. Priorité par clic (remontée de tâches)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 5.1 | Clic sur le titre | Accumule les clics sur la même tâche (invisible pour l'utilisateur) | `app.js › buildTaskItem › pointerup` |
| 5.2 | Délai de flush | 400 ms après le dernier clic → flush appliqué (`CLICK_DELAY`) | `app.js › handleClick / CLICK_DELAY` |
| 5.3 | Remontée proportionnelle | La tâche remonte de N positions (= nombre de clics accumulés) | `app.js › doFlush` |
| 5.4 | Changement de tâche = flush immédiat | Cliquer sur une autre tâche flushie d'abord la précédente | `app.js › handleClick` |
| 5.5 | Flush avant navigation | `openDetail`, `backBtn`, `deleteTaskBtn` flushient avant d'agir | `app.js › openDetail / backBtn / deleteTaskBtn` |
| 5.6 | Pointerup vs click | Utilise `pointerdown/pointermove/pointerup` pour distinguer clic vs drag | `app.js › buildTaskItem` |
| 5.7 | `clicks` incrémenté | Champ `task.clicks` incrémenté et sauvegardé à chaque clic | `app.js › handleClick` |

---

## 6. Vue Détail (detailView)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 6.1 | Ouverture | Clic sur 📋 ou navigation depuis l'arbre → `openDetail` | `app.js › openDetail / navigateToTask` |
| 6.2 | Titre éditable inline | Clic sur le `<h2>` → remplacé par `<input>`, validé par Entrée/blur/Échap | `app.js › startEditTitle` |
| 6.3 | Mise à jour du breadcrumb | Le titre modifié se propage dans le fil d'Ariane et dans l'arbre | `app.js › startEditTitle › commit` |
| 6.4 | Notes Quill | Éditeur rich-text intégré (bold, italic, listes, liens, images…) | `app.js › quill` |
| 6.5 | Auto-sauvegarde notes | 300 ms après le dernier caractère saisi dans Quill | `app.js › quill.on('text-change')` |
| 6.6 | Liste sous-tâches | Rendu de `task.children` dans `<ul#subTaskList>` | `app.js › showDetail › renderList` |
| 6.7 | Ajout sous-tâche | Champ + bouton ou touche Entrée dans la vue détail | `app.js › addSubTask` |
| 6.8 | Bouton ← Retour | Dépile un niveau dans `navigationStack` | `app.js › backBtn` |
| 6.9 | Bouton Supprimer | Envoie la tâche courante en corbeille et remonte d'un niveau | `app.js › deleteTaskBtn` |
| 6.10 | Quill focus protégé | Sur mobile, `pointerdown` hors Quill ne provoque pas de blur parasite | `app.js › document pointerdown` |
| 6.11 | Toolbar Quill mobile | `mousedown/touchstart` sur la toolbar annulés pour conserver la sélection | `app.js › DOMContentLoaded` |

---

## 7. Fil d'Ariane (Breadcrumb)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 7.1 | Affichage | Reflète la `navigationStack` courante | `app.js › renderBreadcrumb` |
| 7.2 | Séparateurs › | Entre chaque niveau | `app.js › renderBreadcrumb` |
| 7.3 | Navigation directe | Clic sur un niveau ancêtre → remonte directement à ce niveau | `app.js › renderBreadcrumb` |
| 7.4 | Niveau courant non cliquable | Dernier élément mis en valeur (classe `current`), non interactif | `app.js › renderBreadcrumb` |

---

## 8. Sidebar — Arbre de navigation

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 8.1 | Nœud racine fixe | "🏠 Tâches (racine)" toujours en tête, clic → retour liste principale | `app.js › renderTree › rootRow` |
| 8.2 | Arborescence complète | Tous les niveaux imbriqués affichés récursivement | `app.js › buildTreeNodes` |
| 8.3 | Indentation par profondeur | `paddingLeft = 14 + depth * 16` px | `app.js › buildTreeNodes` |
| 8.4 | Plier/déplier nœud | Clic sur le triangle ▶ bascule l'état, persisté dans `treeCollapsed` | `app.js › toggle.addEventListener` |
| 8.5 | Nœud actif surligné | Classe `active` sur le nœud correspondant à la vue courante | `app.js › buildTreeNodes` |
| 8.6 | Navigation depuis l'arbre | Clic sur un label → `navigateToTask` reconstruit la pile et affiche le détail | `app.js › row.addEventListener('click')` |
| 8.7 | Filtre mot-clé | Champ de filtre dans la sidebar — affiche uniquement les nœuds correspondants + ancêtres + descendants | `app.js › computeVisibleIds / renderTree` |
| 8.8 | Surlignage du terme filtré | Terme trouvé encadré d'un `<mark>` dans le label | `app.js › highlightMatch` |
| 8.9 | Message "Aucun résultat" | Affiché si le filtre ne correspond à rien | `app.js › renderTree` |
| 8.10 | Bouton clear du filtre | Croix pour effacer le filtre instantanément | `app.js › sidebarFilterClear` |
| 8.11 | Nœuds forcés ouverts en mode filtre | En mode filtre, aucun nœud ne peut être replié | `app.js › buildTreeNodes › forceOpen` |

---

## 9. Drag & Drop

### 9.1 Drag depuis la liste centrale (réordonnement intra-liste)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 9.1.1 | Drag d'un `<li>` | Déplace une tâche dans sa propre liste | `app.js › buildTaskItem › dragstart` |
| 9.1.2 | Ligne d'insertion | Pseudo-élément bleu 3px avant/après le `<li>` cible (classes `drop-before`/`drop-after`) | `app.js › dragover / style.css` |
| 9.1.3 | Moitié haute/basse | La ligne d'insertion se positionne selon la moitié du `<li>` survolée | `app.js › dragover` |
| 9.1.4 | `dragSrcIndex` = id | Stocke l'id de la tâche source (robuste aux réordonnements) | `app.js › dragstart` |
| 9.1.5 | Recalcul destIdx post-splice | Index recalculé après le `splice` pour éviter les décalages | `app.js › drop` |

### 9.2 Drag vers l'arbre (déplacement entre niveaux)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 9.2.1 | Drop sur un nœud arbre | Déplace la tâche comme premier enfant du nœud cible | `app.js › performTreeDrop` |
| 9.2.2 | Drop sur la racine | Déplace la tâche à la racine (`rootTasks`) | `app.js › initTreeDropDelegation › drop` |
| 9.2.3 | Interdiction descendant→ancêtre | Impossible de dropper une tâche sur l'un de ses descendants | `app.js › isDescendantOrSelf` |
| 9.2.4 | Highlight du nœud cible | Classe `drop-target` pendant le survol | `app.js › initTreeDropDelegation` |
| 9.2.5 | Expansion auto 800 ms | Un nœud replié s'ouvre si on le survole 800 ms avec une tâche | `app.js › expandTimer / EXPAND_DELAY` |
| 9.2.6 | Event delegation | Un seul `dragover/drop` sur `sidebarTree` (robuste aux re-renders) | `app.js › initTreeDropDelegation` |
| 9.2.7 | `body.dragging-active` | Pendant le drag, `pointer-events:none` sur les enfants des `.tree-row` (évite les faux `dragleave`) | `app.js / style.css` |

### 9.3 Drag depuis la vue détail

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 9.3.1 | Détail draggable | La vue détail entière est draggable vers l'arbre | `app.js › setupDetailDrag` |
| 9.3.2 | Exclusion Quill/inputs | Drag annulé si la cible est l'éditeur Quill ou un champ input | `app.js › setupDetailDrag › dragstart` |
| 9.3.3 | Drag sous-tâche depuis détail | Les `<li>` de sous-tâches dans le détail sont également draggables | `app.js › setupDetailDrag` (ne bloque pas `.task-item`) |

### 9.4 Comportements communs

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 9.4.1 | Ghost drag synthétique | Bulle personnalisée avec le titre tronqué, offset (-10, 8) à droite du curseur | `app.js › createDragGhost` |
| 9.4.2 | `activeDragTaskId` global | Variable globale lue pendant `dragover` (car `dataTransfer.getData()` = `""` à ce stade) | `app.js › activeDragTaskId` |
| 9.4.3 | `resolveDragSource()` | Lit `treeDragTaskId` puis `activeDragTaskId` pour identifier la source | `app.js › resolveDragSource` |
| 9.4.4 | Nettoyage en fin de drag | Classes, variables et timers réinitialisés dans `dragend` | `app.js › dragend handlers` |

---

## 10. Menu contextuel (clic droit)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 10.1 | Affichage au clic droit | Menu positionné à la souris, repositionné pour rester dans le viewport | `app.js › showContextMenu` |
| 10.2 | Options de déplacement | ⬆ Tout en haut, ▲+5, ▲+10, ▲+20, ▼-5, ▼-10, ▼-20 positions | `app.js › showContextMenu › items` |
| 10.3 | Vrai parent retrouvé | En mode recherche, `findParentList` retrouve le vrai tableau parent | `app.js › showContextMenu` |
| 10.4 | Rafraîchissement adapté | Relance `runSearch()` si mode recherche, sinon `renderList` | `app.js › showContextMenu` |
| 10.5 | Fermeture automatique | Sur clic ailleurs, scroll, ou touche Échap | `app.js › document click / scroll / keydown` |

---

## 11. Recherche

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 11.1 | Déclenchement | 200 ms après la dernière frappe dans le champ de recherche | `app.js › searchInput input` |
| 11.2 | Scope : niveau courant | Par défaut, ne cherche que dans la liste visible | `app.js › runSearch › searchLevel` |
| 11.3 | Scope : tous les niveaux | Option "Tous les niveaux" — parcours récursif de tout l'arbre | `app.js › runSearch › searchAll` |
| 11.4 | Recherche dans les notes | Option "Inclure les notes" — cherche dans le HTML Quill (texte brut) | `app.js › matchTask` |
| 11.5 | Affichage du chemin | Chaque résultat montre son chemin d'appartenance (ex: `Projet › Sprint`) | `app.js › buildTaskItem › pathSpan` |
| 11.6 | Hint de résultats | Nombre de résultats + scope affiché sous le champ | `app.js › runSearch › searchHint` |
| 11.7 | Mode searchResultMode | Pas de drag intra-liste, navigation vers la tâche dans l'arbre au clic 📋 | `app.js › buildTaskItem / noteIcon` |
| 11.8 | Fermeture | Bouton ✕ ou champ vidé → retour à la vue précédente | `app.js › closeSearch` |
| 11.9 | Mise à jour après déplacement | `runSearch()` relancé après un drop ou une suppression en mode recherche | `app.js › performTreeDrop / del click` |

---

## 12. Corbeille

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 12.1 | Suppression douce | Bouton ✕ → `trashTask()` — la tâche est déplacée en corbeille, pas supprimée | `app.js › trashTask` |
| 12.2 | TTL 30 jours | Entrées expirées supprimées automatiquement au chargement | `app.js › loadTrash / TRASH_TTL` |
| 12.3 | Badge numérique | Nombre d'éléments en corbeille affiché sur le bouton corbeille de la topbar | `app.js › updateTrashBadge` |
| 12.4 | Modale corbeille | Liste des éléments avec nom, date, parent, nombre de sous-tâches | `app.js › renderTrashList` |
| 12.5 | Restauration | Bouton "↩ Restaurer" — réinsère la tâche dans son emplacement d'origine | `app.js › restoreTask` |
| 12.6 | Suppression définitive | Bouton ✕ dans la modale — `deleteForever()` + `markPurged()` | `app.js › deleteForever` |
| 12.7 | Vider la corbeille | Bouton "Vider" avec confirmation → `emptyTrash()` | `app.js › emptyTrash` |
| 12.8 | `parentId` conservé | Chaque entrée mémorise l'id du parent pour restaurer au bon endroit | `app.js › trashTask` |
| 12.9 | Fermeture modale | Bouton ✕, clic hors modale | `app.js › initTrashUI` |

---

## 13. PurgedIds — Protection contre le retour via sync

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 13.1 | `markPurged(task)` | Enregistre l'id de la tâche et de tous ses descendants comme purgés | `app.js › markPurged` |
| 13.2 | Déclenché par `deleteForever` | Un suppression définitive = purge de l'id | `app.js › deleteForever` |
| 13.3 | Déclenché par `emptyTrash` | Vidage corbeille = purge de tous les ids | `app.js › emptyTrash` |
| 13.4 | Déclenché par `restoreTask` | Restauration = purge de l'id de la corbeille distante | `app.js › restoreTask` |
| 13.5 | Retiré par `trashTask` | Re-mise en corbeille retire l'id de `purgedIds` | `app.js › trashTask` |
| 13.6 | TTL 60 jours | Entrées expirées supprimées au chargement | `app.js › loadPurgedIds / PURGED_TTL` |
| 13.7 | Merge sync respecte purge | `syncBidirectional` exclut les tâches/entrées corbeille dont l'id est dans `purgedIds` | `sync.js › syncBidirectional` |

---

## 14. Synchronisation GitHub Gist

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 14.1 | Configuration | Token PAT + Gist ID saisis dans la modale sync, persistés dans localStorage | `sync.js › getSyncConfig / setSyncConfig` |
| 14.2 | Sync bidirectionnelle | Merge local + distant, push du résultat | `sync.js › syncBidirectional` |
| 14.3 | Sync push forcée | Écrase le Gist avec les données locales | `sync.js › syncPush` |
| 14.4 | Sync pull forcée | Écrase le local avec les données Gist | `sync.js › syncPull` |
| 14.5 | Sync automatique | Déclenchée après chaque `saveTasks()` avec debounce 3 s | `sync.js › syncAuto` |
| 14.6 | Sync au démarrage | Si sync activée et online au chargement de la page | `app.js › init` |
| 14.7 | Sync sur idle | Si utilisateur actif et dernière sync > 10 min → sync automatique | `sync.js › _startIdleSyncWatcher` |
| 14.8 | Merge last-write-wins | Conflit par tâche → la version avec `updatedAt` le plus récent l'emporte | `sync.js › mergeTasks` |
| 14.9 | Merge corbeille | Union locale + distante, dédoublonnée, filtrée par TTL et purgedIds | `sync.js › syncBidirectional` |
| 14.10 | Merge purgedIds | Union locale + distante, filtrée par TTL 60 j | `sync.js › syncBidirectional` |
| 14.11 | Déplacement local respecté | Tâche présente dans `localAllIds` → pas réinsérée depuis distant | `sync.js › mergeTasks` |
| 14.12 | Format Gist | `{ tasks, trash, purgedIds }` — rétrocompatible tableau pur | `sync.js › gistGet / gistPush` |
| 14.13 | Mode hors-ligne | localStorage = source de vérité, sync jamais bloquante | Architecture globale |
| 14.14 | Statut sync topbar | Indicateur coloré : ⚫ local / 🟢 ok / 🔄 sync / 🔴 erreur / 🟡 hors-ligne | `sync.js › setSyncStatus` |
| 14.15 | Clic sur le statut | Déclenche une sync forcée (ou ouvre les paramètres si sync désactivée) | `sync.js › initSyncUI` |
| 14.16 | Détection réseau | `online/offline` → mise à jour du statut automatique | `sync.js › initSyncUI` |
| 14.17 | `onSyncUpdate` | Callback appelé après sync — recharge les tâches et préserve la vue courante | `app.js › onSyncUpdate` |
| 14.18 | Reconstruction navStack | Après sync, `navigationStack` reconstruite depuis les mêmes taskId | `app.js › onSyncUpdate` |

---

## 15. PWA (Progressive Web App)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 15.1 | Installable Android/iOS | `manifest.json` avec icônes 192 et 512 px, `apple-touch-icon.png` | `manifest.json / index.html` |
| 15.2 | Mode hors-ligne | Service Worker cache toutes les ressources statiques | `sw.js` |
| 15.3 | Stratégie Network-First | Tente le réseau, fallback sur le cache si hors-ligne | `sw.js` |
| 15.4 | Version de cache | `CACHE_VERSION = 'v7'` — incrémenter à chaque déploiement | `sw.js` |
| 15.5 | HTTPS requis | Service Worker et PWA nécessitent HTTPS | Contrainte navigateur |
| 15.6 | Popup d'accueil | Affichée au premier lancement, masquable définitivement | `sync.js › initWelcomeModal` |

---

## 16. Utilitaires internes

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 16.1 | `findTaskById` | Recherche récursive d'une tâche par id dans l'arbre | `app.js › findTaskById` |
| 16.2 | `findParentList` | Retourne le tableau parent direct d'une tâche | `app.js › findParentList` |
| 16.3 | `findPath` | Retourne le chemin complet depuis la racine jusqu'à une tâche | `app.js › findPath` |
| 16.4 | `collectTaskIds` | Collecte récursivement tous les ids d'une tâche et ses descendants dans un Set | `app.js › collectTaskIds` |
| 16.5 | `collectAllIds` | Idem, utilisé dans sync.js pour le merge | `sync.js › collectAllIds` |
| 16.6 | `isDescendantOrSelf` | Vérifie si un id est descendant d'un ancêtre (protection drop) | `app.js › isDescendantOrSelf` |
| 16.7 | `escHtml` | Échappe les caractères HTML pour le rendu du filtre sidebar | `app.js › escHtml` |
| 16.8 | `highlightMatch` | Insère un `<mark>` autour du terme trouvé dans le label sidebar | `app.js › highlightMatch` |
| 16.9 | `timeAgo` | Formate un timestamp en "il y a X jours/heures/minutes" | `app.js › timeAgo` |
| 16.10 | `ensureTimestamps` | Ajoute `updatedAt` récursivement avant chaque sync | `sync.js › ensureTimestamps` |
| 16.11 | `touchTask` | Met à jour `updatedAt` d'une tâche et de ses parents | `sync.js › touchTask` |

---

## 17. Points de vigilance — Ne jamais supprimer

Ces éléments sont critiques et ont déjà causé des régressions par le passé :

| ⚠️ Élément | Pourquoi critique |
|---|---|
| `handleClick / doFlush / clickAccum / CLICK_DELAY` | Système de priorité par clic — supprimé par erreur une fois déjà |
| `pointerdown/pointermove/pointerup` sur `textWrap` | Seule façon fiable de détecter le clic vs drag sur un `draggable` |
| Appels `doFlush()` dans `openDetail`, `backBtn`, `deleteTaskBtn` | Évite les déplacements parasites lors d'une navigation rapide |
| `e.preventDefault()` absent dans `setupDetailDrag` pour `.task-item` | Nécessaire pour que les `<li>` de sous-tâches soient draggables depuis le détail |
| `initTreeDropDelegation()` appelé **une seule fois** à l'init | Si appelé à chaque `renderTree()`, les handlers se cumulent |
| `body.dragging-active` + `pointer-events:none` sur enfants `.tree-row` | Sans ça, des `dragleave` fantômes déclenchent des animations parasites |
| `activeDragTaskId` global | `dataTransfer.getData()` retourne `""` pendant `dragover` — seule source fiable |
| `dragSrcIndex` = id de tâche (pas index) | Si l'index était stocké, il deviendrait invalide après un réordonnement |
| `trashTask` retire les ids de `purgedIds` | Une tâche re-mise en corbeille ne doit pas rester filtrée par `purgedIdsSet` |
| `markPurged` après `restoreTask` | Empêche la sync de ramener l'entrée de corbeille distante |
| `purgedIds` rechargé dans `onSyncUpdate` | Resynchronise la mémoire avec ce que `sync.js` a écrit dans localStorage |
| `findParentList` dans le menu contextuel | En mode recherche, `tasks` est un tableau temporaire — le vrai parent doit être retrouvé |
| `collectAllIds([e.task], deletedIds)` dans `syncBidirectional` | Inclut les descendants des tâches en corbeille dans les ids supprimés |
| `localAllIds` dans `mergeTasks` | Sans ça, un déplacement local est interprété comme une nouvelle tâche distante |
