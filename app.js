/* ═══════════════════════════════════════════════════════════
   VERSION — Numéro de version de l'application.
   À incrémenter à chaque session de modifications.
   Format : MAJEUR.MINEUR.CORRECTIF
     MAJEUR  : refonte complète de l'architecture
     MINEUR  : nouvelle fonctionnalité visible
     CORRECTIF : correction de bug ou ajustement mineur
   Affiché dans la modale de synchronisation (pied de page).
════════════════════════════════════════════════════════════ */
const APP_VERSION = 'v1.0.5';

/* ═══════════════════════════════════════════════════════════
   STORAGE — Persistance dans localStorage
   Les tâches sont sérialisées en JSON sous la clé "tasks".
   Chaque tâche a la forme :
     { id, text, clicks, notes, children[], updatedAt,
       dueDate, importance }
   - dueDate    : string ISO "YYYY-MM-DD" ou "" (pas de date)
   - importance : "high" | "medium" | "low" (défaut "low")
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
    id:         t.id         ?? Date.now() + i,
    text:       t.text       ?? '',
    clicks:     t.clicks     ?? 0,
    notes:      t.notes      ?? '',
    children:   (t.children  ?? []).map(migrateTask),
    // Champs de priorité visuelle (ajoutés en v2) :
    // dueDate    : date d'échéance au format "YYYY-MM-DD", ou "" si non définie
    // importance : niveau d'importance textuel, défaut "low"
    dueDate:    t.dueDate    ?? '',
    importance: (['high','medium','low'].includes(t.importance)) ? t.importance : 'low',
  };
}

/**
 * Sérialise rootTasks dans localStorage, puis déclenche
 * une sync automatique vers le Gist si la sync est activée.
 *
 * Important : on appelle ensureTimestamps() avant d'écrire, ce qui
 * garantit que chaque tâche possède un champ `updatedAt` valide.
 * Sans ça, le merge last-write-wins du côté distant serait aveugle :
 * deux appareils auraient des `updatedAt` identiques et le merge
 * choisirait arbitrairement l'un des deux en ignorant l'autre.
 */
function saveTasks() {
  // ensureTimestamps ne remplace PAS un updatedAt existant (il ajoute seulement
  // si absent). Les tâches réellement modifiées ont déjà leur updatedAt frais
  // posé par makeTask() ou touchUpdatedAt() au moment de la mutation.
  const stamped = (typeof ensureTimestamps === 'function')
    ? ensureTimestamps(rootTasks)
    : rootTasks;
  localStorage.setItem('tasks', JSON.stringify(stamped));
  if (typeof syncAuto === 'function') {
    syncAuto(onSyncUpdate);
  }
}

/* ═══════════════════════════════════════════════════════════
   CORBEILLE — Suppression douce avec restauration
   Chaque entrée a la forme :
     { task, parentId, deletedAt }
   TTL : 30 jours. Purge automatique au chargement.
   Synchronisée dans le Gist via la clé "trash".
════════════════════════════════════════════════════════════ */

const TRASH_TTL    = 30 * 24 * 60 * 60 * 1000; // 30 jours en ms
const PURGED_TTL   = 60 * 24 * 60 * 60 * 1000; // 60 jours : garde les ids purgés assez longtemps

/**
 * Charge la liste des ids purgés définitivement depuis localStorage.
 * Format : [ { id, purgedAt } ]
 */
function loadPurgedIds() {
  try {
    const raw = JSON.parse(localStorage.getItem('purgedIds')) || [];
    const now = Date.now();
    return raw.filter(e => now - e.purgedAt < PURGED_TTL);
  } catch { return []; }
}

/** Sauvegarde la liste des ids purgés dans localStorage. */
function savePurgedIds() {
  localStorage.setItem('purgedIds', JSON.stringify(purgedIds));
}

/**
 * Enregistre un id (et tous les ids descendants d'une tâche) comme purgés,
 * pour que la sync ne les ramène pas depuis le Gist.
 */
/** Collecte récursivement tous les ids d'une tâche et de ses descendants dans un Set. */
function collectTaskIds(task, set) {
  set.add(task.id);
  (task.children || []).forEach(c => collectTaskIds(c, set));
}

function markPurged(task) {
  const now = Date.now();
  function collect(t) {
    purgedIds.push({ id: t.id, purgedAt: now });
    (t.children || []).forEach(collect);
  }
  collect(task);
  savePurgedIds();
}

/** Charge la corbeille depuis localStorage et purge les entrées expirées. */
function loadTrash() {
  try {
    const raw = JSON.parse(localStorage.getItem('trash')) || [];
    const now = Date.now();
    return raw.filter(e => now - e.deletedAt < TRASH_TTL);
  } catch { return []; }
}

/** Sérialise la corbeille dans localStorage. */
function saveTrash() {
  localStorage.setItem('trash', JSON.stringify(trashItems));
}

/**
 * Déplace une tâche vers la corbeille au lieu de la supprimer définitivement.
 */
function trashTask(task, srcList, parentId) {
  const idx = srcList.findIndex(t => t.id === task.id);
  if (idx === -1) return;
  srcList.splice(idx, 1);
  trashItems.unshift({ task, parentId: parentId ?? null, deletedAt: Date.now() });

  // Retire l'id (et ses descendants) de purgedIds : la tâche est en corbeille,
  // pas définitivement supprimée — la sync ne doit pas l'exclure
  const idsToUnpurge = new Set();
  collectTaskIds(task, idsToUnpurge);
  if (idsToUnpurge.size > 0) {
    const before = purgedIds.length;
    purgedIds = purgedIds.filter(e => !idsToUnpurge.has(e.id));
    if (purgedIds.length !== before) savePurgedIds();
  }

  saveTasks();
  saveTrash();
}

/**
 * Restaure une entrée de la corbeille dans son emplacement d'origine.
 */
function restoreTask(entry) {
  const idx = trashItems.indexOf(entry);
  if (idx === -1) return;
  trashItems.splice(idx, 1);

  // Marque l'id comme purgé de la corbeille pour que la sync
  // ne la ramène pas depuis le Gist (même logique que deleteForever)
  markPurged(entry.task);

  const { task, parentId } = entry;
  task.children = task.children || [];

  if (parentId !== null) {
    const parent = findTaskById(rootTasks, parentId);
    if (parent) {
      parent.children.unshift(task);
      saveTasks();
      saveTrash();
      return;
    }
  }
  rootTasks.unshift(task);
  saveTasks();
  saveTrash();
}

/**
 * Supprime définitivement une entrée de la corbeille.
 * Enregistre l'id dans purgedIds pour bloquer tout retour via sync.
 */
function deleteForever(entry) {
  const idx = trashItems.indexOf(entry);
  if (idx !== -1) trashItems.splice(idx, 1);
  markPurged(entry.task);
  saveTrash();
  if (typeof syncAuto === 'function') syncAuto(onSyncUpdate);
}

/**
 * Vide entièrement la corbeille.
 * Enregistre tous les ids dans purgedIds pour bloquer tout retour via sync.
 */
function emptyTrash() {
  trashItems.forEach(e => markPurged(e.task));
  trashItems.length = 0;
  saveTrash();
  if (typeof syncAuto === 'function') syncAuto(onSyncUpdate);
}

/**
 * Callback appelé quand une sync a ramené des données distantes
 * plus récentes que les données locales.
 * Recharge rootTasks et rafraîchit la vue courante.
 * @param {Task[]} mergedTasks - Arbre fusionné retourné par la sync
 */
function onSyncUpdate(mergedTasks, mergedTrash) {
  rootTasks = mergedTasks.map(migrateTask);
  if (mergedTrash) {
    trashItems.length = 0;
    mergedTrash.forEach(e => trashItems.push(e));
    updateTrashBadge();
  }
  // Resynchronise purgedIds en mémoire avec ce que sync.js a écrit dans localStorage
  purgedIds = loadPurgedIds();

  // Préserve la vue courante : recalcule navigationStack avec les nouveaux rootTasks
  // en gardant les mêmes taskId (si les tâches existent toujours)
  const oldNavStack = navigationStack;
  navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];

  // Reconstruit la pile jusqu'à la tâche courante (si elle existe encore)
  for (let i = 1; i < oldNavStack.length; i++) {
    const taskId = oldNavStack[i].taskId;
    if (!taskId) break; // tâche racine, on arrête

    const task = findTaskById(rootTasks, taskId);
    if (!task) {
      // La tâche n'existe plus → retour à la pile précédente (dernier niveau valide)
      activeTreeTaskId = navigationStack[navigationStack.length - 1].taskId || null;
      renderTree();
      return;
    }

    navigationStack.push({ tasks: task.children, title: task.text, taskId: task.id });
  }

  // La pile a été correctement reconstruite → affiche la vue correspondante
  activeTreeTaskId = navigationStack[navigationStack.length - 1].taskId || null;
  renderTree();
  if (navigationStack.length === 1) {
    showList();
  } else {
    const currentTask = findTaskById(rootTasks, activeTreeTaskId);
    if (currentTask) showDetail(currentTask); else showList();
  }
}

/* ═══════════════════════════════════════════════════════════
   STATE — Variables globales de l'application
════════════════════════════════════════════════════════════ */

/** Tableau racine de toutes les tâches de premier niveau. */
let rootTasks = loadTasks();

/** Tableau des tâches en corbeille : { task, parentId, deletedAt }[] */
let trashItems = loadTrash();

/** Ids supprimés définitivement : { id, purgedAt }[] — empêche la sync de les ramener */
let purgedIds = loadPurgedIds();

/**
 * Pile de navigation : chaque entrée représente un niveau de l'arborescence
 * affiché dans la vue détail.
 *   [0] = { tasks: rootTasks, title: 'Tâches', taskId: null }   ← niveau racine
 *   [1] = { tasks: tâcheA.children, title: 'tâcheA', taskId: idA }
 *   [2] = { tasks: tâcheB.children, title: 'tâcheB', taskId: idB }
 * Naviguer "en arrière" = pop(). Naviguer vers une tâche = push().
 */
let navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];

/** Délai en ms d'attente après le dernier clic avant d'appliquer le déplacement de priorité. */
const CLICK_DELAY = 400;

/** État de l'accumulation des clics pour la remontée des tâches. */
let clickAccum = { taskId: null, count: 0, timer: null, getList: null, listEl: null };

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
 * Flag global levé par initTouchDrag dès qu'un cycle touch est en cours
 * (touchstart reçu, cleanup non encore appelé). Permet à buildTaskItem de
 * bloquer handleClick dans pointerup : sur mobile, pointerup est émis à la
 * fin du touch même après un long press, et sans ce guard il déclencherait
 * handleClick → doFlush → renderList → destruction du DOM pendant le geste.
 */
let _touchGestureActive = false;

