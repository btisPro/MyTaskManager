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
| 1.6 | Champ `updatedAt` | Posé par `makeTask()` à la création et par `touchUpdatedAt()` à chaque mutation ; `ensureTimestamps()` ne l'ajoute que si absent (migration données anciennes) | `app.js › makeTask / touchUpdatedAt`, `sync.js › ensureTimestamps` |
| 1.7 | Champ `dueDate` | String ISO `"YYYY-MM-DD"` ou `""`. Défaut `""`. Migré par `migrateTask`. | `app.js › migrateTask / makeTask` |
| 1.8 | Champ `importance` | `"high"` \| `"medium"` \| `"low"` (défaut). Toute valeur invalide → `"low"`. Migré par `migrateTask`. | `app.js › migrateTask / makeTask` |

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
| 6.2b | Importance | Sélecteur `🟢 Faible / 🟠 Moyenne / 🔴 Forte` sous le titre. Sauvegardé immédiatement à chaque changement. Met à jour la couleur dans la liste. | `app.js › showDetail › detailImportance` |
| 6.2c | Date d'échéance | `<input type=date>` sous le titre. Bouton ✕ pour effacer. Sauvegardé immédiatement. | `app.js › showDetail › detailDueDate` |
| 6.2d | `_refreshCurrentList()` | Rafraîchit la liste visible (racine ou sous-tâches) après modification importance/date sans quitter le détail. | `app.js › _refreshCurrentList` |
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

### 9.1 Drag depuis la liste centrale (réordonnement intra-liste) — Souris

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 9.1.1 | Drag d'un `<li>` | Déplace une tâche dans sa propre liste via drag HTML5 | `app.js › buildTaskItem › dragstart` |
| 9.1.2 | Ligne d'insertion | Pseudo-élément bleu 3px avant/après le `<li>` cible (classes `drop-before`/`drop-after`) | `app.js › dragover / style.css` |
| 9.1.3 | Tiers haut/bas/centre | La zone cible est divisée en 3 tiers : tiers haut = insérer avant, tiers bas = insérer après, **tiers central = déplacer en sous-tâche** | `app.js › dragover / drop` |
| 9.1.4 | Drop centre = sous-tâche | Si relâché dans le tiers central de la cible → la tâche source devient le premier enfant de la tâche cible (classe `drop-child`) | `app.js › drop` |
| 9.1.5 | `dragSrcIndex` = id | Stocke l'id de la tâche source (robuste aux réordonnements) | `app.js › dragstart` |
| 9.1.6 | Recalcul destIdx post-splice | Index recalculé après le `splice` pour éviter les décalages | `app.js › drop` |

### 9.1b Drag tactile (mobile) — Touch events

Comportements selon le timing d'appui :

