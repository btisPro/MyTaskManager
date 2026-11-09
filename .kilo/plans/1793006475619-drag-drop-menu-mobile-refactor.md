# Plan — Drag & drop + menu contextuel mobile (refonte UX)

## Contexte et décisions prises

| Aspect | Décision |
|---|---|
| **Menu mobile** | Bouton `⋮` dédié sur chaque tâche → tap = menu immédiat |
| **Appui long** | Reste disponible sur la zone texte (sans bouton) pour ouvrir le menu (second point d'entrée) |
| **Drag mobile** | Poignée `⠿` dédiée à gauche → touch immédiat = drag, sans délai |
| **Desktop** | Inchangé : drag HTML5 natif sur toute la tâche, clic droit = menu |
| **Visibilité** | Toujours visibles sur mobile (`pointer: coarse`), apparaissent au hover sur desktop (`pointer: fine`) |

## Cause racine des bugs actuels

L'architecture actuelle tente de faire deux choses conflictuelles avec un seul geste (appui sur la tâche) :
- Distinguer scroll / long-press-menu / drag en mesurant le temps et le déplacement.
- Sur iOS, `showContextMenu()` modifie le DOM → `touchcancel` → perte des handlers.
- Sur Android, le click fantôme post-touchend ferme le menu avant l'interaction.

**La solution est de séparer physiquement les deux gestes** : poignée pour le drag, bouton pour le menu. Plus aucune ambiguïté temporelle ni DOM à gérer pendant un touch.

---

## Périmètre des modifications

### Fichiers modifiés
- `app.js` — `buildTaskItem`, `initTouchDrag`, `showContextMenu`/`hideContextMenu`
- `index.html` — rien (éléments créés dynamiquement dans `buildTaskItem`)
- `style.css` — styles poignée, bouton ⋮, règles hover desktop / always-on mobile
- `tests.js` — nouveaux groupes de tests couvrant la nouvelle architecture

### Fichiers inchangés
- `sync.js`, `sw.js`, `manifest.json`

---

## Tâches d'implémentation (ordre strict)

### 1. `buildTaskItem` — ajout des deux nouveaux éléments DOM

Dans `buildTaskItem` (app.js), insérer **avant** le `rank` :

```
dragHandle  <span class="task-drag-handle" title="Déplacer">⠿</span>
```

Et **après** `subBadge`, **avant** `del` :

```
menuBtn  <button class="task-menu-btn" title="Options">⋮</button>
```

Ordre final des enfants du `<li>` :
`dragHandle` | `rank` | `textWrap` | `noteIcon` | `subBadge` | `menuBtn` | `del`

#### Comportement `menuBtn`
- Listener `click` (desktop + mobile) → `showContextMenu(e, task, tasks, listEl)`.
- `e.stopPropagation()` pour ne pas remonter vers `document click → hideContextMenu`.
- **Exclure** `menuBtn` de la liste des exclusions du `touchstart` de `initTouchDrag` (il a son propre handler, pas besoin du long press dessus).

#### Comportement `dragHandle`
- Sur desktop : l'élément a `draggable` = false (c'est le `<li>` parent qui est draggable). La poignée est seulement visuelle.
- Sur mobile : le `touchstart` de `initTouchDrag` détecte si le touch vient de `.task-drag-handle` et démarre le drag **immédiatement** (sans timer long press, sans fenêtre scroll).

#### Comportement appui long sur zone texte (maintenu)
- Fonctionne comme avant : appui long sur `textWrap` → menu contextuel.
- Avec la poignée pour le drag, ce comportement devient secondaire mais reste utile.

---

### 2. `initTouchDrag` — refonte de la détection du geste

Remplacer la logique actuelle par **deux chemins explicites** selon la zone touchée :

#### Chemin A — touch sur `.task-drag-handle`
```
touchstart sur handle → startDrag() IMMÉDIAT (canDrag = true dès le départ)
touchmove              → ghost suit le doigt, feedback drop, preventDefault()
touchend               → applyDrop(), cleanup()
touchcancel            → cleanup()
```
- Pas de `longPressTimer`, pas de `scrollBailTimer`, pas de `menuShown`.
- `_touchGestureActive = true` dès le touchstart sur le handle.

