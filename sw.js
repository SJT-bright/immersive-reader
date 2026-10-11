// 沉浸阅读器 Service Worker：网络优先、缓存兜底。
// 两条硬规则（都是修出来的，别再改回去）：
//  1) 导航请求绝不从离线缓存回放。旧壳一旦能在服务不可达时启动，它带的是不认识
//     笔记墓碑契约的 db.js，照样往共享 IndexedDB 写整条记录；服务恢复后这条记录
//     落盘，已删划线就复活了。打不开时给明确的「本机服务未启动」提示。
//  2) 缓存名带服务端 version，版本一变整份丢掉；缓存键去掉 ?key= 口令；每个 pathname
//     只留最近 1 份（旧写法名永不升级，每次 ?v= bump 都留下永不再命中的死副本）。
const CACHE_PREFIX = 'immersive-reader-shell-v3'
const HEALTH_PATH = '/_reader/health'
let CACHE = CACHE_PREFIX          // activate 里按 health 的 version 重命名
let serverVersion = null

// 口令只该出现在 x-reader-key 请求头里（js/db.js 负责带头），URL 上的 ?key= 只是
// 用户书签的引导参数，绝不能整条进 Cache Storage 长期落盘。
function cacheKey (request) {
    const url = new URL(request.url)
    if (!url.searchParams.has('key')) return request
    url.searchParams.delete('key')
    return new Request(url.toString(), { method: 'GET' })
}

function offlineNotice () {
    const body = '<!doctype html><meta charset="utf-8"><title>本机服务未启动</title>'
        + '<div style="font:16px/1.7 -apple-system,system-ui,sans-serif;max-width:34em;margin:14vh auto;padding:0 1.5em">'
        + '<h1 style="font-size:1.3em">本机服务未启动</h1>'
        + '<p>这个页面需要本机的阅读服务在跑：书籍、进度、划线都在你自己的电脑上，服务停了就无从读取。</p>'
        + '<p>请打开「沉浸阅读器」应用，或在项目目录里执行 <code>./start.command</code>（macOS）／<code>./start.sh</code>／<code>start.bat</code>（Windows），'
        + '然后回到本页刷新。</p>'
        + '<p style="opacity:.7">为避免用旧版本页面写坏本机资料，离线时不再回放缓存的界面。</p>'
        + '</div>'
    return new Response(body, { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

// 记录服务端 version，并丢掉不属于这个版本的缓存副本。
async function resolveCacheName () {
    try {
        const info = await (await fetch(HEALTH_PATH, { cache: 'no-store' })).json()
        serverVersion = info && info.app === 'immersive-reader' ? String(info.version || '') : ''
    } catch { serverVersion = '' }
    const target = CACHE_PREFIX + (serverVersion ? '@' + serverVersion : '@offline')
    for (const name of await caches.keys()) {
        // 连旧命名的缓存一起清掉（v2 那种永不升级的名字必须能退役，否则死副本留在盘上）
        if (name.startsWith('immersive-reader-shell-') && name !== target) await caches.delete(name)
    }
    CACHE = target
    return target
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', event => event.waitUntil((async () => {
    await resolveCacheName()
    await self.clients.claim()
})()))

// 每个 pathname 只保留最近 1 份副本：?v= 变了就删掉旧的那条，不留死副本。
async function putCached (cache, key, copy) {
    const pathname = new URL(key.url).pathname
    for (const stored of await cache.keys()) {
        try {
            if (stored.url !== key.url && new URL(stored.url).pathname === pathname) await cache.delete(stored)
        } catch { /* 个别脏条目删不掉不影响主流程 */ }
    }
    await cache.put(key, copy)
}

self.addEventListener('fetch', event => {
    const request = event.request
    if (request.method !== 'GET') return
    const url = new URL(request.url)
    if (url.origin !== self.location.origin) return
    if (url.pathname === HEALTH_PATH || url.pathname.startsWith('/_reader/')) return // 资料库接口不做缓存
    if (request.mode === 'navigate') {
        // 见文件头规则 1：导航只走网络，失败就回明确的提示页，绝不回放缓存的旧壳
        event.respondWith(fetch(request).catch(() => offlineNotice()))
        return
    }
    event.respondWith(
        fetch(request).then(response => {
            if (response && response.ok) {
                const copy = response.clone()
                caches.open(CACHE).then(cache => putCached(cache, cacheKey(request), copy)).catch(() => {})
            }
            return response
        }).catch(() =>
            caches.match(cacheKey(request)).then(matched => matched || Response.error())
        )
    )
})
