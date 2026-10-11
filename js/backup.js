// Portable JSON backups. Validate/decode everything before the single replacement transaction.
import * as db from './db.js'
import { loadSettings, saveSettings, normalizeSettings } from './settings.js'
import { normalizeNote } from './notes.js'
import { sanitizeReadMap } from './reading-stats.js'
import { yieldToUI } from './coop.js'
import { directoryCache } from './toc-model.js'
const APP = 'immersive-reader'
const VERSION = 2
const STORES = ['books', 'backgrounds', 'audio']
const validId = /^[a-zA-Z0-9_-]{1,120}$/
const string = (x, max = 500) => typeof x === 'string' ? x.slice(0, max) : ''
// 导出体积护栏：与导入侧 500MB 上限（inspectBackup）对齐。base64 膨胀约 1.34 倍，
// 原始字节总量超过 370MB 时导出的 JSON 必然超导入上限，提前拒绝比导出一个
// 自己都导不回来的文件诚实。
const EXPORT_RAW_LIMIT = 370 * 1024 * 1024

// v1.11.0：主页目录的扁平 TOC 随备份保留。它是可重建的派生数据（打开一次书即重写），
// 校验从严但不阻断恢复：结构异常按 null 处理，不拒绝整包。
export function normalizeTocFlat (list) {
    if (!Array.isArray(list) || !list.length) return null
    const out = []
    for (const t of list) {
        if (!t || typeof t !== 'object' || Array.isArray(t)) continue
        const label = string(t.label), href = string(t.href, 2000)
        if (!label && !href) continue
        out.push({
            label,
            href,
            index: Number.isInteger(t.index) ? t.index : -1,
            depth: Number.isInteger(t.depth) && t.depth >= 0 ? Math.min(t.depth, 6) : 0,
        })
    }
    return out.length ? directoryCache(out) : null
}

