// 本地存储层：IndexedDB 保存书籍、背景、本地音频、QQ 歌曲链接与进度；无任何网络上传。
// v1.17.0：现有 meta store 保存持久镜像队列，失败操作先重放再合并；保持 DB_VERSION 2 兼容回滚。
// v1.11.0：新增 qq store（DB_VERSION 2）。v1.13.0：磁盘镜像失败不再阻断业务操作（导入/删除/笔记降级为本地保存，启动时自动补同步）。
// v1.16.0：新增 updateBookToc——主页目录用：打开书时把扁平目录持久化到 book.tocFlat（独立于 progress，进度归零不影响目录）。
// v1.16.0 契约扩展（笔记删除标记）：book.notes 里可以留一条同 id、带 deletedAt 的墓碑。
//   mergeNotes 按时间戳裁决、删除平局优先；getBook/listBooks 只把非墓碑的笔记交给界面，
//   exportAll/磁盘镜像/备份保留墓碑，避免镜像失败期间的删除被旧副本复活。
//   2026-10-05 起导入方一律用裸 specifier（不再带 ?v=），天然共用同一模块实例。
// 缓存失效只由 index.html 的入口 ?v= 负责；模块间版本查询已全部移除。
import { isDeletedNote, liveNotes, makeNoteTombstone, noteStamp } from './notes.js'
import { yieldToUI, checkAbort } from './coop.js'
const DB_NAME = 'immersive-reader'
const DB_VERSION = 2

let dbPromise = null

function openDB () {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains('books')) {
                const store = db.createObjectStore('books', { keyPath: 'id' })
                store.createIndex('lastOpenedAt', 'lastOpenedAt')
            }
            if (!db.objectStoreNames.contains('backgrounds')) {
                db.createObjectStore('backgrounds', { keyPath: 'id' })
            }
            if (!db.objectStoreNames.contains('audio')) {
                db.createObjectStore('audio', { keyPath: 'id' })
            }
            if (!db.objectStoreNames.contains('qq')) {
                db.createObjectStore('qq', { keyPath: 'id' })
            }
            if (!db.objectStoreNames.contains('meta')) {
                db.createObjectStore('meta')
            }
        }
        req.onsuccess = () => {
            req.result.onversionchange = () => { req.result.close(); dbPromise = null }
            resolve(req.result)
        }
        req.onerror = () => reject(req.error)
    })
    return dbPromise
}

function requestAsPromise (req) {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
    })
}

// 等待一个读写事务完成
function txDone (tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error || new Error('事务中止'))
    })
}

const uuid = () =>
    (crypto.randomUUID && crypto.randomUUID()) ||
    'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

// 进度通道的裁决依据：progress.at 与 lastOpenedAt 取大。
// 契约依赖 js/reader.js：保存进度时写入 at:Date.now()。旧记录没有 at 时这里退回
// lastOpenedAt，判定结果与升级前完全一致（向后兼容），服务端两个实现同口径。
function progressStamp (record) {
    return Math.max(Number(record?.progress?.at) || 0, Number(record?.lastOpenedAt) || 0)
}

// ---------- 书籍 ----------

export async function addBook ({ title, author, format, data, cover = null }) {
    const book = {
        id: uuid(),
        title,
        author: author || '',
        format, // 'epub' | 'txt'
        data, // Blob
        cover: cover instanceof Blob ? cover : null, // 内嵌封面（仅浏览器与备份，随数据一并保存）
        addedAt: Date.now(),
        lastOpenedAt: Date.now(),
        progress: null, // { cfi, fraction, tocLabel, percent }
    }
    await putBook(book)
    return book
}

// 整条写入（含指定 id），示例书与备份导入使用
export async function putBook (book) {
    const db = await openDB()
    const tx = db.transaction(['books', 'meta'], 'readwrite')
    tx.objectStore('books').put(book)
    queueMirror(tx, {op:'put', store:'books', record:book})
    await txDone(tx)
    await flushMirror()
    return book
}

// 按原 id 整条写入任意 store（备份合并用：保留备份中的 id 与时间戳）
export async function putRecord (store, rec) {
    if (!['backgrounds', 'audio', 'qq'].includes(store)) throw new Error('不支持的存储')
    const db = await openDB()
    const tx = db.transaction([store, 'meta'], 'readwrite')
    tx.objectStore(store).put(rec)
    queueMirror(tx, {op:'put', store, record:rec})
    await txDone(tx)
    await flushMirror()
    return rec
}

// 笔记按 id 合并：本地与磁盘取并集，同 id 按裁决时间（noteStamp）择新。
// 带 deletedAt 的条目是删除标记：时间戳相同或更新时删除优先，这样镜像失败期间的
// 删除不会在另一窗口 / 重载时被磁盘旧副本复活；另一侧未同步的新笔记仍然保留。
// 单侧整组覆盖会丢另一侧未同步的修改（磁盘镜像失败时的心得、另一窗口的划线）。
export function mergeNotes (local, disk) {
    const byId = new Map()
    for (const n of Array.isArray(disk) ? disk : []) {
        if (n && n.id) byId.set(n.id, n)
    }
    for (const n of Array.isArray(local) ? local : []) {
        if (!n || !n.id) continue
        const d = byId.get(n.id)
        byId.set(n.id, d ? pickNewerNote(n, d) : n)
    }
    return [...byId.values()]
}