#### Chemin B — touch sur `.task-item` (hors handle et hors menuBtn)
```
touchstart             → enregistre position, démarre longPressTimer (550ms)
touchmove < 150ms, > MOVE_PX → scroll natif, cleanup()
touchmove > 150ms      → ignoré (ni scroll ni drag — on attend le long press)
longPressTimer expire  → showContextMenu() + vibration + _suppressNextClick
touchend après menu    → handlers détachés, menu reste visible
touchend sans menu     → cleanup() (tap court)
touchcancel si menuShown → ré-enregistrement handlers (iOS)
touchcancel sinon      → cleanup()
```

#### Factorisation
- Garder `attachDocHandlers` / `detachDocHandlers` / `cleanup` / `createGhost` / `moveGhost` / `updateFeedback` / `applyDrop` / `getTaskItemAt` inchangés.
- Ajouter une variable `dragFromHandle = false` dans l'état du geste pour distinguer les deux chemins dans `onMove`.

#### Pseudo-code `touchstart` refactorisé

```js
containerEl.addEventListener('touchstart', (e) => {
  const li = e.target.closest('.task-item');
  if (!li) return;
  if (e.target.closest('button, a, input, select, .task-detail-btn, .task-delete')) return;
  // NE PAS appeler e.preventDefault() ici (casse iOS)

  cleanup();
  _touchGestureActive = true;

  const touch = e.touches[0];
  startX = touch.clientX; startY = touch.clientY;
  curX = touch.clientX;   curY = touch.clientY;

  const tasks = getTasksFn();
  touchSrcTask = tasks.find(t => t.id === parseInt(li.dataset.taskId)) || null;
  if (!touchSrcTask) { _touchGestureActive = false; return; }
  touchSrcList = tasks;

  attachDocHandlers();

  if (e.target.closest('.task-drag-handle')) {
    // ── Chemin A : drag immédiat depuis la poignée ──
    dragFromHandle = true;
    startDrag(); // ghost créé immédiatement
  } else {
    // ── Chemin B : long press → menu ──
    dragFromHandle = false;
    mayScroll = true;
    scrollBailTimer = setTimeout(() => { scrollBailTimer = null; mayScroll = false; }, SCROLL_BAIL_MS);
    longPressTimer = setTimeout(() => {
      /* ... showContextMenu + _suppressNextClick ... */
    }, LONG_PRESS_MS);
  }
}, { passive: false });
```

#### Pseudo-code `onMove` refactorisé

```js
function onMove(e) {
  if (!e.touches.length) return;
  curX = e.touches[0].clientX; curY = e.touches[0].clientY;

  if (canDrag) {
    e.preventDefault(); // bloque scroll uniquement quand drag actif
    moveGhost(curX, curY);
    updateFeedback(curX, curY);
    return;
  }

  if (dragFromHandle) return; // startDrag() déjà appelé, canDrag sera true au prochain onMove

  // Chemin B uniquement :
  if (menuShown) {
    // mouvement post-menu → drag si > DRAG_PX (comportement existant conservé)
    if (Math.hypot(curX - menuX, curY - menuY) > DRAG_PX) {
      hideContextMenu(); menuShown = false; startDrag();
    }
    return;
  }
  if (mayScroll && Math.hypot(curX - startX, curY - startY) > MOVE_PX) { cleanup(); }
}
```

---

### 3. `style.css` — styles des nouveaux éléments

#### Poignée de drag `.task-drag-handle`
```css
.task-drag-handle {
  font-size: 1rem;
  color: #bbb;
  cursor: grab;
  padding: 0 4px;
  flex-shrink: 0;
  touch-action: none; /* empêche le navigateur de gérer ce touch comme scroll */
}
.task-drag-handle:active { cursor: grabbing; }
```

#### Bouton menu `.task-menu-btn`
```css
.task-menu-btn {
  background: none;
  border: none;
  font-size: 1.1rem;
  color: #aaa;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
  flex-shrink: 0;
}
.task-menu-btn:hover { color: var(--accent); }
```

#### Visibilité conditionnelle
```css
/* Desktop : cachés au repos, visibles au hover de la ligne */
@media (pointer: fine) {
  .task-drag-handle,
  .task-menu-btn { opacity: 0; transition: opacity 0.15s; }
  .task-item:hover .task-drag-handle,
  .task-item:hover .task-menu-btn { opacity: 1; }
}

/* Mobile : toujours visibles */
@media (pointer: coarse) {
  .task-drag-handle,
  .task-menu-btn { opacity: 1; }
}
```

#### `touch-action: none` sur la poignée
Important : empêche le navigateur mobile de considérer le touch sur la poignée comme un scroll. Doit être sur `.task-drag-handle`, PAS sur `.task-item` entier (sinon le scroll de liste est bloqué partout).