// PDF 转换保存的是「section → 原 PDF 页」映射，section 数并不等于原页数。
// 保留导入器的 1500 原页上限与 EPUB 的章节文件上限；旧备份缺字段时保持缺省。
function normalizePdfMetadata (record) {
    if (record.format !== 'pdf') return {}
    const out = {}
    const pageCount = Number.isInteger(record.pdfPageCount) && record.pdfPageCount > 0
        && record.pdfPageCount <= 1500 ? record.pdfPageCount : 0
    if (pageCount) out.pdfPageCount = pageCount
    if (Array.isArray(record.pdfPages) && record.pdfPages.length > 0
        && record.pdfPages.length <= 0xFFFF - 6
        && record.pdfPages.every(page => page === null || (Number.isInteger(page)
            && page > 0 && page <= (pageCount || 1500)))) {
        out.pdfPages = [...record.pdfPages]
    }
    if (Number.isInteger(record.pdfEmptyPages) && record.pdfEmptyPages >= 0
        && record.pdfEmptyPages <= (pageCount || 1500)) out.pdfEmptyPages = record.pdfEmptyPages
    if (typeof record.pdfTextOnly === 'boolean') out.pdfTextOnly = record.pdfTextOnly
    return out
}
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
// 协作式解码：atob 分片 + 预分配字节数组，片间让出主线程。旧的
// Uint8Array.from(binary, charCodeAt) 对几十 MB 的记录是整段同步 JS 循环，
// 导入大备份时的成片冻结主要来自这里。
export async function base64ToBlobCooperative(b64, type = 'application/octet-stream') {
    const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
    const bytes = new Uint8Array(Math.floor(b64.length * 3 / 4) - padding)
    const CHUNK = 0x8000 // 4 的倍数，atob 分片边界安全
    let out = 0
    for (let i = 0; i < b64.length; i += CHUNK) {
        const bin = atob(b64.slice(i, i + CHUNK))
        for (let j = 0; j < bin.length; j++) bytes[out++] = bin.charCodeAt(j)
        if ((i / CHUNK) % 32 === 31) await yieldToUI()
    }
    return new Blob([bytes], { type })
}
export async function digest(blob) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]
        .map(n => n.toString(16).padStart(2, '0')).join('')
}
export async function buildBackup({ onProgress } = {}) {
    const stored = await db.exportAll()
    // 导出体积护栏：base64 膨胀约 1.34 倍，超过导入侧 500MB 上限的备份毫无意义，
    // 提前拒绝比导出一个自己都导不回来的文件诚实。
    const rawBytes = [...STORES].reduce((s, name) => s + stored[name]
        .reduce((t, rec) => t + (rec.data?.size || 0) + (rec.cover?.size || 0), 0), 0)
    if (rawBytes > EXPORT_RAW_LIMIT) {
        throw new Error(`备份内容约 ${(rawBytes / 1048576).toFixed(0)}MB，编码后超过 500MB 导入上限。请在书架分批删除不需要的资料后重试，或只备份部分内容`)
    }
    const total = STORES.reduce((s, name) => s + stored[name].length, 0)
    const data = {}
    let done = 0
    // 顺序处理：旧的 Promise.all 会把所有 Blob 和 base64 同时驻留内存（峰值约 2.4× 库体积），
    // 且进度回调乱序。逐条处理配合 db.blobToBase64Cooperative 的分片让步，
    // 大书库导出期间界面保持可响应。
    for (const name of STORES) {
        const out = []
        for (const rec of stored[name]) {
            const { cover, ...rest } = rec
            const item = { ...rest, data: await db.blobToBase64Cooperative(rec.data), mime: rec.data.type,
                byteLength: rec.data.size, sha256: await digest(rec.data) }
            // 书籍内嵌封面（可选字段，旧版本备份保持兼容）
            if (name === 'books' && cover instanceof Blob) {
                item.cover = await db.blobToBase64Cooperative(cover)
                item.coverMime = cover.type
            }
            out.push(item)
            onProgress?.({ stage: '导出', done: ++done, total })
            if (done % 4 === 0) await yieldToUI()
        }
        data[name] = out
    }
    // qq 歌曲是纯元数据，直接随备份保存，无需 base64 与哈希
    data.qqTracks = stored.qqTracks
    return { app: APP, version: VERSION, exportedAt: new Date().toISOString(), settings: loadSettings(), data }
}
export async function exportBackup({ onProgress } = {}) {
    const payload = await buildBackup({ onProgress })
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

// 恢复/合并前的可回退副本：自动下载一份当前完整数据快照（与导出备份同一格式）。
export async function downloadPreRestoreSnapshot({ onProgress } = {}) {
    const payload = await buildBackup({ onProgress })
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const a = document.createElement('a'), url = URL.createObjectURL(blob)
    a.href = url
    a.download = `沉浸阅读器-恢复前快照-${new Date().toISOString().slice(0, 10)}.json`
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
    return { bytes: blob.size }
}

// 合并恢复：不动设置，不清空现有数据；备份只补充缺失记录，同书记录按较新者保留、笔记按条合并。
// 返回 { added: {store: n}, mergedBooks: n, keptLocal: n } 供界面如实报告。
// 中途失败时把已完成计数挂在 err.partial 上，界面能如实报告「已合并多少条后失败」。
export async function mergeBackup(payload, { onProgress } = {}) {
    const { data } = await decodeBackup(payload)
    const local = await db.exportAll()
    const stamp = r => Math.max(r?.lastOpenedAt || 0, r?.addedAt || 0, r?.lastPlayedAt || 0)
    const added = { books: 0, backgrounds: 0, audio: 0, qqTracks: 0 }
    let mergedBooks = 0, keptLocal = 0
    const total = data.books.length + data.backgrounds.length + data.audio.length + data.qqTracks.length
    let done = 0
    const report = () => { onProgress?.({ stage: '合并', done, total }) }

    try {
        // 书籍：按 id 并集；同 id 基础记录取较新，笔记按条合并
        // （mergeNotes 按时间戳择新，删除标记同时间优先，所以旧备份里的笔记不会把已删条目复活）
        const localBooks = new Map(local.books.map(b => [b.id, b]))
        const bookIds = new Set()
        for (const b of data.books) {
            bookIds.add(b.id)
            const cur = localBooks.get(b.id)
            if (!cur) { await db.putBook(b); added.books++; report(); continue }
            const base = stamp(cur) >= stamp(b) ? cur : b
            await db.putBook({ ...base, notes: db.mergeNotes(cur.notes, b.notes) })
            mergedBooks++
            report()
        }
        for (const b of local.books) {
            if (!bookIds.has(b.id)) { keptLocal++; } // 本地独有：原样保留，无需写入
        }

        // 背景/音频/QQ 歌曲：同 id 保留较新者，备份独有的补入
        for (const [store, backupList, localList] of [
            ['backgrounds', data.backgrounds, local.backgrounds],
            ['audio', data.audio, local.audio],
            ['qqTracks', data.qqTracks, local.qqTracks],
        ]) {
            const localById = new Map(localList.map(r => [r.id, r]))
            for (const rec of backupList) {
                const cur = localById.get(rec.id)
                if (!cur) { await db.putRecord(store === 'qqTracks' ? 'qq' : store, rec); added[store]++; report(); continue }
                if (stamp(cur) < stamp(rec)) await db.putRecord(store === 'qqTracks' ? 'qq' : store, rec) // 备份里更新的记录才覆盖
                report()
            }
        }
    } catch (err) {
        err.partial = { added: { ...added }, mergedBooks }
        throw err
    }
    return { added, mergedBooks, keptLocal }
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
export async function decodeBackup(payload, { onProgress } = {}) {
    if (!payload || payload.app !== APP) throw new Error('不是本应用的备份文件')
    if (![1, VERSION].includes(payload.version)) throw new Error('不支持此备份版本')
    if (!payload.settings || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) throw new Error('备份缺少设置')
    const total = STORES.reduce((s, store) => s + (payload.data?.[store]?.length || 0), 0)
    const data = {}
    let done = 0
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
            const blob = await base64ToBlobCooperative(rec.data, mimeFor(rec, store))
            if (payload.version === VERSION && (rec.byteLength !== blob.size || rec.sha256 !== await digest(blob))) {
                throw new Error('备份文件校验失败，内容可能损坏；未替换任何资料')
            }
            const base = { id: rec.id, data: blob, addedAt: Number(rec.addedAt) || 0 }
            if (store === 'books') {
                if (!['epub', 'txt', 'pdf'].includes(rec.format) || !string(rec.title)) throw new Error('书籍信息缺失')
                const p = rec.progress, readMap = sanitizeReadMap(p?.readMap), progress = p && typeof p === 'object' ? {
                    cfi: typeof p.cfi === 'string' && p.cfi.startsWith('epubcfi(') ? string(p.cfi, 10000) : null,
                    fraction: Math.max(0, Math.min(1, Number(p.fraction ?? p.percent) || 0)),
                    percent: Math.max(0, Math.min(1, Number(p.percent ?? p.fraction) || 0)),
                    tocLabel: string(p.tocLabel), section: Number.isInteger(p.section) ? p.section : 0,
                    // 过去这三个字段会被白名单静默丢掉，这里补回（F1-14）：
                    // at 是进度裁决的时间戳，丢了它，恢复备份后「本机 journal 与共享库比新旧」就无从下手（见 js/db.js 进度择新）；
                    // pageItemLabel/pageLabel 是顶栏页码与新建书签 page 的来源，丢了要等首次 relocate 才有值（见 js/notes.js、js/reader.js）。
                    // p.location 仍不保留：foliate 的 location 是任意嵌套对象，来自不可信备份，而全仓没有读取方。
                    at: Number(p.at) || 0,
                    pageItemLabel: string(p.pageItemLabel, 200), pageLabel: string(p.pageLabel, 200),
                    ...(readMap ? { readMap } : {}), // 已读区间（v1.9.0 起随进度保存；旧备份无此字段走迁移）
                } : null
                const tocFlat = normalizeTocFlat(rec.tocFlat)
                data[store].push({ ...base, title: string(rec.title), author: string(rec.author),
                    format: rec.format, lastOpenedAt: Number(rec.lastOpenedAt) || 0, progress,
                    ...normalizePdfMetadata(rec),
                    cover: parseCover(rec),
                    // 主页目录（v1.11.0 起随备份保留）；旧备份或数据异常为 null，打开一次书即重建
                    tocFlat, tocCacheOmitted: !!rec.tocCacheOmitted || !!(rec.tocFlat?.length && !tocFlat),
                    // TXT 转换报告（编码/章节数/字数）随书保留，旧备份无此字段时为 null
                    txtReport: rec.txtReport && typeof rec.txtReport === 'object' && ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be', 'gb18030', 'big5'].includes(rec.txtReport.encoding)
                        ? { encoding: rec.txtReport.encoding, chapters: Math.max(0, Number(rec.txtReport.chapters) || 0), chars: Math.max(0, Number(rec.txtReport.chars) || 0) }
                        : null,
                    // 逐条规范化：带 deletedAt 的删除标记原样保留（normalizeNote 只在真的有标记时
                    // 才加这个键，旧记录与旧备份的条目结构不变）。备份丢标记＝旧副本能把已删笔记复活。
                    notes: (Array.isArray(rec.notes)?rec.notes:[]).map(n=>{
                        const note = normalizeNote(n)
                        if (!note) throw new Error('笔记或书签格式损坏')
                        return note
                    }) })
            } else {
                if (!string(rec.name)) throw new Error('图片或音频缺少名称')
                data[store].push({ ...base, name: string(rec.name) })
            }
            onProgress?.({ stage: '读取', done: ++done, total })
            if (done % 4 === 0) await yieldToUI()
        }
    }
    // qq 歌曲链接：旧备份无此字段时默认空数组，保持兼容
    const qqTracks = normalizeQQTracks(payload.data?.qqTracks)
    return { data: { ...data, qqTracks }, settings: normalizeSettings(payload.settings) }
}
export async function inspectBackup(file, { onProgress } = {}) {
    try {
        if (file.size > 500 * 1024 * 1024) throw new Error('备份超过 500MB，请在桌面浏览器中拆分资料后重新导出')
        // file.text + JSON.parse 对大备份是一次原生同步大活：先让一步，让调用方的
        // 「正在读取备份」提示真的画出来，再开始解析。
        await yieldToUI()
        const payload = JSON.parse(await file.text())
        const decoded = await decodeBackup(payload, { onProgress })
        return { ok: true, payload, counts: Object.fromEntries(STORES.map(k => [k, decoded.data[k].length])), exportedAt: payload.exportedAt }
    } catch (e) { return { ok: false, error: e.message } }
}
export async function restoreBackup(payload, { onProgress } = {}) {
    const { data, settings } = await decodeBackup(payload, { onProgress })
    // importAll 是单事务：要么整库替换要么整体回滚，到这里数据已安全落库。
    // 之后的收尾各自为政、互不回滚——旧顺序里 saveSettings 一抛错，journal 没清、
    // 校验没跑、页面也不刷新，停在「旧界面读新库」的半恢复态。现在收尾步骤
    // 全部 try/catch 成警告，尽量把页面送到 reload。
    const written = await db.importAll(data)
    const warnings = []
    // Remove only this reader's position journals. Old CFIs must not override restored ones.
    try {
        for (const key of Object.keys(localStorage)) {
            if (key.startsWith('immersive-reader-position:') || key === 'immersive-reader-last-book') localStorage.removeItem(key)
        }
    } catch { warnings.push('旧的阅读位置记录未能清除，恢复后的进度可能被旧位置覆盖，请重启应用') }
    let settingsSaved = true
    try { saveSettings(settings) } catch { settingsSaved = false }
    if (!settingsSaved) warnings.push('设置未能写入（本机存储空间不足），书库与阅读进度已恢复，重启应用后请重新调整外观与偏好')
    // 回读校验：键序无关的稳定序列化。逐字节 JSON.stringify 会因「存入对象与
    // 解码对象的字段插入顺序不同」误报不一致（同样的内容被当成恢复失败）。
    const stableStringify = value => {
        if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v) ?? 'null').join(',') + ']'
        if (value && typeof value === 'object') {
            const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
            return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + (stableStringify(v) ?? 'null')).join(',') + '}'
        }
        return JSON.stringify(value) ?? 'null'
    }
    const readback = await db.exportAll(), verify = {}
    for (const store of STORES) {
        const actual = new Map(readback[store].map(r => [r.id, r]))
        verify[store] = actual.size === data[store].length
        for (const record of data[store]) {
            const result = actual.get(record.id)
            if (!result || result.data.type !== record.data.type ||
                await digest(result.data) !== await digest(record.data) ||
                stableStringify({ ...result, data: null }) !== stableStringify({ ...record, data: null })) verify[store] = false
        }
    }
    // qq 歌曲无二进制内容，直接逐条比对元数据
    const actualQQ = new Map(readback.qqTracks.map(r => [r.id, r]))
    verify.qqTracks = actualQQ.size === data.qqTracks.length &&
        data.qqTracks.every(t => stableStringify(actualQQ.get(t.id)) === stableStringify(t))
    return { written, verify, warnings, settingsSaved }
}
