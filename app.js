/* ═══════════════════════════════════════════════════════════
   STORAGE — Persistance dans localStorage
   Les tâches sont sérialisées en JSON sous la clé "tasks".
   Chaque tâche a la forme :
     { id, text, clicks, notes, children[] }
════════════════════════════════════════════════════════════ */

/**
 * Charge les tâches depuis localStorage.
 * Appelle migrateTask() pour garantir que tous les champs existent,
 * même pour des données créées par une version antérieure.
 */
function loadTasks() {
  try {
    const data = JSON.parse(localStorage.getItem('tasks')) || [];
    return data.map(migrateTask);
  } catch { return []; }
}

/**
 * Normalise un objet tâche : ajoute les champs manquants avec des valeurs
 * par défaut, et migre récursivement les sous-tâches (children).
 * @param {object} t   - Objet brut lu depuis le stockage
 * @param {number} i   - Index dans le tableau parent (utilisé pour forger un id unique)
 */
function migrateTask(t, i) {
  return {
    id:       t.id       ?? Date.now() + i,  // id unique basé sur le timestamp
    text:     t.text     ?? '',
    clicks:   t.clicks   ?? 0,               // compteur de clics de priorité
    notes:    t.notes    ?? '',              // HTML Quill
    children: (t.children ?? []).map(migrateTask),
  };
}

/**
 * Sérialise rootTasks dans localStorage, puis déclenche
 * une sync automatique vers le Gist si la sync est activée.
 */
function saveTasks() {
  localStorage.setItem('tasks', JSON.stringify(rootTasks));
  // syncAuto est défini dans sync.js ; si les données distantes sont plus récentes
  // après merge, onSyncUpdate recharge l'arbre complet.
  if (typeof syncAuto === 'function') {
    syncAuto(onSyncUpdate);
  }
}

/**
 * Callback appelé quand une sync a ramené des données distantes
 * plus récentes que les données locales.
 * Recharge rootTasks et rafraîchit la vue courante.
 * @param {Task[]} mergedTasks - Arbre fusionné retourné par la sync
 */
function onSyncUpdate(mergedTasks) {
  rootTasks = mergedTasks.map(migrateTask);
  // Réinitialise la pile de navigation à la racine pour éviter des états incohérents
  navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
  activeTreeTaskId = null;
  renderTree();
  showList();
}

/* ═══════════════════════════════════════════════════════════
   STATE — Variables globales de l'application
════════════════════════════════════════════════════════════ */

/** Tableau racine de toutes les tâches de premier niveau. */
let rootTasks = loadTasks();

/**
 * Pile de navigation : chaque entrée représente un niveau de l'arborescence
 * affiché dans la vue détail.
 *   [0] = { tasks: rootTasks, title: 'Tâches', taskId: null }   ← niveau racine
 *   [1] = { tasks: tâcheA.children, title: 'tâcheA', taskId: idA }
 *   [2] = { tasks: tâcheB.children, title: 'tâcheB', taskId: idB }
 * Naviguer "en arrière" = pop(). Naviguer vers une tâche = push().
 */
let navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];

/**
 * Délai en ms d'attente après le dernier clic avant d'appliquer
 * le déplacement de priorité (permet d'accumuler plusieurs clics).
 */
const CLICK_DELAY = 400;

/** État de repli/déploiement du panneau latéral, persisté dans localStorage. */
let sidebarCollapsed = localStorage.getItem('sidebarCollapsed') === 'true';

/**
 * Dictionnaire { [taskId]: boolean } mémorisant quels nœuds de l'arbre
 * sont repliés dans la sidebar. Persisté dans localStorage.
 */
const treeCollapsed = JSON.parse(localStorage.getItem('treeCollapsed') || '{}');

/** Id de la tâche actuellement surlignée dans l'arbre de la sidebar. */
let activeTreeTaskId = null;

/**
 * Id de la tâche en cours de drag DEPUIS l'arbre (drag intra-arbre).
 * Distinct de dragSrcIndex/dragListRef qui concernent le drag depuis la liste centrale.
 */
let treeDragTaskId = null;

/**
 * Timer d'expansion automatique d'un nœud replié lorsqu'on survole
 * avec une tâche draguée (800 ms de survol = déploiement).
 */
let expandTimer = null;
const EXPAND_DELAY = 800; // ms avant d'ouvrir un nœud replié pendant un drag

/* ═══════════════════════════════════════════════════════════
   DOM REFS — Raccourcis vers les éléments HTML
════════════════════════════════════════════════════════════ */

const sidebar        = document.getElementById('sidebar');
const sidebarToggle  = document.getElementById('sidebarToggle');   // bouton ☰ topbar
const sidebarClose   = document.getElementById('sidebarClose');    // bouton ✕ dans la sidebar
const sidebarTree    = document.getElementById('sidebarTree');     // conteneur de l'arbre
const resizeHandle   = document.getElementById('resizeHandle');    // poignée de redimensionnement

const listView       = document.getElementById('listView');        // vue liste principale
const detailView     = document.getElementById('detailView');      // vue détail d'une tâche
const searchView     = document.getElementById('searchView');      // vue résultats de recherche

const taskInput      = document.getElementById('taskInput');       // champ "nouvelle tâche"
const addBtn         = document.getElementById('addBtn');
const taskListEl     = document.getElementById('taskList');        // <ul> liste racine

const backBtn        = document.getElementById('backBtn');         // bouton ← Retour
const deleteTaskBtn  = document.getElementById('deleteTaskBtn');   // bouton Supprimer la tâche courante
const breadcrumb     = document.getElementById('breadcrumb');      // fil d'Ariane
const detailTitle    = document.getElementById('detailTitle');     // <h2> titre de la tâche
const subTaskInput   = document.getElementById('subTaskInput');    // champ "nouvelle sous-tâche"
const addSubBtn      = document.getElementById('addSubBtn');
const subTaskListEl  = document.getElementById('subTaskList');     // <ul> liste des sous-tâches

const searchInput    = document.getElementById('searchInput');
const searchAllLevels = document.getElementById('searchAllLevels');
const searchInNotes  = document.getElementById('searchInNotes');
const searchClose    = document.getElementById('searchClose');
const searchList     = document.getElementById('searchList');
const searchHint     = document.getElementById('searchHint');

/* ═══════════════════════════════════════════════════════════
   QUILL — Éditeur de notes enrichi
   Les notes sont stockées sous forme de HTML sémantique (getSemanticHTML).
════════════════════════════════════════════════════════════ */

const quill = new Quill('#quillEditor', {
  theme: 'snow',
  placeholder: 'Ajoutez vos notes ici...',
  modules: {
    toolbar: [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ color: [] }, { background: [] }],
      ['blockquote', 'code-block'],
      [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
      [{ indent: '-1' }, { indent: '+1' }],
      ['link', 'image'],
      ['clean'],
    ],
  },
});

