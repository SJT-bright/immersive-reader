// 心得草稿：未保存的输入先落 localStorage，切栏目 / 换书 / 关面板 / 重启都不丢。
// 键为 bookId + noteId，值只存纯文本与时间戳；保存成功后清除对应草稿。

const KEY = 'reader.noteDrafts'
const MAX_DRAFTS = 200
const MAX_TEXT = 100000

function readAll () {
    try {
        const raw = localStorage.getItem(KEY)
        if (!raw) return {}
        const obj = JSON.parse(raw)
        return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
    } catch { return {} }
}

function writeAll (all) {
    try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* 配额满等极端情况：草稿仅内存语义降级，不抛错 */ }
}

export function draftKey (bookId, noteId) {
    return `${String(bookId || '')}:${String(noteId || '')}`
}

// 读草稿；没有草稿返回 ''。ignoreSaved：与已保存心得一致时视为无草稿。
export function getDraft (bookId, noteId, ignoreSaved = '') {
    const d = readAll()[draftKey(bookId, noteId)]
    const text = typeof d?.text === 'string' ? d.text : ''
    if (ignoreSaved && text === ignoreSaved) return ''
    return text
}

export function setDraft (bookId, noteId, text) {
    const all = readAll()
    const key = draftKey(bookId, noteId)
    if (text == null || text === '') delete all[key]
    else {
        all[key] = { text: String(text).slice(0, MAX_TEXT), updatedAt: Date.now() }
        // 防无限增长：超出条数按时间淘汰最旧的
        const keys = Object.keys(all)
        if (keys.length > MAX_DRAFTS) {
            keys.sort((a, b) => (all[a].updatedAt || 0) - (all[b].updatedAt || 0))
            for (const k of keys.slice(0, keys.length - MAX_DRAFTS)) delete all[k]
        }
    }
    writeAll(all)
}

export function clearDraft (bookId, noteId) { setDraft(bookId, noteId, '') }

// 清掉与当前笔记集合无关的陈旧草稿（笔记删除后不残留）。
export function pruneDrafts (validPairs) {
    const all = readAll()
    const valid = new Set(validPairs.map(([b, n]) => draftKey(b, n)))
    let changed = false
    for (const k of Object.keys(all)) {
        if (!valid.has(k)) { delete all[k]; changed = true }
    }
    if (changed) writeAll(all)
}

export function draftCount () { return Object.keys(readAll()).length }