/**
 * Id de la tâche en cours de drag DEPUIS l'arbre (drag intra-arbre).
 * Distinct de dragSrcIndex/dragListRef qui concernent le drag depuis la liste centrale.
 */
let treeDragTaskId = null;

/**
 * Identifiant global de la tâche en cours de drag (toutes sources confondues).
 * Nécessaire car dataTransfer.getData() retourne "" pendant dragover (restriction
 * de sécurité navigateur) — on ne peut lire les données qu'au moment du drop.
 * Cette variable permet à resolveDragSource de fonctionner pendant dragover.
 */
let activeDragTaskId = null;

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
const detailTitle      = document.getElementById('detailTitle');       // <h2> titre de la tâche
const detailImportance = document.getElementById('detailImportance'); // <select> importance
const detailDueDate    = document.getElementById('detailDueDate');    // <input type=date>
const detailDueDateClear = document.getElementById('detailDueDateClear'); // bouton ✕ date
const subTaskInput     = document.getElementById('subTaskInput');     // champ "nouvelle sous-tâche"
const addSubBtn        = document.getElementById('addSubBtn');
const subTaskListEl    = document.getElementById('subTaskList');      // <ul> liste des sous-tâches

const searchInput     = document.getElementById('searchInput');
const searchOptions   = document.getElementById('searchOptions');   // bandeau sous la topbar
const searchAllLevels = document.getElementById('searchAllLevels');
const searchInNotes   = document.getElementById('searchInNotes');
// Filtres urgence : permettent de rechercher par couleur, avec ou sans texte
const searchUrgent    = document.getElementById('searchUrgent');    // 🔴 tâches urgentes
const searchWarning   = document.getElementById('searchWarning');   // 🟠 tâches importantes
const searchClose     = document.getElementById('searchClose');
const searchList      = document.getElementById('searchList');
const searchHint      = document.getElementById('searchHint');

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
     if (task) {
       task.notes = quill.getSemanticHTML();
       // touchUpdatedAt() marque la tâche comme modifiée et met à jour son updatedAt
       // au timestamp courant. Cela garantit que lors de la sync, la version locale
       // (qui possède les notes fraîchement saisies) l'emportera sur les versions
       // distantes plus anciennes, même si elles ont le même id.
       touchUpdatedAt(task.id);
       saveTasks();
     }
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

/* ── Filtre arborescence sidebar ────────────────────────────── */
const sidebarFilter = document.getElementById('sidebarFilter');
const sidebarFilterClear = document.getElementById('sidebarFilterClear');

sidebarFilter.addEventListener('input', (e) => {
  treeFilterQuery = e.target.value.trim().toLowerCase();
  renderTree();
  // Montre/cache le bouton clear
  sidebarFilterClear.classList.toggle('hidden', !treeFilterQuery);
});

sidebarFilterClear.addEventListener('click', () => {
  treeFilterQuery = '';
  sidebarFilter.value = '';
  sidebarFilterClear.classList.add('hidden');
  renderTree();
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

/* ── Filtre sidebar ─────────────────────────────────────────
   treeFilterQuery : mot-clé courant (vide = pas de filtre)
   treeVisibleIds  : Set des ids à afficher quand filtre actif
      = ids correspondants + tous leurs ancêtres + tous leurs descendants
══════════════════════════════════════════════════════════════ */
let treeFilterQuery = '';
let treeVisibleIds  = null; // null = pas de filtre actif

/**
 * Calcule l'ensemble des ids à afficher pour un mot-clé donné.
 * Un nœud est visible si :
 *   - il correspond au filtre (→ "match")
 *   - il est ancêtre d'un nœud correspondant (pour montrer le chemin)
 *   - il est descendant d'un nœud correspondant (pour tout afficher)
 *
 * @param {Task[]} tasks   - Arbre complet
 * @param {string} needle  - Mot-clé en minuscules
 * @returns {Set<number>}  - Ids à afficher ; null si needle vide
 */
function computeVisibleIds(tasks, needle) {
  if (!needle) return null;
  const visible  = new Set();
  const matched  = new Set();

  // Première passe : collecte des ids qui correspondent + tous leurs descendants
  function collectMatches(list) {
    let anyMatch = false;
    for (const t of list) {
      const selfMatch = t.text.toLowerCase().includes(needle);
      const childMatch = t.children.length ? collectMatches(t.children) : false;
      if (selfMatch) {
        matched.add(t.id);
        visible.add(t.id);
        // Tous les descendants d'un nœud correspondant sont visibles
        addAllDescendants(t.children, visible);
      }
      if (selfMatch || childMatch) {
        visible.add(t.id); // ancêtre visible pour montrer le chemin
        anyMatch = true;
      }
    }
    return anyMatch;
  }

  function addAllDescendants(list, set) {
    for (const t of list) {
      set.add(t.id);
      if (t.children.length) addAllDescendants(t.children, set);
    }
  }

  collectMatches(tasks);
  return { visible, matched };
}

/**
 * Reconstruit entièrement l'arbre dans la sidebar.
 * Affiche d'abord un nœud "racine" fixe permettant de revenir
 * au niveau le plus haut et de servir de cible de drop vers la racine.
 */
function renderTree() {
  const filterInfo = computeVisibleIds(rootTasks, treeFilterQuery);

  sidebarTree.innerHTML = '';

  // ── Nœud racine fixe ──────────────────────────────────────
  const rootRow = document.createElement('div');
  rootRow.className = 'tree-row tree-root-node' + (activeTreeTaskId === null ? ' active' : '');
  rootRow.title = 'Revenir à la liste principale';

  const rootIcon = document.createElement('span');
  rootIcon.className = 'tree-toggle leaf';
  rootIcon.textContent = '▶';

  const rootLabel = document.createElement('span');
  rootLabel.className = 'tree-label';
  rootLabel.textContent = '🏠 Tâches (racine)';

  rootRow.appendChild(rootIcon);
  rootRow.appendChild(rootLabel);
  sidebarTree.appendChild(rootRow);

  rootRow.addEventListener('click', () => {
    closeSearch();
    navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
    activeTreeTaskId = null;
    renderTree();
    showList();
    if (window.innerWidth <= 640) { sidebarCollapsed = true; applySidebarState(); }
  });

  attachRootDropHandlers(rootRow);

  // ── Nœuds des tâches de l'arborescence ───────────────────
  if (filterInfo && filterInfo.visible.size === 0) {
    const empty = document.createElement('div');
    empty.className = 'tree-filter-empty';
    empty.textContent = 'Aucun résultat';
    sidebarTree.appendChild(empty);
  } else {
    buildTreeNodes(rootTasks, sidebarTree, 0, filterInfo);
  }
}

/**
 * Construit récursivement les nœuds DOM pour un tableau de tâches.
 * @param {Task[]}      tasks       - Tableau de tâches à afficher
 * @param {HTMLElement} container   - Élément parent dans lequel insérer les nœuds
 * @param {number}      depth       - Profondeur (indentation)
 * @param {object|null} filterInfo  - { visible: Set, matched: Set } ou null
 */
function buildTreeNodes(tasks, container, depth, filterInfo = null) {
  tasks.forEach(task => {
    // En mode filtre, on saute les nœuds hors du sous-ensemble visible
    if (filterInfo && !filterInfo.visible.has(task.id)) return;

    const node = document.createElement('div');
    node.className = 'tree-node';

    const row = document.createElement('div');
    const isMatch = filterInfo && filterInfo.matched.has(task.id);
    row.className = 'tree-row'
      + (task.id === activeTreeTaskId ? ' active' : '')
      + (isMatch ? ' tree-match' : '');
    row.style.paddingLeft = (14 + depth * 16) + 'px';
    row.dataset.taskId = task.id;

    const toggle = document.createElement('span');
    // En mode filtre, tous les nœuds visibles sont toujours dépliés
    const forceOpen = filterInfo !== null;
    toggle.className = 'tree-toggle'
      + (task.children.length === 0 ? ' leaf'
        : ((!forceOpen && treeCollapsed[task.id]) ? '' : ' open'));
    toggle.textContent = '▶';

    const label = document.createElement('span');
    label.className = 'tree-label';
    // En mode filtre, surligne la portion correspondante du texte
    if (isMatch && treeFilterQuery) {
      label.innerHTML = highlightMatch(task.text, treeFilterQuery);
    } else {
      label.textContent = task.text;
    }
    label.title = task.text;

    row.appendChild(toggle);
    row.appendChild(label);

    const childContainer = document.createElement('div');
    const isCollapsed = !forceOpen && !!treeCollapsed[task.id];
    childContainer.className = 'tree-children' + (isCollapsed ? ' collapsed' : '');

    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (task.children.length === 0) return;
      if (forceOpen) return; // pas de repli en mode filtre
      treeCollapsed[task.id] = !treeCollapsed[task.id];
      localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
      toggle.className = 'tree-toggle' + (treeCollapsed[task.id] ? '' : ' open');
      childContainer.classList.toggle('collapsed', !!treeCollapsed[task.id]);
    });

    row.addEventListener('click', () => {
      if (treeDragTaskId !== null) return;
      navigateToTask(task);
    });

    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      treeDragTaskId  = task.id;
      activeDragTaskId = task.id;
      row.classList.add('tree-dragging');
      document.body.classList.add('dragging-active');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('treeDragTaskId', String(task.id));
      
      const ghost = createDragGhost(task.text);
      e.dataTransfer.setDragImage(ghost, -10, 8);
      setTimeout(() => { const g = document.getElementById('dragGhost'); if (g) g.remove(); }, 0);
      
      e.stopPropagation();
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('tree-dragging');
      document.body.classList.remove('dragging-active');
      clearTreeDropHighlight();
      clearExpandTimer();
      setTimeout(() => { treeDragTaskId = null; activeDragTaskId = null; }, 50);
    });

    attachTreeDropHandlers(row, task, childContainer);

    node.appendChild(row);
    node.appendChild(childContainer);
    container.appendChild(node);

    if (task.children.length > 0) {
      buildTreeNodes(task.children, childContainer, depth + 1, filterInfo);
    }
  });
}

/**
 * Surligne la première occurrence de `needle` dans `text` avec un <mark>.
 * @param {string} text
 * @param {string} needle
 * @returns {string} HTML sécurisé avec <mark>
 */
