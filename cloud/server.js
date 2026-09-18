#!/usr/bin/env node
/**
 * 沉浸阅读器 · 云托管动态服务（零依赖，Node >= 16）
 *
 * 提供两部分：
 * 1. 本目录静态站点（index.html / css / js / assets / vendor / licenses）
 * 2. /_reader/library 资料库 API，接口与桌面版 scripts/serve.py 完全一致；
 *    Node >= 22.5 且可用 node:sqlite 时写 SQLite（data/library.sqlite3），
 *    否则自动降级为 JSON 文件（data/library.json）。
 *
 * 环境变量：
 *   PORT             监听端口（默认 8940；托管平台通常自动注入）
 *   HOST             监听地址（默认 0.0.0.0）
 *   READER_DATA_DIR  数据目录（默认 ./data）
 *   READER_STORAGE   强制存储引擎：sqlite | json（默认自动选择）
 *   READER_KEY       访问口令；或把口令写进根目录 key.txt。设置后所有
 *                    /_reader/* 接口要求 ?key=... 或 x-reader-key 头。
 */
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')

const ROOT = __dirname
const PORT = Number(process.env.PORT) || 8940
const HOST = process.env.HOST || '0.0.0.0'
const DATA_DIR = process.env.READER_DATA_DIR || path.join(ROOT, 'data')
const VERSION = '1.7.0'
const KEY = String(process.env.READER_KEY ||
    (fs.existsSync(path.join(ROOT, 'key.txt')) ? fs.readFileSync(path.join(ROOT, 'key.txt'), 'utf8').trim() : ''))

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
    '.gif': 'image/gif', '.ico': 'image/x-icon', '.mp4': 'video/mp4',
    '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
    '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8', '.xhtml': 'application/xhtml+xml',
    '.epub': 'application/epub+zip', '.pdf': 'application/pdf',
}

// ---------- 资料库存储 ----------

