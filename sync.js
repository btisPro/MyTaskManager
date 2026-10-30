/* ═══════════════════════════════════════════════════════════
   SYNC.JS — Synchronisation via GitHub Gist
   ─────────────────────────────────────────────────────────
   Principe :
     • Les tâches sont stockées localement dans localStorage (source
       de vérité pour le mode hors-ligne).
     • Quand la sync est activée, un fichier "tasks.json" est maintenu
       dans un GitHub Gist privé.
     • La stratégie de merge est "last-write-wins" par tâche : chaque
       tâche porte un champ `updatedAt` (timestamp ms). En cas de
       conflit, la version la plus récente l'emporte.
     • La sync est déclenchée automatiquement après chaque sauvegarde
       (avec un debounce pour éviter les appels trop fréquents),
       et au chargement de la page si la sync est activée.
   ─────────────────────────────────────────────────────────
   API GitHub Gist utilisée :
     GET  https://api.github.com/gists/{gist_id}
     PATCH https://api.github.com/gists/{gist_id}
   Authentification : Personal Access Token (scope: gist)
════════════════════════════════════════════════════════════ */

const SYNC_FILENAME      = 'mytaskmanager_tasks.json';
const SYNC_DEBOUNCE      = 3000;       // ms entre deux syncs automatiques
const SYNC_IDLE_INTERVAL = 10 * 60 * 1000; // 10 min sans sync → déclenche une sync si utilisateur actif

/* ── Clés localStorage ── */
const KEY_SYNC_ENABLED = 'sync_enabled';
const KEY_SYNC_TOKEN   = 'sync_token';
const KEY_SYNC_GIST_ID = 'sync_gist_id';
const KEY_SYNC_LAST    = 'sync_last_at';   // timestamp de la dernière sync réussie

/* ── État interne ── */
let syncDebounceTimer  = null;
let syncInProgress     = false;
let _syncIdleTimer     = null;      // timer de vérification toutes les minutes
let _userActiveRecently = false;    // l'utilisateur a interagi dans la dernière minute
let _onTasksUpdatedGlobal = null;   // callback partagé pour la sync sur idle

/* ═══════════════════════════════════════════════════════════
   CONFIGURATION
════════════════════════════════════════════════════════════ */

/** Retourne la configuration de sync stockée dans localStorage. */
function getSyncConfig() {
  return {
    enabled: localStorage.getItem(KEY_SYNC_ENABLED) === 'true',
    token:   localStorage.getItem(KEY_SYNC_TOKEN)   || '',
    gistId:  localStorage.getItem(KEY_SYNC_GIST_ID) || '',
  };
}

/** Sauvegarde la configuration de sync. */
function setSyncConfig({ enabled, token, gistId }) {
  localStorage.setItem(KEY_SYNC_ENABLED, enabled ? 'true' : 'false');
  if (token  !== undefined) localStorage.setItem(KEY_SYNC_TOKEN,   token);
  if (gistId !== undefined) localStorage.setItem(KEY_SYNC_GIST_ID, gistId);
}

/* ═══════════════════════════════════════════════════════════
   TIMESTAMPS — Chaque tâche doit avoir un champ `updatedAt`
   pour permettre le merge intelligent.
════════════════════════════════════════════════════════════ */

/**
 * Ajoute récursivement un champ `updatedAt` aux tâches qui n'en ont pas.
 * Appelé lors du chargement et avant chaque sync.
 */
function ensureTimestamps(tasks, ts) {
  const now = ts || Date.now();
  return tasks.map(t => ({
    ...t,
    updatedAt: t.updatedAt || now,
    children:  ensureTimestamps(t.children || [], now),
  }));
}

/**
 * Met à jour le `updatedAt` d'une tâche et de tous ses parents dans l'arbre.
 * Appelé par app.js après chaque modification d'une tâche.
 * @param {Task[]} tasks  - Arbre de tâches
 * @param {number} taskId - Id de la tâche modifiée
 */
function touchTask(tasks, taskId) {
  const now = Date.now();
  function touch(list) {
    for (const t of list) {
      if (t.id === taskId || touch(t.children)) {
        t.updatedAt = now;
        return true;
      }
    }
    return false;
  }
  touch(tasks);
}