function highlightMatch(text, needle) {
  const idx = text.toLowerCase().indexOf(needle.toLowerCase());
  if (idx === -1) return escHtml(text);
  return escHtml(text.slice(0, idx))
    + '<mark class="tree-highlight">' + escHtml(text.slice(idx, idx + needle.length)) + '</mark>'
    + escHtml(text.slice(idx + needle.length));
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
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
// ── Références des handlers vivants pour detailMeta ──────────────────────────
// Ces variables stockent les fonctions de handler actuellement attachées aux
// éléments du bloc importance/date. On les garde en dehors de showDetail pour
// pouvoir les retirer (removeEventListener) avant d'en attacher de nouveaux.
// C'est l'alternative sûre au cloneNode : les nœuds DOM restent stables,
// seules les fonctions callback changent à chaque ouverture de tâche.
let _detailImpHandler   = null;
let _detailDateHandler  = null;
let _detailClearHandler = null;

function showDetail(task) {
  listView.classList.add('hidden');
  detailView.classList.remove('hidden');
  searchView.classList.add('hidden');

  detailTitle.textContent = task.text;
  detailTitle.title = 'Cliquer pour modifier le titre';

  // ── Champs importance et date d'échéance ─────────────────────────────────
  // On retire le handler précédent avant d'en attacher un nouveau.
  // Cela évite l'accumulation de listeners sans avoir recours à cloneNode
  // (qui détachait les nœuds du DOM et cassait les références constantes).
  if (_detailImpHandler)   detailImportance.removeEventListener('change', _detailImpHandler);
  if (_detailDateHandler)  detailDueDate.removeEventListener('change',    _detailDateHandler);
  if (_detailClearHandler) detailDueDateClear.removeEventListener('click', _detailClearHandler);

  // Charge les valeurs courantes de la tâche dans les champs
  detailImportance.value = task.importance || 'low';
  detailDueDate.value    = task.dueDate    || '';

  // Nouveau handler importance : capture `task` via closure.
  // Chaque appel à showDetail crée une nouvelle closure sur la bonne tâche.
  _detailImpHandler = () => {
    task.importance = detailImportance.value;
    touchUpdatedAt(task.id);
    saveTasks();
    // Rafraîchit la liste visible pour appliquer la nouvelle couleur immédiatement
    _refreshCurrentList();
  };
  detailImportance.addEventListener('change', _detailImpHandler);

  // Nouveau handler date d'échéance
  _detailDateHandler = () => {
    task.dueDate = detailDueDate.value;
    touchUpdatedAt(task.id);
    saveTasks();
    _refreshCurrentList();
  };
  detailDueDate.addEventListener('change', _detailDateHandler);

  // Nouveau handler bouton ✕ (efface la date)
  _detailClearHandler = () => {
    detailDueDate.value = '';
    task.dueDate = '';
    touchUpdatedAt(task.id);
    saveTasks();
    _refreshCurrentList();
  };
  detailDueDateClear.addEventListener('click', _detailClearHandler);

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
 * Rafraîchit la liste actuellement visible (liste racine ou sous-tâches)
 * après une modification d'importance ou de date dans la vue détail.
 * Cela met à jour les couleurs sans quitter la vue détail.
 */
function _refreshCurrentList() {
  if (navigationStack.length === 1) {
    renderList(taskListEl, rootTasks);
  } else {
    const parent = navigationStack[navigationStack.length - 1];
    renderList(subTaskListEl, parent.tasks);
  }
  renderTree();
}

/**
 * Crée et attache au DOM un élément drag-ghost compact (juste titre).
 * L'élément est positionné hors-écran dans le DOM (setDragImage le capture).
 * Il est supprimé automatiquement après dragstart via setTimeout(0).
 * @param {string} taskText - Titre de la tâche
 * @returns {HTMLElement} Élément à passer à setDragImage()
 */
function createDragGhost(taskText) {
  const ghost = document.createElement('div');
  ghost.id = 'dragGhost';
  const text = taskText.length > 35 ? taskText.slice(0, 32) + '…' : taskText;
  ghost.textContent = text;
  // Hors écran pour ne pas être vu (c'est une image drag, pas un vrai élément visible)
  Object.assign(ghost.style, {
    position:      'fixed',
    top:           '-9999px',
    left:          '-9999px',
    background:    '#f8f9ff',
    border:        '2px solid #4f46e5',
    borderRadius:  '8px',
    padding:       '8px 12px',
    fontSize:      '0.9rem',
    fontWeight:    '600',
    color:         '#1a1a2e',
    whiteSpace:    'nowrap',
    boxShadow:     '0 4px 12px rgba(79,70,229,0.25)',
    pointerEvents: 'none',
    zIndex:        '99999',
    maxWidth:      '280px',
    overflow:      'hidden',
    textOverflow:  'ellipsis',
  });
  document.body.appendChild(ghost);
  return ghost;
}

function setupDetailDrag() {
  detailView.draggable = true;

  const qlEditor = detailView.querySelector('#quillEditor');
  if (qlEditor) {
    qlEditor.addEventListener('focusin',  () => { detailView.draggable = false; });
    qlEditor.addEventListener('focusout', () => { detailView.draggable = true;  });
  }

  // Nettoyage de fin de drag — sur document car pointer-events:none
  // sur detailView pendant le drag empêche l'élément de recevoir dragend
  function onDetailDragEnd() {
    document.body.classList.remove('dragging-active');
    detailView.classList.remove('detail-dragging', 'detail-dragging-active');
    clearTreeDropHighlight();
    clearExpandTimer();
    activeDragTaskId = null;
    document.removeEventListener('dragend', onDetailDragEnd);
  }

  detailView.addEventListener('dragstart', (e) => {
    // Si le drag vient d'un li de sous-tâche, on laisse son propre dragstart gérer.
    if (e.target.closest('.task-item')) return;

    // Interdit le drag depuis tout champ interactif : éditeur Quill, inputs texte,
    // textarea, boutons, et en particulier le bloc #detailMeta (select importance,
    // input date, bouton ✕). Sans cette exclusion, l'input[type=date] est draggable
    // par défaut dans certains navigateurs et déclenche ce handler au lieu de son
    // comportement natif, cassant à la fois le sélecteur de date et le drag des li.
    if (e.target.closest('.ql-editor, input, textarea, button, select, .detail-meta')) {
      e.preventDefault();
      return;
    }
    if (!currentNoteTaskId) return;

    const task = findTaskById(rootTasks, currentNoteTaskId);
    if (task) {
      const ghost = createDragGhost(task.text);
      // Offset négatif en X pour que l'image soit à droite du curseur
      e.dataTransfer.setDragImage(ghost, -10, 8);
      // Supprime le ghost du DOM après que le navigateur l'ait capturé
      setTimeout(() => { const g = document.getElementById('dragGhost'); if (g) g.remove(); }, 0);
    }

    e.dataTransfer.setData('detailDragTaskId', String(currentNoteTaskId));
    e.dataTransfer.effectAllowed = 'move';
    activeDragTaskId = currentNoteTaskId;
    document.body.classList.add('dragging-active');
    detailView.classList.add('detail-dragging');
    setTimeout(() => detailView.classList.add('detail-dragging-active'), 0);
    document.addEventListener('dragend', onDetailDragEnd);
  });

  detailView.addEventListener('dragend', onDetailDragEnd);
}

/** Affiche la vue résultats de recherche. */
function showSearch() {
  listView.classList.add('hidden');
  detailView.classList.add('hidden');
  searchView.classList.remove('hidden');
  // Affiche le bandeau d'options sous la topbar dès qu'une recherche est active.
  // Sur mobile, ces options n'ont pas de place dans la topbar ; le bandeau
  // les rend toujours accessibles quelle que soit la taille d'écran.
  searchOptions.classList.remove('hidden');
}

/**
 * Ferme la vue recherche et restaure la vue précédente
 * (liste si on était à la racine, détail sinon).
 * Réinitialise aussi les filtres urgence pour ne pas les laisser cochés
 * lors d'une prochaine ouverture du bandeau.
 */
function closeSearch() {
  searchInput.value = '';
  // Réinitialise les filtres urgence pour repartir d'un état propre
  searchUrgent.checked  = false;
  searchWarning.checked = false;
  searchView.classList.add('hidden');
  // Masque le bandeau d'options : il ne doit être visible que pendant une recherche.
  searchOptions.classList.add('hidden');
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
    li.addEventListener('click', (e) => {
      // stopPropagation empêche le click de remonter jusqu'à
      // document.addEventListener('click', hideContextMenu) qui fermerait
      // le menu AVANT que ce handler ait le temps d'exécuter l'action.
      // Sans ça, sur mobile, le tap sur un item ferme le menu sans rien faire.
      e.stopPropagation();
      hideContextMenu();
      // Retrouve le vrai tableau parent (en mode recherche, `tasks` est un tableau
      // de résultats temporaire — pas le vrai parent de la tâche)
      const realList = findParentList(rootTasks, task.id) || tasks;
      const idx = realList.findIndex(t => t.id === task.id);
      if (idx === -1) return;
      const newIdx = delta === -Infinity
        ? 0
        : Math.max(0, Math.min(realList.length - 1, idx + delta));
      if (newIdx === idx) return;
      const [moved] = realList.splice(idx, 1);
      realList.splice(newIdx, 0, moved);
      // La tâche a changé de position : touchUpdatedAt() met à jour son updatedAt
      // pour signaler à la sync que ce réordonnement local doit être préservé
      // (la position relative dans la liste est un élément d'état de la tâche).
      touchUpdatedAt(moved.id);
      saveTasks();
      // Rafraîchit la vue courante (liste principale, sous-tâches, ou recherche)
      if (listEl === searchList) {
        renderTree();
        runSearch();
       } else {
         renderList(listEl, realList);
         renderTree();
       }
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

// ── Fermeture automatique du menu contextuel ──────────────────────────────
//
// Sur mobile, un appui long suivi d'un touchend génère un "click" synthétique
// ~300 ms plus tard. Ce click est émis sur la zone de la liste (pas sur le menu)
// et remonterait ici pour fermer immédiatement le menu qu'on vient d'ouvrir.
//
// Protection : initTouchDrag lève _suppressNextClick juste avant showContextMenu().
// Le premier click reçu ici l'absorbe sans fermer le menu.
// Les clicks suivants (sur les items du menu, ou hors du menu) ferment normalement.
document.addEventListener('click', () => {
  if (_suppressNextClick) {
    // Click fantôme post-long-press → on l'absorbe silencieusement.
    _suppressNextClick = false;
    return;
  }
  hideContextMenu();
});
document.addEventListener('scroll',  hideContextMenu, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });

/* ═══════════════════════════════════════════════════════════
   TASK LIST RENDER — Rendu des listes de tâches
════════════════════════════════════════════════════════════ */

/**
 * Calcule la classe CSS de coloration d'urgence d'une tâche.
 *
 * Règles (par ordre de priorité décroissante) :
 *   ROUGE  ("task-urgent")  : importance === "high"
 *                           OU date d'échéance dépassée (< aujourd'hui)
 *                           OU date d'échéance dans ≤ 3 jours
 *   ORANGE ("task-warning") : importance === "medium"
 *                           OU date d'échéance dans 4–10 jours
 *   (rien)                  : importance === "low" et pas de date proche
 *
 * La comparaison de dates se fait en "jours calendaires" (sans tenir compte
 * de l'heure) pour éviter les surprises dues aux fuseaux horaires.
 * On compare les chaînes ISO YYYY-MM-DD directement : ordre lexicographique
 * = ordre chronologique pour ce format.
 *
 * @param {Task} task
 * @returns {string} '' | 'task-warning' | 'task-urgent'
 */
function taskUrgencyClass(task) {
  const imp = task.importance || 'low';
  const due = task.dueDate    || '';

  // Calcule "aujourd'hui" en ISO YYYY-MM-DD (heure locale, pas UTC)
  const now   = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;

  // Date dans N jours (heure locale)
  function dateInDays(n) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }

  const in3  = dateInDays(3);  // dans 3 jours
  const in10 = dateInDays(10); // dans 10 jours

  // ── Conditions ROUGE ────────────────────────────────────────────────────
  if (imp === 'high') return 'task-urgent';
  if (due && due <= in3) return 'task-urgent'; // dépassée OU ≤ 3 jours

  // ── Conditions ORANGE ───────────────────────────────────────────────────
  if (imp === 'medium') return 'task-warning';
  if (due && due <= in10) return 'task-warning'; // 4–10 jours

  return ''; // faible importance, pas de date proche
}

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
  // taskUrgencyClass() retourne '' | 'task-warning' | 'task-urgent'
  // Ces classes colorent le fond du <li> selon l'importance/la date d'échéance.
  const urgency = taskUrgencyClass(task);
  li.className = 'task-item' + (urgency ? ' ' + urgency : '');
  li.draggable = true;
  li.dataset.taskId = task.id;

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

  // ── Badge nombre de sous-tâches ───────────────────────
  const subBadge = document.createElement('span');
  subBadge.className = 'task-clicks';
  subBadge.draggable = false;
  if (task.children.length > 0) {
    subBadge.textContent = task.children.length;
    subBadge.title = `${task.children.length} sous-tâche${task.children.length > 1 ? 's' : ''}`;
  } else {
    subBadge.textContent = '';
    subBadge.style.visibility = 'hidden';
  }

  // ── Bouton supprimer ──────────────────────────────────
  const del = document.createElement('button');
  del.className = 'task-delete';
  del.textContent = '✕';
  del.title = 'Supprimer';

  li.appendChild(rank);
  li.appendChild(textWrap);
  li.appendChild(noteIcon);
  li.appendChild(subBadge);
  li.appendChild(del);

  // ── Gestion du clic de priorité (invisible, remonte la tâche) ───────────────
  // On utilise pointerdown/pointermove/pointerup plutôt que "click"
  // car sur un élément draggable, l'événement "click" peut être annulé
  // par le navigateur si le pointeur a légèrement bougé (détection de drag).
  // La variable `pointerMoved` permet de distinguer un vrai clic d'un glisser.
  const getList = () => tasks; // closure : accès au tableau live au moment du flush

  let pointerMoved = false;
  textWrap.addEventListener('pointerdown', () => { pointerMoved = false; });
  textWrap.addEventListener('pointermove', () => { pointerMoved = true; });
  textWrap.addEventListener('pointerup', (e) => {
    // Double protection contre le déclenchement intempestif de handleClick :
    //
    // 1. pointerMoved : si le pointeur a bougé, c'est un drag pas un clic.
    //
    // 2. _touchGestureActive : sur mobile, pointerup est émis à la fin du
    //    toucher MÊME après un long press (600 ms). Sans ce flag, handleClick
    //    serait appelé après chaque long press, reconstruisant le DOM via
    //    doFlush/renderList et détruisant le <li> sur lequel le geste porte.
    //    Ce flag est levé par initTouchDrag dès le touchstart et baissé par cleanup().
    if (pointerMoved || _touchGestureActive) return;
    if (e.button === 0) handleClick(task.id, getList, listEl);
  });

  // Menu contextuel au clic droit (desktop)
  li.addEventListener('contextmenu', (e) => showContextMenu(e, task, tasks, listEl));

  // Icône 📋 : navigue vers le détail (ou vers la tâche dans l'arbre si mode recherche)
  noteIcon.addEventListener('click', (e) => {
    e.stopPropagation();
    if (searchResultMode) navigateToTask(task);
    else openDetail(task);
  });

  // Suppression douce : déplace dans la corbeille au lieu de supprimer
  del.addEventListener('click', (e) => {
    e.stopPropagation();
    // Détermine le parentId : l'entrée courante de la navigationStack pointe
    // vers le niveau où se trouve la tâche ; son taskId est le parent.
    const parentId = searchResultMode
      ? null
      : (navigationStack[navigationStack.length - 1].taskId ?? null);
    trashTask(task, tasks, parentId);
    updateTrashBadge();
    if (searchResultMode) runSearch();
    else { renderList(listEl, tasks); renderTree(); }
  });

  // ── Drag & Drop ───────────────────────────────────────
  // dragstart : toujours actif (drag vers l'arbre possible même en mode recherche)
  li.addEventListener('dragstart', function(e) {
    // On force pointerMoved = true pour que pointerup (qui peut arriver après
    // la fin du drag sur certains navigateurs) ne déclenche pas handleClick.
    // Sans ça, un drag court (mousedown → minuscule déplacement → dragstart →
    // mouseup) peut ne pas avoir émis de pointermove, laissant pointerMoved à
    // false, et handleClick appellerait doFlush → renderList en cours de drag.
    pointerMoved = true;

    this.classList.add('dragging');
    document.body.classList.add('dragging-active');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('taskId', String(task.id));
    activeDragTaskId = task.id;
    
    const ghost = createDragGhost(task.text);
    e.dataTransfer.setDragImage(ghost, -10, 8);
    setTimeout(() => { const g = document.getElementById('dragGhost'); if (g) g.remove(); }, 0);
    
    if (!searchResultMode) {
      dragSrcIndex = task.id; // on stocke l'id, pas l'index de rendu
      dragListRef  = tasks;
    }
  });

  li.addEventListener('dragend', function() {
    document.body.classList.remove('dragging-active');
    listEl.querySelectorAll('.task-item').forEach(el =>
      el.classList.remove('dragging', 'drag-over', 'drop-before', 'drop-after'));
    clearTreeDropHighlight();
    dragSrcIndex     = null;
    dragListRef      = null;
    activeDragTaskId = null;
  });

  // dragover/drop intra-liste : uniquement hors mode recherche
  // et uniquement si la source est bien cette même liste (réordonnement ou mise en sous-tâche)
  if (!searchResultMode) {
    li.addEventListener('dragover', function(e) {
      if (dragListRef !== tasks) return;
      e.preventDefault();

      const rect    = this.getBoundingClientRect();
      const relY    = e.clientY - rect.top;
      const third   = rect.height / 3;

      // Nettoie tous les indicateurs de la liste
      listEl.querySelectorAll('.task-item').forEach(el => {
        el.classList.remove('drop-before', 'drop-after', 'drop-child');
      });

      // Tiers haut → insérer avant, tiers bas → insérer après, tiers central → sous-tâche
      if (relY < third) {
        this.classList.add('drop-before');
      } else if (relY > third * 2) {
        this.classList.add('drop-after');
      } else {
        this.classList.add('drop-child');
      }
    });

    li.addEventListener('dragleave', function(e) {
      if (!this.contains(e.relatedTarget)) {
        this.classList.remove('drop-before', 'drop-after', 'drop-child');
      }
    });

    li.addEventListener('drop', function(e) {
      if (dragListRef !== tasks) return;
      e.preventDefault();
      e.stopPropagation();

      const isChild  = this.classList.contains('drop-child');
      const isBefore = this.classList.contains('drop-before');
      this.classList.remove('drop-before', 'drop-after', 'drop-child');

      const destId = parseInt(this.dataset.taskId);
      const srcId  = dragSrcIndex;
      if (!srcId || srcId === destId) return;

      const srcIdx = tasks.findIndex(t => t.id === srcId);
      let  destIdx = tasks.findIndex(t => t.id === destId);
      if (srcIdx === -1 || destIdx === -1) return;

      const destTask = tasks[destIdx];

      if (isChild) {
        // ── Drop centre : la tâche source devient sous-tâche de la cible ──
        // Le changement hiérarchique (passage du niveau parent au niveau enfant)
        // est un changement d'état : on marque DEUX tâches :
        //   1. La tâche déplacée : elle a changé de liste parente
        //   2. La tâche cible : elle a gagné une sous-tâche, donc son contenu structurel change
        if (isDescendantOrSelf(destId, srcId, rootTasks)) return;
        const [moved] = tasks.splice(srcIdx, 1);
        destTask.children.unshift(moved);
        treeCollapsed[destId] = false;
        localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
        touchUpdatedAt(moved.id);      // Marque la tâche qui a changé de parent
        touchUpdatedAt(destTask.id);   // Marque le parent qui a gagné un enfant
      } else {
        // ── Drop haut/bas : réordonnement dans la même liste ──
        // La position relative a changé (avant/après une autre tâche).
        // On marque uniquement la tâche déplacée pour signaler que son ordre
        // s'est modifié — les autres tâches ne changent pas d'état, seulement
        // leur position relative (qui est implicite dans l'ordre du tableau).
        const [moved] = tasks.splice(srcIdx, 1);
        destIdx = tasks.findIndex(t => t.id === destId);
        const insertIdx = isBefore ? destIdx : destIdx + 1;
        tasks.splice(insertIdx, 0, moved);
        touchUpdatedAt(moved.id);      // Marque le réordonnement local
      }

      dragSrcIndex = null;
      dragListRef  = null;
      saveTasks();
      renderList(listEl, tasks);
      renderTree();
    });
  }

  return li;
}

/* ═══════════════════════════════════════════════════════════
   TREE DROP — Déplacer une tâche vers un nœud de l'arbre
   Event delegation sur sidebarTree : un seul handler dragover/drop
   sur le conteneur, qui identifie la tree-row cible via closest().
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
 * Vérifie si `taskId` est un descendant (ou lui-même) de `ancestorId`.
 * Utilisé pour interdire le drop d'une tâche sur l'un de ses propres descendants.
 */
function isDescendantOrSelf(taskId, ancestorId, list) {
  for (const t of list) {
    if (t.id === ancestorId) return findTaskById([t], taskId) !== null;
    if (isDescendantOrSelf(taskId, ancestorId, t.children)) return true;
  }
  return false;
}

/**
 * Résout la tâche source depuis les variables globales de drag.
 * Retourne { srcId, srcTask, srcList } ou null.
 */
function resolveDragSource() {
  const id = treeDragTaskId || activeDragTaskId;
  if (!id) return null;
  const srcTask = findTaskById(rootTasks, id);
  const srcList = findParentList(rootTasks, id);
  return srcTask && srcList ? { srcId: id, srcTask, srcList } : null;
}

/**
 * Trouve le tableau parent qui contient directement la tâche d'id donné.
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
 * @param {object}      src          - { srcTask, srcList }
 * @param {Task[]}      targetList   - Tableau cible
 * @param {number|null} targetTaskId - Id du nœud cible (null = racine)
 */
function performTreeDrop(src, targetList, targetTaskId) {
  if (targetTaskId && isDescendantOrSelf(targetTaskId, src.srcId, rootTasks)) return;
  if (src.srcList === targetList) return;

  const idx = src.srcList.indexOf(src.srcTask);
  if (idx === -1) return;
  src.srcList.splice(idx, 1);
  targetList.unshift(src.srcTask);
  // La tâche a changé de parent (depuis un nœud de l'arbre vers un autre).
  // touchUpdatedAt() met à jour son updatedAt, ce qui signale à la sync que
  // ce mouvement hiérarchique doit être préservé. Les ancêtres (le nouveau parent
  // et potentiellement ses propres ancêtres) reçoivent aussi une marque de modification.
  touchUpdatedAt(src.srcTask.id);

  if (targetTaskId) {
    treeCollapsed[targetTaskId] = false;
    localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
  }

  saveTasks();
  dragSrcIndex     = null;
  dragListRef      = null;
  activeDragTaskId = null;
  treeDragTaskId   = null;

  const movedIsCurrentTask = navigationStack.length > 1 &&
    navigationStack[navigationStack.length - 1].taskId === src.srcId;
  if (movedIsCurrentTask) {
    navigationStack.pop();
    const parentEntry = navigationStack[navigationStack.length - 1];
    if (parentEntry.taskId) {
      const parentTask = findTaskById(rootTasks, parentEntry.taskId);
      activeTreeTaskId = parentEntry.taskId;
      renderTree();
      if (parentTask) showDetail(parentTask); else showList();
    } else {
      activeTreeTaskId = null;
      renderTree();
      showList();
    }
    return;
  }

  const movedIsAncestor = navigationStack.some(e => e.taskId === src.srcId);
  if (movedIsAncestor) {
    navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
    activeTreeTaskId = null;
    renderTree();
    showList();
  } else {
    renderTree();
    // Si on était en mode recherche, relance la recherche pour refléter le déplacement
    if (!searchView.classList.contains('hidden')) {
      runSearch();
    } else if (navigationStack.length === 1) {
      renderList(taskListEl, rootTasks);
    } else {
      const currentEntry = navigationStack[navigationStack.length - 1];
      const currentTask = findTaskById(rootTasks, currentEntry.taskId);
      if (currentTask) {
        currentEntry.tasks = currentTask.children;
        renderList(subTaskListEl, currentTask.children);
      } else {
        navigationStack = [{ tasks: rootTasks, title: 'Tâches', taskId: null }];
        activeTreeTaskId = null;
        renderTree();
        showList();
      }
    }
  }
}

/**
 * Initialise la gestion drop de la sidebar via event delegation.
 * Appelé une seule fois à l'init — robuste aux re-renders de renderTree().
 */
function initTreeDropDelegation() {
  // Stocke la tree-row actuellement survolée pour gérer dragleave proprement
  let currentDropRow = null;

  sidebarTree.addEventListener('dragover', (e) => {
    if (!activeDragTaskId && !treeDragTaskId) return;

    const row = e.target.closest('.tree-row');
    if (!row) { clearTreeDropHighlight(); clearExpandTimer(); return; }

    const src = resolveDragSource();
    if (!src) return;

    // Détermine la cible (racine ou nœud)
    const isRoot = row.classList.contains('tree-root-node');
    let targetList, targetTaskId, targetTask;

    if (isRoot) {
      if (src.srcList === rootTasks) return; // déjà à la racine
      targetList   = rootTasks;
      targetTaskId = null;
    } else {
      const taskId = parseInt(row.dataset.taskId);
      if (!taskId) return;
      targetTask = findTaskById(rootTasks, taskId);
      if (!targetTask) return;
      if (isDescendantOrSelf(taskId, src.srcId, rootTasks)) return;
      if (src.srcList === targetTask.children) return;
      targetList   = targetTask.children;
      targetTaskId = taskId;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';

    if (currentDropRow !== row) {
      clearTreeDropHighlight();
      clearExpandTimer();
      currentDropRow = row;
      row.classList.add('drop-target');
    }

    // Timer d'expansion automatique des nœuds repliés
    if (targetTask && treeCollapsed[targetTaskId] && targetTask.children.length > 0) {
      if (!expandTimer) {
        expandTimer = setTimeout(() => {
          treeCollapsed[targetTaskId] = false;
          localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
          const childContainer = row.closest('.tree-node')?.querySelector('.tree-children');
          if (childContainer) childContainer.classList.remove('collapsed');
          const toggle = row.querySelector('.tree-toggle');
          if (toggle) toggle.className = 'tree-toggle open';
          expandTimer = null;
        }, EXPAND_DELAY);
      }
    } else if (!targetTask || !treeCollapsed[targetTaskId]) {
      clearExpandTimer();
    }
  });

  sidebarTree.addEventListener('dragleave', (e) => {
    if (!sidebarTree.contains(e.relatedTarget)) {
      clearTreeDropHighlight();
      clearExpandTimer();
      currentDropRow = null;
    }
  });

  sidebarTree.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    clearExpandTimer();
    clearTreeDropHighlight();
    currentDropRow = null;

    const src = resolveDragSource();
    if (!src) return;

    const row = e.target.closest('.tree-row');
    if (!row) return;

    if (row.classList.contains('tree-root-node')) {
      if (src.srcList !== rootTasks) performTreeDrop(src, rootTasks, null);
    } else {
      const taskId = parseInt(row.dataset.taskId);
      if (!taskId) return;
      const targetTask = findTaskById(rootTasks, taskId);
      if (!targetTask) return;
      performTreeDrop(src, targetTask.children, taskId);
    }
  });
}

/** No-op : les drop handlers sont désormais gérés par initTreeDropDelegation(). */
function attachTreeDropHandlers(row, targetTask, childContainer) {}
function attachRootDropHandlers(rootRow) {}

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
     // Le titre a changé : touchUpdatedAt() marque la tâche ET tous ses ancêtres
     // dans l'arbre comme modifiés. Cela garantit que la sync verra cette tâche
     // (et potentiellement sa structure hiérarchique) comme fraîchement éditée.
     touchUpdatedAt(task.id);
     // Met à jour l'entrée correspondante dans la pile de navigation
    const entry = navigationStack[navigationStack.length - 1];
    entry.title = newText;
    saveTasks();
    detailTitle.textContent = newText;
    detailTitle.onclick = () => startEditTitle(task);
    renderBreadcrumb();
    renderTree();
    // Rafraîchit la liste racine en arrière-plan (elle est masquée mais doit être à jour)
    // La liste de sous-tâches (subTaskListEl) n'est pas touchée : elle affiche déjà
    // correctement les enfants de la tâche courante.
    renderList(taskListEl, rootTasks);
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
  if (!taskId) return;

  const task = findTaskById(rootTasks, taskId);

  // Détermine le parentId : l'avant-dernier niveau de la pile
  const parentEntry = navigationStack.length >= 2
    ? navigationStack[navigationStack.length - 2]
    : null;
  const parentId = parentEntry ? (parentEntry.taskId ?? null) : null;

  const parentList = findParentList(rootTasks, taskId);
  if (!parentList) return;

  trashTask(task, parentList, parentId);
  updateTrashBadge();

  // Remonte d'un niveau dans la navigation
  navigationStack.pop();
  if (navigationStack.length === 1) {
    activeTreeTaskId = null;
    renderTree();
    showList();
  } else {
    const prevEntry  = navigationStack[navigationStack.length - 1];
    const prevTask   = findTaskById(rootTasks, prevEntry.taskId);
    activeTreeTaskId = prevEntry.taskId;
    renderTree();
    if (prevTask) showDetail(prevTask); else showList();
  }
});

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
    if (clickAccum.timer) { clearTimeout(clickAccum.timer); doFlush(); }
    clickAccum = { taskId, count: 0, timer: null, getList, listEl };
  }
  clickAccum.count += 1;

  const tasks   = getList();
  const liveIdx = tasks.findIndex(t => t.id === taskId);
  if (liveIdx !== -1) {
    tasks[liveIdx].clicks += 1;
    saveTasks();
  }

  clearTimeout(clickAccum.timer);
  clickAccum.timer = setTimeout(doFlush, CLICK_DELAY);
}