function createSqliteStore() {
    const { DatabaseSync } = require('node:sqlite')
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const filename = path.join(DATA_DIR, 'library.sqlite3')
    const legacy = process.env.READER_LEGACY_DATA_DIR && path.join(process.env.READER_LEGACY_DATA_DIR, 'library.sqlite3')
    if (!fs.existsSync(filename) && legacy && fs.existsSync(legacy)) {
        const source = new DatabaseSync(legacy, { readOnly: true })
        try { source.exec("VACUUM INTO '" + filename.replace(/'/g, "''") + "'") } finally { source.close() }
    }
    const db = new DatabaseSync(filename)
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('CREATE TABLE IF NOT EXISTS records (store TEXT, id TEXT, meta TEXT, data BLOB, mime TEXT, PRIMARY KEY(store,id))')
    return {
        engine: 'sqlite',
        list() {
            return db.prepare('SELECT store, meta FROM records').all()
                .map(row => ({ store: row.store, ...JSON.parse(row.meta) }))
        },
        get(store, id) {
            const row = db.prepare('SELECT meta, data, mime FROM records WHERE store = ? AND id = ?').get(store, id)
            if (!row) throw new Error('Record missing')
            return { ...JSON.parse(row.meta), data: Buffer.from(row.data).toString('base64'), mime: row.mime }
        },
        put(store, id, meta, data, mime) {
            db.prepare('INSERT OR REPLACE INTO records VALUES (?, ?, ?, ?, ?)')
                .run(store, id, JSON.stringify(meta), data, mime || 'application/octet-stream')
        },
        meta(store, id, meta, replaceNotes = false) {
            if (store === 'books' && !replaceNotes) {
                const row = db.prepare('SELECT meta FROM records WHERE store=? AND id=?').get(store,id)
                if (row) { const saved=JSON.parse(row.meta); meta = { ...meta, notes:saved.notes || [],lastOpenedAt:Math.max(meta.lastOpenedAt||0,saved.lastOpenedAt||0) } }
            }
            db.prepare('UPDATE records SET meta = ? WHERE store = ? AND id = ?').run(JSON.stringify(meta), store, id)
        },
        del(store, id) {
            db.prepare('DELETE FROM records WHERE store = ? AND id = ?').run(store, id)
        },
    }
}

function createJsonStore() {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const file = path.join(DATA_DIR, 'library.json')
    let state = { records: {} }
    try {
        state = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
        if (error.code !== 'ENOENT') throw error
    }
    let pending = Promise.resolve()
    function persist() {
        pending = pending.then(() => {
            const tmp = file + '.tmp'
            fs.writeFileSync(tmp, JSON.stringify(state))
            fs.renameSync(tmp, file)
        }).catch(error => console.error('[reader] 资料库写入失败:', error.message))
        return pending
    }
    return {
        engine: 'json',
        list() {
            const out = []
            for (const [store, records] of Object.entries(state.records))
                for (const record of Object.values(records)) out.push({ store, ...record.meta })
            return out
        },
        get(store, id) {
            const record = (state.records[store] || {})[id]
            if (!record) throw new Error('Record missing')
            return { ...record.meta, data: record.data, mime: record.mime }
        },
        put(store, id, meta, data, mime) {
            state.records[store] = state.records[store] || {}
            state.records[store][id] = { meta, data: data.toString('base64'), mime: mime || 'application/octet-stream' }
            persist()
        },
        meta(store, id, meta, replaceNotes = false) {
            const record = (state.records[store] || {})[id]
            if (!record) throw new Error('Record missing')
            record.meta = store === 'books' && !replaceNotes ? { ...meta, notes:record.meta.notes || [],lastOpenedAt:Math.max(meta.lastOpenedAt||0,record.meta.lastOpenedAt||0) } : meta
            persist()
        },
        del(store, id) {
            if (state.records[store]) { delete state.records[store][id]; persist() }
        },
    }
}

let store
if (process.env.READER_STORAGE === 'json') {
    store = createJsonStore()
} else {
    try {
        store = createSqliteStore()
    } catch (error) {
        store = createJsonStore()
    }
}

// 与 scripts/library_store.py 的校验保持一致
function runStore(item) {
    const op = item.op
    if (op === 'list') return { records: store.list() }
    const storeName = item.store
    const key = item.id
    if (!['books', 'backgrounds', 'audio', 'qq'].includes(storeName) ||
        typeof key !== 'string' || !(key.length > 0 && key.length <= 120)) throw new Error('Invalid record')
    if (op === 'get') return store.get(storeName, key)
    if (op === 'delete') { store.del(storeName, key); return { ok: true } }
    if (op === 'note') {
        const note=item.note
        if(storeName!=='books'||!note||typeof note.id!=='string'||!note.id.length||note.id.length>120)throw Error('Invalid note')
        if(!item.remove && (!['quote','bookmark'].includes(note.type)||typeof note.cfi!=='string'||!note.cfi.startsWith('epubcfi(')))throw Error('Invalid note anchor')
        const record=store.list().find(r=>r.store==='books'&&r.id===key)
        if(!record)throw Error('Record missing')
        const {store:ignored,...meta}=record
        meta.notes=(meta.notes||[]).filter(n=>n.id!==note.id)
        if(!item.remove)meta.notes.push(note)
        meta.lastOpenedAt=Math.max(Date.now(),(meta.lastOpenedAt||0)+1)
        if(JSON.stringify(meta).length>200000)throw Error('Metadata too large')
        store.meta('books',key,meta,true)
        return {notes:meta.notes,lastOpenedAt:meta.lastOpenedAt}
    }
    const meta = item.meta
    if (!meta || typeof meta !== 'object' || Array.isArray(meta) || meta.id !== key) throw new Error('Invalid metadata')
    const encoded = JSON.stringify(meta)
    if (encoded.length > 200000) throw new Error('Metadata too large')
    if (op === 'meta') { store.meta(storeName, key, meta); return { ok: true } }
    if (op === 'put') {
        if (typeof item.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) throw new Error('Invalid base64')
        const data = Buffer.from(item.data, 'base64')
        if (data.length > 250 * 1024 * 1024) throw new Error('File too large')
        store.put(storeName, key, meta, data, item.mime)
        return { ok: true }
    }
    throw new Error('Unknown operation')
}

// ---------- HTTP ----------

function json(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload))
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-cache' })
    res.end(body)
}

function text(res, status, message) {
    const body = Buffer.from(message)
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length })
    res.end(body)
}

function serveStatic(req, res, pathname) {
    let rel
    try { rel = decodeURIComponent(pathname) } catch { return text(res, 400, 'bad path') }
    if (rel === '/' || rel === '') rel = '/index.html'
    // 数据目录、密钥与隐藏文件不提供下载
    if (/^\/(data|cloud)(\/|$)/.test(rel) || /^\/key\.txt$/.test(rel) || rel.includes('/.') || rel.startsWith('.')) {
        return text(res, 403, 'forbidden')
    }
    const target = path.normalize(path.join(ROOT, rel))
    if (target !== ROOT && !target.startsWith(ROOT + path.sep)) return text(res, 403, 'forbidden')
    let stat = fs.existsSync(target) ? fs.statSync(target) : null
    if (stat && stat.isDirectory()) {
        const nested = path.join(target, 'index.html')
        stat = fs.existsSync(nested) ? fs.statSync(nested) : null
        if (stat) return serveFile(req, res, nested, stat)
    } else if (stat) {
        return serveFile(req, res, target, stat)
    }
    return text(res, 404, 'not found')
}

function serveFile(req, res, file, stat) {
    res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    const stream = fs.createReadStream(file)
    stream.on('error', () => { if (!res.headersSent) text(res, 500, 'read error'); else res.destroy() })
    stream.pipe(res)
}