// 同 id 二选一：较新者胜；平局时删除标记优先，其余保本地。
function pickNewerNote (local, other) {
    const ls = noteStamp(local), os = noteStamp(other)
    if (ls !== os) return ls > os ? local : other
    if (isDeletedNote(local) || isDeletedNote(other)) return isDeletedNote(local) ? local : other
    return local
}

// 本地单条写入（镜像不可用时的降级路径）：同 id 只留最新一条，新条目已在调用处把时间戳抬到严格更新。
function upsertNoteEntry (notes, entry) {
    return [...(Array.isArray(notes) ? notes : []).filter(n => n?.id !== entry.id), entry]
}

// 界面读取路径剔除删除标记：笔记列表、计数与原文标注都只看活条目。
// 备份导出与磁盘同步走 readBookRaw / readBooksRaw（exportAll），墓碑必须留在里面，
// 否则旧副本重新合并时笔记又会复活。
function toReaderBook (book) {
    return book && Array.isArray(book.notes) ? { ...book, notes: liveNotes(book.notes) } : book
}

async function readBookRaw (id) {
    const db = await openDB()
    return requestAsPromise(
        db.transaction('books').objectStore('books').get(id))
}

async function readBooksRaw () {
    const db = await openDB()
    const all = await requestAsPromise(
        db.transaction('books').objectStore('books').getAll())
    return all.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
}

export async function getBook (id) {
    return toReaderBook(await readBookRaw(id))
}

export async function listBooks () {
    return (await readBooksRaw()).map(toReaderBook)
}

export async function touchBook (id, progress) {
    const db = await openDB()
    const store = db.transaction(['books', 'meta'], 'readwrite').objectStore('books')
    const book = await requestAsPromise(store.get(id))
    if (!book) return
    book.lastOpenedAt = Math.max(Date.now(), (book.lastOpenedAt || 0) + 1)
    // 进度择新契约：js/reader.js 写出的 progress 带 at:Date.now()（v1.17.0 起）。
    // 双方都有 at 时按 at 择新，另一个窗口/迟到的旧对象（例如关页时补写的旧进度）
    // 不会把更新的位置盖掉；任一方缺 at 时保持原有的「后写覆盖」，兼容旧记录。
    // 服务端（cloud/server.js 与 scripts/library_store.py）用同一口径的
    // progressStamp = max(progress.at, lastOpenedAt) 裁决磁盘侧。
    if (progress) {
        const current = book.progress
        const bothStamped = current && typeof current.at === 'number' && typeof progress.at === 'number'
        if (!bothStamped || progressStamp(progress) >= progressStamp(current)) book.progress = progress
    }
    store.put(book)
    queueMirror(store.transaction, {op:'meta', store:'books', record:book})
    await txDone(store.transaction)
    await flushMirror()
}

// 主页目录：把打开书时得到的扁平目录存到 book.tocFlat（独立字段，不被 touchBook 的
// progress 整体替换覆盖，进度归零也不影响）。内容相同则跳过，避免每次开卷都写盘。
export async function updateBookToc (id, tocFlat) {
    const db = await openDB()
    const store = db.transaction(['books', 'meta'], 'readwrite').objectStore('books')
    const book = await requestAsPromise(store.get(id))
    if (!book) return
    if (JSON.stringify(book.tocFlat || null) === JSON.stringify(tocFlat)) return
    book.tocFlat = tocFlat
    store.put(book)
    queueMirror(store.transaction, {op:'meta', store:'books', record:book})
    await txDone(store.transaction)
    await flushMirror()
}

// 只补缺失封面，沿用最新整条记录，避免覆盖并行产生的阅读进度和笔记。
export async function updateBookCover (id, cover) {
    if (!(cover instanceof Blob) || !cover.size) return false
    const db = await openDB()
    const store = db.transaction(['books', 'meta'], 'readwrite').objectStore('books')
    const book = await requestAsPromise(store.get(id))
    if (!book || book.cover instanceof Blob) return false
    book.cover = cover
    store.put(book)
    queueMirror(store.transaction, {op:'meta', store:'books', record:book})
    await txDone(store.transaction)
    await flushMirror()
    return true
}

export async function deleteBook (id) {
    const db = await openDB()
    const tx = db.transaction(['books', 'meta'], 'readwrite')
    tx.objectStore('books').delete(id)
    queueMirror(tx, {op:'delete', store:'books', id})
    await txDone(tx)
    await flushMirror()
}

// ---------- 背景 ----------

export async function addBackground ({ name, data }) {
    const db = await openDB()
    const bg = { id: uuid(), name, data, addedAt: Date.now() }
    const tx = db.transaction(['backgrounds', 'meta'], 'readwrite')
    tx.objectStore('backgrounds').put(bg)
    queueMirror(tx, {op:'put', store:'backgrounds', record:bg})
    await txDone(tx)
    await flushMirror()
    return bg
}