let quillSaveTimer = null;
/** Id de la tâche dont on édite actuellement les notes dans Quill. */
let currentNoteTaskId = null;

/**
 * Auto-sauvegarde des notes : 300 ms après le dernier caractère saisi,
 * on met à jour task.notes avec le HTML de l'éditeur et on persiste.
 */
quill.on('text-change', () => {
  clearTimeout(quillSaveTimer);
  quillSaveTimer = setTimeout(() => {
    const task = findTaskById(rootTasks, currentNoteTaskId);
    if (task) { task.notes = quill.getSemanticHTML(); saveTasks(); }
  }, 300);
});

/**
 * Retourne true si l'éditeur Quill a actuellement le focus.
 * Utilisé pour protéger le focus du clavier sur mobile.
 */
function quillHasFocus() {
  return quill.hasFocus();
}

/**
 * Sur mobile, tout `pointerdown` en dehors de l'éditeur Quill
 * déclenche un blur involontaire (le navigateur transfère le focus).
 * On intercepte ces événements au niveau du document et on appelle
 * preventDefault() pour empêcher le transfert de focus, SAUF si
 * la cible est un élément interactif légitime (input, button, select,
 * lien, ou l'éditeur lui-même).
 */
document.addEventListener('pointerdown', (e) => {
  if (!quillHasFocus()) return;
  const target = e.target;
  if (target.closest('.ql-editor, .ql-toolbar')) return;
  if (target.closest('input, textarea, select, button, a, [contenteditable]')) return;
  e.preventDefault();
}, { passive: false });

/**
 * La toolbar Quill utilise `mousedown` pour ses boutons de formatage,
 * ce qui provoque un blur sur l'éditeur avant d'appliquer le format.
 * On annule ce comportement via preventDefault sur mousedown/touchstart
 * de la toolbar, ce qui permet à Quill de garder le focus et d'appliquer
 * correctement le formatage sur la sélection courante.
 */
document.addEventListener('DOMContentLoaded', () => {
  const toolbar = document.querySelector('.ql-toolbar');
  if (toolbar) {
    toolbar.addEventListener('mousedown',  (e) => e.preventDefault(), { passive: false });
    toolbar.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  }
});

/* ═══════════════════════════════════════════════════════════
   SIDEBAR — Affichage / repli / redimensionnement
════════════════════════════════════════════════════════════ */

/**
 * Applique l'état courant de la sidebar (repliée ou déployée)
 * en ajoutant/retirant la classe CSS "collapsed" et en restaurant
 * la largeur mémorisée.
 */
function applySidebarState() {
  if (sidebarCollapsed) {
    sidebar.classList.add('collapsed');
  } else {
    sidebar.classList.remove('collapsed');
    sidebar.style.width = (localStorage.getItem('sidebarWidth') || '260') + 'px';
  }
  localStorage.setItem('sidebarCollapsed', sidebarCollapsed);
}

// Bouton ☰ dans la topbar : bascule repli/déploiement
sidebarToggle.addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  applySidebarState();
});

// Bouton ✕ dans la sidebar : repli forcé
sidebarClose.addEventListener('click', () => {
  sidebarCollapsed = true;
  applySidebarState();
});

/* ── Redimensionnement par glisser la poignée (souris) ── */
let isResizing = false;

resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true;
  resizeHandle.classList.add('dragging');
  e.preventDefault(); // évite la sélection de texte pendant le drag
});

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return;
  // La position X de la souris détermine directement la largeur de la sidebar
  const newWidth = Math.min(520, Math.max(160, e.clientX));
  sidebar.style.width = newWidth + 'px';
  localStorage.setItem('sidebarWidth', newWidth);
});

document.addEventListener('mouseup', () => {
  if (!isResizing) return;
  isResizing = false;
  resizeHandle.classList.remove('dragging');
});

/* ── Redimensionnement par glisser la poignée (tactile) ── */
resizeHandle.addEventListener('touchstart', (e) => {
  isResizing = true;
  e.preventDefault();
}, { passive: false });

document.addEventListener('touchmove', (e) => {
  if (!isResizing) return;
  const newWidth = Math.min(520, Math.max(160, e.touches[0].clientX));
  sidebar.style.width = newWidth + 'px';
  localStorage.setItem('sidebarWidth', newWidth);
}, { passive: true });

document.addEventListener('touchend', () => { isResizing = false; });

/* ═══════════════════════════════════════════════════════════
   SIDEBAR TREE — Arborescence des tâches
   Structure HTML générée :
     div.tree-node
       div.tree-row          ← cliquable (navigation) + drop target
         span.tree-toggle    ← ▶ pour plier/déplier
         span.tree-label     ← texte de la tâche
       div.tree-children     ← sous-nœuds (masqués si "collapsed")
════════════════════════════════════════════════════════════ */

/**
 * Reconstruit entièrement l'arbre dans la sidebar.
 * Affiche d'abord un nœud "racine" fixe permettant de revenir
 * au niveau le plus haut et de servir de cible de drop vers la racine.
 */
function renderTree() {
  sidebarTree.innerHTML = '';

  // ── Nœud racine fixe ──────────────────────────────────────
  // Ce nœud spécial représente la liste de premier niveau.
  // Cliquer dessus revient à la vue liste principale.
  // Il accepte aussi les drops pour déplacer une tâche vers la racine.
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row tree-root-node' + (activeTreeTaskId === null ? ' active' : '');
  rootRow.title = 'Revenir à la liste principale';

  const rootIcon = document.createElement('span');
  rootIcon.className = 'tree-toggle leaf'; // pas de ▶ sur la racine
  rootIcon.textContent = '▶';

  const rootLabel = document.createElement('span');
  rootLabel.className = 'tree-label';
  rootLabel.textContent = '🏠 Tâches (racine)';

  rootRow.appendChild(rootIcon);
  rootRow.appendChild(rootLabel);
  sidebarTree.appendChild(rootRow);

  // Clic sur la racine → retour à la vue liste principale
  rootRow.addEventListener('click', () => {
    closeSearch();
    navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
    activeTreeTaskId = null;
    renderTree();
    showList();
    if (window.innerWidth <= 640) { sidebarCollapsed = true; applySidebarState(); }
  });

  // Drop sur la racine → déplace la tâche au niveau racine (en tête)
  attachRootDropHandlers(rootRow);

  // ── Nœuds des tâches de l'arborescence ───────────────────
  buildTreeNodes(rootTasks, sidebarTree, 0);
}

/**
 * Construit récursivement les nœuds DOM pour un tableau de tâches.
 * @param {Task[]} tasks      - Tableau de tâches à afficher
 * @param {HTMLElement} container - Élément parent dans lequel insérer les nœuds
 * @param {number} depth      - Profondeur dans l'arbre (indentation visuelle)
 */
