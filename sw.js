/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER — MyTaskManager
   Stratégie : Network-First pour les fichiers de l'app.
   • En ligne  → toujours récupérer la version la plus récente
                 depuis le serveur, puis mettre à jour le cache.
   • Hors-ligne → servir depuis le cache (mode offline).
   Le cache est versionné : changer CACHE_VERSION invalide
   l'ancien cache et force le téléchargement de tous les fichiers.
════════════════════════════════════════════════════════════ */

const CACHE_VERSION = 'v6';
const CACHE_NAME    = `mytaskmanager-${CACHE_VERSION}`;

const APP_FILES = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './sync.js',
  'https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js',
  'https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css',
];

/* ── Installation : mise en cache initiale ── */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES))
  );
  self.skipWaiting();
});

/* ── Activation : supprime les anciens caches ── */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key.startsWith('mytaskmanager-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

/* ── Fetch : Network-First ── */
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then(networkResponse => {
        if (networkResponse && networkResponse.status === 200) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return networkResponse;
      })
      .catch(() => caches.match(event.request))
  );
});
