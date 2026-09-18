// 本地存储层：IndexedDB 保存书籍、背景、本地音频、QQ 歌曲链接与进度；无任何网络上传。
// v1.11.0：新增 qq store（DB_VERSION 2）。v1.13.0：磁盘镜像失败不再阻断业务操作（导入/删除/笔记降级为本地保存，启动时自动补同步）。
// 各调用方 import 本模块的 ?v= 版本查询由调用方文件持有，本文件无需处理。
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
        req.onsuccess = () => resolve(req.result)
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
    const tx = db.transaction('books', 'readwrite')
    tx.objectStore('books').put(book)
    await txDone(tx)
    await diskPut('books',book)
    return book
}

export async function getBook (id) {
    const db = await openDB()
    return requestAsPromise(
        db.transaction('books').objectStore('books').get(id))
}

export async function listBooks () {
    const db = await openDB()
    const all = await requestAsPromise(
        db.transaction('books').objectStore('books').getAll())
    return all.sort((a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0))
}

export async function touchBook (id, progress) {
    const db = await openDB()
    const store = db.transaction('books', 'readwrite').objectStore('books')
    const book = await requestAsPromise(store.get(id))
    if (!book) return
    book.lastOpenedAt = Date.now()
    if (progress) book.progress = progress
    store.put(book)
    await txDone(store.transaction)
    await diskPut('books',book,true)
}

export async function deleteBook (id) {
    const db = await openDB()
    const tx = db.transaction('books', 'readwrite')
    tx.objectStore('books').delete(id)
    await txDone(tx)
    await diskDelete('books',id)
}

// ---------- 背景 ----------

export async function addBackground ({ name, data }) {
    const db = await openDB()
    const bg = { id: uuid(), name, data, addedAt: Date.now() }
    const tx = db.transaction('backgrounds', 'readwrite')
    tx.objectStore('backgrounds').put(bg)
    await txDone(tx)
    await diskPut('backgrounds',bg)
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
    const tx = db.transaction('backgrounds', 'readwrite')
    tx.objectStore('backgrounds').delete(id)
    await txDone(tx)
    await diskDelete('backgrounds',id)
}

export async function renameBackground (id, name) {
    const db = await openDB()
    const tx = db.transaction('backgrounds', 'readwrite')
    const store = tx.objectStore('backgrounds')
    const record = await requestAsPromise(store.get(id))
    if (record) store.put({ ...record, name: name.trim().slice(0, 80) })
    await txDone(tx)
    if(record)await diskPut('backgrounds',{...record,name:name.trim().slice(0,80)},true)
}

// ---------- 本地音频 ----------

export async function addAudioTrack ({ name, data }) {
    const db = await openDB()
    const track = { id: uuid(), name, data, addedAt: Date.now() }
    const tx = db.transaction('audio', 'readwrite')
    tx.objectStore('audio').put(track)
    await txDone(tx)
    await diskPut('audio',track)
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
    const tx = db.transaction('audio', 'readwrite')
    tx.objectStore('audio').delete(id)
    await txDone(tx)
    await diskDelete('audio',id)
}

export async function renameAudioTrack (id, name) {
    const db = await openDB()
    const tx = db.transaction('audio', 'readwrite')
    const store = tx.objectStore('audio')
    const record = await requestAsPromise(store.get(id))
    if (record) store.put({ ...record, name: String(name).trim().slice(0, 120) })
    await txDone(tx)
    if(record)await diskPut('audio',{...record,name:String(name).trim().slice(0,120)},true)
}

// ---------- QQ 音乐歌曲链接（纯元数据，无 Blob） ----------