/* ═══════════════════════════════════════════════════════════
   MERGE — Fusion de deux arbres de tâches
   Stratégie : last-write-wins par tâche (basé sur updatedAt).
   Les tâches présentes uniquement dans un côté sont conservées.
════════════════════════════════════════════════════════════ */

/**
 * Fusionne deux listes de tâches.
 * @param {Task[]} local  - Tâches locales
 * @param {Task[]} remote - Tâches distantes (Gist)
 * @returns {Task[]} Liste fusionnée
 */
function mergeTasks(local, remote) {
  const localMap  = new Map(local.map(t => [t.id, t]));
  const remoteMap = new Map(remote.map(t => [t.id, t]));
  const allIds    = new Set([...localMap.keys(), ...remoteMap.keys()]);
  const merged    = [];

  for (const id of allIds) {
    const l = localMap.get(id);
    const r = remoteMap.get(id);

    if (l && r) {
      // Conflit : on garde la version la plus récente
      const winner = (l.updatedAt || 0) >= (r.updatedAt || 0) ? l : r;
      // Merge récursif des enfants
      merged.push({
        ...winner,
        children: mergeTasks(l.children || [], r.children || []),
      });
    } else {
      // Présent d'un seul côté : on le conserve
      const task = l || r;
      merged.push({ ...task, children: task.children || [] });
    }
  }

  // Tri : on respecte l'ordre local en priorité, sinon l'ordre distant
  const localOrder  = local.map(t => t.id);
  const remoteOrder = remote.map(t => t.id);
  merged.sort((a, b) => {
    const ai = localOrder.indexOf(a.id);
    const bi = localOrder.indexOf(b.id);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return remoteOrder.indexOf(a.id) - remoteOrder.indexOf(b.id);
  });

  return merged;
}

/* ═══════════════════════════════════════════════════════════
   GITHUB GIST API
════════════════════════════════════════════════════════════ */

/**
 * Récupère le contenu du Gist.
 * @returns {Task[]|null} Tâches distantes, ou null en cas d'erreur
 */
async function gistGet(token, gistId) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
  const data = await res.json();
  const file = data.files && data.files[SYNC_FILENAME];
  if (!file || !file.content) return { tasks: [], trash: [] };
  const parsed = JSON.parse(file.content);
  // Compatibilité ancien format (tableau pur) → nouveau format { tasks, trash }
  if (Array.isArray(parsed)) return { tasks: parsed, trash: [] };
  return { tasks: parsed.tasks || [], trash: parsed.trash || [] };
}

/**
 * Envoie les tâches dans le Gist (PATCH = mise à jour).
 * @param {Task[]} tasks - Tâches à envoyer
 */