/**
 * Applique le déplacement accumulé : remonte la tâche de `count` positions.
 */
function doFlush() {
  if (!clickAccum.taskId || clickAccum.count === 0) {
    clickAccum = { taskId: null, count: 0, timer: null, getList: null, listEl: null };
    return;
  }
  const { taskId, count, getList, listEl } = clickAccum;
  clickAccum = { taskId: null, count: 0, timer: null, getList: null, listEl: null };

  const tasks = getList();
  const cur   = tasks.findIndex(t => t.id === taskId);

  if (cur > 0) {
    const newIdx = Math.max(0, cur - count);
    const [moved] = tasks.splice(cur, 1);
    tasks.splice(newIdx, 0, moved);
    // Après accumulation de clics, la tâche a remontée dans la priorité (ordre).
    // touchUpdatedAt() marque ce changement de position pour que la sync sache
    // que cet ordre prioritaire doit prévaloir sur les données distantes.
    touchUpdatedAt(moved.id);
    saveTasks();
    renderList(listEl, tasks);
    renderTree();
  } else {
    renderList(listEl, tasks);
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
  const now = Date.now();
  // updatedAt posé dès la création : le merge distant saura que cette tâche
  // est plus récente que toute version antérieure sans timestamp.
  return { id: now, text: text.trim(), clicks: 0, notes: '', children: [], updatedAt: now,
           dueDate: '', importance: 'low' };
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
// Affiche le bandeau d'options dès que le champ reçoit le focus.
// Cela permet à l'utilisateur de cocher un filtre urgence AVANT de taper du texte.
// Le bandeau disparaît si l'utilisateur quitte le champ sans critère (via closeSearch).
searchInput.addEventListener('focus', () => {
  searchOptions.classList.remove('hidden');
});

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  // Si le champ est vide ET qu'aucun filtre urgence n'est coché → ferme la recherche.
  // Si un filtre urgence est coché, on garde la recherche ouverte même sans texte.
  if (!q && !searchUrgent.checked && !searchWarning.checked) { closeSearch(); return; }
  searchTimer = setTimeout(runSearch, 200);
});