export async function listBackgrounds () {
    const db = await openDB()
    const all = await requestAsPromise(
        db.transaction('backgrounds').objectStore('backgrounds').getAll())
    return all.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
}

export async function getBackground (id) {
    const db = await openDB()
    return requestAsPromise(
        db.transaction('backgrounds').objectStore('backgrounds').get(id))
}

export async function deleteBackground (id) {
    const db = await openDB()
    const tx = db.transaction(['backgrounds', 'meta'], 'readwrite')
    tx.objectStore('backgrounds').delete(id)
    queueMirror(tx, {op:'delete', store:'backgrounds', id})
    await txDone(tx)
    await flushMirror()
}

export async function renameBackground (id, name) {
    const db = await openDB()
    const tx = db.transaction(['backgrounds', 'meta'], 'readwrite')
    const store = tx.objectStore('backgrounds')
    const record = await requestAsPromise(store.get(id))
    if (record) store.put({ ...record, name: name.trim().slice(0, 80) })
    if(record)queueMirror(tx, {op:'meta', store:'backgrounds', record:{...record,name:name.trim().slice(0,80)}})
    await txDone(tx)
    await flushMirror()
}

// ---------- 本地音频 ----------

export async function addAudioTrack ({ name, data }) {
    const db = await openDB()
    const track = { id: uuid(), name, data, addedAt: Date.now() }
    const tx = db.transaction(['audio', 'meta'], 'readwrite')
    tx.objectStore('audio').put(track)
    queueMirror(tx, {op:'put', store:'audio', record:track})
    await txDone(tx)
    await flushMirror()
    return track
}

export async function listAudioTracks () {
    const db = await openDB()
    const all = await requestAsPromise(
        db.transaction('audio').objectStore('audio').getAll())
    return all.sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))
}

export async function deleteAudioTrack (id) {
    const db = await openDB()
    const tx = db.transaction(['audio', 'meta'], 'readwrite')
    tx.objectStore('audio').delete(id)
    queueMirror(tx, {op:'delete', store:'audio', id})
    await txDone(tx)
    await flushMirror()
}

export async function renameAudioTrack (id, name) {
    const db = await openDB()
    const tx = db.transaction(['audio', 'meta'], 'readwrite')
    const store = tx.objectStore('audio')
    const record = await requestAsPromise(store.get(id))
    if (record) store.put({ ...record, name: String(name).trim().slice(0, 120) })
    if(record)queueMirror(tx, {op:'meta', store:'audio', record:{...record,name:String(name).trim().slice(0,120)}})
    await txDone(tx)
    await flushMirror()
}

// ---------- QQ 音乐歌曲链接（纯元数据，无 Blob） ----------

// url 为去重键：同一链接重复导入只刷新标题与时间，不产生重复曲目
export async function addQQTrack ({ url, kind, key, ref, title }) {
    const db = await openDB()
    const store = db.transaction(['qq', 'meta'], 'readwrite').objectStore('qq')
    const hit = (await requestAsPromise(store.getAll())).find(t => t.url === url)
    const track = hit
        ? { ...hit, title: title || hit.title, addedAt: Date.now() }
        : { id: uuid(), url, kind, key, ref, title, addedAt: Date.now(), lastPlayedAt: 0 }
    store.put(track)
    queueMirror(store.transaction, {op:'put', store:'qq', record:track})
    await txDone(store.transaction)
    await flushMirror()
    return track
}

export async function listQQTracks () {
    const db = await openDB()
    const all = await requestAsPromise(
        db.transaction('qq').objectStore('qq').getAll())
    return all.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
}

export async function touchQQTrack (id) {
    const db = await openDB()
    const store = db.transaction(['qq', 'meta'], 'readwrite').objectStore('qq')
    const track = await requestAsPromise(store.get(id))
    if (!track) return
    track.lastPlayedAt = Date.now()
    store.put(track)
    queueMirror(store.transaction, {op:'meta', store:'qq', record:track})
    await txDone(store.transaction)
    await flushMirror()
}

export async function deleteQQTrack (id) {
    const db = await openDB()
    const tx = db.transaction(['qq', 'meta'], 'readwrite')
    tx.objectStore('qq').delete(id)
    queueMirror(tx, {op:'delete', store:'qq', id})
    await txDone(tx)
    await flushMirror()
}

// ---------- 元数据（备份时间戳等） ----------

export async function setMeta (key, value) {
    const db = await openDB()
    const tx = db.transaction('meta', 'readwrite')
    tx.objectStore('meta').put(value, key)
    await txDone(tx)
}

export async function getMeta (key) {
    const db = await openDB()
    return requestAsPromise(db.transaction('meta').objectStore('meta').get(key))
}

// ---------- 备份用：整体读取 / 写入 ----------

