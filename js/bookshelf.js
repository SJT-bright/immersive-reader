// 书架渲染：纯函数生成 HTML，样式见 css/bookshelf.css。
// 封面按书籍 id 稳定生成：配色 + 分区构图，两本书并排时能一眼分开。
// v1.6.0：每本书新增「目录」入口（data-action="book-toc"），主页不开书也能查看目录。

const escapeHtml = s =>
    String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))

function hashId (id) {
    let h = 0
    const key = String(id ?? '')
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
    return h
}

// a = 色块，b = 放书名的底，ink 写在 b 上。相邻书要能从色相上分开。
const PALETTES = [
    { a: '#c43c28', b: '#f3e6d0', ink: '#2a1610', accent: '#8a2418' }, // 朱砂 / 宣纸
    { a: '#1e3c78', b: '#e8d6a0', ink: '#1a2744', accent: '#c4a24a' }, // 靛蓝 / 金笺
    { a: '#2a6a48', b: '#e4eee8', ink: '#143024', accent: '#c4a35a' }, // 松绿 / 雾白
    { a: '#1a1c1e', b: '#f0e6d8', ink: '#1a1c1e', accent: '#c4452d' }, // 墨 / 朱印
    { a: '#d06a32', b: '#f3ead8', ink: '#3a2416', accent: '#8a3e22' }, // 赭橙 / 沙
    { a: '#6a2d58', b: '#f0e4ec', ink: '#3a1c30', accent: '#d4a0c0' }, // 绛紫 / 藕
    { a: '#1c6a74', b: '#e2f0ee', ink: '#143840', accent: '#e0b86a' }, // 海 / 沫
    { a: '#5c6424', b: '#efe6cc', ink: '#2c3014', accent: '#c45a32' }, // 橄榄 / 锈
    { a: '#243044', b: '#ece4d2', ink: '#1c2430', accent: '#7aa0c4' }, // 夜空 / 月
    { a: '#8a2038', b: '#f4e6d6', ink: '#4a1822', accent: '#d4a05a' }, // 酒红 / 乳
    { a: '#2a6b62', b: '#f0e4dc', ink: '#1c3c38', accent: '#e07a5a' }, // 青磁 / 珊瑚
    { a: '#3d4a52', b: '#f2ead0', ink: '#2a3034', accent: '#d4a017' }, // 青灰 / 芥
].map(p => Object.assign(p, { c1: p.a, c2: p.b }))

const LAYOUTS = ['head', 'foot', 'rail', 'cap', 'pane', 'slash']
const MARKS = ['disc', 'bar', 'sq']

export function coverSpec (id) {
    const h = hashId(id)
    return {
        palette: PALETTES[h % PALETTES.length],
        layout: LAYOUTS[(Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0) % LAYOUTS.length],
        mark: MARKS[(Math.imul(h ^ 0x85ebca6b, 2246822519) >>> 0) % MARKS.length],
    }
}

export function coverTheme (id) {
    return coverSpec(id).palette
}

export const THEME_COUNT = PALETTES.length
export const LAYOUT_COUNT = LAYOUTS.length

function formatLabel (book) {
    if (book.format === 'pdf') return 'PDF · 文字版'
    if (book.format === 'txt') return 'TXT'
    return 'EPUB'
}

function percentOf (book) {
    const pct = Math.round((book.progress?.percent || 0) * 100)
    return Math.max(0, Math.min(100, pct))
}

function coverText (book) {
    const parts = [formatLabel(book)]
    if (book.author) parts.push(String(book.author).slice(0, 40))
    const pct = percentOf(book)
    if (pct > 0) parts.push(pct + '%')
    return parts.join(' · ')
}

const SORTERS = {
    recent: (a, b) => (b.lastOpenedAt || 0) - (a.lastOpenedAt || 0),
    added: (a, b) => (b.addedAt || 0) - (a.addedAt || 0),
    title: (a, b) => String(a.title).localeCompare(String(b.title), 'zh-Hans-CN'),
    progress: (a, b) => (b.progress?.percent || 0) - (a.progress?.percent || 0),
}