searchAllLevels.addEventListener('change', runSearch);
searchInNotes.addEventListener('change',   runSearch);
searchClose.addEventListener('click',      closeSearch);

// Les filtres urgence déclenchent immédiatement une (re)recherche.
// Si on décoche le dernier filtre ET que le champ est vide → fermeture.
searchUrgent.addEventListener('change', () => {
  if (!searchUrgent.checked && !searchWarning.checked && !searchInput.value.trim()) {
    closeSearch();
  } else {
    runSearch();
  }
});
searchWarning.addEventListener('change', () => {
  if (!searchUrgent.checked && !searchWarning.checked && !searchInput.value.trim()) {
    closeSearch();
  } else {
    runSearch();
  }
});

/**
 * Lance la recherche et affiche les résultats dans la vue recherche.
 *
 * Logique combinée texte + urgence :
 *   - Texte seul       : filtre par titre/notes (comportement historique)
 *   - Urgence seul     : affiche TOUTES les tâches de la couleur sélectionnée
 *                        (pas de filtre textuel, tous les niveaux)
 *   - Texte + urgence  : intersection — résultats textuels ET de la bonne couleur
 *
 * Quand les deux filtres urgence sont cochés simultanément, on retourne l'union
 * (toutes les tâches urgentes ET importantes), ce qui est plus utile que
 * l'intersection (qui serait vide puisqu'une tâche ne peut pas être les deux).
 */