// 备份与磁盘同步的整库读取：保留删除标记（exportAll 的调用方是 backup.js 与 initDiskLibrary）。
export async function exportAll () {
    const [books, backgrounds, audio, qqTracks, lastBackupAt] = await Promise.all([
        readBooksRaw(), listBackgrounds(), listAudioTracks(), listQQTracks(), getMeta('lastBackupAt'),
    ])
    return { books, backgrounds, audio, qqTracks, lastBackupAt }
}

// 全量替换导入（在调用方确认后执行）。返回实际写入数量供恢复验证。
export async function importAll ({ books = [], backgrounds = [], audio = [], qqTracks = [] }) {
    const db = await openDB()
    const tx = db.transaction(['books', 'backgrounds', 'audio', 'qq', 'meta'], 'readwrite')
    tx.objectStore('books').clear()
    tx.objectStore('backgrounds').clear()
    tx.objectStore('audio').clear()
    tx.objectStore('qq').clear()
    for (const b of books) tx.objectStore('books').put(b)
    for (const b of backgrounds) tx.objectStore('backgrounds').put(b)
    for (const a of audio) tx.objectStore('audio').put(a)
    for (const t of qqTracks) tx.objectStore('qq').put(t)
    tx.objectStore('meta').put(Date.now(), 'lastBackupAt')
    // Replacement intent and payloads commit with the local replacement. On a
    // failed mirror, startup replays these before it may merge any old disk data.
    const lists = {books, backgrounds, audio, qq:qqTracks}
    for (const [store, records] of Object.entries(lists)) {
        // replace:true 声明这是「用户确认过的整库替换」，服务端据此跳过时间戳裁决，
        // 否则被替换掉的旧快照会把 notes/progress 从磁盘再合并回来（见 F1-3 说明）。
        for (const record of records) queueMirror(tx, {op:'put', store, record, replace:true})
    }
    queueMirror(tx, {op:'prune', ids:Object.fromEntries(Object.entries(lists).map(([store, records]) => [store, records.map(r=>r.id)]))})
    await txDone(tx)
    await flushMirror()
    return { books: books.length, backgrounds: backgrounds.length, audio: audio.length, qqTracks: qqTracks.length }
}

export async function clearAll () {
    const db = await openDB()
    const tx = db.transaction(['books', 'backgrounds', 'audio', 'qq', 'meta'], 'readwrite')
    tx.objectStore('books').clear()
    tx.objectStore('backgrounds').clear()
    tx.objectStore('audio').clear()
    tx.objectStore('qq').clear()
    queueMirror(tx, {op:'prune', ids:{books:[], backgrounds:[], audio:[], qq:[]}})
    await txDone(tx)
    await flushMirror()
}

// Disk mirror enabled only by app startup; standalone browser regression pages remain isolated.
let diskEnabled=false
let diskState='浏览器本地保存'
export const diskStatus=()=>diskState
// 页面自身的能力位与服务端鉴权/裁决口径对齐：
//   x-reader-note-tombstone:1 声明本页面认识「笔记删除标记」契约，服务端据此放行
//     books 的整条元数据写入（服务线程离线兜底放行的旧壳没有这个头，写盘会被拒）。
//   x-reader-client-version 仅供服务端日志与排查。
const APP_CLIENT_VERSION = '1.17.0'
// 连续 diskRequest 失败达到阈值就熔断：不再为每次翻页发一个 20 秒超时的无用请求，
// 退避窗口结束后由下一次 flushMirror 半开重试（不用刷新页面也能续上同步）。
// journal 照常入队 —— 漏记一条 delete 会让已删的书在下次启动时从磁盘复活，
// 停的只是「无谓的网络重试」。
const CIRCUIT_THRESHOLD = 3
const CIRCUIT_BACKOFF_MS = 30000
let diskFailures = 0
let diskPausedUntil = 0
// 永久失败（超限 / 记录非法）：重试一万次也是同样结果。这类条目挪进 dead 前缀继续
// 往下走，否则一条坏记录卡死整库落盘、journal 还会随每次写无限增长。
const PERMANENT_CODES = new Set(['metadata_too_large', 'invalid_record', 'invalid_metadata',
    'invalid_note', 'invalid_base64', 'file_too_large', 'unknown_operation'])
