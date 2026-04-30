const CACHE_NAME = 'crdms-cache-v18';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.png',
  './lib/dexie.js',
  './lib/tailwind.js',
  './lib/sweetalert2.js',
  './lib/chart.js',
  './lib/supabase.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install Event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching essential assets');
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Activate Event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('Clearing old cache');
            return caches.delete(cache);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Fetch Event
self.addEventListener('fetch', (event) => {
  // Always skip interception for ALL Supabase API requests (always go to network)
  if (event.request.url.includes('supabase.co')) {
    return; // Let the browser handle it normally
  }

  // We want to serve from cache if available, else fetch from network and cache
  event.respondWith(
    caches.match(event.request).then((response) => {
      if (response) {
        return response; // Return from cache
      }

      return fetch(event.request).then((networkResponse) => {
        // Don't cache if not a valid response or if it's a Chrome extension or something external we don't want
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic' && !event.request.url.includes('cdn') && !event.request.url.includes('gstatic')) {
          return networkResponse;
        }

        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });

        return networkResponse;
      }).catch(() => {
        // Offline fallback could go here
      });
    })
  );
});