export function filterSortBooks (books, query, sort) {
    const q = String(query || '').trim().toLowerCase()
    const matched = (books || []).filter(b => !q ||
        String(b.title || '').toLowerCase().includes(q) ||
        String(b.author || '').toLowerCase().includes(q))
    return matched.sort(SORTERS[sort] || SORTERS.recent)
}

export function shelfHTML (books) {
    return (books || []).map((b, i) => {
        const spec = coverSpec(b.id)
        const theme = spec.palette
        const pct = percentOf(b)
        const label = `打开《${b.title}》${coverText(b)}`
        const zoneA = b.coverUrl
            ? `<img class="cover-img" src="${escapeHtml(b.coverUrl)}" alt="" draggable="false">`
            : ''
        const thick = 32 + (hashId(b.id) % 12)
        return `
        <div class="shelf-book" style="--i:${i};--bt:${thick}px;--bc1:${theme.a};--bc2:${theme.b};--bink:${theme.ink};--bacc:${theme.accent}">
            <button data-action="open-book" data-id="${escapeHtml(b.id)}" class="book3d" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
                <span class="book-face book-front${b.coverUrl ? ' with-image' : ''}" data-layout="${spec.layout}" data-mark="${spec.mark}" aria-hidden="true">
                    <span class="cover-a">${zoneA}</span>
                    <span class="cover-b"></span>
                    <span class="cover-mark"></span>
                    <span class="cover-title">${escapeHtml(b.title)}</span>
                </span>
                <span class="book-face book-spine" aria-hidden="true"><span class="spine-text">${escapeHtml(b.title)}</span></span>
                <span class="book-face book-pages" aria-hidden="true"></span>
                <span class="book-face book-top" aria-hidden="true"></span>
            </button>
            <div class="book-progress" aria-hidden="true"><span style="width:${pct}%"></span></div>
            <button data-action="book-toc" data-id="${escapeHtml(b.id)}" class="book-toc" aria-label="查看《${escapeHtml(b.title)}》的目录" title="目录">目</button>
            <button data-action="del-book" data-id="${escapeHtml(b.id)}" class="book-del" aria-label="删除《${escapeHtml(b.title)}》" title="删除">✕</button>
        </div>`
    }).join('')
}

// 相对时间：继续阅读卡片与列表行的「最近阅读」描述
export function timeAgoLabel (ts) {
    if (!ts) return ''
    const diff = Date.now() - ts
    if (diff < 60e3) return '刚刚'
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`
    if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`
    if (diff < 2 * 86400e3) return '昨天'
    if (diff < 30 * 86400e3) return `${Math.floor(diff / 86400e3)} 天前`
    return new Date(ts).toLocaleDateString('zh-CN')
}

// 紧凑列表视图：同一数据与操作（打开/删除），行内显示章节与最近阅读时间
export function shelfListHTML (books) {
    return `<div class="book-list">` + (books || []).map(b => {
        const pct = percentOf(b)
        const meta = [
            b.author || '佚名',
            b.progress?.tocLabel ? `读到「${b.progress.tocLabel}」` : '',
            pct > 0 ? `已读 ${pct}%` : '未开始',
            timeAgoLabel(b.lastOpenedAt),
        ].filter(Boolean).join(' · ')
        return `
        <div class="book-row">
            <button data-action="open-book" data-id="${escapeHtml(b.id)}" class="book-row-main" aria-label="打开《${escapeHtml(b.title)}》">
                <span class="bl-title">${escapeHtml(b.title)}</span>
                <span class="bl-meta">${escapeHtml(meta)}</span>
            </button>
            <button data-action="book-toc" data-id="${escapeHtml(b.id)}" class="list-toc" aria-label="查看《${escapeHtml(b.title)}》的目录" title="目录">目录</button>
            <button data-action="del-book" data-id="${escapeHtml(b.id)}" class="book-del list-del" aria-label="删除《${escapeHtml(b.title)}》" title="删除">✕</button>
        </div>`
    }).join('') + `</div>`
}