function buildTreeNodes(tasks, container, depth) {
  tasks.forEach(task => {
    const node = document.createElement('div');
    node.className = 'tree-node';

    // Ligne cliquable représentant la tâche
    const row = document.createElement('div');
    row.className = 'tree-row' + (task.id === activeTreeTaskId ? ' active' : '');
    row.style.paddingLeft = (14 + depth * 16) + 'px'; // indentation proportionnelle à la profondeur

    // Triangle ▶ de pliage/dépliage ; invisible ("leaf") si pas de sous-tâches
    const toggle = document.createElement('span');
    toggle.className = 'tree-toggle' +
      (task.children.length === 0 ? ' leaf' : (treeCollapsed[task.id] ? '' : ' open'));
    toggle.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = task.text;
    label.title = task.text; // tooltip pour les titres longs

    row.appendChild(toggle);
    row.appendChild(label);

    // Conteneur des enfants, masqué si le nœud est replié
    const childContainer = document.createElement('div');
    childContainer.className = 'tree-children' + (treeCollapsed[task.id] ? ' collapsed' : '');

    // Clic sur le ▶ : bascule repli/déploiement sans naviguer
    toggle.addEventListener('click', (e) => {
      e.stopPropagation(); // ne pas déclencher la navigation du row
      if (task.children.length === 0) return;
      treeCollapsed[task.id] = !treeCollapsed[task.id];
      localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
      toggle.className = 'tree-toggle' + (treeCollapsed[task.id] ? '' : ' open');
      childContainer.classList.toggle('collapsed', !!treeCollapsed[task.id]);
    });

    // Clic sur la ligne : navigation (ignoré si on vient de finir un drag)
    row.addEventListener('click', () => {
      if (treeDragTaskId !== null) return; // évite la navigation accidentelle après un drag
      navigateToTask(task);
    });

    // ── Drag source : rendre le nœud draggable ────────────────
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      treeDragTaskId = task.id;
      row.classList.add('tree-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('treeDragTaskId', String(task.id));
      e.stopPropagation(); // ne pas interférer avec d'autres dragstart
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('tree-dragging');
      clearTreeDropHighlight();
      clearExpandTimer();
      // Petit délai avant de réactiver la navigation au clic (évite le clic post-drag)
      setTimeout(() => { treeDragTaskId = null; }, 50);
    });

    // Rendre la ligne receptrice de drops (liste centrale + arbre + vue détail)
    attachTreeDropHandlers(row, task, childContainer);

    node.appendChild(row);
    node.appendChild(childContainer);
    container.appendChild(node);

    // Récursion sur les enfants
    if (task.children.length > 0) {
      buildTreeNodes(task.children, childContainer, depth + 1);
    }
  });
}

/**
 * Navigue vers une tâche depuis l'arbre de la sidebar.
 * Reconstruit la navigationStack en cherchant le chemin depuis la racine,
 * puis affiche la vue détail de la tâche cible.
 * @param {Task} target - Tâche vers laquelle naviguer
 */
function navigateToTask(target) {
  const path = findPath(rootTasks, target.id);
  if (!path) return;

  closeSearch();

  // Reconstruction de la pile : racine + un niveau par ancêtre jusqu'à la cible
  navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
  for (const t of path) {
    navigationStack.push({ tasks: t.children, title: t.text, taskId: t.id });
  }

  activeTreeTaskId = target.id;
  renderTree();
  showDetail(path[path.length - 1]);

  // Sur mobile : referme la sidebar après la navigation
  if (window.innerWidth <= 640) { sidebarCollapsed = true; applySidebarState(); }
}

/**
 * Retourne le chemin depuis la racine jusqu'à la tâche dont l'id est donné,
 * sous forme de tableau de tâches [ancêtre1, ancêtre2, ..., cible].
 * Retourne null si non trouvé.
 */