function runSearch() {
  const q          = searchInput.value.trim();
  const allLevels  = searchAllLevels.checked;
  const inNotes    = searchInNotes.checked;
  const filterUrg  = searchUrgent.checked;    // filtre 🔴 urgentes
  const filterWarn = searchWarning.checked;   // filtre 🟠 importantes
  const needle     = q.toLowerCase();

  // Aucun critère → on ferme
  if (!q && !filterUrg && !filterWarn) { closeSearch(); return; }

  // ── Étape 1 : collecte du pool de candidats ────────────────────────────
  // Si un filtre urgence est actif, on parcourt TOUJOURS tous les niveaux pour
  // ne pas manquer des tâches urgentes enfouies dans des sous-tâches.
  // Si seul le texte est actif, on respecte l'option "tous les niveaux".
  let candidates;
  if (filterUrg || filterWarn) {
    // Toujours tous les niveaux quand un filtre urgence est coché
    candidates = searchAll(rootTasks, needle, inNotes, '');
    if (!q) {
      // Pas de texte : on prend TOUTES les tâches de tous les niveaux comme candidats
      // (searchAll avec needle vide retournerait [] car matchTask teste le texte)
      candidates = collectAllTasksFlat(rootTasks, '');
    }
  } else if (allLevels) {
    candidates = searchAll(rootTasks, needle, inNotes, '');
  } else {
    const currentList = navigationStack[navigationStack.length - 1].tasks;
    const prefix = navigationStack.length > 1
      ? navigationStack.slice(1).map(e => e.title).join(' › ')
      : '';
    candidates = searchLevel(currentList, needle, inNotes, prefix);
  }

  // ── Étape 2 : filtre par urgence ───────────────────────────────────────
  // On applique le filtre couleur après la collecte textuelle.
  // Les deux filtres cochés = union (urgent OU warning), plus utile que l'intersection.
  if (filterUrg || filterWarn) {
    candidates = candidates.filter(task => {
      const cls = taskUrgencyClass(task);
      if (filterUrg  && cls === 'task-urgent')  return true;
      if (filterWarn && cls === 'task-warning') return true;
      return false;
    });
  }

  showSearch();

  // ── Étape 3 : construction du hint ────────────────────────────────────
  const scopeParts = [];
  if (q) scopeParts.push((filterUrg || filterWarn || allLevels) ? 'tous les niveaux' : 'niveau courant');
  if (inNotes && q) scopeParts.push('notes');
  if (filterUrg)  scopeParts.push('🔴 urgentes');
  if (filterWarn) scopeParts.push('🟠 importantes');
  searchHint.textContent = `${candidates.length} résultat(s) — filtres : ${scopeParts.join(' + ') || 'aucun'}`;

  // ── Étape 4 : rendu ───────────────────────────────────────────────────
  searchList.innerHTML = '';
  candidates.forEach((task, index) => {
    searchList.appendChild(buildTaskItem(task, index, candidates, searchList, true));
  });
}

/**
 * Collecte récursivement TOUTES les tâches de l'arborescence (sans filtre textuel).
 * Utilisé quand un filtre urgence est coché sans texte de recherche.
 * Chaque tâche reçoit un `_path` indiquant son emplacement dans l'arbre.
 *
 * @param {Task[]} tasks       - Tableau à parcourir
 * @param {string} pathPrefix  - Chemin accumulé depuis la racine
 * @returns {Task[]}           - Copies plates avec `_path` injecté
 */
function collectAllTasksFlat(tasks, pathPrefix) {
  let results = [];
  for (const t of tasks) {
    const path = pathPrefix ? pathPrefix + ' › ' + t.text : t.text;
    results.push({ ...t, _path: pathPrefix || 'Racine' });
    if (t.children.length > 0) {
      results = results.concat(collectAllTasksFlat(t.children, path));
    }
  }
  return results;
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
   CORBEILLE UI — Modale de consultation et restauration
════════════════════════════════════════════════════════════ */

/**
 * Met à jour le badge numérique sur le bouton corbeille de la topbar.
 * Affiche le nombre d'éléments en corbeille, masque le badge si vide.
 */
function updateTrashBadge() {
  const badge = document.getElementById('trashBadge');
  if (!badge) return;
  if (trashItems.length === 0) {
    badge.classList.add('hidden');
  } else {
    badge.textContent = trashItems.length;
    badge.classList.remove('hidden');
  }
}

/** Formate un timestamp en "il y a X jours/heures/minutes". */
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const min  = Math.floor(diff / 60000);
  const h    = Math.floor(diff / 3600000);
  const d    = Math.floor(diff / 86400000);
  if (d > 0)  return `il y a ${d} jour${d > 1 ? 's' : ''}`;
  if (h > 0)  return `il y a ${h} heure${h > 1 ? 's' : ''}`;
  if (min > 0) return `il y a ${min} min`;
  return "à l'instant";
}

