// Directory identity is independent of reading position and layout.
// One spine section may contain many TOC anchors; only its representative owns page statistics.
const models = new WeakMap()
export function directoryModel(book) {
    if (!book) return { entries: [], groups: new Map() }
    if (models.has(book)) return models.get(book)
    const sections = new Map((book.sections || []).map((s, i) => [s.id, i]))
    const entries = [], groups = new Map()
    const stack = [...(book.toc || [])].reverse().map(item => ({ item, depth: 0, parent: -1 }))
    while (stack.length) {
        const { item, depth, parent } = stack.pop()
        let index = -1
        try { index = sections.get(book.splitTOCHref?.(item.href)?.[0]) ?? -1 } catch {}
        const entry = { label: item.label || '(无标题)', href: item.href || '', index,
            depth, parent, key: entries.length, statistics: false }
        entries.push(entry)
        if (index >= 0) {
            const group = groups.get(index) || []
            group.push(entry)
            groups.set(index, group)
        }
        for (const child of [...(item.subitems || [])].reverse())
            stack.push({ item: child, depth: depth + 1, parent: entry.key })
    }
    for (const group of groups.values()) {
        // Prefer a shallow entry linking the whole section, otherwise the first shallow anchor.
        const owner = group.reduce((best, entry) => entry.depth < best.depth ||
            (entry.depth === best.depth && !entry.href.includes('#') && best.href.includes('#')) ? entry : best)
        owner.statistics = true
    }
    const model = { entries, groups }
    models.set(book, model)
    return model
}

export function currentDirectoryKey(model, { section, href, label } = {}) {
    const group = model.groups.get(section) || []
    const exact = href && group.find(entry => entry.href === href)
    if (exact) return exact.key
    const named = label && group.find(entry => entry.label === label)
    return (named || group.find(entry => entry.statistics))?.key ?? -1
}

export function directoryMatches(entries, query) {
    const q = String(query || '').trim().toLocaleLowerCase()
    const visible = new Set(), matches = new Set()
    for (const entry of entries) {
        if (!q || entry.label.toLocaleLowerCase().includes(q)) {
            matches.add(entry.key)
            let next = entry
            while (next && !visible.has(next.key)) {
                visible.add(next.key)
                next = entries[next.parent]
            }
        }
    }
    return { visible, count: matches.size }
}

// Bound DOM allocation even for very large sections. Preserve the selected window during updates.
export function pageWindow(pages, start = 1, limit = 80) {
    if (!Number.isInteger(pages) || pages <= 0) return { start: 1, end: 0, pages: [] }
    const first = Math.max(1, Math.min(pages, Number.isInteger(start) ? start : 1))
    const end = Math.min(pages, first + limit - 1)
    return { start: first, end, pages: Array.from({ length: end - first + 1 }, (_, i) => first + i) }
}

// Persisted TOCs have section indexes but no book parser. Keep the same ownership and ancestry rules.
export function savedDirectoryModel(flat) {
    const entries = [], groups = new Map(), ancestors = []
    for (const raw of Array.isArray(flat) ? flat : []) {
        const depth = Math.max(0, Math.min(6, Number(raw.depth) || 0))
        while (ancestors.length && ancestors.at(-1).depth >= depth) ancestors.pop()
        const entry = { ...raw, label: raw.label || '(无标题)', depth, key: entries.length,
            parent: ancestors.at(-1)?.key ?? -1, statistics: false }
        entries.push(entry); ancestors.push(entry)
        if (Number.isInteger(entry.index) && entry.index >= 0) {
            const group = groups.get(entry.index) || []
            group.push(entry); groups.set(entry.index, group)
        }
    }
    for (const group of groups.values()) group.reduce((best, entry) => entry.depth < best.depth ||
        (entry.depth === best.depth && !entry.href?.includes('#') && best.href?.includes('#')) ? entry : best).statistics = true
    return { entries, groups }
}

// The cache is derived from the book. Keep it below the shared metadata budget so reading saves survive.
export function directoryCache(flat, budget = 512 * 1024) {
    if (!Array.isArray(flat) || flat.length > 10000) return null
    const serialized = JSON.stringify(flat)
    return new TextEncoder().encode(serialized).byteLength <= budget ? flat : null
}
