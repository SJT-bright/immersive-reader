// 一书一隔离的笔记：划线 / 书签都挂在该书记录上。
// 保存时记下章节、页码、原句，以及原句后面的下一句。

const END = /[。．.！？!?]/

export function nextSentenceFromText (rest, max = 180) {
    const t = String(rest || '').replace(/\s+/g, ' ').trim().replace(/^[。！？!?；;、，,.\s]+/, '')
    if (!t) return ''
    const cut = t.search(END)
    if (cut >= 0) return t.slice(0, Math.min(cut + 1, max)).trim()
    return t.slice(0, Math.min(80, max)).trim()
}

export function nextSentenceFromRange (range) {
    if (!range || typeof range.cloneRange !== 'function') return ''
    try {
        const node = range.endContainer
        const root = node?.ownerDocument?.body
        if (!root) return ''
        const after = range.cloneRange()
        after.collapse(false)
        after.setEnd(root, root.childNodes.length)
        let rest = after.toString()
        if (rest.length > 600) rest = rest.slice(0, 600)
        return nextSentenceFromText(rest)
    } catch { return '' }
}

export function splitSentences (text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim()
    if (!t) return []
    const out = []
    let buf = ''
    for (const ch of t) {
        buf += ch
        if (END.test(ch) && buf.trim().length > 1) {
            out.push(buf.trim())
            buf = ''
        }
    }
    if (buf.trim()) out.push(buf.trim())
    return out
}

export function passageFromText (text) {
    const parts = splitSentences(text)
    return { text: parts[0] || '', after: parts[1] || '' }
}

export function pageLabel (progress) {
    if (!progress || typeof progress !== 'object') return ''
    const page = progress.pageItemLabel
    if (page != null && String(page).trim()) return String(page).trim()
    const loc = progress.location
    if (typeof loc === 'number' && Number.isFinite(loc) && loc > 0 && loc < 100000 && Number.isInteger(loc)) {
        return String(loc)
    }
    return ''
}

export function placeLabel (note) {
    const bits = []
    const page = String(note?.page || '').trim()
    if (page) bits.push(/^\d/.test(page) ? `第 ${page} 页` : page)
    const chapter = String(note?.chapter || '').trim()
    if (chapter && chapter !== page) bits.push(chapter)
    return bits.join(' · ')
}

export function noteCounts (notes) {
    const list = Array.isArray(notes) ? notes : []
    let quotes = 0
    let bookmarks = 0
    for (const n of list) {
        if (n?.type === 'quote') quotes++
        else if (n?.type === 'bookmark') bookmarks++
    }
    return { quotes, bookmarks, total: quotes + bookmarks }
}

const clip = (x, max) => typeof x === 'string' ? x.slice(0, max) : ''

export function normalizeNote (raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    if (!['quote', 'bookmark'].includes(raw.type)) return null
    if (typeof raw.cfi !== 'string' || !raw.cfi.startsWith('epubcfi(') || !raw.id) return null
    return {
        id: clip(raw.id, 120),
        type: raw.type,
        cfi: clip(raw.cfi, 10000),
        text: clip(raw.text, 100000),
        after: clip(raw.after, 100000),
        comment: clip(raw.comment, 100000),
        chapter: clip(raw.chapter, 500),
        page: clip(raw.page, 120),
        location: clip(String(raw.location ?? ''), 120),
        createdAt: Number(raw.createdAt) || 0,
        editedAt: Number(raw.editedAt) || Number(raw.createdAt) || 0,
    }
}

export function makeQuoteNote (selection) {
    const page = clip(selection?.page, 120) || pageLabel(selection)
    return {
        id: selection?.id || (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'n-' + Date.now()),
        type: 'quote',
        cfi: selection.cfi,
        text: String(selection.text || '').trim(),
        after: String(selection.after || '').trim(),
        chapter: String(selection.chapter || '').trim(),
        page,
        location: String(selection.location ?? ''),
        comment: '',
        createdAt: Date.now(),
        editedAt: Date.now(),
    }
}

export function makeBookmarkNote (progress, passage = {}) {
    const page = pageLabel(progress)
    const text = String(passage.text || progress?.tocLabel || '阅读书签').trim()
    return {
        id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'n-' + Date.now(),
        type: 'bookmark',
        cfi: progress.cfi,
        text,
        after: String(passage.after || '').trim(),
        chapter: String(progress.tocLabel || '').trim(),
        page,
        location: progress.location == null ? '' : String(progress.location),
        comment: '',
        createdAt: Date.now(),
        editedAt: Date.now(),
    }
}