function findPath(list, id, path = []) {
  for (const t of list) {
    const cur = [...path, t];
    if (t.id === id) return cur;
    const found = findPath(t.children, id, cur);
    if (found) return found;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   VIEW SWITCHING — Bascule entre les 3 vues principales
════════════════════════════════════════════════════════════ */

/** Affiche la vue liste (tâches de premier niveau). */
function showList() {
  listView.classList.remove('hidden');
  detailView.classList.add('hidden');
  searchView.classList.add('hidden');
  activeTreeTaskId = null;
  renderTree();
  renderList(taskListEl, rootTasks);
}

/**
 * Affiche la vue détail d'une tâche :
 * - charge le titre (éditable au clic)
 * - charge les notes dans Quill
 * - affiche le fil d'Ariane
 * - affiche la liste des sous-tâches
 * @param {Task} task
 */
function showDetail(task) {
  listView.classList.add('hidden');
  detailView.classList.remove('hidden');
  searchView.classList.add('hidden');

  detailTitle.textContent = task.text;
  detailTitle.title = 'Cliquer pour modifier le titre';

  // Charge les notes dans Quill (en mode silencieux pour ne pas déclencher l'auto-save)
  currentNoteTaskId = task.id;
  const delta = quill.clipboard.convert({ html: task.notes || '' });
  quill.setContents(delta, 'silent');

  renderBreadcrumb();
  renderList(subTaskListEl, task.children);

  // Clic sur le <h2> → édition inline du titre
  detailTitle.onclick = null;
  detailTitle.onclick = () => startEditTitle(task);
}

/**
 * Rend la vue détail draggable pour permettre de glisser la tâche courante
 * vers un nœud de l'arbre dans la sidebar.
 * Le dragstart est déclenché par un glisser depuis n'importe quel endroit
 * de la vue détail (hors éditeur Quill et champs de saisie).
 */
function setupDetailDrag() {
  detailView.draggable = true;

  // Sur mobile, désactiver le draggable quand Quill a le focus
  // pour éviter que le touch déclenche un drag et vole le focus.
  const qlEditor = detailView.querySelector('#quillEditor');
  if (qlEditor) {
    qlEditor.addEventListener('focusin',  () => { detailView.draggable = false; });
    qlEditor.addEventListener('focusout', () => { detailView.draggable = true;  });
  }

  detailView.addEventListener('dragstart', (e) => {
    // Ne pas interférer avec les éléments interactifs internes
    if (e.target.closest('.ql-editor, input, textarea, button, .task-item')) {
      e.preventDefault();
      return;
    }
    if (!currentNoteTaskId) return;
    e.dataTransfer.setData('detailDragTaskId', String(currentNoteTaskId));
    e.dataTransfer.effectAllowed = 'move';
    detailView.classList.add('detail-dragging');
  });

  detailView.addEventListener('dragend', () => {
    detailView.classList.remove('detail-dragging');
    clearTreeDropHighlight();
    clearExpandTimer();
  });
}

/** Affiche la vue résultats de recherche. */
function showSearch() {
  listView.classList.add('hidden');
  detailView.classList.add('hidden');
  searchView.classList.remove('hidden');
}

/**
 * Ferme la vue recherche et restaure la vue précédente
 * (liste si on était à la racine, détail sinon).
 */
function closeSearch() {
  searchInput.value = '';
  searchView.classList.add('hidden');
  if (navigationStack.length === 1) {
    listView.classList.remove('hidden');
  } else {
    detailView.classList.remove('hidden');
  }
}

/* ═══════════════════════════════════════════════════════════
   BREADCRUMB — Fil d'Ariane cliquable
   Reflète la navigationStack. Chaque élément (sauf le dernier)
   est cliquable pour remonter directement à ce niveau.
════════════════════════════════════════════════════════════ */

function renderBreadcrumb() {
  breadcrumb.innerHTML = '';
  navigationStack.forEach((entry, i) => {
    const isLast = i === navigationStack.length - 1;

    // Séparateur › entre les niveaux
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '›';
      breadcrumb.appendChild(sep);
    }

    const span = document.createElement('span');
    span.textContent = entry.title;

    if (isLast) {
      // Niveau courant : non cliquable, mis en valeur
      span.className = 'current';
    } else {
      // Niveau ancêtre : clic → remonte à ce niveau
      span.addEventListener('click', () => {
        navigationStack = navigationStack.slice(0, i + 1);
        if (i === 0) { showList(); return; }
        const task = findTaskById(rootTasks, navigationStack[i].taskId);
        if (task) { activeTreeTaskId = task.id; renderTree(); showDetail(task); }
        else showList();
      });
    }
    breadcrumb.appendChild(span);
  });
}

/* ═══════════════════════════════════════════════════════════
   CONTEXT MENU — Menu clic droit sur une tâche
   Permet de déplacer rapidement une tâche dans sa liste
   sans avoir à cliquer plusieurs fois.
════════════════════════════════════════════════════════════ */

// Création du menu contextuel (élément unique partagé par toutes les tâches)
const ctxMenu = document.createElement('ul');
ctxMenu.id = 'ctxMenu';
ctxMenu.className = 'ctx-menu hidden';
document.body.appendChild(ctxMenu);

/**
 * Affiche le menu contextuel au niveau du clic droit.
 * @param {MouseEvent} e   - Événement contextmenu
 * @param {Task}  task     - Tâche sur laquelle on a cliqué
 * @param {Task[]} tasks   - Tableau contenant cette tâche
 * @param {HTMLElement} listEl - <ul> qui affiche ce tableau
 */
function showContextMenu(e, task, tasks, listEl) {
  e.preventDefault();
  e.stopPropagation();
  ctxMenu.innerHTML = '';

  // delta < 0 = remonter, delta > 0 = descendre, -Infinity = tout en haut
  const items = [
    { label: '⬆ Tout en haut',  delta: -Infinity },
    { label: '▲ +5 positions',   delta: -5  },
    { label: '▲ +10 positions',  delta: -10 },
    { label: '▲ +20 positions',  delta: -20 },
    { label: '▼ -5 positions',   delta: +5  },
    { label: '▼ -10 positions',  delta: +10 },
    { label: '▼ -20 positions',  delta: +20 },
  ];

  items.forEach(({ label, delta }) => {
    const li = document.createElement('li');
    li.className = 'ctx-item';
    li.textContent = label;
    li.addEventListener('click', () => {
      hideContextMenu();
      const idx = tasks.findIndex(t => t.id === task.id);
      if (idx === -1) return;
      // Calcul du nouvel index en clampant dans [0, length-1]
      const newIdx = delta === -Infinity
        ? 0
        : Math.max(0, Math.min(tasks.length - 1, idx + delta));
      if (newIdx === idx) return;
      const [moved] = tasks.splice(idx, 1);
      tasks.splice(newIdx, 0, moved);
      saveTasks();
      renderList(listEl, tasks);
      renderTree();
      animateClickBadge(listEl, newIdx);
    });
    ctxMenu.appendChild(li);
  });

  ctxMenu.classList.remove('hidden');

  // Positionnement : on évite que le menu dépasse du viewport
  const x = Math.min(e.clientX, window.innerWidth  - ctxMenu.offsetWidth  - 8);
  const y = Math.min(e.clientY, window.innerHeight - ctxMenu.offsetHeight - 8);
  ctxMenu.style.left = x + 'px';
  ctxMenu.style.top  = y + 'px';
}

function hideContextMenu() {
  ctxMenu.classList.add('hidden');
}

// Fermeture automatique du menu contextuel
document.addEventListener('click',   hideContextMenu);
document.addEventListener('scroll',  hideContextMenu, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

/* ═══════════════════════════════════════════════════════════
   TASK LIST RENDER — Rendu des listes de tâches
════════════════════════════════════════════════════════════ */

/** Index de la tâche en cours de drag dans sa liste source. */
let dragSrcIndex = null;
/** Référence au tableau source lors d'un drag (pour valider le drop). */
let dragListRef  = null;

/**
 * Vide et reconstruit un <ul> à partir d'un tableau de tâches.
 * @param {HTMLElement} listEl       - L'élément <ul> à remplir
 * @param {Task[]}      tasks        - Les tâches à afficher
 * @param {boolean}  searchResultMode - Si true : pas de drag, affiche le chemin
 */
function renderList(listEl, tasks, searchResultMode = false) {
  listEl.innerHTML = '';
  tasks.forEach((task, index) => {
    listEl.appendChild(buildTaskItem(task, index, tasks, listEl, searchResultMode));
  });
}

/**
 * Construit le <li> DOM complet pour une tâche.
 * Attache tous les événements : clic priorité, pointer, drag, drop, contextmenu.
 *
 * @param {Task}      task            - La tâche à représenter
 * @param {number}    index           - Sa position dans le tableau tasks
 * @param {Task[]}    tasks           - Le tableau contenant cette tâche
 * @param {HTMLElement} listEl        - Le <ul> parent
 * @param {boolean}   searchResultMode - Mode résultat de recherche
 */
function buildTaskItem(task, index, tasks, listEl, searchResultMode) {
  const li = document.createElement('li');
  li.className = 'task-item';
  li.draggable = !searchResultMode; // drag désactivé en mode recherche
  li.dataset.index = index;

  // ── Rang #N ────────────────────────────────────────────
  const rank = document.createElement('span');
  rank.className = 'task-rank';
  rank.textContent = `#${index + 1}`;

  // ── Zone texte (titre + compteur sous-tâches + chemin en mode recherche) ──
  const textWrap = document.createElement('span');
  textWrap.className = 'task-text';
  textWrap.draggable = false; // empêche le conflit avec le drag du li parent

  const textSpan = document.createElement('span');
  textSpan.textContent = task.text;
  textWrap.appendChild(textSpan);

  // Nombre de sous-tâches entre parenthèses
  if (task.children.length > 0) {
    const sub = document.createElement('span');
    sub.className = 'task-subtask-count';
    sub.textContent = ` (${task.children.length})`;
    textWrap.appendChild(sub);
  }

  // En mode recherche : affiche le chemin d'appartenance (ex: "Projet › Sprint")
  if (searchResultMode && task._path) {
    const pathSpan = document.createElement('span');
    pathSpan.className = 'task-path';
    pathSpan.textContent = task._path;
    textWrap.appendChild(pathSpan);
  }

  // ── Icône 📋 (ouvre le détail de la tâche) ────────────
  const hasContent = task.notes || task.children.length > 0;
  const noteIcon = document.createElement('span');
  noteIcon.className = 'task-detail-btn' + (hasContent ? ' has-content' : '');
  noteIcon.title = 'Voir le détail / notes';
  noteIcon.textContent = '📋';

  // ── Badge de clics (compteur de priorité) ─────────────
  const clicks = document.createElement('span');
  clicks.className = 'task-clicks';
  clicks.title = 'Cliquer pour remonter la tâche';
  clicks.textContent = task.clicks;
  clicks.draggable = false;

  // ── Bouton supprimer ──────────────────────────────────
  const del = document.createElement('button');
  del.className = 'task-delete';
  del.textContent = '✕';
  del.title = 'Supprimer';

  li.appendChild(rank);
  li.appendChild(textWrap);
  li.appendChild(noteIcon);
  li.appendChild(clicks);
  li.appendChild(del);

  // ── Gestion du clic de priorité ───────────────────────
  // On utilise pointerdown/pointermove/pointerup plutôt que "click"
  // car sur un élément draggable, l'événement "click" peut être annulé
  // par le navigateur si le pointeur a légèrement bougé (détection de drag).
  // La variable `pointerMoved` permet de distinguer un vrai clic d'un glisser.
  const getList = () => tasks; // closure : accès au tableau live au moment du flush

  let pointerMoved = false;
  textWrap.addEventListener('pointerdown', () => { pointerMoved = false; });
  textWrap.addEventListener('pointermove', () => { pointerMoved = true; });
  textWrap.addEventListener('pointerup', (e) => {
    if (!pointerMoved && e.button === 0) handleClick(task.id, getList, listEl);
  });

  let clickPointerMoved = false;
  clicks.addEventListener('pointerdown', (e) => { e.stopPropagation(); clickPointerMoved = false; });
  clicks.addEventListener('pointermove', () => { clickPointerMoved = true; });
  clicks.addEventListener('pointerup', (e) => {
    e.stopPropagation();
    if (!clickPointerMoved && e.button === 0) handleClick(task.id, getList, listEl);
  });

  // Menu contextuel (clic droit) — désactivé en mode recherche
  if (!searchResultMode) {
    li.addEventListener('contextmenu', (e) => showContextMenu(e, task, tasks, listEl));
  }

  // Icône 📋 : navigue vers le détail (ou vers la tâche dans l'arbre si mode recherche)
  noteIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    if (searchResultMode) navigateToTask(task);
    else openDetail(task);
  });

  // Suppression : retire la tâche du tableau, re-render
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    const liveIdx = tasks.findIndex(t => t.id === task.id);
    if (liveIdx !== -1) tasks.splice(liveIdx, 1);
    saveTasks();
    if (searchResultMode) runSearch();
    else { renderList(listEl, tasks); renderTree(); }
  });

  // ── Drag & Drop intra-liste ───────────────────────────
  // Permet de réordonner les tâches dans la même liste par glisser-déposer.
  if (!searchResultMode) {
    li.addEventListener('dragstart', function(e) {
      dragSrcIndex = index;
      dragListRef  = tasks;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      // On stocke l'id dans dataTransfer pour le récupérer dans les drop handlers de l'arbre
      e.dataTransfer.setData('taskId', String(task.id));
    });

    li.addEventListener('dragover', function(e) {
      e.preventDefault();
      // Retire le highlight de tous les items et le remet sur celui survolé
      listEl.querySelectorAll('.task-item').forEach(el => el.classList.remove('drag-over'));
      this.classList.add('drag-over');
    });

    li.addEventListener('drop', function(e) {
      e.preventDefault();
      const dest = parseInt(this.dataset.index);
      // On ignore si même index, même origine, ou liste différente
      if (dragSrcIndex === null || dragSrcIndex === dest || dragListRef !== tasks) return;
      const [moved] = tasks.splice(dragSrcIndex, 1);
      tasks.splice(dest, 0, moved);
      saveTasks();
      renderList(listEl, tasks);
      renderTree();
    });

    li.addEventListener('dragend', function() {
      listEl.querySelectorAll('.task-item').forEach(el => el.classList.remove('dragging', 'drag-over'));
      clearTreeDropHighlight();
      dragSrcIndex = null;
      dragListRef  = null;
    });
  }

  return li;
}