function isPermanentError (error) {
    if (!error) return false
    if (error.code && PERMANENT_CODES.has(error.code)) return true
    // 旧服务端没有结构化 code：按错误文案判定，这些都是服务端确定性拒绝
    return /Metadata too large|Invalid record|Invalid metadata|Invalid note|Invalid base64|File too large|Unknown operation/
        .test(String(error.message || ''))
}
async function diskRequest(value){
    // 云端口令模式：页面链接带 ?key= 时，把口令经 x-reader-key 头透传给同源资料库接口，
    // 后续所有读写都走这个头 —— 口令不该停在会被缓存/记日志的 URL query 上。
    // 请求地址恒为同源固定端点，口令仅接受 URL 安全字符白名单。
    const headers={'Content-Type':'application/json','x-reader-note-tombstone':'1','x-reader-client-version':APP_CLIENT_VERSION}
    try{
        const key=new URLSearchParams(location.search).get('key')
        if(key && /^[A-Za-z0-9_-]{1,128}$/.test(key)) headers['x-reader-key']=key
    }catch{ /* 无 location 环境保持原样 */ }
    const response=await fetch('/_reader/library',{method:'POST',headers,body:JSON.stringify(value),signal:AbortSignal.timeout(20000)})
    const data=await response.json().catch(()=>({}))
    if(!response.ok){
        const error=new Error(data.error||'本地资料库不可用')
        // code 让排空循环区分「永久失败」与「暂时失败」；旧服务端不返回 code 时兜底
        error.code=data.code||(response.status===403?'forbidden':'storage_write_failed')
        error.status=response.status
        throw error
    }
    return data
}
async function diskPut(store,record,metadataOnly=false,replace=false){
    if(!diskEnabled||!record)return
    // cover（Blob）不进磁盘元数据：JSON 会把它序列化成 {}，恢复时反而覆盖真封面
    const {data,cover,...meta}=record
    const request={op:metadataOnly?'meta':'put',store,id:record.id,meta}
    if(replace)request.replace=true
    if(!metadataOnly&&data instanceof Blob){
        request.data=await blobToBase64Cooperative(data);request.mime=data.type
    }else if(!metadataOnly){
        // qq 歌曲等纯元数据记录没有 Blob：按空数据整条入库，meta 即全部内容
        request.data='';request.mime='application/json'
    }
    await diskRequest(request)
}
// 整本书 → base64。旧实现先把全书写进一个 binary 字符串再一次性 btoa：几十 MB 的书
// 会在主线程产生几百 MB 的中间字符串，导入后和启动补传时都出现秒级整页冻结。
// 现在按「3 的倍数」分块直接 btoa（块长能被 3 整除时块间 base64 可直接拼接），
// 每隔几块让出主线程，冻结不再成片。
export async function blobToBase64Cooperative (blob, { onProgress, signal } = {}) {
    const bytes = new Uint8Array(await blob.arrayBuffer())
    const parts = []
    const CHUNK = 3 * 16384 // 49152：块内再按 8192 字节切，避开 Function.apply 参数上限
    for (let i = 0; i < bytes.length; i += CHUNK) {
        let binary = ''
        const chunk = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
        for (let j = 0; j < chunk.length; j += 8192) {
            binary += String.fromCharCode.apply(null, chunk.subarray(j, Math.min(j + 8192, chunk.length)))
        }
        parts.push(btoa(binary))
        onProgress?.({ bytes: Math.min(i + CHUNK, bytes.length), total: bytes.length })
        if ((i / CHUNK) % 8 === 7) {
            checkAbort(signal)
            await yieldToUI(signal)
        }
    }
    checkAbort(signal)
    return parts.join('')
}
async function diskDelete(store,id){
    await diskRequest({op:'delete',store,id})
}

// Journal entries contain a structured clone of the exact committed mutation.
// They survive reload and are acknowledged only after the server succeeds.
const journalPrefix = '__reader_mirror:'
// dead 前缀必须落在 journal 扫描区间之外：排空循环用 bound(journalPrefix,
// journalPrefix+'\uffff') 取待重放条目，若按 __reader_mirror:dead: 命名，坏条目会被
// 立刻再捞出来重放，形成死循环。'_'(0x5F) > ':'(0x3A)，dead 键因此在上界之后。
const deadPrefix = '__reader_mirror_dead:'
const JOURNAL_LIMIT = 500   // journal 条数上限（每条含整记录克隆，不能无限长）
const DEAD_LIMIT = 100      // dead 队列只留最近这些条备查
const journalRange = () => IDBKeyRange.bound(journalPrefix, journalPrefix + '\uffff')
const deadRange = () => IDBKeyRange.bound(deadPrefix, deadPrefix + '\uffff')
let deadLetters = 0

const queuedTransactions = new WeakMap()
function queueMirror(tx, operation) {
    let operations = queuedTransactions.get(tx)
    if (operations) { operations.push(operation); return }
    operations = [operation]
    queuedTransactions.set(tx, operations)
    const meta = tx.objectStore('meta')
    const appended = { done: false }
    let seqValue = 0
    const append = (existingCount) => {
        if (appended.done) return
        appended.done = true
        let seq = seqValue
        const lastExistingKey = journalPrefix + String(seq).padStart(16, '0')
        for (const item of operations) {
            ++seq
            meta.put({...item,seq}, journalPrefix + String(seq).padStart(16,'0'))
        }
        meta.put(seq,'__reader_mirror_sequence')
        // 超限只淘汰 meta/note 这类增量（下次启动的全量对齐按时间戳补回）；
        // put/delete/prune 一条都不能丢 —— 漏掉一条 delete 等于让已删的书复活。
        const overflow = (existingCount === null ? 0 : existingCount + operations.length) - JOURNAL_LIMIT
        if (overflow <= 0) return
        let dropped = 0
        const cursor = meta.openCursor(IDBKeyRange.bound(journalPrefix, lastExistingKey))
        cursor.onsuccess = () => {
            const entry = cursor.result
            if (!entry || dropped >= overflow) return
            const op = entry.value && entry.value.op
            if (op === 'meta' || op === 'note') { entry.delete(); ++dropped }
            else entry.continue()
        }
    }
    // 先读序号再数 journal：两个请求必须串在同一条链上，否则 count 的完成顺序不确定，
    // 可能拿到 null 而永远不触发淘汰。
    const counter = meta.get('__reader_mirror_sequence')
    counter.onsuccess = () => {
        seqValue = Number(counter.result) || 0
        const total = meta.count(journalRange())
        total.onsuccess = () => append(Number(total.result) || 0)
        total.onerror = () => append(null)
    }
    counter.onerror = () => append(null)
}

