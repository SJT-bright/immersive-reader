// Portable JSON backups. Validate/decode everything before the single replacement transaction.
import * as db from './db.js?v=1.13.0'
import { loadSettings, saveSettings, normalizeSettings } from './settings.js?v=2.2.0'
import { normalizeNote } from './notes.js?v=1.0.0'
const APP = 'immersive-reader'
const VERSION = 2
const STORES = ['books', 'backgrounds', 'audio']
const validId = /^[a-zA-Z0-9_-]{1,120}$/
const string = (x, max = 500) => typeof x === 'string' ? x.slice(0, max) : ''
const QQ_HOSTS = ['y.qq.com', 'i.y.qq.com', 'c.y.qq.com', 'c6.y.qq.com']

// QQ 歌曲链接是纯元数据：逐条白名单校验，非法整包拒绝（与替换式恢复的保守哲学一致）。
// 字段缺失（旧备份或未导入过）默认空数组。导出为纯函数供 node 回归直接测试。
export function normalizeQQTracks (list) {
    if (list === undefined) return []
    if (!Array.isArray(list)) throw new Error('备份的 QQ 歌曲列表无效')
    const ids = new Set()
    return list.map(rec => {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec) ||
            !validId.test(rec.id) || ids.has(rec.id)) throw new Error('备份存在无效或重复的 QQ 歌曲编号')
        ids.add(rec.id)
        for (const field of ['url', 'kind', 'key', 'ref']) {
            if (typeof rec[field] !== 'string') throw new Error('备份的 QQ 歌曲信息缺失')
        }
        let host = '', protocol = ''
        try { const parsed = new URL(rec.url); host = parsed.hostname; protocol = parsed.protocol } catch { throw new Error('备份的 QQ 歌曲链接无效') }
        if (!/^https?:$/.test(protocol) || rec.url.length > 500 || !QQ_HOSTS.includes(host)) throw new Error('备份的 QQ 歌曲链接无效')
        if (!['song', 'playlist', 'album'].includes(rec.kind) ||
            !['songid', 'songmid', 'shorttag'].includes(rec.key) || rec.ref.length > 80) throw new Error('备份的 QQ 歌曲信息缺失')
        return { id: rec.id, url: rec.url, kind: rec.kind, key: rec.key, ref: rec.ref,
            title: string(rec.title), addedAt: Number(rec.addedAt) || 0, lastPlayedAt: Number(rec.lastPlayedAt) || 0 }
    })
}