/* ═══════════════════════════════════════════════════════════
   TREE DROP — Déplacer une tâche vers un nœud de l'arbre
   Permet de changer l'affectation d'une tâche dans l'arborescence
   par glisser-déposer depuis la liste centrale vers la sidebar.
════════════════════════════════════════════════════════════ */

/** Retire la mise en surbrillance de drop sur tous les nœuds de l'arbre. */
function clearTreeDropHighlight() {
  sidebarTree.querySelectorAll('.tree-row').forEach(r => r.classList.remove('drop-target'));
}

/** Annule le timer d'expansion automatique d'un nœud replié. */
function clearExpandTimer() {
  if (expandTimer) { clearTimeout(expandTimer); expandTimer = null; }
}

/**
 * Vérifie si ancestorId est un ancêtre (ou lui-même) de taskId dans l'arbre.
 * Utilisé pour interdire le drop d'une tâche sur l'un de ses propres descendants.
 */
function isAncestorOrSelf(taskId, ancestorId, list) {
  for (const t of list) {
    if (t.id === ancestorId) return findTaskById([t], taskId) !== null;
    if (isAncestorOrSelf(taskId, ancestorId, t.children)) return true;
  }
  return false;
}

/**
 * Résout l'id de la tâche source depuis un événement drag.
 * Gère trois sources possibles :
 *   1. Drag depuis l'arbre         → dataTransfer "treeDragTaskId"
 *   2. Drag depuis la liste centrale→ dragListRef[dragSrcIndex]
 *   3. Drag depuis la vue détail   → dataTransfer "detailDragTaskId"
 * Retourne { srcId, srcTask, srcList } ou null si invalide.
 */