// url 为去重键：同一链接重复导入只刷新标题与时间，不产生重复曲目
export async function addQQTrack ({ url, kind, key, ref, title }) {
    const db = await openDB()
    const store = db.transaction('qq', 'readwrite').objectStore('qq')
    const hit = (await requestAsPromise(store.getAll())).find(t => t.url === url)
    const track = hit
        ? { ...hit, title: title || hit.title, addedAt: Date.now() }
        : { id: uuid(), url, kind, key, ref, title, addedAt: Date.now(), lastPlayedAt: 0 }
    store.put(track)
    await txDone(store.transaction)
    await diskPut('qq', track)
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
    const store = db.transaction('qq', 'readwrite').objectStore('qq')
    const track = await requestAsPromise(store.get(id))
    if (!track) return
    track.lastPlayedAt = Date.now()
    store.put(track)
    await txDone(store.transaction)
    await diskPut('qq', track, true)
}

export async function deleteQQTrack (id) {
    const db = await openDB()
    const tx = db.transaction('qq', 'readwrite')
    tx.objectStore('qq').delete(id)
    await txDone(tx)
    await diskDelete('qq', id)
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

export async function exportAll () {
    const [books, backgrounds, audio, qqTracks, lastBackupAt] = await Promise.all([
        listBooks(), listBackgrounds(), listAudioTracks(), listQQTracks(), getMeta('lastBackupAt'),
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
    await txDone(tx)
    if(diskEnabled){
        const old=await diskRequest({op:'list'})
        for(const [store,records] of Object.entries({books,backgrounds,audio,qq:qqTracks})){
            for(const record of records)await diskPut(store,record)
            const ids=new Set(records.map(r=>r.id))
            for(const rec of old.records)if(rec.store===store&&!ids.has(rec.id))await diskDelete(store,rec.id)
        }
    }
    return { books: books.length, backgrounds: backgrounds.length, audio: audio.length, qqTracks: qqTracks.length }
}

export async function clearAll () {
    const db = await openDB()
    const tx = db.transaction(['books', 'backgrounds', 'audio', 'qq'], 'readwrite')
    tx.objectStore('books').clear()
    tx.objectStore('backgrounds').clear()
    tx.objectStore('audio').clear()
    tx.objectStore('qq').clear()
    await txDone(tx)
}

// Disk mirror enabled only by app startup; standalone browser regression pages remain isolated.
let diskEnabled=false
let diskState='浏览器本地保存'
export const diskStatus=()=>diskState
async function diskRequest(value){
    // 云端口令模式：页面链接带 ?key= 时，把口令经 x-reader-key 头透传给同源资料库接口。
    // 请求地址恒为同源固定端点，口令仅接受 URL 安全字符白名单。
    const headers={'Content-Type':'application/json'}
    try{
        const key=new URLSearchParams(location.search).get('key')
        if(key && /^[A-Za-z0-9_-]{1,128}$/.test(key)) headers['x-reader-key']=key
    }catch{ /* 无 location 环境保持原样 */ }
    const response=await fetch('/_reader/library',{method:'POST',headers,body:JSON.stringify(value)})
    const data=await response.json()
    if(!response.ok)throw new Error(data.error||'本地资料库不可用')
    return data
}
async function diskPut(store,record,metadataOnly=false){
    if(!diskEnabled||!record)return
    // cover（Blob）不进磁盘元数据：JSON 会把它序列化成 {}，恢复时反而覆盖真封面
    const {data,cover,...meta}=record
    const request={op:metadataOnly?'meta':'put',store,id:record.id,meta}
    if(!metadataOnly&&data instanceof Blob){
        const bytes=new Uint8Array(await data.arrayBuffer());let binary=''
        for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768))
        request.data=btoa(binary);request.mime=data.type
    }else if(!metadataOnly){
        // qq 歌曲等纯元数据记录没有 Blob：按空数据整条入库，meta 即全部内容
        request.data='';request.mime='application/json'
    }
    try{await diskRequest(request);diskState='已保存到本机资料库'}
    catch(error){
        // 镜像失败不拖垮业务操作：IndexedDB 已先行保存（txDone 在 diskPut 之前完成），
        // 下次启动 initDiskLibrary 会把浏览器副本自动补同步到磁盘。导入曾被这里整单拒绝。
        console.warn('磁盘镜像失败（内容已存浏览器，下次启动自动补同步）：', error.message)
        diskState='磁盘暂时没有保存到本机资料库（内容已存浏览器，重启应用自动补齐）；请导出备份'
    }
}
async function diskDelete(store,id){
    if(!diskEnabled)return
    try{await diskRequest({op:'delete',store,id})}
    catch(error){console.warn('磁盘删除失败（下次启动自动补同步）：',error.message)}
}
export async function initDiskLibrary(){
    let remote
    try{remote=await diskRequest({op:'list'})}
    catch{diskState='当前仅存浏览器；请使用项目启动器开启本机资料库';return false}
    const database=await openDB()
    const local=await exportAll()
    diskEnabled=true
    try{
        for(const store of ['books','backgrounds','audio']){
            const saved=remote.records.filter(r=>r.store===store)
            const byId=new Map(saved.map(r=>[r.id,r]))
            for(const record of local[store])if(!byId.has(record.id))await diskPut(store,record)
            const localById=new Map(local[store].map(r=>[r.id,r]))
            for(const meta of saved){
                const existing=localById.get(meta.id)
                if(existing&&(existing.lastOpenedAt||0)>(meta.lastOpenedAt||0)){
                    if(store==='books') {
                        existing.notes=meta.notes||[]
                        const tx=database.transaction(store,'readwrite');tx.objectStore(store).put(existing);await txDone(tx)
                    }
                    await diskPut(store,existing,true);continue
                }
                const rec=existing||await diskRequest({op:'get',store,id:meta.id})
                let blob=rec.data
                if(!existing){const binary=atob(rec.data);blob=new Blob([Uint8Array.from(binary,c=>c.charCodeAt(0))],{type:rec.mime})}
                const {store:ignored,...fields}=meta
                // 恢复/合并时保留本地已有的内嵌封面（磁盘元数据不含封面）
                const tx=database.transaction(store,'readwrite');tx.objectStore(store).put({...fields,data:blob,cover:existing?.cover??null});await txDone(tx)
            }
        }
        // qq 歌曲是纯元数据：不走书籍的二进制合并分支；本地缺失的取回元数据直接入库，本地多出的补传磁盘
        {
            const saved=remote.records.filter(r=>r.store==='qq')
            const byId=new Map(saved.map(r=>[r.id,r]))
            for(const track of local.qqTracks)if(!byId.has(track.id))await diskPut('qq',track)
            const localById=new Map(local.qqTracks.map(r=>[r.id,r]))
            for(const meta of saved){
                const existing=localById.get(meta.id)
                if(existing&&(existing.lastPlayedAt||0)>(meta.lastPlayedAt||0)){await diskPut('qq',existing,true);continue}
                const rec=existing?meta:await diskRequest({op:'get',store:'qq',id:meta.id})
                // get 返回的 data/mime 是空数据占位，忽略；只保留元数据字段写入 IDB
                const {store:ignored,...fields}=rec;delete fields.data;delete fields.mime
                const tx=database.transaction('qq','readwrite');tx.objectStore('qq').put(fields);await txDone(tx)
            }
        }
        diskState='已保存到本机资料库';return true
    }catch(error){diskState='本机资料同步未完成，请保留浏览器资料并重试';throw error}
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
    // Merge on the shared service before updating this window's cache. A stale
    // reading-position save from another window must not erase annotations.
    // 镜像不可用时降级为本地合并（浏览器副本仍保存，启动时补同步），不让笔记保存整体失败。
    let shared = null
    if (diskEnabled) {
        try { shared = await diskRequest({op:'note',store:'books',id:bookId,note,remove}) }
        catch (error) { console.warn('笔记镜像失败，改为本地保存：', error.message) }
    }
    const database=await openDB(),tx=database.transaction('books','readwrite'),store=tx.objectStore('books')
    const book=await requestAsPromise(store.get(bookId))
    if(!book)throw new Error('书籍已不存在')
    const notes=shared ? shared.notes : (book.notes||[]).filter(item=>item.id!==note.id)
    if(!shared&&!remove)notes.push(note)
    book.notes=notes;book.lastOpenedAt=shared?.lastOpenedAt||Date.now()
    store.put(book);await txDone(tx)
    return notes
}