// 同站写校验：浏览器跨站 JSON 写入本身会被 CORS 预检拦截，这里只做纵深防御。
// 反向代理（如 WorkBuddy 托管）常把 Host 改写成沙箱内部地址，因此同时接受
// X-Forwarded-Host 与 Host，并放行本平台托管域名后缀。
function isSameSiteWrite(req, origin) {
    if (process.env.READER_DESKTOP === '1') return origin === `http://127.0.0.1:${PORT}`
    if (!origin) return false
    let originHost = ''
    try { originHost = new URL(origin).hostname.toLowerCase() } catch { return false }
    if (!originHost) return false
    if (originHost === 'app.workbuddy.host' || originHost.endsWith('.app.workbuddy.host')) return true
    const candidates = new Set()
    for (const header of ['x-forwarded-host', 'host']) {
        const value = req.headers[header]
        if (!value) continue
        for (const part of String(value).split(',')) candidates.add(part.trim().split(':')[0].toLowerCase())
    }
    return candidates.has(originHost)
}

function handleDesktopVolume(req, res) {
    if (process.platform !== 'darwin') return json(res, 503, { error: '请使用系统音量键。' })
    const { execFileSync } = require('node:child_process')
    const read = () => {
        const result = execFileSync('/usr/bin/osascript', ['-e', 'get volume settings'], { encoding:'utf8', timeout:4000 })
        return { volume:Number(result.match(/output volume:(\d+)/)?.[1] || 0), muted:result.includes('output muted:true') }
    }
    if (req.method === 'GET') { try { return json(res,200,read()) } catch { return json(res,503,{error:'请使用系统音量键。'}) } }
    if (req.method !== 'POST' || !isSameSiteWrite(req, req.headers.origin) || req.headers['content-type'] !== 'application/json') return json(res,403,{error:'仅允许本机阅读页面操作'})
    const size=Number(req.headers['content-length']); if (!(size>0 && size<=128)) return json(res,400,{error:'音量参数不正确'})
    let raw='';req.on('data',chunk=>{raw+=chunk;if(raw.length>128)req.destroy()})
    req.on('end',()=>{try {
        const value=JSON.parse(raw)
        if(!Number.isInteger(value.volume)||value.volume<0||value.volume>100||typeof value.muted!=='boolean')throw Error('Invalid')
        execFileSync('/usr/bin/osascript',['-e',`set volume output volume ${value.volume} output muted ${value.muted}`],{timeout:4000})
        json(res,200,read())
    } catch {json(res,400,{error:'音量未能调整，请使用系统音量键。'})}})
}

function handleLibraryPost(req, res) {
    if (!isSameSiteWrite(req, req.headers.origin)) return json(res, 403, { error: '仅允许本站页面操作' })
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim()
    if (contentType !== 'application/json') return json(res, 403, { error: '仅允许本站页面操作' })
    const size = Number(req.headers['content-length'] || 0)
    if (!(size > 0) || size > 350 * 1024 * 1024) return json(res, 400, { error: '请求过大' })
    const chunks = []
    let received = 0
    req.on('data', chunk => {
        received += chunk.length
        if (received > size) { req.destroy(); return }
        chunks.push(chunk)
    })
    req.on('end', () => {
        try {
            json(res, 200, runStore(JSON.parse(Buffer.concat(chunks).toString('utf8'))))
        } catch (error) {
            json(res, 400, { error: '资料保存失败：' + error.message })
        }
    })
    req.on('error', () => {})
}

const server = http.createServer((req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost')
        const pathname = url.pathname
        if (pathname === '/_reader/health') {
            return json(res, 200, { app: 'immersive-reader', workspace: process.env.READER_DESKTOP === '1' ? 'f84beeaed81a7673' : 'cloud', version: VERSION, storage: store.engine })
        }
        if (pathname.startsWith('/_reader/')) {
            if (KEY) {
                const provided = url.searchParams.get('key') || req.headers['x-reader-key']
                if (provided !== KEY) return json(res, 403, { error: '需要访问口令' })
            }
            if (pathname === '/_reader/library' && req.method === 'GET') return json(res, 200, { records: store.list() })
            if (pathname === '/_reader/library' && req.method === 'POST') return handleLibraryPost(req, res)
            if (pathname === '/_reader/volume' && process.env.READER_DESKTOP === '1') return handleDesktopVolume(req, res)
            if (pathname === '/_reader/volume') return json(res, 503, { error: '云端环境无法控制电脑音量，请使用设备音量键。' })
            return json(res, 404, { error: 'Not found' })
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') return text(res, 405, 'method not allowed')
        return serveStatic(req, res, pathname)
    } catch (error) {
        console.error('[reader] 请求处理失败:', error.message)
        if (!res.headersSent) text(res, 500, 'server error')
    }
})

server.listen(PORT, HOST, () => {
    console.log('沉浸阅读器（云端动态版）已启动，存储引擎: ' + store.engine)
    console.log('监听 ' + HOST + ':' + PORT + '，数据目录: ' + DATA_DIR + (KEY ? '，已启用访问口令' : ''))
})