async function pendingJournalCount (db) {
    try { return await requestAsPromise(db.transaction('meta').objectStore('meta').count(journalRange())) }
    catch { return 0 }
}
async function collectDeadKeys (db) {
    const store = db.transaction('meta').objectStore('meta')
    return new Promise((resolve, reject) => {
        const keys = []
        const cursor = store.openCursor(deadRange())
        cursor.onsuccess = () => {
            const entry = cursor.result
            if (!entry) return resolve(keys)
            keys.push(entry.key)
            entry.continue()
        }
        cursor.onerror = () => reject(cursor.error)
    })
}
// 永久失败的条目挪出 journal（保留原 payload 与拒绝原因，便于事后排查），
// 并把 dead 队列裁到最近 DEAD_LIMIT 条。
async function moveToDead (db, key, value, error) {
    const seq = Number(value && value.seq) || 0
    const tx = db.transaction('meta', 'readwrite')
    const store = tx.objectStore('meta')
    store.put({ ...value, deadAt: Date.now(), deadCode: (error && error.code) || 'unknown',
        deadReason: String((error && error.message) || error) },
        deadPrefix + String(seq).padStart(16, '0'))
    store.delete(key)
    await txDone(tx)
    const keys = await collectDeadKeys(db)
    const excess = keys.slice(0, Math.max(0, keys.length - DEAD_LIMIT))
    if (excess.length) {
        const trim = db.transaction('meta', 'readwrite')
        for (const stale of excess) trim.objectStore('meta').delete(stale)
        await txDone(trim)
    }
    deadLetters = Math.min(keys.length, DEAD_LIMIT)
}

let mirrorDrain = null
export async function flushMirror() {
    if (!diskEnabled) {
        // 熔断退避窗口结束后半开重试，不需要刷新页面
        if (diskPausedUntil && Date.now() >= diskPausedUntil) { diskPausedUntil = 0; diskEnabled = true }
        else return false
    }
    if (mirrorDrain) {
        if (!await mirrorDrain) return false
        return flushMirror()
    }
    const drain = async () => {
        let dead = 0
        try {
            const db = await openDB()
            for (;;) {
                const entry = await requestAsPromise(db.transaction('meta').objectStore('meta').openCursor(journalRange()))
                if (!entry) break
                const value = entry.value
                try {
                    await replayMirrorEntry(db, value)
                    diskFailures = 0
                    diskPausedUntil = 0
                } catch (error) {
                    if (isPermanentError(error)) {
                        // 这条永远写不进去：挪进 dead 前缀，继续排空后面的条目
                        await moveToDead(db, entry.key, value, error)
                        ++dead
                        continue
                    }
                    if (error && error.code === 'client_upgrade_required') {
                        // 缓存里的旧壳不认识墓碑契约：保留 journal，等页面刷新后重放
                        diskState = '页面版本与本机资料库不一致（旧缓存页不认识笔记删除标记），已保留 '
                            + await pendingJournalCount(db) + ' 条待同步；请强制刷新页面（⇧⌘R）'
                        return false
                    }
                    throw error
                }
                const tx = db.transaction('meta','readwrite')
                tx.objectStore('meta').delete(entry.key)
                await txDone(tx)
            }
            deadLetters = (await collectDeadKeys(db)).length
            diskState = mirrorOkState(dead)
            return true
        } catch (error) {
            console.warn('本机资料同步待重试：',error.message)
            noteTransientFailure(dead)
            return false
        }
    }
    // All same-origin windows share IDB. Serialize drains so a slow older
    // request cannot arrive after its successor from a second window.
    mirrorDrain = (globalThis.navigator?.locks
        ? navigator.locks.request('immersive-reader-mirror', drain) : drain())
    try { return await mirrorDrain } finally { mirrorDrain = null }
}

