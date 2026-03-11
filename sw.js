self.addEventListener('install', (event) => {
    console.log('[Service Worker] Install');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activate');
    event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
    // Cache strategy can be added later or keep it minimal
});