async function gistPush(token, gistId, payload) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: {
        [SYNC_FILENAME]: {
          content: JSON.stringify(payload, null, 2),
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
}

/* ═══════════════════════════════════════════════════════════
   OPÉRATIONS DE SYNC
════════════════════════════════════════════════════════════ */

/**
 * Synchronisation bidirectionnelle (merge + push).
 * 1. Récupère les données distantes
 * 2. Merge avec les données locales
 * 3. Sauvegarde le résultat localement
 * 4. Envoie le résultat dans le Gist
 * @returns {{ ok: boolean, message: string, tasks?: Task[] }}
 */
async function syncBidirectional() {
  const { token, gistId } = getSyncConfig();
  if (!token || !gistId) return { ok: false, message: 'Token ou Gist ID manquant.' };
  if (syncInProgress) return { ok: false, message: 'Sync déjà en cours…' };

  syncInProgress = true;
  setSyncStatus('syncing');
  try {
    const remote     = await gistGet(token, gistId);
    const localTasks = ensureTimestamps(JSON.parse(localStorage.getItem('tasks') || '[]'));
    const remTasks   = ensureTimestamps(remote.tasks || []);
    const merged     = mergeTasks(localTasks, remTasks);

    // Merge de la corbeille : union des deux listes, dédoublonnée par task.id
    const localTrash = JSON.parse(localStorage.getItem('trash') || '[]');
    const remTrash   = remote.trash || [];
    const trashMap   = new Map();
    [...remTrash, ...localTrash].forEach(e => trashMap.set(e.task.id, e));
    const TRASH_TTL  = 30 * 24 * 60 * 60 * 1000;
    const now        = Date.now();
    const mergedTrash = Array.from(trashMap.values())
      .filter(e => now - e.deletedAt < TRASH_TTL);

    localStorage.setItem('tasks', JSON.stringify(merged));
    localStorage.setItem('trash', JSON.stringify(mergedTrash));
    await gistPush(token, gistId, { tasks: merged, trash: mergedTrash });
    localStorage.setItem(KEY_SYNC_LAST, new Date().toISOString());
    setSyncStatus('ok');
    return { ok: true, message: 'Synchronisation réussie.', tasks: merged, trash: mergedTrash };
  } catch (err) {
    setSyncStatus('error');
    return { ok: false, message: `Erreur : ${err.message}` };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Envoi forcé : écrase le Gist avec les données locales.
 * Utile pour initialiser la sync sur un premier appareil.
 */
async function syncPush() {
  const { token, gistId } = getSyncConfig();
  if (!token || !gistId) return { ok: false, message: 'Token ou Gist ID manquant.' };
  if (syncInProgress) return { ok: false, message: 'Sync déjà en cours…' };

  syncInProgress = true;
  setSyncStatus('syncing');
  try {
    const tasks = ensureTimestamps(JSON.parse(localStorage.getItem('tasks') || '[]'));
    const trash = JSON.parse(localStorage.getItem('trash') || '[]');
    localStorage.setItem('tasks', JSON.stringify(tasks));
    await gistPush(token, gistId, { tasks, trash });
    localStorage.setItem(KEY_SYNC_LAST, new Date().toISOString());
    setSyncStatus('ok');
    return { ok: true, message: 'Données envoyées vers le Gist.' };
  } catch (err) {
    setSyncStatus('error');
    return { ok: false, message: `Erreur : ${err.message}` };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Récupération forcée : écrase les données locales avec le Gist.
 * Utile pour initialiser un nouvel appareil.
 * @returns {{ ok: boolean, message: string, tasks?: Task[] }}
 */
async function syncPull() {
  const { token, gistId } = getSyncConfig();
  if (!token || !gistId) return { ok: false, message: 'Token ou Gist ID manquant.' };
  if (syncInProgress) return { ok: false, message: 'Sync déjà en cours…' };

  syncInProgress = true;
  setSyncStatus('syncing');
  try {
    const remote = await gistGet(token, gistId);
    const tasks  = ensureTimestamps(remote.tasks || []);
    const trash  = remote.trash || [];
    localStorage.setItem('tasks', JSON.stringify(tasks));
    localStorage.setItem('trash', JSON.stringify(trash));
    localStorage.setItem(KEY_SYNC_LAST, new Date().toISOString());
    setSyncStatus('ok');
    return { ok: true, message: 'Données récupérées depuis le Gist.', tasks, trash };
  } catch (err) {
    setSyncStatus('error');
    return { ok: false, message: `Erreur : ${err.message}` };
  } finally {
    syncInProgress = false;
  }
}

/**
 * Sync automatique déclenchée après chaque sauvegarde.
 * Utilise un debounce pour éviter les appels trop fréquents.
 * Ne bloque pas l'UI (fire-and-forget).
 */
function syncAuto(onSuccess) {
  const { enabled } = getSyncConfig();
  if (!enabled) return;
  if (!navigator.onLine) { setSyncStatus('offline'); return; }

  clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(async () => {
    const result = await syncBidirectional();
    if (result.ok && result.tasks && onSuccess) {
      onSuccess(result.tasks, result.trash);
    }
  }, SYNC_DEBOUNCE);
}

/* ═══════════════════════════════════════════════════════════
   INDICATEUR DE STATUT
════════════════════════════════════════════════════════════ */

const STATUS = {
  off:     { icon: '⚫', label: 'Local',      cls: 'sync-off'     },
  ok:      { icon: '🟢', label: 'Synchronisé', cls: 'sync-ok'      },
  syncing: { icon: '🔄', label: 'Sync…',       cls: 'sync-pending' },
  error:   { icon: '🔴', label: 'Erreur sync', cls: 'sync-error'   },
  offline: { icon: '🟡', label: 'Hors-ligne',  cls: 'sync-offline' },
};

/**
 * Met à jour l'indicateur de statut dans la topbar.
 * @param {'off'|'ok'|'syncing'|'error'|'offline'} state
 */
function setSyncStatus(state) {
  const el    = document.getElementById('syncStatus');
  const icon  = document.getElementById('syncIcon');
  const label = document.getElementById('syncLabel');
  if (!el || !icon || !label) return;

  const s = STATUS[state] || STATUS.off;
  icon.textContent  = s.icon;
  label.textContent = s.label;
  el.className      = `sync-status ${s.cls}`;
}

/* ═══════════════════════════════════════════════════════════
   INTERFACE — Modale paramètres
════════════════════════════════════════════════════════════ */

/**
 * Initialise la modale de paramètres de sync.
 * Appelé une seule fois au chargement de la page.
 * @param {Function} onTasksUpdated - Callback appelé quand les tâches changent suite à une sync
 */
function initSyncUI(onTasksUpdated) {
  const modal         = document.getElementById('syncModal');
  const openBtn       = document.getElementById('syncSettingsBtn');
  const closeBtn      = document.getElementById('syncModalClose');
  const enabledCb     = document.getElementById('syncEnabled');
  const fields        = document.getElementById('syncFields');
  const tokenInput    = document.getElementById('syncToken');
  const gistIdInput   = document.getElementById('syncGistId');
  const syncNowBtn    = document.getElementById('syncNowBtn');
  const syncPushBtn   = document.getElementById('syncPushBtn');
  const syncPullBtn   = document.getElementById('syncPullBtn');
  const log           = document.getElementById('syncLog');

  if (!modal) return;

  /* ── Charge la config enregistrée ── */
  function loadUI() {
    const cfg = getSyncConfig();
    enabledCb.checked   = cfg.enabled;
    tokenInput.value    = cfg.token;
    gistIdInput.value   = cfg.gistId;
    fields.classList.toggle('hidden', !cfg.enabled);
    setSyncStatus(cfg.enabled ? 'ok' : 'off');

    const last = localStorage.getItem(KEY_SYNC_LAST);
    if (last) {
      const d = new Date(last);
      logMsg(`Dernière sync : ${d.toLocaleString()}`, 'info');
    }
  }

  function logMsg(msg, type = 'info') {
    if (!log) return;
    const p = document.createElement('p');
    p.className = `log-${type}`;
    p.textContent = `${new Date().toLocaleTimeString()} — ${msg}`;
    log.prepend(p);
    // Garde uniquement les 10 derniers messages
    while (log.children.length > 10) log.removeChild(log.lastChild);
  }

  /* ── Ouverture / fermeture ── */
  openBtn.addEventListener('click',  () => { loadUI(); modal.classList.remove('hidden'); });
  closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') modal.classList.add('hidden'); });

  /* ── Activation / désactivation ── */
  enabledCb.addEventListener('change', () => {
    const enabled = enabledCb.checked;
    setSyncConfig({ enabled, token: tokenInput.value, gistId: gistIdInput.value });
    fields.classList.toggle('hidden', !enabled);
    setSyncStatus(enabled ? 'ok' : 'off');
  });

  /* ── Sauvegarde auto du token et gistId au changement ── */
  [tokenInput, gistIdInput].forEach(input => {
    input.addEventListener('change', () => {
      setSyncConfig({ enabled: enabledCb.checked, token: tokenInput.value, gistId: gistIdInput.value });
    });
  });

  /* ── Boutons d'action ── */
  syncNowBtn.addEventListener('click', async () => {
    setSyncConfig({ enabled: true, token: tokenInput.value, gistId: gistIdInput.value });
    logMsg('Synchronisation bidirectionnelle…');
    const result = await syncBidirectional();
    logMsg(result.message, result.ok ? 'ok' : 'error');
    if (result.ok && result.tasks) onTasksUpdated(result.tasks, result.trash);
  });

  syncPushBtn.addEventListener('click', async () => {
    setSyncConfig({ enabled: true, token: tokenInput.value, gistId: gistIdInput.value });
    logMsg('Envoi des données locales…');
    const result = await syncPush();
    logMsg(result.message, result.ok ? 'ok' : 'error');
  });

  syncPullBtn.addEventListener('click', async () => {
    setSyncConfig({ enabled: true, token: tokenInput.value, gistId: gistIdInput.value });
    if (!confirm('Remplacer les données locales par celles du Gist ? Les modifications locales non synchronisées seront perdues.')) return;
    logMsg('Récupération des données distantes…');
    const result = await syncPull();
    logMsg(result.message, result.ok ? 'ok' : 'error');
    if (result.ok && result.tasks) onTasksUpdated(result.tasks, result.trash);
  });

  /* ── Clic sur l'indicateur de statut = sync forcée ── */
  const syncStatusEl = document.getElementById('syncStatus');
  if (syncStatusEl) {
    syncStatusEl.style.cursor = 'pointer';
    syncStatusEl.title = 'Cliquer pour synchroniser maintenant';
    syncStatusEl.addEventListener('click', async () => {
      const cfg = getSyncConfig();
      if (!cfg.enabled) { modal.classList.remove('hidden'); loadUI(); return; }
      if (!navigator.onLine) { setSyncStatus('offline'); return; }
      logMsg('Synchronisation forcée (clic sur le statut)…');
      const result = await syncBidirectional();
      logMsg(result.message, result.ok ? 'ok' : 'error');
      if (result.ok && result.tasks) onTasksUpdated(result.tasks);
    });
  }

  /* ── Détection du statut réseau ── */
  window.addEventListener('online',  () => { if (getSyncConfig().enabled) setSyncStatus('ok'); });
  window.addEventListener('offline', () => { if (getSyncConfig().enabled) setSyncStatus('offline'); });

  /* ── État initial ── */
  const cfg = getSyncConfig();
  setSyncStatus(cfg.enabled ? (navigator.onLine ? 'ok' : 'offline') : 'off');

  /* ── Sync automatique sur inactivité > 10 min ── */
  _onTasksUpdatedGlobal = onTasksUpdated;
  _startIdleSyncWatcher();
}

/* ═══════════════════════════════════════════════════════════
   SYNC SUR IDLE — déclenche une sync si l'utilisateur est
   actif et que la dernière sync date de plus de 10 minutes.
════════════════════════════════════════════════════════════ */

/**
 * Démarre le watcher de sync sur idle.
 * Vérifie toutes les minutes si une sync est nécessaire.
 */
function _startIdleSyncWatcher() {
  const ACTIVITY_EVENTS = ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'];

  ACTIVITY_EVENTS.forEach(evt => {
    window.addEventListener(evt, () => { _userActiveRecently = true; }, { passive: true });
  });

  _syncIdleTimer = setInterval(async () => {
    if (!_userActiveRecently) return;
    _userActiveRecently = false;

    const { enabled } = getSyncConfig();
    if (!enabled || !navigator.onLine || syncInProgress) return;

    const lastStr = localStorage.getItem(KEY_SYNC_LAST);
    const lastMs  = lastStr ? new Date(lastStr).getTime() : 0;
    if (Date.now() - lastMs < SYNC_IDLE_INTERVAL) return;

    const result = await syncBidirectional();
    if (result.ok && result.tasks && _onTasksUpdatedGlobal) {
      _onTasksUpdatedGlobal(result.tasks, result.trash);
    }
  }, 60 * 1000);
}

/* ═══════════════════════════════════════════════════════════
   POPUP D'ACCUEIL
════════════════════════════════════════════════════════════ */

const KEY_WELCOME_HIDE = 'welcome_hide';

/**
 * Affiche la popup d'accueil si l'utilisateur ne l'a pas masquée.
 * Appelé au chargement de la page.
 */
function initWelcomeModal() {
  const modal      = document.getElementById('welcomeModal');
  const closeX     = document.getElementById('welcomeModalClose');
  const closeBtn   = document.getElementById('welcomeCloseBtn');
  const dontShow   = document.getElementById('welcomeDontShow');
  if (!modal) return;

  function close() {
    if (dontShow && dontShow.checked) {
      localStorage.setItem(KEY_WELCOME_HIDE, 'true');
    }
    modal.classList.add('hidden');
  }

  if (localStorage.getItem(KEY_WELCOME_HIDE) === 'true') return;

  modal.classList.remove('hidden');
  closeX.addEventListener('click',   close);
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}