function resolveDragSource(e) {
  // Source : arbre
  const treeId = parseInt(e.dataTransfer.getData('treeDragTaskId'));
  if (treeId) {
    const srcTask = findTaskById(rootTasks, treeId);
    const srcList = findParentList(rootTasks, treeId);
    return srcTask && srcList ? { srcId: treeId, srcTask, srcList } : null;
  }
  // Source : vue détail (la tâche couramment affichée)
  const detailId = parseInt(e.dataTransfer.getData('detailDragTaskId'));
  if (detailId) {
    const srcTask = findTaskById(rootTasks, detailId);
    const srcList = findParentList(rootTasks, detailId);
    return srcTask && srcList ? { srcId: detailId, srcTask, srcList } : null;
  }
  // Source : liste centrale
  if (dragListRef !== null && dragSrcIndex !== null) {
    const srcTask = dragListRef[dragSrcIndex];
    return srcTask ? { srcId: srcTask.id, srcTask, srcList: dragListRef } : null;
  }
  return null;
}

/**
 * Trouve le tableau parent qui contient directement la tâche dont l'id est donné.
 * Retourne null si non trouvé (par exemple si la tâche est à la racine,
 * retourne rootTasks).
 */
function findParentList(list, id) {
  for (const t of list) {
    if (t.id === id) return list;
    const found = findParentList(t.children, id);
    if (found) return found;
  }
  return null;
}

/**
 * Effectue le déplacement effectif d'une tâche vers une liste cible.
 * Retire la tâche de sa liste source, l'insère en tête de la liste cible.
 * Rafraîchit la vue courante et l'arbre.
 *
 * @param {object} src        - { srcTask, srcList } issu de resolveDragSource
 * @param {Task[]} targetList - Tableau dans lequel insérer la tâche
 * @param {number|null} targetTaskId - Id du nœud cible (pour l'expansion), null si racine
 */
function performTreeDrop(src, targetList, targetTaskId) {
  // Interdit de dropper dans ses propres enfants
  if (targetTaskId && isAncestorOrSelf(targetTaskId, src.srcId, rootTasks)) return;
  // Interdit de dropper dans son propre tableau (sans changement de niveau)
  if (src.srcList === targetList) return;

  // Retire de la source
  const idx = src.srcList.indexOf(src.srcTask);
  if (idx === -1) return;
  src.srcList.splice(idx, 1);

  // Insère en tête de la cible (priorité maximale dans ce niveau)
  targetList.unshift(src.srcTask);

  // Déploie le nœud cible si replié
  if (targetTaskId) {
    treeCollapsed[targetTaskId] = false;
    localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
  }

  saveTasks();
  dragSrcIndex = null;
  dragListRef  = null;

  // Si la vue détail affichait la tâche déplacée ou l'une de ses parentes,
  // on revient à la liste racine pour éviter un état incohérent
  const movedIsCurrentOrAncestor = navigationStack.some(e => e.taskId === src.srcId);
  if (movedIsCurrentOrAncestor) {
    navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
    activeTreeTaskId = null;
    renderTree();
    showList();
  } else {
    const currentEntry  = navigationStack[navigationStack.length - 1];
    const currentListEl = navigationStack.length === 1 ? taskListEl : subTaskListEl;
    renderList(currentListEl, currentEntry.tasks);
    renderTree();
  }
}

/**
 * Attache les événements dragover/dragleave/drop sur un nœud de l'arbre.
 * Gère :
 *   - le highlight de drop
 *   - le timer d'expansion automatique (EXPAND_DELAY ms de survol)
 *   - l'exécution du déplacement au drop
 *
 * @param {HTMLElement} row           - L'élément .tree-row cible
 * @param {Task}        targetTask    - La tâche représentée par ce nœud
 * @param {HTMLElement} childContainer- Le .tree-children de ce nœud (pour l'expansion)
 */
function attachTreeDropHandlers(row, targetTask, childContainer) {
  row.addEventListener('dragover', (e) => {
    const src = resolveDragSource(e);
    if (!src) return;
    if (isAncestorOrSelf(targetTask.id, src.srcId, rootTasks)) return;
    if (src.srcList === targetTask.children) return; // déjà enfant direct
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearTreeDropHighlight();
    row.classList.add('drop-target');

    // Lance le timer d'expansion si le nœud est replié et a des enfants
    if (treeCollapsed[targetTask.id] && targetTask.children.length > 0) {
      if (!expandTimer) {
        expandTimer = setTimeout(() => {
          treeCollapsed[targetTask.id] = false;
          localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
          if (childContainer) childContainer.classList.remove('collapsed');
          // Met à jour le toggle visuellement
          const toggle = row.querySelector('.tree-toggle');
          if (toggle) toggle.className = 'tree-toggle open';
          expandTimer = null;
        }, EXPAND_DELAY);
      }
    } else {
      clearExpandTimer();
    }
  });

  row.addEventListener('dragleave', (e) => {
    // Ne nettoie que si on quitte vraiment la row (pas vers un enfant)
    if (!row.contains(e.relatedTarget)) {
      row.classList.remove('drop-target');
      clearExpandTimer();
    }
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearExpandTimer();
    clearTreeDropHighlight();
    const src = resolveDragSource(e);
    if (!src) return;
    performTreeDrop(src, targetTask.children, targetTask.id);
  });
}

/**
 * Attache les événements drop sur le nœud racine de la sidebar.
 * Déplace une tâche au niveau racine (rootTasks), en tête.
 * @param {HTMLElement} rootRow - L'élément .tree-row racine
 */
function attachRootDropHandlers(rootRow) {
  rootRow.addEventListener('dragover', (e) => {
    const src = resolveDragSource(e);
    if (!src) return;
    if (src.srcList === rootTasks) return; // déjà à la racine
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearTreeDropHighlight();
    rootRow.classList.add('drop-target');
    clearExpandTimer();
  });

  rootRow.addEventListener('dragleave', (e) => {
    if (!rootRow.contains(e.relatedTarget)) {
      rootRow.classList.remove('drop-target');
    }
  });

  rootRow.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearExpandTimer();
    clearTreeDropHighlight();
    const src = resolveDragSource(e);
    if (!src || src.srcList === rootTasks) return;
    performTreeDrop(src, rootTasks, null);
  });
}

/* ═══════════════════════════════════════════════════════════
   TITLE EDIT — Édition inline du titre dans la vue détail
   Un clic sur le <h2> remplace son contenu par un <input>
   validé par Entrée, blur ou annulé par Échap.
════════════════════════════════════════════════════════════ */

function startEditTitle(task) {
  if (detailTitle.querySelector('input')) return; // déjà en édition

  const currentText = task.text;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentText;
  input.className = 'title-edit-input';
  detailTitle.textContent = '';
  detailTitle.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const newText = input.value.trim() || currentText;
    task.text = newText;
    // Met à jour l'entrée correspondante dans la pile de navigation
    const entry = navigationStack[navigationStack.length - 1];
    entry.title = newText;
    saveTasks();
    detailTitle.textContent = newText;
    detailTitle.onclick = () => startEditTitle(task);
    renderBreadcrumb();
    renderTree();
    // Rafraîchit la liste parente pour mettre à jour le texte visible
    const parentListEl = navigationStack.length === 1 ? taskListEl : subTaskListEl;
    const parentTasks  = navigationStack.length > 1
      ? navigationStack[navigationStack.length - 2].tasks : rootTasks;
    renderList(parentListEl, parentTasks);
  }

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentText; input.blur(); }
  });
}

