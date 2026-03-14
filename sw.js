self.addEventListener('install', (event) => {
    console.log('[Service Worker] Install');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[Service Worker] Activate');
    event.waitUntil(clients.claim());
});

const STATIC_CACHE = 'toca-static-v1';
const API_CACHE = 'toca-api-v1';

// Básico: manter fetch "pass-through" para tudo, exceto APIs críticas de chat
self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Apenas mesma origem
    if (url.origin !== self.location.origin) return;

    // Estratégia stale-while-revalidate para lista de conversas / sync leve
    if (url.pathname.startsWith('/api/conversas') || url.pathname.startsWith('/api/chat/sync')) {
        event.respondWith(
            caches.open(API_CACHE).then(async (cache) => {
                const cached = await cache.match(request);
                const networkFetch = fetch(request)
                    .then((response) => {
                        if (response && response.ok) {
                            cache.put(request, response.clone());
                        }
                        return response;
                    })
                    .catch(() => cached);

                // Retorna cache imediatamente, atualiza em background
                return cached || networkFetch;
            })
        );
        return;
    }
});
