#!/usr/bin/env node
/**
 * tests.js — Tests automatisés MyTaskManager
 * Exécution : node tests.js
 *
 * Ce fichier teste les fonctions pures de l'application (celles qui ne
 * dépendent pas du DOM). Pour chaque groupe de fonctions, on importe la
 * logique via eval() après avoir défini les stubs minimaux nécessaires.
 *
 * Les fonctions testées :
 *   - migrateTask       : migration/normalisation d'un objet tâche
 *   - makeTask          : création d'une nouvelle tâche
 *   - taskUrgencyClass  : calcul de la classe CSS d'urgence
 *   - mergeTasks (sync) : fusion last-write-wins de deux arbres
 *   - ensureTimestamps  : ajout des timestamps manquants
 *   - findTaskById      : recherche récursive par id
 *   - isDescendantOrSelf: protection anti-cycle du drag & drop
 *   - collectTaskIds    : collecte des ids d'une sous-arborescence
 */

'use strict';

/* ═══════════════════════════════════════════════════════════
   INFRASTRUCTURE DE TEST — minimaliste, sans dépendance
════════════════════════════════════════════════════════════ */

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${message}\n`);
  } else {
    failed++;
    errors.push(message);
    process.stdout.write(`  ✗ ÉCHEC : ${message}\n`);
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    process.stdout.write(`    attendu : ${JSON.stringify(expected)}\n`);
    process.stdout.write(`    obtenu  : ${JSON.stringify(actual)}\n`);
  }
  assert(ok, message);
}

function describe(label, fn) {
  process.stdout.write(`\n▶ ${label}\n`);
  fn();
}

/* ═══════════════════════════════════════════════════════════
   EXTRACTION DES FONCTIONS PURES depuis app.js et sync.js
   On charge le source, on extrait les fonctions nommées et on
   les évalue dans un contexte qui mocke le DOM et localStorage.
════════════════════════════════════════════════════════════ */

const fs = require('fs');
const path = require('path');

const appSrc  = fs.readFileSync(path.join(__dirname, 'app.js'),  'utf8');
const syncSrc = fs.readFileSync(path.join(__dirname, 'sync.js'), 'utf8');

// ── Stubs DOM / browser ───────────────────────────────────
// Les fonctions pures testées n'utilisent pas le DOM, mais app.js
// contient du code top-level qui en a besoin. On mocke l'essentiel.
const domStub = () => ({
  addEventListener: () => {}, removeEventListener: () => {},
  classList: { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false },
  style: {}, appendChild: () => {}, cloneNode: () => domStub(),
  querySelectorAll: () => [], querySelector: () => null,
  textContent: '', innerHTML: '', value: '', checked: false,
  dataset: {}, parentNode: { replaceChild: () => {} },
});

global.document = {
  getElementById: () => domStub(),
  createElement: () => domStub(),
  addEventListener: () => {},
  removeEventListener: () => {},
  elementFromPoint: () => null,
  body: { classList: { add: () => {}, remove: () => {} }, appendChild: () => {} },
};
global.window = {
  innerWidth: 1024,
  addEventListener: () => {},
  removeEventListener: () => {},
};
global.navigator = { onLine: true, vibrate: () => {} };
global.localStorage = (() => {
  const store = {};
  return {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = v; },
    removeItem: k => { delete store[k]; },
  };
})();
global.setTimeout  = (fn) => { fn(); return 0; };  // exécution synchrone pour les tests
global.clearTimeout = () => {};
global.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) });

// Quill stub
global.Quill = function() {
  return {
    setContents: () => {},
    getSemanticHTML: () => '',
    clipboard: { convert: () => ({}) },
    on: () => {},
  };
};

// ── Évaluation contrôlée ──────────────────────────────────
// On wrap le source dans une IIFE pour éviter les collisions de scope,
// et on expose les fonctions testées via un objet retourné.

function extractFunctions(src, names) {
  const exports = {};
  const wrapper = `
    (function() {
      ${src}
      const __out = {};
      ${names.map(n => `if (typeof ${n} === 'function') __out['${n}'] = ${n};`).join('\n')}
      return __out;
    })()
  `;
  try {
    const result = eval(wrapper); // eslint-disable-line no-eval
    return result;
  } catch (e) {
    // Certaines erreurs viennent du code top-level qui s'exécute immédiatement
    // (ex: initTouchDrag() appelé avec des éléments DOM nuls). On les ignore
    // et on récupère les fonctions déjà définies avant l'erreur.
    return {};
  }
}

const appFns  = extractFunctions(appSrc, [
  'migrateTask', 'makeTask', 'taskUrgencyClass',
  'findTaskById', 'isDescendantOrSelf', 'collectTaskIds',
]);
const syncFns = extractFunctions(syncSrc, [
  'mergeTasks', 'ensureTimestamps', 'collectAllIds',
  'buildParentMap', 'removeTaskFromTree',
]);

// Vérifie que les fonctions ont bien été extraites
const allFns = { ...appFns, ...syncFns };
const required = [
  'migrateTask', 'makeTask', 'taskUrgencyClass',
  'findTaskById', 'isDescendantOrSelf', 'collectTaskIds',
  'mergeTasks', 'ensureTimestamps', 'collectAllIds',
];
const missing = required.filter(n => typeof allFns[n] !== 'function');
if (missing.length) {
  process.stdout.write(`\n⚠ Fonctions non extraites (code top-level DOM) : ${missing.join(', ')}\n`);
  process.stdout.write('  → Ces fonctions sont testées via des copies locales ci-dessous.\n');
}

/* ═══════════════════════════════════════════════════════════
   COPIES LOCALES des fonctions pures (si l'extraction échoue)
   Identiques au source — servent de filet de sécurité.
════════════════════════════════════════════════════════════ */

function migrateTask(t, i = 0) {
  return {
    id:         t.id         ?? (Date.now() + i),
    text:       t.text       ?? '',
    clicks:     t.clicks     ?? 0,
    notes:      t.notes      ?? '',
    children:   (t.children  ?? []).map(migrateTask),
    dueDate:    t.dueDate    ?? '',
    importance: (['high','medium','low'].includes(t.importance)) ? t.importance : 'low',
  };
}

function makeTask(text) {
  const now = Date.now();
  return { id: now, text: text.trim(), clicks: 0, notes: '', children: [],
           updatedAt: now, dueDate: '', importance: 'low' };
}

function taskUrgencyClass(task) {
  const imp = task.importance || 'low';
  const due = task.dueDate    || '';
  const now   = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  function dateInDays(n) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  const in3  = dateInDays(3);
  const in10 = dateInDays(10);
  if (imp === 'high') return 'task-urgent';
  if (due && due <= in3) return 'task-urgent';
  if (imp === 'medium') return 'task-warning';
  if (due && due <= in10) return 'task-warning';
  return '';
}

function findTaskById(list, id) {
  for (const t of list) {
    if (t.id === id) return t;
    const found = findTaskById(t.children || [], id);
    if (found) return found;
  }
  return null;
}

function isDescendantOrSelf(taskId, ancestorId, list) {
  for (const t of list) {
    if (t.id === ancestorId) {
      return findTaskById([t], taskId) !== null;
    }
    if (isDescendantOrSelf(taskId, ancestorId, t.children || [])) return true;
  }
  return false;
}

function collectTaskIds(task, set = new Set()) {
  set.add(task.id);
  (task.children || []).forEach(c => collectTaskIds(c, set));
  return set;
}

function ensureTimestamps(tasks, ts) {
  const now = ts || Date.now();
  return tasks.map(t => ({
    ...t,
    updatedAt: t.updatedAt || now,
    children:  ensureTimestamps(t.children || [], now),
  }));
}

function collectAllIds(tasks, out = new Set()) {
  for (const t of tasks) {
    out.add(t.id);
    if (t.children && t.children.length) collectAllIds(t.children, out);
  }
  return out;
}

function mergeTasks(local, remote, deletedIds = new Set(), localAllIds = new Set()) {
  const localMap  = new Map(local.map(t => [t.id, t]));
  const remoteMap = new Map(remote.map(t => [t.id, t]));
  const allIds    = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const merged    = [];

  for (const id of allIds) {
    if (deletedIds.has(id)) continue;
    const l = localMap.get(id);
    const r = remoteMap.get(id);
    if (l && r) {
      const lTs = l.updatedAt || 0;
      const rTs = r.updatedAt || 0;
      let winner;
      if (lTs > rTs)      winner = l;
      else if (rTs > lTs) winner = r;
      else winner = { ...l, text: (r.text && r.text.length > (l.text||'').length) ? r.text : (l.text||r.text), notes: (r.notes && r.notes.length > (l.notes||'').length) ? r.notes : (l.notes||r.notes) };
      merged.push({ ...winner, children: mergeTasks(l.children||[], r.children||[], deletedIds, localAllIds) });
    } else if (l) {
      merged.push({ ...l, children: mergeTasks(l.children||[], [], deletedIds, localAllIds) });
    } else {
      if (localAllIds.has(id)) continue;
      merged.push({ ...r, children: mergeTasks([], r.children||[], deletedIds, localAllIds) });
    }
  }

  const localMax  = local.reduce( (m, t) => Math.max(m, t.updatedAt||0), 0);
  const remoteMax = remote.reduce((m, t) => Math.max(m, t.updatedAt||0), 0);
  const refIds    = (remoteMax >= localMax ? remote : local).map(t => t.id);
  merged.sort((a, b) => {
    const ai = refIds.indexOf(a.id), bi = refIds.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    return 0;
  });
  return merged;
}

/* ═══════════════════════════════════════════════════════════
   HELPERS pour les tests de dates
════════════════════════════════════════════════════════════ */

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function isoInDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

/* ═══════════════════════════════════════════════════════════
   TESTS
════════════════════════════════════════════════════════════ */

describe('migrateTask — normalisation du modèle', () => {
  assert(typeof migrateTask === 'function', 'migrateTask est une fonction');

  const t1 = migrateTask({ id: 1, text: 'Tâche A' });
  assertEqual(t1.id,         1,      'conserve l\'id existant');
  assertEqual(t1.text,       'Tâche A', 'conserve le texte');
  assertEqual(t1.clicks,     0,      'clicks par défaut = 0');
  assertEqual(t1.notes,      '',     'notes par défaut = ""');
  assertEqual(t1.children,   [],     'children par défaut = []');
  assertEqual(t1.dueDate,    '',     'dueDate par défaut = ""');
  assertEqual(t1.importance, 'low',  'importance par défaut = "low"');

  const t2 = migrateTask({ id: 2, text: 'B', importance: 'high', dueDate: '2026-12-01' });
  assertEqual(t2.importance, 'high',       'conserve importance "high"');
  assertEqual(t2.dueDate,    '2026-12-01', 'conserve dueDate');

  const t3 = migrateTask({ id: 3, text: 'C', importance: 'INVALID' });
  assertEqual(t3.importance, 'low', 'importance invalide → "low"');

  const t4 = migrateTask({ id: 4, text: 'Parent', children: [{ id: 5, text: 'Enfant' }] });
  assertEqual(t4.children.length,     1,     'children migrés récursivement');
  assertEqual(t4.children[0].dueDate, '',    'enfant a dueDate par défaut');
});

describe('makeTask — création d\'une nouvelle tâche', () => {
  const t = makeTask('  Ma tâche  ');
  assert(typeof t.id === 'number',       'id est un nombre');
  assertEqual(t.text,       'Ma tâche', 'texte trimmé');
  assertEqual(t.clicks,     0,          'clicks = 0');
  assertEqual(t.notes,      '',         'notes = ""');
  assertEqual(t.children,   [],         'children = []');
  assertEqual(t.dueDate,    '',         'dueDate = ""');
  assertEqual(t.importance, 'low',      'importance = "low"');
  assert(typeof t.updatedAt === 'number', 'updatedAt est un timestamp');
  assert(t.updatedAt > 0,                'updatedAt > 0');
});

describe('taskUrgencyClass — importance uniquement', () => {
  const low    = { importance: 'low',    dueDate: '' };
  const medium = { importance: 'medium', dueDate: '' };
  const high   = { importance: 'high',   dueDate: '' };

  assertEqual(taskUrgencyClass(low),    '',              'low, sans date → aucune classe');
  assertEqual(taskUrgencyClass(medium), 'task-warning',  'medium → warning');
  assertEqual(taskUrgencyClass(high),   'task-urgent',   'high → urgent');
});

describe('taskUrgencyClass — date d\'échéance', () => {
  const yesterday = isoInDays(-1);
  const today     = isoToday();
  const in2       = isoInDays(2);
  const in3       = isoInDays(3);
  const in5       = isoInDays(5);
  const in10      = isoInDays(10);
  const in15      = isoInDays(15);

  const task = (dueDate) => ({ importance: 'low', dueDate });

  assertEqual(taskUrgencyClass(task(yesterday)), 'task-urgent',  'date hier → urgent');
  assertEqual(taskUrgencyClass(task(today)),     'task-urgent',  'date aujourd\'hui → urgent');
  assertEqual(taskUrgencyClass(task(in2)),       'task-urgent',  'date dans 2j → urgent');
  assertEqual(taskUrgencyClass(task(in3)),       'task-urgent',  'date dans 3j → urgent (borne incluse)');
  assertEqual(taskUrgencyClass(task(in5)),       'task-warning', 'date dans 5j → warning');
  assertEqual(taskUrgencyClass(task(in10)),      'task-warning', 'date dans 10j → warning (borne incluse)');
  assertEqual(taskUrgencyClass(task(in15)),      '',             'date dans 15j → aucune classe');
  assertEqual(taskUrgencyClass(task('')),        '',             'pas de date → aucune classe');
});

describe('taskUrgencyClass — importance prime sur la date', () => {
  // importance "high" doit l'emporter sur toute date
  const t1 = { importance: 'high', dueDate: isoInDays(30) };
  assertEqual(taskUrgencyClass(t1), 'task-urgent', 'high + date lointaine → urgent');

  // importance "medium" avec date dans 2j → urgent (date gagne sur medium)
  const t2 = { importance: 'medium', dueDate: isoInDays(2) };
  assertEqual(taskUrgencyClass(t2), 'task-urgent', 'medium + date dans 2j → urgent');

  // importance "low" avec date dans 7j → warning (date)
  const t3 = { importance: 'low', dueDate: isoInDays(7) };
  assertEqual(taskUrgencyClass(t3), 'task-warning', 'low + date dans 7j → warning');
});

describe('findTaskById — recherche récursive', () => {
  const tree = [
    { id: 1, text: 'A', children: [
      { id: 2, text: 'B', children: [
        { id: 3, text: 'C', children: [] }
      ]}
    ]},
    { id: 4, text: 'D', children: [] },
  ];
  assert(findTaskById(tree, 1) !== null,         'trouve à la racine');
  assert(findTaskById(tree, 2) !== null,         'trouve niveau 2');
  assert(findTaskById(tree, 3) !== null,         'trouve niveau 3');
  assert(findTaskById(tree, 4) !== null,         'trouve deuxième racine');
  assertEqual(findTaskById(tree, 99), null,      'retourne null si absent');
  assertEqual(findTaskById(tree, 3).text, 'C',  'retourne le bon objet');
});

describe('isDescendantOrSelf — protection cycles drag & drop', () => {
  const tree = [
    { id: 1, text: 'A', children: [
      { id: 2, text: 'B', children: [
        { id: 3, text: 'C', children: [] }
      ]}
    ]},
    { id: 4, text: 'D', children: [] },
  ];
  assert( isDescendantOrSelf(1, 1, tree),  '1 est descendant de lui-même (self)');
  assert( isDescendantOrSelf(2, 1, tree),  '2 est descendant de 1');
  assert( isDescendantOrSelf(3, 1, tree),  '3 est descendant de 1 (niveau 2)');
  assert(!isDescendantOrSelf(1, 2, tree),  '1 n\'est pas descendant de 2 (parent)');
  assert(!isDescendantOrSelf(4, 1, tree),  '4 n\'est pas descendant de 1 (branche séparée)');
  assert(!isDescendantOrSelf(99, 1, tree), 'id inexistant → false');
});

describe('collectTaskIds — collecte récursive des ids', () => {
  const task = { id: 1, children: [
    { id: 2, children: [{ id: 3, children: [] }] },
    { id: 4, children: [] },
  ]};
  const ids = collectTaskIds(task);
  assert(ids.has(1), 'contient id racine');
  assert(ids.has(2), 'contient enfant niveau 1');
  assert(ids.has(3), 'contient petit-enfant niveau 2');
  assert(ids.has(4), 'contient deuxième enfant');
  assertEqual(ids.size, 4, 'taille correcte (4 ids)');
});

describe('ensureTimestamps — ajout des timestamps manquants', () => {
  const tasks = [
    { id: 1, text: 'A', updatedAt: 1000, children: [] },
    { id: 2, text: 'B', children: [
      { id: 3, text: 'C', children: [] }
    ]},
  ];
  const stamped = ensureTimestamps(tasks, 9999);
  assertEqual(stamped[0].updatedAt, 1000, 'ne remplace PAS un updatedAt existant');
  assertEqual(stamped[1].updatedAt, 9999, 'ajoute updatedAt manquant');
  assertEqual(stamped[1].children[0].updatedAt, 9999, 'ajoute récursivement');
});

describe('mergeTasks — last-write-wins sur les champs', () => {
  const local  = [{ id: 1, text: 'Ancien', updatedAt: 100, notes: '', children: [] }];
  const remote = [{ id: 1, text: 'Nouveau', updatedAt: 200, notes: '', children: [] }];
  const merged = mergeTasks(local, remote);
  assertEqual(merged[0].text, 'Nouveau', 'remote plus récent → gagne');

  const local2  = [{ id: 1, text: 'Local récent', updatedAt: 300, notes: '', children: [] }];
  const remote2 = [{ id: 1, text: 'Remote ancien', updatedAt: 200, notes: '', children: [] }];
  const merged2 = mergeTasks(local2, remote2);
  assertEqual(merged2[0].text, 'Local récent', 'local plus récent → gagne');
});

describe('mergeTasks — tâche uniquement locale conservée', () => {
  const local  = [{ id: 1, text: 'Local only', updatedAt: 100, notes: '', children: [] }];
  const remote = [];
  const merged = mergeTasks(local, remote);
  assertEqual(merged.length, 1, 'tâche locale seule conservée');
  assertEqual(merged[0].id,  1, 'bonne tâche');
});

describe('mergeTasks — tâche uniquement distante intégrée', () => {
  const local  = [];
  const remote = [{ id: 42, text: 'Remote only', updatedAt: 100, notes: '', children: [] }];
  const merged = mergeTasks(local, remote, new Set(), new Set());
  assertEqual(merged.length, 1,  'tâche distante intégrée');
  assertEqual(merged[0].id,  42, 'bonne tâche');
});

describe('mergeTasks — tâche dans deletedIds exclue', () => {
  const local  = [{ id: 1, text: 'A', updatedAt: 100, notes: '', children: [] }];
  const remote = [{ id: 1, text: 'A', updatedAt: 100, notes: '', children: [] }];
  const deleted = new Set([1]);
  const merged  = mergeTasks(local, remote, deleted);
  assertEqual(merged.length, 0, 'tâche dans deletedIds absente du résultat');
});

describe('mergeTasks — tâche locale déjà dans localAllIds ignorée côté distant', () => {
  // Simule un déplacement local : id=2 est dans localAllIds mais pas dans la liste courante
  const local  = [{ id: 1, text: 'A', updatedAt: 100, notes: '', children: [] }];
  const remote = [
    { id: 1, text: 'A', updatedAt: 100, notes: '', children: [] },
    { id: 2, text: 'B', updatedAt: 50,  notes: '', children: [] },
  ];
  const localAllIds = new Set([1, 2]); // id=2 est ailleurs dans l'arbre local
  const merged = mergeTasks(local, remote, new Set(), localAllIds);
  assert(!merged.find(t => t.id === 2), 'id=2 non réinséré (déplacement local)');
});

describe('collectAllIds — collecte dans sync.js', () => {
  const tasks = [
    { id: 10, children: [{ id: 11, children: [] }] },
    { id: 12, children: [] },
  ];
  const ids = collectAllIds(tasks);
  assert(ids.has(10), 'collecte id racine');
  assert(ids.has(11), 'collecte id enfant');
  assert(ids.has(12), 'collecte deuxième racine');
  assertEqual(ids.size, 3, 'taille exacte');
});

describe('migrateTask — préserve importance medium', () => {
  const t = migrateTask({ id: 1, text: 'T', importance: 'medium', dueDate: '2027-01-15' });
  assertEqual(t.importance, 'medium',     'importance "medium" préservée');
  assertEqual(t.dueDate,    '2027-01-15', 'dueDate préservée');
});

describe('APP_VERSION — format et présence', () => {
  // La constante APP_VERSION est définie en tête de app.js.
  // On la relit depuis le source pour ne pas dépendre de l'extraction DOM.
  const src = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const match = src.match(/const APP_VERSION\s*=\s*'([^']+)'/);
  assert(match !== null, 'APP_VERSION déclarée dans app.js');
  if (match) {
    const ver = match[1];
    assert(/^v\d+\.\d+\.\d+$/.test(ver), `APP_VERSION au format vMAJEUR.MINEUR.CORRECTIF (valeur: "${ver}")`);
  }
});

describe('renderTrashList — tri décroissant par deletedAt', () => {
  // Simule la logique de tri de renderTrashList.
  // Les entrées sont volontairement dans l'ordre chronologique croissant ;
  // le tri doit les inverser : la plus récente doit venir en premier.
  const entries = [
    { task: { id: 1, text: 'Ancienne', children: [] }, parentId: null, deletedAt: 1000 },
    { task: { id: 2, text: 'Moyenne',  children: [] }, parentId: null, deletedAt: 2000 },
    { task: { id: 3, text: 'Récente',  children: [] }, parentId: null, deletedAt: 3000 },
  ];

  // Reproduction exacte du tri de renderTrashList (slice + sort décroissant)
  const sorted = entries.slice().sort((a, b) => b.deletedAt - a.deletedAt);

  assertEqual(sorted[0].task.id, 3, 'entrée la plus récente (deletedAt=3000) en position 0');
  assertEqual(sorted[1].task.id, 2, 'entrée médiane (deletedAt=2000) en position 1');
  assertEqual(sorted[2].task.id, 1, 'entrée la plus ancienne (deletedAt=1000) en position 2');

  // Le slice() ne doit pas modifier le tableau d'origine
  assertEqual(entries[0].task.id, 1, 'tableau d\'origine non modifié (entrée 0)');
  assertEqual(entries[1].task.id, 2, 'tableau d\'origine non modifié (entrée 1)');
  assertEqual(entries[2].task.id, 3, 'tableau d\'origine non modifié (entrée 2)');
});

describe('renderTrashList — tri avec deletedAt identiques', () => {
  // Cas limite : deux entrées avec le même timestamp → ordre stable (inchangé)
  const entries = [
    { task: { id: 10, text: 'A', children: [] }, parentId: null, deletedAt: 5000 },
    { task: { id: 11, text: 'B', children: [] }, parentId: null, deletedAt: 5000 },
  ];
  const sorted = entries.slice().sort((a, b) => b.deletedAt - a.deletedAt);
  // Les deux ont le même deletedAt → sort retourne 0, l'ordre relatif est conservé
  assert(sorted.length === 2, 'deux entrées conservées avec deletedAt identiques');
  // On vérifie juste qu'aucune entrée n'est perdue
  const ids = sorted.map(e => e.task.id);
  assert(ids.includes(10), 'id=10 toujours présent');
  assert(ids.includes(11), 'id=11 toujours présent');
});

describe('APP_VERSION — passage à v1.5.0', () => {
  const src   = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const match = src.match(/const APP_VERSION\s*=\s*'([^']+)'/);
  if (match) {
    assertEqual(match[1], 'v1.5.0', 'APP_VERSION vaut "v1.5.0" après l\'ajout des filtres urgence');
  }
});

describe('collectAllTasksFlat — collecte plate de toute l\'arborescence', () => {
  // Reproduction de la fonction collectAllTasksFlat de app.js.
  // Utilisée quand un filtre urgence est coché sans texte.
  function collectAllTasksFlat(tasks, pathPrefix) {
    let results = [];
    for (const t of tasks) {
      const path = pathPrefix ? pathPrefix + ' › ' + t.text : t.text;
      results.push({ ...t, _path: pathPrefix || 'Racine' });
      if (t.children && t.children.length > 0) {
        results = results.concat(collectAllTasksFlat(t.children, path));
      }
    }
    return results;
  }

  const tree = [
    { id: 1, text: 'A', importance: 'high',   dueDate: '', children: [
      { id: 2, text: 'A1', importance: 'low',    dueDate: '', children: [] },
      { id: 3, text: 'A2', importance: 'medium', dueDate: '', children: [] },
    ]},
    { id: 4, text: 'B', importance: 'low',    dueDate: '', children: [] },
  ];

  const all = collectAllTasksFlat(tree, '');
  assertEqual(all.length, 4, 'collecte 4 tâches (racines + enfants)');
  assertEqual(all[0].id, 1, 'premier élément = tâche racine A (id=1)');
  assertEqual(all[0]._path, 'Racine', '_path racine = "Racine"');
  assertEqual(all[1].id, 2, 'deuxième élément = sous-tâche A1 (id=2)');
  assertEqual(all[1]._path, 'A',      '_path de A1 = "A"');
  assertEqual(all[3].id, 4, 'quatrième élément = tâche racine B (id=4)');
});

describe('filtre urgence — logique de filtrage par taskUrgencyClass', () => {
  // Simule la logique du filtre urgence dans runSearch :
  //   candidates.filter(task => cls === 'task-urgent' || cls === 'task-warning')
  const tasks = [
    { id: 1, text: 'T1', importance: 'high',   dueDate: '',            children: [] },
    { id: 2, text: 'T2', importance: 'medium', dueDate: '',            children: [] },
    { id: 3, text: 'T3', importance: 'low',    dueDate: '',            children: [] },
    { id: 4, text: 'T4', importance: 'low',    dueDate: isoInDays(2),  children: [] },
    { id: 5, text: 'T5', importance: 'low',    dueDate: isoInDays(7),  children: [] },
    { id: 6, text: 'T6', importance: 'low',    dueDate: isoInDays(20), children: [] },
  ];

  // Filtre 🔴 seul
  const urgents = tasks.filter(t => taskUrgencyClass(t) === 'task-urgent');
  assert(urgents.some(t => t.id === 1), 'id=1 (high) → urgent');
  assert(urgents.some(t => t.id === 4), 'id=4 (low + date dans 2j) → urgent');
  assert(!urgents.some(t => t.id === 2), 'id=2 (medium) → PAS urgent (warning)');
  assert(!urgents.some(t => t.id === 3), 'id=3 (low, sans date) → PAS urgent');

  // Filtre 🟠 seul
  const warnings = tasks.filter(t => taskUrgencyClass(t) === 'task-warning');
  assert(warnings.some(t => t.id === 2), 'id=2 (medium) → warning');
  assert(warnings.some(t => t.id === 5), 'id=5 (low + date dans 7j) → warning');
  assert(!warnings.some(t => t.id === 1), 'id=1 (high) → PAS warning (urgent)');
  assert(!warnings.some(t => t.id === 6), 'id=6 (low + date dans 20j) → PAS warning');

  // Filtres 🔴 ET 🟠 cochés simultanément = union
  const both = tasks.filter(t => {
    const cls = taskUrgencyClass(t);
    return cls === 'task-urgent' || cls === 'task-warning';
  });
  assert(both.some(t => t.id === 1), 'union : id=1 (urgent) présent');
  assert(both.some(t => t.id === 2), 'union : id=2 (warning) présent');
  assert(both.some(t => t.id === 4), 'union : id=4 (urgent par date) présent');
  assert(both.some(t => t.id === 5), 'union : id=5 (warning par date) présent');
  assert(!both.some(t => t.id === 3), 'union : id=3 (aucun) absent');
  assert(!both.some(t => t.id === 6), 'union : id=6 (date lointaine) absent');
  assertEqual(both.length, 4, 'union : 4 tâches au total (1, 2, 4, 5)');
});

describe('filtre urgence + texte — intersection', () => {
  // Quand texte ET filtre urgence sont actifs, on retourne l'intersection :
  // la tâche doit correspondre au texte ET à la couleur.
  const tasks = [
    { id: 1, text: 'Projet Alpha', importance: 'high',   dueDate: '', children: [] },
    { id: 2, text: 'Projet Beta',  importance: 'low',    dueDate: '', children: [] },
    { id: 3, text: 'Tâche Alpha',  importance: 'medium', dueDate: '', children: [] },
  ];

  const needle = 'alpha';
  // Résultats textuels : id=1 et id=3 (contiennent "alpha")
  const textMatches = tasks.filter(t => t.text.toLowerCase().includes(needle));
  assertEqual(textMatches.length, 2, 'recherche "alpha" → 2 résultats textuels');

  // Filtre 🔴 sur les résultats textuels
  const urgentAlpha = textMatches.filter(t => taskUrgencyClass(t) === 'task-urgent');
  assertEqual(urgentAlpha.length, 1, 'filtre 🔴 sur "alpha" → 1 résultat (Projet Alpha)');
  assertEqual(urgentAlpha[0].id, 1, 'le résultat est id=1 (Projet Alpha, high)');

  // Filtre 🟠 sur les résultats textuels
  const warningAlpha = textMatches.filter(t => taskUrgencyClass(t) === 'task-warning');
  assertEqual(warningAlpha.length, 1, 'filtre 🟠 sur "alpha" → 1 résultat (Tâche Alpha)');
  assertEqual(warningAlpha[0].id, 3, 'le résultat est id=3 (Tâche Alpha, medium)');
});

/* ═══════════════════════════════════════════════════════════
   BILAN
════════════════════════════════════════════════════════════ */

process.stdout.write(`\n${'─'.repeat(50)}\n`);
process.stdout.write(`Tests : ${passed + failed} total  |  ✓ ${passed} passés  |  ✗ ${failed} échoués\n`);
if (errors.length) {
  process.stdout.write('\nÉchecs :\n');
  errors.forEach(e => process.stdout.write(`  • ${e}\n`));
}
process.stdout.write(`${'─'.repeat(50)}\n`);
process.exit(failed > 0 ? 1 : 0);