async function replayMirrorEntry (db, value) {
    const { op, store, id, record, note, ids } = value
    if (op === 'prune') {
        const remote = await diskRequest({op:'list'})
        for (const rec of remote.records) {
            if (ids[rec.store] && !ids[rec.store].includes(rec.id)) await diskDelete(rec.store,rec.id)
        }
    } else if (op === 'delete') await diskDelete(store,id)
    else if (op === 'note') {
        try { await diskRequest({op,store,id,note}) }
        catch (error) {
            // A pre-upgrade browser may have a book that never
            // reached disk. Seed only when the server says missing.
            if (!record || !/Record missing/.test(error.message)) throw error
            await diskPut(store,record)
        }
    } else {
        try { await diskPut(store,record,op === 'meta', op === 'put' && value.replace) }
        catch (error) {
            if (op !== 'meta' || !/Record missing/.test(error.message)) throw error
            await diskPut(store,record)
        }
    }
}
// 状态文案把三种失败分开：有一条永远写不进去 / 服务暂时没起 / 页面版本过旧。
function mirrorOkState (dead) {
    return '已保存到本机资料库'
        + (dead ? '；有 ' + dead + ' 条被资料库永久拒收（已移入待弃队列，不再重试，请导出备份检查）' : '')
        + (deadLetters && !dead ? '；待弃队列留有 ' + deadLetters + ' 条（永久拒收，不再重试）' : '')
}
function noteTransientFailure (dead = 0) {
    ++diskFailures
    const suffix = dead ? '；本轮已跳过 ' + dead + ' 条永久拒收的记录' : ''
    if (diskFailures >= CIRCUIT_THRESHOLD) {
        diskEnabled = false
        diskPausedUntil = Date.now() + CIRCUIT_BACKOFF_MS
        diskState = '本机资料库连续 ' + diskFailures + ' 次无响应，已暂停写盘重试（约 '
            + Math.round(CIRCUIT_BACKOFF_MS / 1000) + ' 秒后自动续上）；内容已存浏览器' + suffix
    } else {
        diskState = '磁盘暂时未同步（本机服务未响应，稍后自动重试）；内容已存浏览器；重试或重启会补齐，请导出备份' + suffix
    }
}
// 磁盘镜像必须和浏览器一致：既要留着删除标记（否则另一个旧副本合并时又把已删笔记复活），
// 也要收下镜像失败期间本地新写/新改的笔记（否则这份笔记只活在这台浏览器里，
// 一旦某一侧的副本覆盖了它的本地记录就彻底丢了）。
// 元数据写入按设计保留磁盘里的 notes，所以这里逐条 upsert 合并胜出的那一份：
// 只碰「磁盘没有」或「时间戳/删除状态不一致」的 id，也就是离线期间的增量。
// 返回服务端刷新后的 lastOpenedAt，供调用方把本地记录保持在同一水平，避免阅读位置反而变旧。
async function syncNoteStates(bookId,mergedNotes,diskNotes){
    const merged=Array.isArray(mergedNotes)?mergedNotes:[]
    const disk=Array.isArray(diskNotes)?diskNotes:[]
    if(!merged.length)return 0
    const diskById=new Map(disk.map(n=>[n.id,n]))
    const stale=merged.filter(n=>{
        const have=diskById.get(n.id)
        return !have||noteStamp(have)!==noteStamp(n)||isDeletedNote(have)!==isDeletedNote(n)
    })
    let lastOpenedAt=0
    for(const note of stale){
        try{
            const result=await diskRequest({op:'note',store:'books',id:bookId,note})
            lastOpenedAt=Math.max(lastOpenedAt,Number(result?.lastOpenedAt)||0)
        }catch(error){
            throw error
        }
    }
    return lastOpenedAt
}
export async function initDiskLibrary(){
    // Never union a stale disk snapshot with local data before replaying pending
    // deletes or a replacement backup. Failure keeps the browser authoritative.
    diskEnabled=true
    if (!await flushMirror()) return false
    let remote
    try{remote=await diskRequest({op:'list'})}
    catch{diskState='当前仅存浏览器；请使用项目启动器开启本机资料库';return false}
    const database=await openDB()
    const local=await exportAll()
    diskEnabled=true
    // 每条记录各自兜住异常：旧实现任一条抛错就整库放弃（外层一个 catch 包住全部），
    // 一本损坏的书能把其余所有的同步一起拖没。失败清单累计后写进状态文案。
    const failed=[]
    const attempt=async (label,fn)=>{
        try{await fn();return true}
        catch(error){failed.push(label+'：'+String(error&&error.message||error));return false}
    }
    try{
        for(const store of ['books','backgrounds','audio']){
            const saved=remote.records.filter(r=>r.store===store)
            const byId=new Map(saved.map(r=>[r.id,r]))
            for(const record of local[store]){
                if(byId.has(record.id))continue
                await attempt(store+':'+record.id+' 补传',()=>diskPut(store,record))
            }
            const localById=new Map(local[store].map(r=>[r.id,r]))
            for(const meta of saved){
                await attempt(store+':'+meta.id+' 合并',async()=>{
                const existing=localById.get(meta.id)
                // 谁较新：progress.at 与 lastOpenedAt 取大（progressStamp）。旧记录没有 at
                // 时结果与升级前逐条一致；契约依赖 js/reader.js 给 progress 补 at。
                if(existing&&progressStamp(existing)>progressStamp(meta)){
                    if(store==='books') {
                        // 本地较新只代表阅读位置较新；笔记按条合并，不整组覆盖
                        existing.notes=mergeNotes(existing.notes,meta.notes)
                        // 磁盘写入会保留磁盘里的 notes，离线期间的笔记增量改用单条 upsert 补回磁盘
                        existing.lastOpenedAt=Math.max(existing.lastOpenedAt||0,
                            await syncNoteStates(existing.id,existing.notes,meta.notes))
                        const tx=database.transaction(store,'readwrite');tx.objectStore(store).put(existing);await txDone(tx)
                    }
                    await diskPut(store,existing,true);return
                }
                const rec=existing||await diskRequest({op:'get',store,id:meta.id})
                let blob=rec.data
                if(!existing){const binary=atob(rec.data);blob=new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))],{type:rec.mime})}
                const {store:ignored,...fields}=meta
                // 恢复/合并时保留本地已有的内嵌封面（磁盘元数据不含封面）；
                // 磁盘较新时笔记同样按条合并，避免镜像失败期间的本地心得被清掉
                const merged=store==='books'&&existing?mergeNotes(existing.notes,fields.notes):null
                const bumped=merged?await syncNoteStates(existing.id,merged,fields.notes):0
                const tx=database.transaction(store,'readwrite')
                tx.objectStore(store).put(store==='books'&&existing
                    ? {...fields,data:blob,cover:existing.cover??null,notes:merged,lastOpenedAt:Math.max(fields.lastOpenedAt||0,bumped)}
                    : {...fields,data:blob,cover:existing?.cover??null})
                await txDone(tx)
                })
            }
        }
        // qq 歌曲是纯元数据：不走书籍的二进制合并分支；本地缺失的取回元数据直接入库，本地多出的补传磁盘
        {
            const saved=remote.records.filter(r=>r.store==='qq')
            const byId=new Map(saved.map(r=>[r.id,r]))
            for(const track of local.qqTracks){
                if(byId.has(track.id))continue
                await attempt('qq:'+track.id+' 补传',()=>diskPut('qq',track))
            }
            const localById=new Map(local.qqTracks.map(r=>[r.id,r]))
            for(const meta of saved){
                await attempt('qq:'+meta.id+' 合并',async()=>{
                const existing=localById.get(meta.id)
                if(existing&&(existing.lastPlayedAt||0)>(meta.lastPlayedAt||0)){await diskPut('qq',existing,true);return}
                const rec=existing?meta:await diskRequest({op:'get',store:'qq',id:meta.id})
                // get 返回的 data/mime 是空数据占位，忽略；只保留元数据字段写入 IDB
                const {store:ignored,...fields}=rec;delete fields.data;delete fields.mime
                const tx=database.transaction('qq','readwrite');tx.objectStore('qq').put(fields);await txDone(tx)
                })
            }
        }
        // 失败清单只影响状态文案：连接本身是好的，其余记录已经逐条合并完
        if (failed.length) console.warn('本机资料库启动合并有 ' + failed.length + ' 条未完成：', failed[0])
        diskState = failed.length
            ? '本机资料库已连接，但有 ' + failed.length + ' 条未完成同步（内容仍存浏览器，可点「重试连接」）'
            : mirrorOkState(0)
        return failed.length === 0
    }catch(error){
        console.warn('本机资料库启动合并未完成：',error.message)
        diskState='本机资料同步未完成，请保留浏览器资料并重试';return false}
}