---

### 4. Exclusions à mettre à jour dans `touchstart`

La liste d'exclusions du `touchstart` de `initTouchDrag` doit exclure `.task-menu-btn` (il a son propre handler `click`) mais **NE PAS** exclure `.task-drag-handle` (c'est lui qui déclenche le chemin A) :

```js
if (e.target.closest('button:not(.task-drag-handle), a, input, select, .task-detail-btn, .task-delete, .task-menu-btn')) return;
```

Ou plus lisiblement :
```js
const isInteractive = e.target.closest('a, input, select, .task-detail-btn, .task-delete, .task-menu-btn');
const isHandle = e.target.closest('.task-drag-handle');
if (isInteractive) return; // laisse le comportement natif
// isHandle → chemin A, sinon chemin B
```

---

### 5. Suppression de `initTouchDrag` pour la vue détail

`initTouchDrag` est appelé sur `taskListEl` et `subTaskListEl`. La vue détail (`detailView`) utilise le drag HTML5 natif via `setupDetailDrag`. Aucun changement ici.

---

### 6. `tests.js` — groupes de tests à ajouter/mettre à jour

#### Modifier
- Groupe `APP_VERSION` : inchangé (version reste `v1.0.2`).
- Groupe `Guard click fantôme` : vérifier que `_suppressNextClick` est toujours présent.

#### Ajouter
1. **Présence des nouveaux éléments DOM dans `buildTaskItem`** : vérifier que le source contient `task-drag-handle` et `task-menu-btn`.
2. **`touch-action: none` sur `.task-drag-handle`** : vérifier dans style.css.
3. **Chemin A vs Chemin B** : vérifier que `dragFromHandle` est déclaré dans `initTouchDrag`.
4. **Exclusions `touchstart`** : vérifier que `.task-menu-btn` est dans les exclusions ET que `.task-drag-handle` n'y est pas.
5. **`menuBtn` click handler** : vérifier que `showContextMenu` est appelé depuis le listener click de `.task-menu-btn`.

---

## Points de vigilance

| Risque | Mitigation |
|---|---|
| `touch-action: none` sur `.task-drag-handle` casse le scroll | Mettre `touch-action: none` UNIQUEMENT sur `.task-drag-handle`, jamais sur `.task-item` |
| `startDrag()` appelle `createGhost()` qui ne modifie pas la liste → OK | Contrainte déjà respectée, ne pas changer |
| `dragFromHandle = true` mais `canDrag` pas encore vrai au 1er `onMove` | `startDrag()` pose `canDrag = true` → le 2e `onMove` entre dans la bonne branche. Le 1er est géré par `if (dragFromHandle) return` |
| iOS `touchcancel` lors de `showContextMenu` (chemin B uniquement) | Comportement existant conservé : `onCancel` ré-enregistre si `menuShown` |
| Desktop : `.task-drag-handle` visible au hover mais `draggable` sur `<li>` | Sur desktop, le drag démarre sur toute la `<li>` (comportement inchangé). La poignée est visuelle. |
| `_suppressNextClick` toujours nécessaire pour le chemin B (long press) | Conserver tel quel |
| `buildTaskItem` crée un `button.task-menu-btn` → exclu de `initTouchDrag` mais son click appelle `showContextMenu` → risque de double fermeture via `document click` | `e.stopPropagation()` dans le handler du `menuBtn` empêche la remontée |

---

## Non-régressions à vérifier manuellement après implémentation

1. Desktop : drag HTML5 sur toute la tâche fonctionne (pas seulement sur la poignée).
2. Desktop : clic droit → menu contextuel.
3. Mobile : tap sur `.task-drag-handle` → drag immédiat, ghost visible, drop correct.
4. Mobile : tap sur `⋮` → menu contextuel visible, items fonctionnels.
5. Mobile : appui long sur zone texte → menu contextuel (chemin B).
6. Mobile : scroll de liste non perturbé (touch rapide + mouvement).
7. Mobile : tap court sur tâche → handleClick (priorité par clic).
8. iOS : menu contextuel reste visible après touchend (pas fermé par click fantôme).
9. Drag vers l'arbre sidebar (desktop + mobile).
10. `initTouchDrag` sur `subTaskListEl` (sous-tâches) : même comportement.

---

## Validation automatisée

Après implémentation, `node tests.js` doit afficher **≥ 131 tests passés, 0 échecs**.