| Timing | Comportement |
|---|---|
| Mouvement dans les 150 premiers ms | Scroll natif — abandon propre |
| 150–600 ms, mouvement | Ignoré (attente du long press) |
| Appui ≥ 600 ms immobile | **Menu contextuel** affiché (vibration 20 ms) |
| → Doigt bouge > 10 px après menu | Menu fermé + **drag démarré** (vibration 40 ms) |
| → Doigt levé après menu | Menu reste visible (sélection d'un item) |
| Drag actif, relâchement | Drop appliqué |

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 9.1b.1 | Fenêtre scroll (150 ms) | Mouvement > 6 px dans les 150 premières ms → scroll natif, `cleanup()` immédiat. | `app.js › initTouchDrag › scrollBailTimer / mayScroll` |
| 9.1b.2 | Long press (600 ms) | Appui ≥ 600 ms immobile → menu contextuel affiché + vibration 20 ms. | `app.js › initTouchDrag › longPressTimer` |
| 9.1b.3 | Ré-enregistrement après touchcancel menu | iOS émet `touchcancel` quand le DOM change (menu apparu). `onCancel` détecte `menuShown = true`, détache puis ré-attache immédiatement les handlers → les prochains `touchmove` sont bien reçus. | `app.js › initTouchDrag › onCancel › attachDocHandlers` |
| 9.1b.4 | Drag depuis le menu | Après le menu, si le doigt bouge > 10 px (`DRAG_PX`) → `hideContextMenu()` + `startDrag()`. Référence de position : `menuX/Y` (position du doigt au moment du menu). | `app.js › initTouchDrag › onMove` |
| 9.1b.5 | `startDrag()` sans mutation DOM de liste | Crée uniquement un overlay ghost (position fixed). Pas d'insertion dans la liste → pas de touchcancel iOS supplémentaire. | `app.js › initTouchDrag › startDrag` |
| 9.1b.6 | Ghost visuel | Clone du `<li>` source, `opacity: 0.72`, `pointer-events: none`, centré sous le doigt (-24 px vertical). | `app.js › initTouchDrag › createGhost / moveGhost` |
| 9.1b.7 | Feedback de drop | Tiers haut → `drop-before`, tiers central → `drop-child` (sous-tâche), tiers bas → `drop-after`. | `app.js › initTouchDrag › updateFeedback` |
| 9.1b.8 | Drop au relâchement | `touchend` lit `changedTouches[0]` avec fallback `curX/Y`. Applique `applyDrop` si drag actif. Si menu visible et pas de drag → détache handlers seulement (menu reste). | `app.js › initTouchDrag › onEnd` |
| 9.1b.9 | `attachDocHandlers / detachDocHandlers` | Factorisées pour être appelées au touchstart ET dans `onCancel` (ré-enregistrement post-menu). Nommées (pas lambdas) pour `removeEventListener`. | `app.js › initTouchDrag` |
| 9.1b.10 | `touchstart` non-passif | `{ passive: false }` pour autoriser `preventDefault()` dans `touchmove`. | `app.js › initTouchDrag` |
| 9.1b.11 | `removeEventListener` avec `false` | Seule la valeur `capture` compte. On passe `false` explicitement (pas les options `passive`). | `app.js › initTouchDrag › detachDocHandlers` |

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

## 10. Menu contextuel (clic droit / long press)

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 10.1 | Affichage au clic droit (desktop) | Menu positionné à la souris, repositionné pour rester dans le viewport | `app.js › buildTaskItem › contextmenu` |
| 10.2 | Affichage au long press (mobile) | Appui ≥ 600 ms → menu + vibration 20 ms. Si le doigt bouge ensuite > 10 px → menu fermé + drag. | `app.js › initTouchDrag › longPressTimer` |
| 10.3 | Options de déplacement | ⬆ Tout en haut, ▲+5, ▲+10, ▲+20, ▼-5, ▼-10, ▼-20 positions | `app.js › showContextMenu › items` |
| 10.4 | Vrai parent retrouvé | En mode recherche, `findParentList` retrouve le vrai tableau parent | `app.js › showContextMenu` |
| 10.5 | Rafraîchissement adapté | Relance `runSearch()` si mode recherche, sinon `renderList` | `app.js › showContextMenu` |
| 10.6 | Fermeture automatique | Sur clic/tap ailleurs, scroll, ou touche Échap | `app.js › document click / scroll / keydown` |
| 10.7 | Transition menu → drag (mobile) | `onCancel` ré-enregistre les handlers après le touchcancel iOS causé par le menu. `onMove` détecte le mouvement post-menu et enchaîne sur le drag. | `app.js › initTouchDrag › onCancel / onMove` |

---

## 11. Recherche

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 11.1 | Déclenchement | 200 ms après la dernière frappe dans le champ de recherche | `app.js › searchInput input` |
| 11.2 | Scope : niveau courant | Par défaut, ne cherche que dans la liste visible | `app.js › runSearch › searchLevel` |
| 11.3 | Scope : tous les niveaux | Option "Tous les niveaux" — parcours récursif de tout l'arbre | `app.js › runSearch › searchAll` |
| 11.4 | Recherche dans les notes | Option "Inclure les notes" — cherche dans le HTML Quill (texte brut) | `app.js › matchTask` |
| 11.9b | Bandeau options sous topbar | Cases à cocher dans un bandeau `#searchOptions` affiché sous la topbar dès que le champ reçoit le focus (listener `focus`) OU qu'une recherche est active. `closeSearch` le masque et décoche les filtres urgence. | `app.js › showSearch / closeSearch / searchInput focus`, `index.html › #searchOptions` |
| 11.5 | Affichage du chemin | Chaque résultat montre son chemin d'appartenance (ex: `Projet › Sprint`) | `app.js › buildTaskItem › pathSpan` |
| 11.6 | Hint de résultats | Nombre de résultats + filtres actifs affichés sous le champ | `app.js › runSearch › searchHint` |
| 11.7 | Mode searchResultMode | Pas de drag intra-liste, navigation vers la tâche dans l'arbre au clic 📋 | `app.js › buildTaskItem / noteIcon` |
| 11.8 | Fermeture | Bouton ✕, champ vidé + filtres décochés → retour à la vue précédente + reset filtres urgence | `app.js › closeSearch` |
| 11.9 | Mise à jour après déplacement | `runSearch()` relancé après un drop ou une suppression en mode recherche | `app.js › performTreeDrop / del click` |
| 11.10 | Filtre 🔴 Urgentes | Case `#searchUrgent` : filtre les tâches dont `taskUrgencyClass` = `'task-urgent'`. Utilisable sans texte (parcourt tous les niveaux). | `app.js › runSearch › filterUrg` |
| 11.11 | Filtre 🟠 Importantes | Case `#searchWarning` : filtre les tâches dont `taskUrgencyClass` = `'task-warning'`. Utilisable sans texte. | `app.js › runSearch › filterWarn` |
| 11.12 | Combinaison texte + urgence | Texte seul → scope respecte l'option "tous niveaux". Urgence seule → toujours tous les niveaux + `collectAllTasksFlat`. Texte + urgence → intersection (résultats textuels filtrés par couleur). | `app.js › runSearch` |
| 11.13 | Union 🔴 + 🟠 | Quand les deux filtres sont cochés : union (urgent **OU** warning) — plus utile que l'intersection qui serait toujours vide. | `app.js › runSearch` |
| 11.14 | `collectAllTasksFlat` | Collecte récursive de toutes les tâches (sans filtre texte) avec `_path`. Utilisée quand un filtre urgence est actif sans texte. | `app.js › collectAllTasksFlat` |

---

## 12. Corbeille

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 12.1 | Suppression douce | Bouton ✕ → `trashTask()` — la tâche est déplacée en corbeille, pas supprimée | `app.js › trashTask` |
| 12.2 | TTL 30 jours | Entrées expirées supprimées automatiquement au chargement | `app.js › loadTrash / TRASH_TTL` |
| 12.3 | Badge numérique | Nombre d'éléments en corbeille affiché sur le bouton corbeille de la topbar | `app.js › updateTrashBadge` |
| 12.4 | Modale corbeille | Liste des éléments avec nom, date, parent, nombre de sous-tâches | `app.js › renderTrashList` |
| 12.4b | Tri décroissant | Éléments affichés du plus récemment supprimé (en haut) au plus ancien (en bas). Tri sur une copie (`slice().sort()`) sans modifier `trashItems` en mémoire. | `app.js › renderTrashList` |
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

### 14a. Comportement nominal de la sync bidirectionnelle

À chaque sync, les 4 opérations suivantes sont appliquées dans l'ordre :

1. **Intégration des nouvelles tâches distantes** : toute tâche présente dans le Gist mais absente en local est ajoutée à l'arbre local.
2. **Mise à jour last-write-wins** : pour chaque tâche présente des deux côtés, la version avec `updatedAt` le plus grand l'emporte (texte, notes, priorité).
3. **Respect des déplacements hiérarchiques distants** : si une tâche a changé de niveau dans l'arbre côté distant ET que le distant est plus récent, la tâche est repositionnée localement à sa place distante.
4. **Suppression des tâches distantes en corbeille** : si une tâche est dans la corbeille distante (supprimée sur l'autre appareil), elle est retirée de l'arbre local et ajoutée à la corbeille locale (restaurable si besoin).

### 14b. Tableau des fonctionnalités

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 14.1 | Configuration | Token PAT + Gist ID saisis dans la modale sync, persistés dans localStorage | `sync.js › getSyncConfig / setSyncConfig` |
| 14.2 | Sync bidirectionnelle | GET Gist → merge → save local → push Gist. Le Gist est **toujours lu en premier**. Retourne `hasRemoteChanges` : true si le merge a intégré des données du Gist absentes en local. | `sync.js › syncBidirectional` |
| 14.3 | Sync push forcée | Écrase le Gist avec les données locales (initialisation premier appareil) | `sync.js › syncPush` |
| 14.4 | Sync pull forcée | Écrase le local avec les données Gist (initialisation nouvel appareil) | `sync.js › syncPull` |
| 14.5 | Sync automatique | Déclenchée après chaque `saveTasks()` avec debounce 3 s. Ne déclenche un re-render que si `hasRemoteChanges = true` (le Gist avait des données nouvelles), pour éviter le flash visuel. | `sync.js › syncAuto` |
| 14.6 | Sync au démarrage | Si sync activée et online au chargement de la page — `mergedTrash` passé à `onSyncUpdate` | `app.js › init` |
| 14.7 | Sync sur idle | Si utilisateur actif et dernière sync > 10 min → sync automatique | `sync.js › _startIdleSyncWatcher` |
| 14.8 | `updatedAt` sur toutes les mutations | Chaque création/modification/déplacement pose `updatedAt = Date.now()` via `touchUpdatedAt()` ou `makeTask()` | `app.js › touchUpdatedAt / makeTask` |
| 14.9 | `ensureTimestamps` avant merge | Ajoute `updatedAt` aux tâches qui n'en ont pas (migration) — n'écrase **jamais** les timestamps existants | `sync.js › ensureTimestamps` |
| 14.10 | Merge last-write-wins (champs) | Tâche commune : la version avec `updatedAt` le plus grand gagne sur text, notes, clicks | `sync.js › mergeTasks` |
| 14.11 | Merge timestamps égaux | Si `updatedAt` identiques : fusion conservative — texte le plus long, notes non vides en priorité | `sync.js › mergeTasks` |
| 14.12 | Merge enfants toujours récursif | Les `children` sont toujours mergés récursivement, même quand un côté gagne sur les champs scalaires | `sync.js › mergeTasks` |
| 14.13 | Déplacement local respecté | Tâche présente dans `localAllIds` → pas réinsérée depuis distant (elle est à son nouvel emplacement local) | `sync.js › mergeTasks` |
| 14.13b | Ordre last-write-wins | L'ordre des tâches dans la liste suit le côté dont le `updatedAt` MAX est le plus grand. Si distant ≥ local → ordre distant (référence partagée). Si local > distant → ordre local (réordonnement local plus récent). Garantit que tous les appareils affichent le même ordre après sync mutuelle. | `sync.js › mergeTasks › remoteMax / localMax / useRemoteOrder` |
| 14.14 | Déplacement hiérarchique distant | Si une tâche a changé de niveau côté distant ET distant plus récent → retirée de l'arbre local avant merge → replacée à sa position distante | `sync.js › syncBidirectional › buildParentMap / removeTaskFromTree` |
| 14.15 | Suppression distante → corbeille locale | Tâches dans la corbeille distante sont ajoutées à `deletedIds` → exclues de l'arbre mergé et intégrées à la corbeille locale | `sync.js › syncBidirectional` |
| 14.16 | Merge purgedIds anticipé | Les `purgedIds` distants intégrés **avant** le merge → suppressions définitives distantes respectées immédiatement | `sync.js › syncBidirectional` |
| 14.17 | Merge corbeille | Union locale + distante, local écrase distant si même id, filtrée par TTL 30 j et purgedIds | `sync.js › syncBidirectional` |
| 14.18 | Merge purgedIds final | Union locale + distante, filtrée par TTL 60 j, persistée avant push | `sync.js › syncBidirectional` |
| 14.19 | Format Gist | `{ tasks, trash, purgedIds }` — rétrocompatible tableau pur | `sync.js › gistGet / gistPush` |
| 14.20 | Mode hors-ligne | localStorage = source de vérité, sync jamais bloquante | Architecture globale |
| 14.21 | Statut sync topbar | Indicateur coloré : ⚫ local / 🟢 ok / 🔄 sync / 🔴 erreur / 🟡 hors-ligne | `sync.js › setSyncStatus` |
| 14.22 | Clic sur le statut | Déclenche une sync forcée (ou ouvre les paramètres si sync désactivée) | `sync.js › initSyncUI` |
| 14.23 | Détection réseau | `online/offline` → mise à jour du statut automatique | `sync.js › initSyncUI` |
| 14.24 | `onSyncUpdate` | Callback après sync — recharge tâches + corbeille, préserve la vue courante | `app.js › onSyncUpdate` |
| 14.25 | Reconstruction navStack | Après sync, `navigationStack` reconstruite depuis les mêmes taskId | `app.js › onSyncUpdate` |

---

## 14b. Interface générale

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 14b.1 | Titre "Tâches" supprimé | Le `<h1>Tâches</h1>` de la vue liste a été retiré pour gagner de la place, en particulier sur smartphone. L'identité de l'app est assurée par "MtM" dans la topbar. | `index.html` |
| 14b.2 | Numéro de version (`APP_VERSION`) | Constante `'v1.5.0'` définie en tête de `app.js`. Format `vMAJEUR.MINEUR.CORRECTIF`. Injectée dans `#syncVersion` au démarrage. | `app.js › APP_VERSION` |
| 14b.3 | Version affichée dans la modale sync | Pied de modale `#syncVersion` (toujours visible, que la sync soit activée ou non). Style monospace discret. | `index.html / style.css / app.js` |

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

## 16. Coloration d'urgence des tâches

| # | Fonctionnalité | Détail | Fichier / Fonction |
|---|---|---|---|
| 16a.1 | `taskUrgencyClass(task)` | Retourne `''` \| `'task-warning'` \| `'task-urgent'` selon importance + date d'échéance. | `app.js › taskUrgencyClass` |
| 16a.2 | ROUGE (`task-urgent`) | importance = "high" **OU** date dépassée/aujourd'hui/dans ≤ 3 jours. | `app.js › taskUrgencyClass` |
| 16a.3 | ORANGE (`task-warning`) | importance = "medium" **OU** date dans 4–10 jours. | `app.js › taskUrgencyClass` |
| 16a.4 | Priorité importance > date | "high" prime sur toute date. La date est testée ensuite. | `app.js › taskUrgencyClass` |
| 16a.5 | CSS fond + bordure gauche | `.task-urgent` : fond `#fff1f1`, bordure gauche rouge `#ef4444`. `.task-warning` : fond `#fff8f0`, bordure gauche orange `#f97316`. Subtil pour ne pas surcharger. | `style.css` |
| 16a.6 | Comparaison dates ISO | Comparaison lexicographique de chaînes `YYYY-MM-DD` (ordre alphabétique = chronologique). Calcul en heure locale. | `app.js › taskUrgencyClass › dateInDays` |
| 16a.7 | Priorité drop-child > urgence | Les classes drop-child (bleu) remplacent le fond rouge/orange pendant le drag. | `style.css` |

## 17. Tests automatisés

| # | Fonctionnalité | Détail | Fichier |
|---|---|---|---|
| 17.1 | Runner Node.js | `node tests.js` — 108 assertions, zéro dépendance externe. | `tests.js` |
| 17.2 | Fonctions testées | `migrateTask`, `makeTask`, `taskUrgencyClass`, `findTaskById`, `isDescendantOrSelf`, `collectTaskIds`, `ensureTimestamps`, `mergeTasks`, `collectAllIds`, tri corbeille, `APP_VERSION`, `collectAllTasksFlat`, filtres urgence (seuls, combinés, intersection) | `tests.js` |
| 17.3 | Stubs DOM/browser | `document`, `window`, `navigator`, `localStorage`, `setTimeout` mockés pour exécution hors navigateur. | `tests.js` |

## 18. Utilitaires internes

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

## 19. Points de vigilance — Ne jamais supprimer

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
| `touchUpdatedAt(id)` après **chaque** mutation | Sans ça, le merge choisit arbitrairement entre local et distant car les `updatedAt` sont identiques |
| `hasRemoteChanges` dans `syncBidirectional` | Comparaison JSON du résultat merged vs données locales avant sync. Si identique : `syncAuto` et le watcher idle n'appellent pas `onSyncUpdate` → pas de re-render → pas de flash visuel après modification locale |
| Sync manuelle (clic statut, boutons modale) toujours re-rend | Même si `hasRemoteChanges = false`, une sync déclenchée manuellement re-rend toujours l'UI (l'utilisateur veut voir le résultat complet) |
| `makeTask()` pose `updatedAt: now` | Une nouvelle tâche doit avoir un timestamp plus récent que toute version distante sans timestamp |
| `ensureTimestamps` ne doit PAS écraser les `updatedAt` existants | Il ne pose que si absent — sinon il effacerait les timestamps des tâches récemment modifiées |
| `remotePurgedRaw` intégré **avant** le merge | Sans ça, une tâche supprimée définitivement sur l'autre appareil est réintégrée dans l'arbre local au merge |
| `syncBidirectional` lit le Gist **avant** de sauvegarder | Garantit que les modifications des autres appareils sont prises en compte avant le push |
| `remTrash` dans `deletedIds` **avant** le merge | Sans ça, une tâche supprimée sur l'autre appareil reste dans l'arbre local (la corbeille distante était mergée mais les tâches n'étaient pas retirées de l'arbre) |
| Ordre basé sur `updatedAt` MAX, pas priorité locale absolue | Avant : les tâches locales étaient TOUJOURS avant les distantes → les nouveautés distantes s'affichaient en bas. Maintenant : ordre du côté le plus récent → même position sur tous les appareils après sync |
| `buildParentMap` + `removeTaskFromTree` avant le merge | Sans ça, un déplacement hiérarchique distant est ignoré : la tâche reste à sa position locale même si le distant est plus récent |
| `result.trash` passé à `onSyncUpdate` au démarrage | Sans ça, la corbeille distante n'était pas chargée en mémoire au démarrage (mergedTrash ignoré) |
| `initTouchDrag()` appelé **une seule fois** à l'init | Même principe qu'`initTreeDropDelegation` : les handlers se cumuleraient sinon |
| `dragReadyTimer` (200 ms) avant tout drag | Si le doigt bouge avant 200 ms → `cleanupTouch()` immédiat, scroll natif, pas de drag |
| `startDrag()` ne modifie PAS la structure DOM de la liste | Crée uniquement un overlay ghost (position fixed). Pas d'insertion dans la liste → pas de touchcancel iOS supplémentaire lors du drag. |
| `onCancel` ré-enregistre les handlers si `menuShown` | iOS émet `touchcancel` quand le DOM change (menu apparu). Sans ce ré-enregistrement, les prochains `touchmove` ne seraient pas reçus et le drag serait impossible après le menu. |
| `menuX/Y` mémorisé au moment du long press | Seuil de démarrage du drag (DRAG_PX) calculé depuis la position du doigt au moment du menu, pas depuis le touchstart. Sans ça, la distance accumulée pendant l'appui fausserait le seuil. |
| `detachDocHandlers()` avant `attachDocHandlers()` dans `onCancel` | Évite la duplication de handlers si onCancel est appelé plusieurs fois. |
| `e.touches[0]` (pas `changedTouches`) dans `onMove` | `touches[0]` = position courante du doigt actif, toujours disponible pendant `touchmove`. `changedTouches` peut être incomplet sur iOS. |
| `changedTouches[0]` dans `touchend` | Dans `touchend`, le doigt vient d'être levé donc absent de `touches[]`. `changedTouches[0]` est correct ici. Fallback sur `curX/Y` si absent. |
| `removeEventListener` avec `false` (pas les options `passive`) | Seule la valeur `capture` compte pour identifier le listener. Passer `false` explicitement. |
| `touchstart` déclaré `{ passive: false }` | Obligatoire pour que `preventDefault()` dans `touchmove` soit respecté et bloque le scroll pendant le drag. |
| `e.preventDefault()` dans `touchmove` seulement si `canDrag` | Avant que le drag soit actif, ne pas bloquer le scroll natif. |
| Drop-center (sous-tâche) : vérifier `isDescendantOrSelf` | Interdire de dropper une tâche sur l'un de ses propres descendants. |
| `curX/Y` mis à jour à chaque `touchmove` | Sert de fallback dans `touchend`. Sans ça, le drop peut être appliqué aux coordonnées (0,0). |
| `initTouchDrag()` appelé une seule fois à l'init | Les handlers se cumuleraient sinon. |
| `removeEventListener` + re-`addEventListener` dans `showDetail` (pas `cloneNode`) | `cloneNode(true)` + `replaceChild` détache les nœuds du DOM, ce qui invalide les références DOM constantes (`detailImportance`, `detailDueDate`, `detailDueDateClear`) et empêche leur utilisation au prochain appel de `showDetail`. La méthode correcte : stocker les handlers dans des variables (`_detailImpHandler`, etc.) et les remplacer explicitement. |
| `closest('.detail-meta')` dans `dragstart` de `setupDetailDrag` | Sans cette exclusion, l'`<input type=date>` et le `<select>` du bloc `#detailMeta` sont draggables par défaut. Leur `dragstart` déclenche le handler du `detailView`, ce qui bloque le drag natif de l'input ET casse le drag des sous-tâches en interférant avec `dragListRef`. |
| `'select'` dans la liste d'exclusions du `touchstart` de `initTouchDrag` | Sans cette exclusion, le `<select>` importance dans `#detailMeta` ne reçoit pas le tap correct et ne peut pas ouvrir son menu déroulant sur mobile. |