export async function blobToBase64(blob) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
}
export function base64ToBlob(b64, type = 'application/octet-stream') {
    const binary = atob(b64)
    return new Blob([Uint8Array.from(binary, c => c.charCodeAt(0))], { type })
}
export async function digest(blob) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
        .map(n => n.toString(16).padStart(2, '0')).join('')
}
export async function buildBackup() {
    const stored = await db.exportAll(), data = {}
    for (const name of STORES) data[name] = await Promise.all(stored[name].map(async rec => {
        const { cover, ...rest } = rec
        const out = { ...rest, data: await blobToBase64(rec.data), mime: rec.data.type,
            byteLength: rec.data.size, sha256: await digest(rec.data) }
        // 书籍内嵌封面（可选字段，旧版本备份保持兼容）
        if (name === 'books' && cover instanceof Blob) {
            out.cover = await blobToBase64(cover)
            out.coverMime = cover.type
        }
        return out
    }))
    // qq 歌曲是纯元数据，直接随备份保存，无需 base64 与哈希
    data.qqTracks = stored.qqTracks
    return { app: APP, version: VERSION, exportedAt: new Date().toISOString(), settings: loadSettings(), data }
}
export async function exportBackup() {
    const payload = await buildBackup()
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const a = document.createElement('a'), url = URL.createObjectURL(blob)
    a.href = url
    a.download = `沉浸阅读器备份-${new Date().toISOString().slice(0, 10)}.json`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    return { ...Object.fromEntries(STORES.map(k => [k, payload.data[k].length])), qqTracks: payload.data.qqTracks.length, bytes: blob.size }
}
function mimeFor(rec, store) {
    if (store === 'books') return 'application/epub+zip'
    if (typeof rec.mime === 'string' && /^(image|audio|video)\/[a-zA-Z0-9.+-]+$/.test(rec.mime)) return rec.mime
    // Legacy v1 backups omitted Blob.type. Infer the common file signatures without changing bytes.
    if (rec.data.startsWith('iVBOR')) return 'image/png'
    if (rec.data.startsWith('/9j/')) return 'image/jpeg'
    if (store === 'backgrounds') return 'image/webp'
    const ext = string(rec.name).split('.').pop().toLowerCase()
    return ({ mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac' })[ext] || 'application/octet-stream'
}
function parseCover(rec) {
    if (!rec.cover) return null
    if (typeof rec.cover !== 'string' || rec.cover.length > 1200000 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(rec.cover)) throw new Error('封面数据无效')
    const mime = typeof rec.coverMime === 'string' && /^image\/[a-zA-Z0-9.+-]+$/.test(rec.coverMime)
        ? rec.coverMime : 'image/jpeg'
    return base64ToBlob(rec.cover, mime)
}
export async function decodeBackup(payload) {
    if (!payload || payload.app !== APP) throw new Error('不是本应用的备份文件')
    if (![1, VERSION].includes(payload.version)) throw new Error('不支持此备份版本')
    if (!payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) throw new Error('备份缺少设置')
    const data = {}
    for (const store of STORES) {
        const list = payload.data?.[store]
        if (!Array.isArray(list)) throw new Error(`备份缺少 ${store} 列表，尚未替换任何资料`)
        const ids = new Set()
        data[store] = []
        for (const rec of list) {
            if (!rec || !validId.test(rec.id) || ids.has(rec.id)) throw new Error('备份存在无效或重复的资料编号')
            ids.add(rec.id)
            if (typeof rec.data !== 'string' || !rec.data.length || rec.data.length % 4 !== 0 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(rec.data)) throw new Error('备份的文件内容无效')
            const blob = base64ToBlob(rec.data, mimeFor(rec, store))
            if (payload.version === VERSION && (rec.byteLength !== blob.size || rec.sha256 !== await digest(blob))) {
                throw new Error('备份文件校验失败，内容可能损坏；未替换任何资料')
            }
            const base = { id: rec.id, data: blob, addedAt: Number(rec.addedAt) || 0 }
            if (store === 'books') {
                if (!['epub', 'txt', 'pdf'].includes(rec.format) || !string(rec.title)) throw new Error('书籍信息缺失')
                const p = rec.progress, progress = p && typeof p === 'object' ? {
                    cfi: typeof p.cfi === 'string' && p.cfi.startsWith('epubcfi(') ? string(p.cfi, 10000) : null,
                    fraction: Math.max(0, Math.min(1, Number(p.fraction ?? p.percent) || 0)),
                    percent: Math.max(0, Math.min(1, Number(p.percent ?? p.fraction) || 0)),
                    tocLabel: string(p.tocLabel), section: Number.isInteger(p.section) ? p.section : 0,
                } : null
                data[store].push({ ...base, title: string(rec.title), author: string(rec.author),
                    format: rec.format, lastOpenedAt: Number(rec.lastOpenedAt) || 0, progress,
                    cover: parseCover(rec),
                    // TXT 转换报告（编码/章节数/字数）随书保留，旧备份无此字段时为 null
                    txtReport: rec.txtReport && typeof rec.txtReport === 'object' && ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'gb18030', 'big5'].includes(rec.txtReport.encoding)
                        ? { encoding: rec.txtReport.encoding, chapters: Math.max(0, Number(rec.txtReport.chapters) || 0), chars: Math.max(0, Number(rec.txtReport.chars) || 0) }
                        : null,
                    notes: (Array.isArray(rec.notes)?rec.notes:[]).map(n=>{
                        const note = normalizeNote(n)
                        if (!note) throw new Error('笔记或书签格式损坏')
                        return note
                    }) })
            } else {
                if (!string(rec.name)) throw new Error('图片或音频缺少名称')
                data[store].push({ ...base, name: string(rec.name) })
            }
        }
    }
    // qq 歌曲链接：旧备份无此字段时默认空数组，保持兼容
    const qqTracks = normalizeQQTracks(payload.data?.qqTracks)
    return { data: { ...data, qqTracks }, settings: normalizeSettings(payload.settings) }
}
export async function inspectBackup(file) {
    try {
        if (file.size > 500 * 1024 * 1024) throw new Error('备份超过 500MB，请在桌面浏览器中拆分资料后重新导出')
        const payload = JSON.parse(await file.text())
        const decoded = await decodeBackup(payload)
        return { ok: true, payload, counts: Object.fromEntries(STORES.map(k => [k, decoded.data[k].length])), exportedAt: payload.exportedAt }
    } catch (e) { return { ok: false, error: e.message } }
}
export async function restoreBackup(payload) {
    const { data, settings } = await decodeBackup(payload)
    const written = await db.importAll(data)
    saveSettings(settings)
    // Remove only this reader's position journals. Old CFIs must not override restored ones.
    for (const key of Object.keys(localStorage)) {
        if (key.startsWith('immersive-reader-position:') || key === 'immersive-reader-last-book') localStorage.removeItem(key)
    }
    const readback = await db.exportAll(), verify = {}
    for (const store of STORES) {
        const actual = new Map(readback[store].map(r => [r.id, r]))
        verify[store] = actual.size === data[store].length
        for (const record of data[store]) {
            const result = actual.get(record.id)
            if (!result || result.data.type !== record.data.type ||
                await digest(result.data) !== await digest(record.data) ||
                JSON.stringify({ ...result, data: null }) !== JSON.stringify({ ...record, data: null })) verify[store] = false
        }
    }
    // qq 歌曲无二进制内容，直接逐条比对元数据
    const actualQQ = new Map(readback.qqTracks.map(r => [r.id, r]))
    verify.qqTracks = actualQQ.size === data.qqTracks.length &&
        data.qqTracks.every(t => JSON.stringify(actualQQ.get(t.id)) === JSON.stringify(t))
    return { written, verify }
}