/* ═══════════════════════════════════════════════════════════
   NAVIGATION — Ouverture du détail et bouton Retour
════════════════════════════════════════════════════════════ */

/**
 * Ouvre la vue détail d'une tâche en poussant un niveau dans la pile.
 * Flush d'abord tout clic en attente pour éviter des déplacements parasites.
 */
function openDetail(task) {
  if (clickAccum.timer) { clearTimeout(clickAccum.timer); doFlush(); }
  navigationStack.push({ tasks: task.children, title: task.text, taskId: task.id });
  activeTreeTaskId = task.id;
  renderTree();
  showDetail(task);
}

// Bouton ← Retour : dépile un niveau et revient à la vue précédente
backBtn.addEventListener('click', () => {
  if (clickAccum.timer) { clearTimeout(clickAccum.timer); doFlush(); }
  navigationStack.pop();
  if (navigationStack.length === 1) {
    activeTreeTaskId = null;
    renderTree();
    showList();
  } else {
    const entry = navigationStack[navigationStack.length - 1];
    const task  = findTaskById(rootTasks, entry.taskId);
    activeTreeTaskId = entry.taskId;
    renderTree();
    if (task) showDetail(task); else showList();
  }
});

/**
 * Supprime la tâche couramment affichée dans la vue détail.
 * La tâche est retirée de la liste parente, puis on remonte d'un niveau.
 */
deleteTaskBtn.addEventListener('click', () => {
  if (clickAccum.timer) { clearTimeout(clickAccum.timer); doFlush(); }

  const currentEntry = navigationStack[navigationStack.length - 1];
  const taskId = currentEntry.taskId;
  if (!taskId) return; // on est à la racine, rien à supprimer

  // Demande de confirmation pour éviter les suppressions accidentelles
  const task = findTaskById(rootTasks, taskId);
  if (!confirm(`Supprimer « ${task ? task.text : 'cette tâche'} » et toutes ses sous-tâches ?`)) return;

  // Trouve la liste parente et retire la tâche
  const parentList = findParentList(rootTasks, taskId);
  if (parentList) {
    const idx = parentList.findIndex(t => t.id === taskId);
    if (idx !== -1) parentList.splice(idx, 1);
  }
  saveTasks();

  // Remonte d'un niveau dans la navigation
  navigationStack.pop();
  if (navigationStack.length === 1) {
    activeTreeTaskId = null;
    renderTree();
    showList();
  } else {
    const parentEntry = navigationStack[navigationStack.length - 1];
    const parentTask  = findTaskById(rootTasks, parentEntry.taskId);
    activeTreeTaskId  = parentEntry.taskId;
    renderTree();
    if (parentTask) showDetail(parentTask); else showList();
  }
});

/* ═══════════════════════════════════════════════════════════
   CLICK PRIORITISATION — Accumulation de clics avec rémanence
   Principe :
     1. Chaque clic incrémente le compteur de la tâche (badge live)
     2. On attend CLICK_DELAY ms après le dernier clic
     3. Au flush : on remonte la tâche du nombre de clics accumulés
   La variable clickAccum garde l'état de l'accumulation en cours.
════════════════════════════════════════════════════════════ */

let clickAccum = { taskId: null, count: 0, timer: null, getList: null, listEl: null };

/**
 * Appelé à chaque clic sur une tâche.
 * Accumule les clics successifs sur la même tâche, flush si on change de tâche.
 *
 * @param {number}    taskId  - Id de la tâche cliquée
 * @param {Function}  getList - Closure retournant le tableau live contenant la tâche
 * @param {HTMLElement} listEl - Le <ul> à re-rendre après le flush
 */
function handleClick(taskId, getList, listEl) {
  if (clickAccum.taskId !== taskId) {
    // On clique sur une tâche différente : flush l'accumulation précédente
    if (clickAccum.timer) { clearTimeout(clickAccum.timer); doFlush(); }
    clickAccum = { taskId, count: 0, timer: null, getList, listEl };
  }
  clickAccum.count += 1;

  // Mise à jour immédiate du badge (retour visuel instantané)
  const tasks   = getList();
  const liveIdx = tasks.findIndex(t => t.id === taskId);
  if (liveIdx !== -1) {
    tasks[liveIdx].clicks += 1;
    saveTasks();
    refreshClickBadge(listEl, liveIdx, tasks[liveIdx].clicks);
  }

  // (Re)démarre le timer : le déplacement n'aura lieu que si aucun clic
  // supplémentaire ne survient dans les CLICK_DELAY ms suivants
  clearTimeout(clickAccum.timer);
  clickAccum.timer = setTimeout(doFlush, CLICK_DELAY);
}

/**
 * Applique le déplacement accumulé : remonte la tâche de `count` positions.
 * Appelé automatiquement après CLICK_DELAY ms, ou manuellement avant
 * une navigation (pour ne pas laisser de déplacement en suspens).
 */
function doFlush() {
  if (!clickAccum.taskId || clickAccum.count === 0) {
    clickAccum = { taskId: null, count: 0, timer: null, getList: null, listEl: null };
    return;
  }
  const { taskId, count, getList, listEl } = clickAccum;
  clickAccum = { taskId: null, count: 0, timer: null, getList: null, listEl: null };

  const tasks = getList(); // tableau live au moment du flush
  const cur   = tasks.findIndex(t => t.id === taskId);

  if (cur > 0) {
    // Déplace la tâche vers le haut de count positions (minimum position 0)
    const newIdx = Math.max(0, cur - count);
    const [moved] = tasks.splice(cur, 1);
    tasks.splice(newIdx, 0, moved);
    saveTasks();
    renderList(listEl, tasks);
    animateClickBadge(listEl, newIdx);
    renderTree();
  } else {
    // Déjà en tête : re-render quand même pour synchroniser l'affichage
    renderList(listEl, tasks);
  }
}

/** Met à jour le texte et l'animation du badge de clics pour un item donné. */
function refreshClickBadge(listEl, index, value) {
  const badges = listEl.querySelectorAll('.task-clicks');
  if (badges[index]) {
    badges[index].textContent = value;
    badges[index].classList.remove('pulse');
    void badges[index].offsetWidth; // force le reflow pour relancer l'animation CSS
    badges[index].classList.add('pulse');
  }
}

