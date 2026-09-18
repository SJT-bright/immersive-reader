// 沉浸阅读器 Service Worker：网络优先、缓存兜底（离线仍可打开界面）。
// 数据（书籍/背景/音频/进度）不经过网络，全部在浏览器与本机资料库中。
const CACHE = 'immersive-reader-shell-v2'

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil((async () => {
    for (const key of await caches.keys()) {
        if (key.startsWith('immersive-reader-shell-') && key !== CACHE) await caches.delete(key)
    }
    await self.clients.claim()
})()))

self.addEventListener('fetch', event => {
    const request = event.request
    if (request.method !== 'GET') return
    const url = new URL(request.url)
    if (url.origin !== self.location.origin) return
    if (url.pathname.startsWith('/_reader/')) return // 资料库接口不做缓存
    event.respondWith(
        fetch(request).then(response => {
            if (response && response.ok) {
                const copy = response.clone()
                caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {})
            }
            return response
        }).catch(() =>
            caches.match(request).then(matched => matched || Response.error())
        )
    )
})