/** Construit et affiche la liste des éléments en corbeille dans la modale. */
function renderTrashList() {
  const list      = document.getElementById('trashList');
  const emptyMsg  = document.getElementById('trashEmpty');
  const countEl   = document.getElementById('trashCount');
  if (!list) return;

  list.innerHTML = '';
  if (countEl) countEl.textContent = trashItems.length ? `(${trashItems.length})` : '';

  if (trashItems.length === 0) {
    emptyMsg && emptyMsg.classList.remove('hidden');
    return;
  }
  emptyMsg && emptyMsg.classList.add('hidden');

  // Trie par date de suppression décroissante : la tâche la plus récemment
  // supprimée apparaît en premier. On trie une copie superficielle du tableau
  // (slice) pour ne pas modifier l'ordre de trashItems en mémoire —
  // l'ordre interne de trashItems n'a pas d'importance, seul l'affichage change.
  const sorted = trashItems.slice().sort((a, b) => b.deletedAt - a.deletedAt);

  sorted.forEach(entry => {
    const li = document.createElement('li');
    li.className = 'trash-item';

    const info = document.createElement('div');
    info.className = 'trash-item-info';

    const name = document.createElement('span');
    name.className = 'trash-item-name';
    name.textContent = entry.task.text;

    const meta = document.createElement('span');
    meta.className = 'trash-item-meta';
    const parentTask = entry.parentId ? findTaskById(rootTasks, entry.parentId) : null;
    const parentLabel = parentTask ? `dans « ${parentTask.text} »` : 'à la racine';
    const subCount = entry.task.children && entry.task.children.length
      ? ` · ${entry.task.children.length} sous-tâche(s)` : '';
    meta.textContent = `${timeAgo(entry.deletedAt)} · ${parentLabel}${subCount}`;

    info.appendChild(name);
    info.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'trash-item-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn-restore';
    restoreBtn.textContent = '↩ Restaurer';
    restoreBtn.addEventListener('click', () => {
      restoreTask(entry);
      updateTrashBadge();
      renderTrashList();
      renderTree();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'btn-delete-forever';
    deleteBtn.textContent = '✕';
    deleteBtn.title = 'Supprimer définitivement';
    deleteBtn.addEventListener('click', () => {
      deleteForever(entry);
      updateTrashBadge();
      renderTrashList();
    });

    actions.appendChild(restoreBtn);
    actions.appendChild(deleteBtn);
    li.appendChild(info);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

/** Initialise les événements de la modale corbeille. */
function initTrashUI() {
  const modal      = document.getElementById('trashModal');
  const openBtn    = document.getElementById('trashBtn');
  const closeBtn   = document.getElementById('trashModalClose');
  const emptyBtn   = document.getElementById('emptyTrashBtn');
  if (!modal || !openBtn) return;

  openBtn.addEventListener('click', () => {
    renderTrashList();
    modal.classList.remove('hidden');
  });
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  emptyBtn.addEventListener('click', () => {
    if (!trashItems.length) return;
    if (!confirm('Supprimer définitivement tous les éléments de la corbeille ?')) return;
    emptyTrash();
    updateTrashBadge();
    renderTrashList();
  });
}

/* ═══════════════════════════════════════════════════════════
   UTILS — Fonctions utilitaires
════════════════════════════════════════════════════════════ */

/**
 * Met à jour le champ `updatedAt` d'une tâche et de tous ses ancêtres
 * dans l'arbre rootTasks, afin que le merge last-write-wins soit correct.
 *
 * À appeler après toute mutation d'une tâche (titre, notes, déplacement…)
 * avant saveTasks().
 *
 * @param {number} taskId - Id de la tâche modifiée
 */
function touchUpdatedAt(taskId) {
  const now = Date.now();
  function touch(list) {
    for (const t of list) {
      if (t.id === taskId) { t.updatedAt = now; return true; }
      if (touch(t.children)) { t.updatedAt = now; return true; }
    }
    return false;
  }
  touch(rootTasks);
}

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
   TOUCH DRAG — Drag & Drop tactile + menu contextuel long press
   ─────────────────────────────────────────────────────────
   Le Drag & Drop HTML5 natif est inopérant sur mobile (iOS/Android).
   On implémente un système complet via les Touch Events.

   COMPORTEMENTS selon le timing d'appui :
   ┌──────────────────────────────────────────────────────────────┐
   │ Mouvement > MOVE_PX dans les SCROLL_BAIL_MS premières ms     │
   │   → scroll natif autorisé, abandon du geste                 │
   │ Appui ≥ LONG_PRESS_MS immobile                               │
   │   → menu contextuel + vibration 20 ms                       │
   │   └→ doigt bouge > DRAG_PX ensuite → menu fermé + drag      │
   │   └→ doigt levé → menu reste visible (choix d'un item)      │
   │ Drag actif → touchend → drop appliqué                        │
   └──────────────────────────────────────────────────────────────┘

   PROBLÈMES MOBILES RÉSOLUS (v1.0.2) :

   1. CLICK FANTÔME après touchend (Android Chrome, Samsung Internet)
      Sur mobile, un appui court génère AUSSI un événement "click"
      synthétique ~300 ms après touchend. Sans protection, ce click remontait
      jusqu'à document.addEventListener('click', hideContextMenu) et fermait
      le menu instantanément après chaque long press.
      SOLUTION : flag _suppressNextClick levé juste avant showContextMenu().
      Le handler global de fermeture l'absorbe sans fermer le menu.

   2. TOUCHCANCEL iOS lors du changement DOM (menu affiché)
      iOS Safari émet automatiquement un touchcancel quand le DOM change
      pendant un touch actif (ex : showContextMenu modifie ctxMenu.innerHTML).
      SOLUTION : onCancel détecte menuShown=true et ré-enregistre les handlers
      sur document sans nettoyer l'état. Les touchmove/touchend suivants sont
      alors bien reçus.

   3. SCROLL INVOLONTAIRE qui annule le long press
      Sur écran scrollable, tout touchmove déclenchait cleanup(), empêchant
      le long press si l'utilisateur bougeait le doigt de 1px pendant l'appui.
      SOLUTION : la fenêtre scroll (SCROLL_BAIL_MS) n'abandonne QUE si le
      doigt s'est déplacé de plus de MOVE_PX px. Après SCROLL_BAIL_MS, le
      long press continue même si le doigt bouge légèrement.

   4. ORPHELINS DE HANDLERS si touchSrcTask introuvable
      Si la tâche n'est pas dans getTasksFn() (rendu obsolète), attachDocHandlers
      était quand même appelé. SOLUTION : vérification touchSrcTask avant attach.

   ARCHITECTURE :
     touchstart  → containerEl (event delegation, enregistré une fois à l'init)
     touchmove / touchend / touchcancel → document (ajoutés/retirés dynamiquement)
     La raison d'utiliser document (pas containerEl) pour move/end/cancel :
     après le touchcancel iOS, les handlers sur containerEl cessent de recevoir
     les events. Sur document, les handlers ré-enregistrés les reçoivent.

   @param {HTMLElement} containerEl  Le <ul> contenant les tâches
   @param {Function}    getTasksFn   Retourne le tableau de tâches courant (live)
════════════════════════════════════════════════════════════ */

/**
 * Flag module-level pour supprimer le prochain événement "click" global.
 * Sur mobile, un touchend génère un click synthétique ~300 ms plus tard.
 * Ce click remonte jusqu'à document.addEventListener('click', hideContextMenu)
 * et fermerait le menu contextuel juste après son ouverture.
 * On lève ce flag avant showContextMenu() et on le consomme dans le handler
 * global de fermeture.
 */
let _suppressNextClick = false;

function initTouchDrag(containerEl, getTasksFn) {

  // ── Constantes ────────────────────────────────────────────────────────────
  const SCROLL_BAIL_MS = 120; // ms : fenêtre pendant laquelle un mouvement = scroll
  const LONG_PRESS_MS  = 550; // ms d'appui immobile → menu contextuel (légèrement
                              // réduit pour paraître plus réactif sur mobile)
  const MOVE_PX        = 8;   // px de mouvement max dans la fenêtre scroll
  const DRAG_PX        = 12;  // px de mouvement après menu → démarre le drag

  // ── État du geste ─────────────────────────────────────────────────────────
  let scrollBailTimer = null;  // setTimeout SCROLL_BAIL_MS
  let longPressTimer  = null;  // setTimeout LONG_PRESS_MS
  let mayScroll       = true;  // true pendant la fenêtre scroll (0 → SCROLL_BAIL_MS)
  let menuShown       = false; // true après l'affichage du menu (long press atteint)
  let canDrag         = false; // true quand le drag visuel est actif
  let touchSrcTask    = null;  // tâche source du geste
  let touchSrcList    = null;  // tableau contenant la tâche source
  let touchGhost      = null;  // clone DOM fixed qui suit le doigt pendant le drag
  let srcLi           = null;  // <li> source (affichée en opacité réduite pendant drag)
  let startX = 0, startY = 0;  // position au touchstart (seuil de scroll)
  let menuX  = 0, menuY  = 0;  // position du doigt quand le menu s'est affiché
  let curX   = 0, curY   = 0;  // dernière position connue du doigt

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Retourne le <li.task-item> situé aux coordonnées (x, y).
   * Masque temporairement le ghost (pointer-events:none n'est pas toujours
   * respecté par elementFromPoint sur tous les navigateurs mobiles).
   */
  function getTaskItemAt(x, y) {
    if (touchGhost) touchGhost.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (touchGhost) touchGhost.style.display = '';
    return el ? el.closest('.task-item') : null;
  }

  /**
   * Crée le ghost visuel : clone fixed du <li>, superposé à l'écran,
   * non interactif. N'est PAS inséré dans la liste → pas de touchcancel iOS.
   */
  function createGhost(li) {
    const r = li.getBoundingClientRect();
    touchGhost = li.cloneNode(true);
    touchGhost.id = 'touchDragGhost';
    Object.assign(touchGhost.style, {
      position:     'fixed',
      left:         r.left + 'px',
      top:          r.top  + 'px',
      width:        r.width + 'px',
      opacity:      '0.78',
      pointerEvents:'none',
      zIndex:       '9999',
      background:   '#eef2ff',
      border:       '2px solid #4f46e5',
      borderRadius: '6px',
      boxShadow:    '0 4px 20px rgba(79,70,229,0.35)',
      transform:    'scale(1.04)',
      transition:   'none',
    });
    document.body.appendChild(touchGhost);
  }

  /** Repositionne le ghost centré horizontalement sous le doigt (-24 px vertical). */
  function moveGhost(x, y) {
    if (!touchGhost) return;
    touchGhost.style.left = (x - touchGhost.offsetWidth / 2) + 'px';
    touchGhost.style.top  = (y - 24) + 'px';
  }

  /**
   * Démarre le drag visuel.
   * On ne modifie PAS la structure DOM de la liste : on crée uniquement
   * un overlay ghost en position:fixed. Cette contrainte est critique pour
   * iOS qui émet un touchcancel supplémentaire dès qu'un nœud est inséré
   * ou retiré du document pendant un touch actif.
   */
  function startDrag() {
    if (!touchSrcTask || canDrag) return;
    canDrag = true;
    if (navigator.vibrate) navigator.vibrate(40);
    document.body.classList.add('dragging-active');
    // Cherche le <li> source dans le DOM courant
    srcLi = containerEl.querySelector(`[data-task-id="${touchSrcTask.id}"]`);
    if (srcLi) {
      srcLi.classList.add('touch-src'); // opacité réduite pour indiquer la source
      createGhost(srcLi);
      moveGhost(curX, curY);
    }
  }

  /**
   * Feedback visuel : calcule dans quel tier (haut/centre/bas) du <li> cible
   * se trouve le doigt et applique la classe CSS correspondante.
   * Haut   → drop-before  (insérer avant la cible)
   * Centre → drop-child   (devenir sous-tâche de la cible)
   * Bas    → drop-after   (insérer après la cible)
   */
  function updateFeedback(x, y) {
    containerEl.querySelectorAll('.task-item').forEach(el =>
      el.classList.remove('drop-before', 'drop-after', 'drop-child'));
    if (!touchSrcTask) return;
    const li = getTaskItemAt(x, y);
    if (!li || li.dataset.taskId === String(touchSrcTask.id)) return;
    const r = li.getBoundingClientRect();
    const rel = y - r.top, third = r.height / 3;
    if      (rel < third)     li.classList.add('drop-before');
    else if (rel > third * 2) li.classList.add('drop-after');
    else                      li.classList.add('drop-child');
  }

  /**
   * Applique le déplacement au moment du relâchement.
   * Gère trois cas : insérer avant la cible, insérer après, ou imbriquer.
   */
  function applyDrop(x, y) {
    const targetLi = getTaskItemAt(x, y);
    if (!targetLi || !touchSrcTask) return;
    if (targetLi.dataset.taskId === String(touchSrcTask.id)) return; // drop sur soi-même

    const tasks  = getTasksFn();
    const srcId  = touchSrcTask.id;
    const destId = parseInt(targetLi.dataset.taskId);
    const srcIdx = tasks.findIndex(t => t.id === srcId);
    let destIdx  = tasks.findIndex(t => t.id === destId);
    if (srcIdx === -1 || destIdx === -1) return; // source ou cible absente de la liste

    if (targetLi.classList.contains('drop-child')) {
      // Imbrication : protection anti-cycle (ne pas dropper sur un descendant)
      if (isDescendantOrSelf(destId, srcId, rootTasks)) return;
      const destTask = tasks[destIdx];
      const [moved]  = tasks.splice(srcIdx, 1);
      destTask.children.unshift(moved);
      // Ouvre le nœud cible dans l'arbre pour montrer le nouvel enfant
      treeCollapsed[destId] = false;
      localStorage.setItem('treeCollapsed', JSON.stringify(treeCollapsed));
      touchUpdatedAt(moved.id); touchUpdatedAt(destTask.id);
    } else {
      const isBefore = targetLi.classList.contains('drop-before');
      const [moved]  = tasks.splice(srcIdx, 1);
      // Recalcul de destIdx après le splice (l'index a pu changer)
      destIdx = tasks.findIndex(t => t.id === destId);
      tasks.splice(isBefore ? destIdx : destIdx + 1, 0, moved);
      touchUpdatedAt(moved.id);
    }
    saveTasks();
    renderList(containerEl, tasks);
    renderTree();
  }

  /**
   * Enregistre les 3 handlers sur document.
   * Appelé au touchstart (premier enregistrement) et dans onCancel quand
   * menuShown=true (ré-enregistrement après le touchcancel iOS causé par le menu).
   * { passive: false } sur touchmove pour pouvoir appeler preventDefault()
   * et bloquer le scroll natif pendant le drag.
   * On passe toujours { capture: false } pour que removeEventListener
   * puisse identifier précisément ces listeners.
   */
  function attachDocHandlers() {
    document.addEventListener('touchmove',   onMove,   { passive: false, capture: false });
    document.addEventListener('touchend',    onEnd,    { passive: true,  capture: false });
    document.addEventListener('touchcancel', onCancel, { passive: true,  capture: false });
  }

  /**
   * Retire les 3 handlers document.
   * IMPORTANT : on passe `false` (= capture: false) et non les options
   * { passive, capture }. removeEventListener identifie un listener
   * uniquement par [fonction, capture] — `passive` est ignoré lors du retrait.
   */
  function detachDocHandlers() {
    document.removeEventListener('touchmove',   onMove,   false);
    document.removeEventListener('touchend',    onEnd,    false);
    document.removeEventListener('touchcancel', onCancel, false);
  }

  /**
   * Nettoyage complet de fin de cycle.
   * Appelé après un drop, un abandon (scroll), un touchcancel système,
   * ou un touchend sans drag actif.
   */
  function cleanup() {
    detachDocHandlers();
    if (touchGhost) { touchGhost.remove(); touchGhost = null; }
    if (srcLi)      { srcLi.classList.remove('touch-src'); srcLi = null; }
    containerEl.querySelectorAll('.task-item').forEach(el =>
      el.classList.remove('drop-before', 'drop-after', 'drop-child'));
    document.body.classList.remove('dragging-active');
    clearTimeout(longPressTimer);  longPressTimer  = null;
    clearTimeout(scrollBailTimer); scrollBailTimer = null;
    mayScroll    = true;
    menuShown    = false;
    canDrag      = false;
    touchSrcTask = null;
    touchSrcList = null;
    // Baisse le flag global : le prochain pointerup sur textWrap pourra
    // de nouveau déclencher handleClick (tap court = clic de priorité).
    _touchGestureActive = false;
  }

  // ── Handlers document ─────────────────────────────────────────────────────

  function onMove(e) {
    if (!e.touches.length) return;
    const t = e.touches[0];
    curX = t.clientX; curY = t.clientY;

    // Phase 1 — Drag actif : le ghost suit le doigt, feedback drop.
    if (canDrag) {
      e.preventDefault(); // indispensable : bloque le scroll natif
      moveGhost(curX, curY);
      updateFeedback(curX, curY);
      return;
    }

    // Phase 2 — Après le menu : le doigt bouge → démarrage du drag si > DRAG_PX.
    if (menuShown) {
      const dist = Math.hypot(curX - menuX, curY - menuY);
      if (dist > DRAG_PX) {
        hideContextMenu();
        menuShown = false;
        startDrag();
        // Les prochains onMove entreront dans la branche "canDrag" ci-dessus.
      }
      // Sous le seuil : on n'agit pas (ni scroll, ni drop prématuré).
      return;
    }

    // Phase 3 — Fenêtre scroll (0 → SCROLL_BAIL_MS) : abandon si déplacement > MOVE_PX.
    if (mayScroll) {
      const dist = Math.hypot(curX - startX, curY - startY);
      if (dist > MOVE_PX) {
        // L'utilisateur veut scroller → on s'efface complètement.
        cleanup();
      }
      // Sous le seuil : on attend encore (ni drag, ni abandon).
      return;
    }

    // Phase 4 — Entre SCROLL_BAIL_MS et LONG_PRESS_MS avec mouvement : on ignore.
    // On ne scrolle plus (mayScroll=false) mais on n'est pas encore en drag.
    // Rien à faire : on attend que le long press se déclenche.
  }

  function onEnd(e) {
    const t = e.changedTouches[0];
    const x = t ? t.clientX : curX;
    const y = t ? t.clientY : curY;

    // Cas 1 — Drag actif → appliquer le drop.
    if (canDrag) {
      applyDrop(x, y);
      cleanup();
      return;
    }

    // Cas 2 — Menu visible et doigt levé (sans avoir dragué) →
    // le menu doit rester visible pour que l'utilisateur tape sur un item.
    // On détache les handlers document mais on ne ferme PAS le menu.
    // Le menu se fermera lui-même via document click ou Échap.
    if (menuShown) {
      detachDocHandlers();
      clearTimeout(longPressTimer);  longPressTimer  = null;
      clearTimeout(scrollBailTimer); scrollBailTimer = null;
      mayScroll           = true;
      touchSrcTask        = null;
      touchSrcList        = null;
      _touchGestureActive = false;
      // menuShown reste true : hideContextMenu le réinitialisera via
      // le handler global (click document), mais seulement après que
      // _suppressNextClick aura absorbé le click fantôme.
      return;
    }

    // Cas 3 — Tap court (< LONG_PRESS_MS, pas de drag) → nettoyage simple.
    // handleClick sera déclenché par pointerup si l'utilisateur a tapé
    // sur le textWrap, car _touchGestureActive sera baissé par cleanup().
    cleanup();
  }

  function onCancel(e) {
    // iOS Safari émet touchcancel quand le DOM est modifié pendant un touch.
    // C'est précisément ce qui se passe quand showContextMenu() remplit ctxMenu.
    //
    // Si menuShown = true : cancel "attendu" causé par l'affichage du menu.
    // On NE réinitialise PAS l'état. On ré-enregistre les handlers sur document
    // pour capturer les touchmove/touchend qui suivront.
    if (menuShown) {
      detachDocHandlers(); // retire d'abord pour éviter les doublons
      attachDocHandlers(); // ré-enregistre : iOS enverra bien les prochains events
      return;
    }

    // Cancel système (appel entrant, alert, etc.) → nettoyage complet.
    cleanup();
  }

  // ── touchstart sur containerEl ────────────────────────────────────────────
  //
  // { passive: false } est OBLIGATOIRE pour permettre à onMove (attaché sur
  // document avec { passive: false }) d'appeler e.preventDefault() afin de
  // bloquer le scroll natif pendant le drag. Certains navigateurs mobiles
  // ignorent preventDefault() dans touchmove si le touchstart correspondant
  // n'était pas déclaré comme non-passif.
  //
  // IMPORTANT : on N'appelle PAS e.preventDefault() ici.
  // Sur iOS Safari, preventDefault() dans touchstart bloque tous les
  // touchmove/touchend ultérieurs — le drag devient impossible.
  // Sur Android, il bloque aussi les taps normaux (scroll, clic sur tâche).
  // La protection contre le "click fantôme" post-long-press est assurée
  // uniquement par le flag _suppressNextClick dans le handler document click.
  containerEl.addEventListener('touchstart', (e) => {
    // Identifie la tâche touchée via event delegation
    const li = e.target.closest('.task-item');
    if (!li) return;

    // Laisse passer les touches sur les contrôles interactifs natifs :
    // boutons, liens, inputs, selects, et les boutons de tâche spécifiques
    // (📋 détail, ✕ supprimer). Sans cette exclusion, appuyer sur ces
    // contrôles déclencherait le long press au lieu de leur comportement natif.
    if (e.target.closest('button, a, input, select, .task-detail-btn, .task-delete')) return;

    cleanup(); // nettoie tout cycle précédent non terminé (robustesse)

    // Lève le flag global AVANT d'attacher les handlers :
    // tout pointerup sur textWrap pendant ce geste sera ignoré par handleClick.
    _touchGestureActive = true;

    const touch = e.touches[0];
    startX = touch.clientX; startY = touch.clientY;
    curX   = touch.clientX; curY   = touch.clientY;

    const tasks  = getTasksFn();
    touchSrcTask = tasks.find(t => t.id === parseInt(li.dataset.taskId)) || null;
    touchSrcList = tasks;

    // Si la tâche n'est pas dans la liste courante (peut arriver après un
    // re-render asynchrone), on abandonne proprement sans attacher de handlers.
    if (!touchSrcTask) {
      _touchGestureActive = false;
      return;
    }

    attachDocHandlers();

    // Fenêtre scroll : pendant SCROLL_BAIL_MS ms, un mouvement > MOVE_PX = scroll.
    mayScroll = true;
    scrollBailTimer = setTimeout(() => {
      scrollBailTimer = null;
      mayScroll = false; // fenêtre scroll expirée : le mouvement ne scrolle plus
    }, SCROLL_BAIL_MS);

    // Long press : si le doigt ne bouge pas trop pendant LONG_PRESS_MS ms →
    // afficher le menu contextuel.
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      clearTimeout(scrollBailTimer); scrollBailTimer = null;
      mayScroll = false;

      // Mémorise la position du doigt au moment exact du déclenchement du menu.
      // Le seuil DRAG_PX (pour démarrer le drag depuis le menu) est calculé
      // depuis cette position, pas depuis startX/Y. Sans ça, les quelques pixels
      // de déplacement accumulés pendant l'appui long fausseraient le seuil.
      menuX = curX; menuY = curY;
      menuShown = true;

      // PROTECTION CLICK FANTÔME :
      // Sur mobile, un touchend après long press génère souvent un "click"
      // synthétique ~300 ms plus tard. Ce click remonterait jusqu'à
      // document.addEventListener('click', hideContextMenu) et fermerait
      // immédiatement notre menu. On lève ce flag AVANT d'afficher le menu
      // pour que le handler global l'absorbe en silence.
      _suppressNextClick = true;

      // Vibration courte : feedback haptique indiquant que le menu va s'ouvrir.
      if (navigator.vibrate) navigator.vibrate(20);

      // Affiche le menu.
      // ATTENTION : showContextMenu() modifie ctxMenu.innerHTML → iOS émettra
      // un touchcancel. onCancel détectera menuShown=true et ré-attachera les
      // handlers sans nettoyer l'état.
      showContextMenu(
        { preventDefault: () => {}, stopPropagation: () => {}, clientX: menuX, clientY: menuY },
        touchSrcTask, touchSrcList, containerEl
      );
    }, LONG_PRESS_MS);

  }, { passive: false });
}

/* ═══════════════════════════════════════════════════════════
   INIT — Point d'entrée
════════════════════════════════════════════════════════════ */

applySidebarState(); // applique l'état mémorisé de la sidebar (repliée ou non)
setupDetailDrag();   // rend la vue détail draggable vers la sidebar

// Affiche le numéro de version dans le pied de la modale de synchronisation.
// APP_VERSION est défini tout en haut du fichier ; on l'injecte ici car le DOM
// est garanti prêt (les scripts sont chargés en bas de <body>).
const syncVersionEl = document.getElementById('syncVersion');
if (syncVersionEl) syncVersionEl.textContent = `MyTaskManager ${APP_VERSION}`;

// Initialise l'UI de synchronisation (modale + indicateur de statut)
if (typeof initSyncUI === 'function') {
  initSyncUI(onSyncUpdate);
  // Sync automatique au démarrage si la sync est activée et qu'on est en ligne
  const cfg = getSyncConfig();
  if (cfg.enabled && navigator.onLine) {
    // On passe AUSSI result.trash à onSyncUpdate pour que la corbeille distante
    // soit chargée en mémoire dès le démarrage (sinon mergedTrash était ignoré).
    syncBidirectional().then(result => {
      if (result.ok && result.tasks) onSyncUpdate(result.tasks, result.trash);
    });
  }
}

// Affiche la popup d'accueil si l'utilisateur ne l'a pas masquée
if (typeof initWelcomeModal === 'function') {
  initWelcomeModal();
}

initTrashUI();             // initialise la modale corbeille
updateTrashBadge();        // affiche le badge si des éléments sont en corbeille
initTreeDropDelegation();  // gestion drop sidebar via event delegation (une seule fois)

// Drag tactile sur la liste racine : getTasksFn lit rootTasks en live
initTouchDrag(taskListEl, () => rootTasks);

// Drag tactile sur la liste de sous-tâches : lit le niveau courant de la navigationStack
initTouchDrag(subTaskListEl, () => navigationStack[navigationStack.length - 1].tasks);

renderTree();              // construit l'arborescence dans la sidebar
showList();                // affiche la liste principale des tâches