/** Déclenche uniquement l'animation pulse sur le badge (après un flush). */
function animateClickBadge(listEl, index) {
  const badges = listEl.querySelectorAll('.task-clicks');
  if (badges[index]) {
    badges[index].classList.remove('pulse');
    void badges[index].offsetWidth;
    badges[index].classList.add('pulse');
  }
}

/* ═══════════════════════════════════════════════════════════
   ADD TASKS — Création de nouvelles tâches
════════════════════════════════════════════════════════════ */

/**
 * Crée un objet tâche vide avec un id unique basé sur le timestamp.
 * @param {string} text - Titre de la tâche
 */
function makeTask(text) {
  return { id: Date.now(), text: text.trim(), clicks: 0, notes: '', children: [] };
}

// Ajout d'une tâche racine via le bouton ou la touche Entrée
addBtn.addEventListener('click', () => {
  const val = taskInput.value;
  if (!val.trim()) return;
  rootTasks.unshift(makeTask(val)); // unshift → la nouvelle tâche est en première position
  saveTasks();
  taskInput.value = '';
  taskInput.focus();
  renderList(taskListEl, rootTasks);
  renderTree();
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !taskInput.value.trim()) return;
  rootTasks.unshift(makeTask(taskInput.value));
  saveTasks();
  taskInput.value = '';
  renderList(taskListEl, rootTasks);
  renderTree();
});

/** Ajoute une sous-tâche dans le niveau courant de la navigationStack. */
function addSubTask() {
  const val = subTaskInput.value;
  if (!val.trim()) return;
  const entry = navigationStack[navigationStack.length - 1];
  entry.tasks.unshift(makeTask(val)); // unshift → priorité maximale dans ce niveau
  saveTasks();
  subTaskInput.value = '';
  subTaskInput.focus();
  renderList(subTaskListEl, entry.tasks);
  renderTree();
}

addSubBtn.addEventListener('click', addSubTask);
subTaskInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') addSubTask(); });

/* ═══════════════════════════════════════════════════════════
   SEARCH — Moteur de recherche global
   Options :
     - Niveau courant (défaut) ou tous les niveaux
     - Titre uniquement (défaut) ou titre + notes
   Résultats : liste de tâches avec le même rendu que la liste normale,
   mais en mode "searchResultMode" (pas de drag, affichage du chemin).
════════════════════════════════════════════════════════════ */

let searchTimer = null;

// Déclenchement de la recherche 200 ms après la dernière frappe
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (!q) { closeSearch(); return; }
  searchTimer = setTimeout(runSearch, 200);
});

searchAllLevels.addEventListener('change', runSearch);
searchInNotes.addEventListener('change',   runSearch);
searchClose.addEventListener('click',      closeSearch);

/** Lance la recherche et affiche les résultats. */
function runSearch() {
  const q = searchInput.value.trim();
  if (!q) { closeSearch(); return; }

  const allLevels = searchAllLevels.checked;
  const inNotes   = searchInNotes.checked;
  const needle    = q.toLowerCase();

  let results;
  if (allLevels) {
    // Parcours récursif de toute l'arborescence
    results = searchAll(rootTasks, needle, inNotes, '');
  } else {
    // Parcours du seul niveau courant de la navigationStack
    const currentList = navigationStack[navigationStack.length - 1].tasks;
    const prefix = navigationStack.length > 1
      ? navigationStack.slice(1).map(e => e.title).join(' › ')
      : '';
    results = searchLevel(currentList, needle, inNotes, prefix);
  }

  showSearch();

  const scope = allLevels ? 'tous les niveaux' : 'niveau courant';
  const extra = inNotes ? ' + notes' : '';
  searchHint.textContent = `${results.length} résultat(s) — recherche sur : ${scope}${extra}`;

  searchList.innerHTML = '';
  results.forEach((task, index) => {
    searchList.appendChild(buildTaskItem(task, index, results, searchList, true));
  });
}

/**
 * Filtre les tâches d'un seul niveau (sans récursion).
 * Ajoute _path à chaque résultat pour l'afficher dans le rendu.
 */
function searchLevel(tasks, needle, inNotes, pathPrefix) {
  return tasks
    .filter(t => matchTask(t, needle, inNotes))
    .map(t => ({ ...t, _path: pathPrefix || 'Racine' }));
}

/**
 * Parcourt récursivement toute l'arborescence et collecte les tâches
 * correspondant au terme de recherche, en construisant leur chemin.
 */
function searchAll(tasks, needle, inNotes, pathPrefix) {
  let results = [];
  for (const t of tasks) {
    const path = pathPrefix ? pathPrefix + ' › ' + t.text : t.text;
    if (matchTask(t, needle, inNotes)) {
      results.push({ ...t, _path: pathPrefix || 'Racine' });
    }
    if (t.children.length > 0) {
      results = results.concat(searchAll(t.children, needle, inNotes, path));
    }
  }
  return results;
}

/**
 * Teste si une tâche correspond au terme de recherche.
 * Cherche dans le titre, et optionnellement dans les notes (HTML strippé).
 */
function matchTask(task, needle, inNotes) {
  if (task.text.toLowerCase().includes(needle)) return true;
  if (inNotes && task.notes) {
    const plainNotes = task.notes.replace(/<[^>]+>/g, ' ').toLowerCase();
    if (plainNotes.includes(needle)) return true;
  }
  return false;
}

/* ═══════════════════════════════════════════════════════════
   UTILS — Fonctions utilitaires
════════════════════════════════════════════════════════════ */

/**
 * Recherche récursive d'une tâche par id dans un arbre.
 * @param {Task[]} list - Tableau de tâches (avec children imbriqués)
 * @param {number} id   - Id recherché
 * @returns {Task|null}
 */
function findTaskById(list, id) {
  for (const t of list) {
    if (t.id === id) return t;
    const found = findTaskById(t.children, id);
    if (found) return found;
  }
  return null;
}

/* ═══════════════════════════════════════════════════════════
   INIT — Point d'entrée
════════════════════════════════════════════════════════════ */

applySidebarState(); // applique l'état mémorisé de la sidebar (repliée ou non)
setupDetailDrag();   // rend la vue détail draggable vers la sidebar

// Initialise l'UI de synchronisation (modale + indicateur de statut)
if (typeof initSyncUI === 'function') {
  initSyncUI(onSyncUpdate);
  // Sync automatique au démarrage si la sync est activée et qu'on est en ligne
  const cfg = getSyncConfig();
  if (cfg.enabled && navigator.onLine) {
    syncBidirectional().then(result => {
      if (result.ok && result.tasks) onSyncUpdate(result.tasks);
    });
  }
}

// Affiche la popup d'accueil si l'utilisateur ne l'a pas masquée
if (typeof initWelcomeModal === 'function') {
  initWelcomeModal();
}

renderTree();        // construit l'arborescence dans la sidebar
showList();          // affiche la liste principale des tâches