// 启动时申请持久存储：防止浏览器在磁盘紧张时清理书籍/背景/音频。
// 返回 'persisted' | 'default' | 'unsupported'，仅供状态栏展示，不阻塞启动。
export async function requestDurableStorage () {
    try {
        if (!navigator.storage?.persist) return 'unsupported'
        if (await navigator.storage.persisted()) return 'persisted'
        return await navigator.storage.persist() ? 'persisted' : 'default'
    } catch { return 'unsupported' }
}

// 当前源的总用量与配额（MB，向上取整），失败返回 null。
export async function storageEstimateMB () {
    try {
        const est = await navigator.storage?.estimate?.()
        if (!est) return null
        const mb = n => Math.ceil((n || 0) / (1024 * 1024))
        return { usage: mb(est.usage), quota: mb(est.quota) }
    } catch { return null }
}

// Atomic metadata mutation prevents a concurrent reading-position save losing notes.
export async function updateBookNote(bookId, note, remove=false) {
    const database=await openDB()
    const tx=database.transaction(['books','meta'],'readwrite')
    const store=tx.objectStore('books')
    const book=await requestAsPromise(store.get(bookId))
    if(!book)throw new Error('书籍已不存在')
    const prev=book.notes?.find(item=>item?.id===note?.id)
    const stamp=Math.max(Date.now(),noteStamp(prev)+1)
    const change=remove ? makeNoteTombstone(note,stamp)
        : {...note,editedAt:Math.max(Number(note?.editedAt)||0,stamp)}
    book.notes=upsertNoteEntry(book.notes,change)
    // Editing a note does not mean the reading position changed.
    store.put(book)
    queueMirror(tx,{op:'note',store:'books',id:bookId,note:change,record:book})
    await txDone(tx)
    await flushMirror()
    return liveNotes(book.notes)
}
