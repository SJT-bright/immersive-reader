// Annotation overlay stays separate from book contents and follows repagination.
function dashedUnderline(rects, {color, writingMode}={}) {
    const ns='http://www.w3.org/2000/svg',group=document.createElementNS(ns,'g')
    group.setAttribute('fill','none');group.setAttribute('stroke',color||'#e3b95e')
    group.setAttribute('stroke-width','2');group.setAttribute('stroke-dasharray','4 3')
    group.setAttribute('stroke-linecap','round')
    for(const rect of rects) {
        const line=document.createElementNS(ns,'line'),vertical=writingMode?.startsWith('vertical')
        const coords=vertical?[rect.right-1,rect.top,rect.right-1,rect.bottom]:[rect.left,rect.bottom-1,rect.right,rect.bottom-1]
        for(const [i,key] of ['x1','y1','x2','y2'].entries())line.setAttribute(key,coords[i])
        group.append(line)
    }
    return group
}
// All renderer operations share a queue: foliate's paginator must not load two sections at once.
import '../vendor/foliate-js/view.js'
import { spreadColumnMetrics } from './book-spread.js'
import { touchBook } from './db.js'
import { nextSentenceFromRange } from './notes.js'
import { addRange, readFraction, sectionSizesFrom, initReadMapFromPercent, sanitizeReadMap,
    DwellMeter, DWELL_TICK_MS } from './reading-stats.js'
import { PageTurn } from './page-turn.js'

const FONTS = {
    song: '"Songti SC", "Noto Serif CJK SC", "SimSun", serif',
    hei: '"PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif',
    kai: '"Kaiti SC", "KaiTi", "STKaiti", serif',
}
const frame = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 150)
    requestAnimationFrame(() => { clearTimeout(timer); resolve() })
})
const timeout = async (promise, ms) => {
    let timer
    try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('书页未能载入，请用独立 Chrome 浏览器打开此地址重试')), ms)
    })]) } finally { clearTimeout(timer) }
}
const JOURNAL = 'immersive-reader-position:'

// 分页器的阴影是关闭的，书缝对齐需要改它内部的栏网格。只对 foliate 元素打开。
if (typeof Element !== 'undefined' && !Element.prototype.__readerShadowPatched) {
    const attachShadow = Element.prototype.attachShadow
    Element.prototype.attachShadow = function (init) {
        const root = attachShadow.call(this, { ...(init || {}), mode: 'open' })
        this.__readerShadow = root
        return root
    }
    Element.prototype.__readerShadowPatched = true
}

export class Reader extends EventTarget {
    constructor(container) {
        super()
        this.container = container
        this.view = null
        this.flow = 'paginated'
        this.bookSpread = false
        this.bookId = null
        this.layout = { fontSize: 21, lineHeight: 1.9, maxWidth: 640, fontFamily: 'song' }
        this.textTheme = { textColor: '#2b2620' }
        this._queue = Promise.resolve()
        this._save = Promise.resolve()
        this._generation = 0
        // 排版令牌：每次真正入队的排版请求自增一号，任务体在每个 await 之后比对，
        // 号不对就说明后面又有新的排版请求，本任务立刻作废（不再 render/落盘）。
        this._layoutSeq = 0
        // 拖动字号/行距时一次产生 30-60 个 setLayout 调用：这里合并成「一个进行中的排版轮次」，
        // 后续调用只更新 this.layout 并标记该轮需要重跑，绝不再往队列里塞任务。
        this._layoutPass = null
        this._wheelLockUntil = 0
        this._layoutBusy = false // 排版/导航进行中：渐进分页的中继 relocate 不计已读
        this._layoutAnchorCFI = null // 调字号后的页首会前移；连续排版始终锚定原正文位置
        this._resizePending = false // 原生分页器会先于应用重排发出临时 relocate
        // 「读满 30 秒才算一页」的停留计时（阈值 PAGE_DWELL_MS 在 reading-stats.js）。
        // 计时只在这里推进，写入点集中在 _commitDwell，翻页/跳章/关书都会取消未满的计时。
        this._dwell = new DwellMeter()
        this._dwellTimer = null
        this._onDwellVisibility = () => {
            const now = performance.now()
            if (document.hidden) this._dwell.pause(now)
            else this._dwell.resume(now)
        }
        if (typeof document !== 'undefined') {
            // 切后台/切标签页期间不能累积阅读时长（挂在那里不算在读）。
            document.addEventListener('visibilitychange', this._onDwellVisibility)
        }
        this.turn = new PageTurn(container)
        this._turning = null
        this._queuedTurn = 0
        this.lastProgress = null
        this._readMap = null // 已读区间 { [sectionIndex]: [[a,b],...] }，见 reading-stats.js
        this._sizes = [] // section 权重（字符量），与 foliate SectionProgress 同规则
        // PDF 的 section 序号 → 原书第几页（长页被拆成多个 section，序号不等于页号，见 txt2epub.packChapters）
        this._pdfPages = null
        this._pdfPageCount = 0
    }

    enqueue(fn) {
        const task = this._queue.then(fn)
        this._queue = task.catch(() => {})
        return task
    }

    async open(record, { lastLocation, useJournal = true } = {}) {
        this.dispatchEvent(new Event('manualnavigation'))
        const generation = ++this._generation
        // 换书时排队中/进行中的排版请求立刻作废，否则「回书架/换书」要等整条排版队列跑完
        ++this._layoutSeq
        this._layoutPass = null
        return this.enqueue(async () => {
            this._layoutBusy = true
            try {
            await this.dispose()
            if (generation !== this._generation) return false
            const view = document.createElement('foliate-view')
            this.view = view
            this.notes = record.notes || []
            this.bookId = record.id
            const frontispiece = this.container.querySelector('.book-frontispiece-title')
            if (frontispiece) frontispiece.textContent = record.title || '阅读时光'
            this.bookFormat = record.format
            this.lastProgress = null
            this._readMap = null
            this._sizes = []
            this._dwell.cancel() // 换书：上一本未读满 30s 的计时作废
            const current = () => this.view === view && generation === this._generation
            view.addEventListener('relocate', e => {
                if (current()) this.onRelocate(record.id, e.detail)
            })
            view.addEventListener('load', e => { if (current()) this.onLoad(e.detail.doc, view) })
            view.addEventListener('external-link', e => {
                e.preventDefault()
                if (current()) this.dispatchEvent(new CustomEvent('externallink', { detail: e.detail.href_ }))
            })
            // Internal links use the same navigation queue as keyboard/TOC.
            view.addEventListener('link', e => {
                e.preventDefault()
                if (current()) { this.dispatchEvent(new Event('linkjump')); this.goTo(e.detail.href) }
            })
            view.addEventListener('draw-annotation',e=>e.detail.draw(dashedUnderline,{color:'#e3b95e',writingMode:e.detail.doc.defaultView.getComputedStyle(e.detail.doc.body).writingMode}))
            view.addEventListener('create-overlay',()=>setTimeout(()=>{
                if(current())this.drawNotes()
            },0))
            this.container.append(view)
            // PDF 的「第 N 页」要用原书页号：长页会被拆成多个 section，序号≠页号
            this._pdfPages = Array.isArray(record.pdfPages) ? record.pdfPages : null
            this._pdfPageCount = Number(record.pdfPageCount) ||
                (this._pdfPages ? Math.max(0, ...this._pdfPages.map(p => Number(p) || 0)) : 0)
            try {
                const file = new File([record.data], 'book.epub', { type: 'application/epub+zip' })
                await view.open(file)
                if (view.isFixedLayout) throw new Error('暂不支持固定版式 EPUB，请使用可重排 EPUB 或 TXT')
                const renderer = view.renderer
                const render = renderer.render.bind(renderer)
                renderer.render = (...args) => {
                    // ResizeObserver can fire while a chapter iframe is loading or already
                    // detached. Keep the pinned engine intact and wait for a live document.
                    if (!current() || !view.isConnected || !renderer.getContents().some(({doc}) => doc?.documentElement && doc?.body)) return
                    return render(...args)
                }
                if (!view.book.sections?.length) throw new Error('书籍没有可读章节')
                view.renderer.setAttribute('flow', this.flow)
                this.configureColumns(view)
                view.renderer.setAttribute('margin', '0')
                // Our load handler owns each chapter's style element. The pinned paginator's
                // setStyles schedules an uncancellable RAF that can outlive close() (1113).
                // Avoid that path, including its internal call on chapter load; render() below
                // repaginates synchronously and onLoad supplies styles before chapter layout.
                view.renderer.setStyles = () => {}
                this._sizes = sectionSizesFrom(view.book.sections)
                try {
                    const journal = JSON.parse(localStorage.getItem(JOURNAL + record.id))
                    // 本机 journal 与共享 DB 的进度谁新用谁。两边都有时间戳才比较；任一边缺
                    // at（本次改动之前写入的旧记录）保持原行为＝journal 优先，向后兼容。
                    const journalAt = Number(journal?.at) || 0
                    const dbAt = Number(record.progress?.at) || 0
                    const journalNewer = !journalAt || !dbAt || journalAt >= dbAt
                    if (useJournal && journal?.cfi && journalNewer) lastLocation = journal.cfi
                    // 已读记录恢复：较新的一边优先（位置比 DB 旧时不能再让 journal 抢）
                    const fresh = journalNewer ? journal : record.progress
                    const stale = journalNewer ? record.progress : journal
                    const legacy = fresh?.readMap || stale?.readMap
                    const migrated = sanitizeReadMap(legacy)
                    if (migrated) this._readMap = migrated
                    else if (record.progress?.percent != null || journal?.percent != null)
                        this._readMap = initReadMapFromPercent(
                            (fresh?.percent ?? stale?.percent) ?? 0, this._sizes)
                    else this._readMap = {}
                } catch { this._readMap = sanitizeReadMap(record.progress?.readMap) || {} }
                const target = lastLocation && view.resolveNavigation(lastLocation)
                if (target && target.index >= 0 && target.index < view.book.sections.length) {
                    await timeout(view.renderer.goTo(target), 15000)
                } else await timeout(view.init({ showTextStart: true }), 15000)
                await this.settle(view)
                if (!current()) return false
                this.recordScreen() // 开卷/恢复位置：登记当前屏，读满 30s 才计入（排版期中继 relocate 已跳过）
                this._startDwellClock() // 停留计时的秒针：没有事件也要能判定「读满」
                this.applyColor(view)
                this.dispatchEvent(new CustomEvent('bookopen', { detail: { title: record.title, author: record.author } }))
                return true
            } catch (error) {
                await this.dispose()
                throw error
            }
            } finally { this._layoutBusy = false }
        })
    }

    // 顶栏页码文案：优先书自带纸书页码（pageList）；PDF 显示原书第几页（一页可能被拆成
    // 多个 section，靠导入时记录的映射换算）；EPUB/TXT 为重排版式，全书页数随字号与窗口
    // 变化，显示本章第几页（口径与已读区间一致）。
    pageText(detail) {
        const label = detail?.pageItem?.label
        if (label) return `第 ${label} 页`
        const sec = detail?.section
        if (this.bookFormat === 'pdf' && Number.isInteger(sec?.current)) {
            // 原书页号取导入时记录的映射：一页段落数超过上限会被拆成多个 section
            // （见 txt2epub.packChapters），拿 section.current+1 当页号会从那一页起整本错位。
            const page = Number(this._pdfPages?.[sec.current]) || 0
            const total = this._pdfPageCount
            if (page > 0) return `第 ${page}${total ? ' / ' + total : ''} 页`
            return `第 ${sec.current + 1}${Number.isInteger(sec.total) ? ' / ' + sec.total : ''} 页`
        }
        const r = this.view?.renderer
        if (!r) return ''
        if (r.scrolled) {
            if (!(r.pages > 0) || !(r.size > 0)) return ''
            const total = r.pages
            const cur = Math.min(total, Math.floor(r.start / r.size) + 1)
            return `本章第 ${cur} / ${total} 页`
        }
        if (r.pages > 2) {
            const total = r.pages - 2
            const cur = Math.min(total, Math.max(1, r.page))
            return `本章第 ${cur} / ${total} 页`
        }
        return ''
    }

    // 当前屏在 section 内的 fraction 区间（renderer 实时读）：
    // paginated 正文页 page∈[1,pages-2]；scrolled 用 start/viewSize。排版未成态时返回 null。
    screenRange(r) {
        if (r?.scrolled && r.viewSize > 0) {
            const a = Math.max(0, Math.min(1, r.start / r.viewSize))
            return [a, Math.min(1, a + r.size / r.viewSize)]
        }
        if (r && r.pages > 2) {
            const textPages = r.pages - 2
            const cur = Math.min(textPages, Math.max(1, r.page))
            return [(cur - 1) / textPages, Math.min(1, cur / textPages)]
        }
        return null
    }

    // 布局落定后登记当前屏（开卷、翻页/跳转/换章、换排版、自动阅读共用），
    // 并同步 lastProgress、落盘与顶栏（合成 relocate 复用主界面监听）。
    // 注意：这里不再「进入即计为已读」，只把这一屏交给 30s 停留计时；
    // 满时长由 _noteScreen → _commitDwell 写入 readMap（产品规则，见 PAGE_DWELL_MS）。
    recordScreen({ preserveLayoutAnchor = false } = {}) {
        const view = this.view
        const index = view?.lastLocation?.section?.current
        if (!Number.isInteger(index) || index < 0) return
        const range = this.screenRange(view.renderer)
        if (!range) { this.#countBlankChapter(index); return }
        if (!preserveLayoutAnchor && view.lastLocation?.cfi)
            this._layoutAnchorCFI = view.lastLocation.cfi
        this._noteScreen()
        if (!this.lastProgress) return
        if (preserveLayoutAnchor && this._layoutAnchorCFI)
            this.lastProgress.cfi = this._layoutAnchorCFI
        this.lastProgress.percent = readFraction(this._readMap, this._sizes)
        this.lastProgress.readMap = this._readMap
        if (!this._autoStep || Date.now() - (this._lastSavedAt || 0) >= 1000)
            this.savePosition(this.bookId, this.lastProgress)
        this.dispatchEvent(new CustomEvent('relocate', { detail: view.lastLocation }))
    }

    // 排不出任何一页的章（空白章、纯装饰页、只有背景色的扉页）：section 有字节所以进了
    // reading-stats 的权重分母，却永远产不出 screenRange，全书进度就卡在 99% 附近、
    // 目录里该章圆点恒「未读」。确认「这一章确实无可排内容」后整章记满一次；
    // addRange 幂等，重复调用不产生新增也就不会反复落盘。
    #countBlankChapter (index) {
        const view = this.view
        // 不设 _layoutBusy 守卫：recordScreen 的全部调用点（开卷/翻页/跳章/归零/
        // 自动阅读）都在版面落定之后才进来，渐进排版的中继 relocate 只走
        // onRelocate→_noteScreen，从不经过这里。此前这个守卫把 7 条路径里的 6 条
        // 吞掉，空白章永远不计入，全书进度卡在 99% 附近、目录圆点不亮；
        // 下方的四重复核（位置一致、排得出页、权重大于 0、addRange 幂等）保证
        // 即使将来新增调用点也不会重复计数。
        if (!view?.renderer) return
        if (view.lastLocation?.section?.current !== index || !view.lastLocation?.cfi) return
        if (!(index < this._sizes.length)) return
        if (this.chapterPages(index) !== 0) return // 排得出页就不是空白章
        if (!(this._sizes[index] > 0)) return // 权重为 0 的章本来就不进分母
        const map = addRange(this._readMap || {}, index, 0, 1)
        if (map === this._readMap) return
        this._readMap = map
        if (this.lastProgress) {
            this.lastProgress.percent = readFraction(map, this._sizes)
            this.lastProgress.readMap = map
            if (this.bookId) this.savePosition(this.bookId, this.lastProgress)
        }
        this.dispatchEvent(new CustomEvent('relocate', { detail: view.lastLocation }))
    }

    // 采样当前屏并推进停留计时：分页模式换屏即重新计时，滚动模式按滑动容差带累积。
    // 返回是否产生了新的已读计入（计入本身由 _commitDwell 落盘并广播）。
    _noteScreen() {
        const view = this.view
        const renderer = view?.renderer
        const index = view?.lastLocation?.section?.current
        if (!renderer || !Number.isInteger(index) || index < 0) return false
        if (typeof document !== 'undefined' && document.hidden) {
            this._dwell.pause(performance.now()) // 隐藏期间不累积（可能没有 visibilitychange）
            return false
        }
        const range = this.screenRange(renderer)
        if (!range) return false
        // 分页模式一屏是一屏；滚动模式没有离散页，交给滑动窗口按停留时长结算。
        const commits = this._dwell.observe(index, range[0], range[1],
            performance.now(), !renderer.scrolled)
        if (!commits.length) return false
        this._commitDwell(commits)
        return true
    }

    // 停留满 30s 的屏在这里计入：写区间、刷进度、落盘、通知顶栏与目录。
    _commitDwell(commits) {
        let map = this._readMap || {}
        let changed = false
        for (const [index, a, b] of commits) {
            const next = addRange(map, index, a, b)
            if (next !== map) { map = next; changed = true }
        }
        if (!changed) return
        this._readMap = map
        const loc = this.view?.lastLocation
        if (this.lastProgress) {
            this.lastProgress.percent = readFraction(map, this._sizes)
            this.lastProgress.readMap = map
            if (this.bookId) this.savePosition(this.bookId, this.lastProgress)
        }
        if (loc) this.dispatchEvent(new CustomEvent('relocate', { detail: loc }))
    }

    // 每秒采样一次：盯着页面不动不会再有任何事件，停留时长只能靠这个推进。
    _startDwellClock() {
        if (this._dwellTimer || typeof setInterval !== 'function') return
        this._dwellTimer = setInterval(() => {
            if (!this.view?.renderer || this._layoutBusy) return // 排版进行中不计时
            this._noteScreen()
        }, DWELL_TICK_MS)
    }
    _stopDwellClock() {
        clearInterval(this._dwellTimer)
        this._dwellTimer = null
    }

    // 供目录 UI 消费：指定 section 在当前排版下的总页数；拿不到返回 0。
    // 口径与 screenRange/pageText 严格一致——分页正文页 = renderer.pages - 2
    // （foliate 在章首章末各排一空白页），滚动模式 = renderer.pages（按视口高度折算）。
    // 分页器一次只排版一个 section（见 foliate getContents()），
    // 所以只有当前正在排版的 section 才有页数，其余（含未加载章节）返回 0。
    chapterPages(index) {
        const r = this.view?.renderer
        if (!r || !Number.isInteger(index) || index < 0) return 0
        try {
            if (!r.getContents().some(item => item?.index === index)) return 0
        } catch { return 0 } // 排版器还没初始化
        const pages = Math.round(Number(r.pages) || 0)
        if (!(pages > 0) || !(Number(r.size) > 0)) return 0
        if (r.scrolled) return pages
        return pages > 2 ? pages - 2 : 0
    }

    onRelocate(id, detail) {
        if (this._resizePending) return
        // 已读页记录：当前屏不再立即计入，只登记进 30s 停留计时（分页换屏即重新计时，
        // 滚动模式按滑动窗口结算）。view 的 relocate detail 是 lastLocation（无 index/size），
        // section 序号取 section.current，页位置从 renderer 实时读。
        // 排版/导航进行中（_layoutBusy）的分页渐进中继不采样，
        // 由操作落定后的 recordScreen 统一登记，避免把整章误标为已读。
        const index = detail.section?.current
        if (!this._layoutBusy && Number.isInteger(index) && index >= 0) this._noteScreen()
        const percent = readFraction(this._readMap, this._sizes)
        const progress = {
            cfi: detail.cfi || null,
            at: Date.now(), // 进度时间戳：本机 journal 与共享 DB 比新旧用（见 open()）
            fraction: detail.fraction || 0,
            percent, // 已读口径：加权已读区间 / 全书，跳过的页不计入
            readMap: this._readMap,
            section: detail.section?.current ?? 0,
            tocLabel: detail.tocItem?.label || '',
            location: detail.location ?? null,
            pageItemLabel: detail.pageItem?.label || '',
            pageLabel: this.pageText(detail),
        }
        this.lastProgress = progress
        if (!this._layoutBusy && detail.cfi) this._layoutAnchorCFI = detail.cfi
        if (!this._autoStep || Date.now() - (this._lastSavedAt || 0) >= 1000) this.savePosition(id, progress)
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    // 目录面板等消费方：已读区间与各 section 覆盖
    get readStats() {
        return { readMap: this._readMap || {}, sizes: this._sizes, percent: readFraction(this._readMap, this._sizes) }
    }
    // 进度归零（书打开时）：清空已读区间并把视图真正送回开头。
    // 锚点必须一起清空：留着旧 cfi，下一次翻页/改字号（recordScreen 的
    // preserveLayoutAnchor 分支）就会把归零前的位置重新写回 journal 与 SQLite，重开仍回原处。
    // 返回的 Promise 在「回到开头」落定后 resolve；调用方不 await 也能立刻看到顶栏 0%。
    resetProgress() {
        this._readMap = {}
        this._dwell.cancel() // 归零后不许再把归零前的计时补记回来
        this._layoutAnchorCFI = null
        const keep = this.lastProgress || {}
        const progress = {
            cfi: null,
            at: Date.now(),
            fraction: 0,
            percent: 0,
            readMap: {},
            section: Number.isInteger(keep.section) ? keep.section : 0,
            tocLabel: keep.tocLabel || '',
            location: keep.location ?? null,
            pageItemLabel: keep.pageItemLabel || '',
            pageLabel: keep.pageLabel || '',
        }
        this.lastProgress = progress
        // savePosition 用 cfi:null 覆盖整条 journal，旧的开头前位置不会再被 open() 选中
        if (this.bookId) this.savePosition(this.bookId, progress)
        this.dispatchEvent(new CustomEvent('relocate', { detail: this.view?.lastLocation }))
        const view = this.view
        const generation = this._generation
        if (!view?.renderer) return Promise.resolve()
        return this.enqueue(async () => {
            if (this.view !== view || generation !== this._generation) return
            this._layoutBusy = true
            try {
                await timeout(view.goToTextStart(), 15000)
                await this.settle(view)
                this.recordScreen()
            } finally { this._layoutBusy = false }
        }).catch(error => this.report(error, '进度归零后未能回到开头'))
    }
    savePosition(id, progress) {
        // 落盘即刷新时间戳：journal（本机）与 DB（共享）谁新用谁在 open() 里判定
        if (progress) progress.at = Date.now()
        this._lastSavedAt = Date.now(); this._savedCFI = progress.cfi
        // Synchronous journal closes the last-page gap on reload/tab close; each ID is captured here.
        try { localStorage.setItem(JOURNAL + id, JSON.stringify(progress)) } catch { /* DB remains available. */ }
        this._save = this._save.catch(() => {}).then(() => touchBook(id, progress))
        this._save.catch(error => this.report(error, '阅读位置未能保存'))
    }

    // 形注逐条交给 foliate 定位。逐条 await 时视图可能在中途被换书销毁，剩下的必然全部失败；
    // 失败不能静默——计数后派发 notesdrawfailed（detail: {bookId, failed, total}）供 UI 提示。
    async drawNotes() {
        const view = this.view
        const quotes = (this.notes || []).filter(note => note?.type === 'quote')
        let failed = 0
        if (!view && quotes.length) failed = quotes.length // 没有可用视图：一条都画不上
        for (const note of quotes) {
            if (this.view !== view || !view) break // 已经换书/关书，剩下的不再尝试
            try { await view.addAnnotation({ value: note.cfi }) }
            catch { failed++ }
        }
        if (failed) this.dispatchEvent(new CustomEvent('notesdrawfailed', {
            detail: { bookId: this.bookId, failed, total: quotes.length },
        }))
    }
    onLoad(doc, view) {
        const selectionChanged=()=>{
            const selection=doc.getSelection(),text=selection?.toString().trim()
            if(!text || selection.isCollapsed)return
            const content=view.renderer.getContents().find(item=>item.doc===doc)
            if(!content)return
            const range=selection.getRangeAt(0)
            const cfi=view.getCFI(content.index,range)
            const page=this.lastProgress?.pageItemLabel || ''
            const after=nextSentenceFromRange(range)
            this.dispatchEvent(new CustomEvent('textselection',{detail:{
                bookId:this.bookId,cfi,text,after,page,
                chapter:this.lastProgress?.tocLabel||'',
                location:this.lastProgress?.location ?? '',
            }}))
        }
        doc.addEventListener('pointerup',()=>setTimeout(selectionChanged,0))
        doc.addEventListener('keyup',selectionChanged)

        doc.documentElement.dataset.readerFlow=this.flow
        const style = doc.createElement('style')
        style.dataset.readerStyle = ''
        style.textContent = this.styles()
        doc.head.append(style)
        this.applyColorToDoc(doc)
        const activity = () => this.dispatchEvent(new Event('activity'))
        doc.addEventListener('pointermove', activity, { passive: true })
        doc.addEventListener('touchstart', activity, { passive: true })
        doc.addEventListener('keydown', e => {
            activity()
            if (e.target.closest('input,textarea,select,[contenteditable]') || e.ctrlKey || e.metaKey || e.altKey) return
            if(e.code==='Space'||e.key===' '){
                e.preventDefault()
                if(!e.repeat&&!e.isComposing)this.dispatchEvent(new Event('togglecontrols'))
                return
            }
            if (['ArrowRight', 'PageDown', 'ArrowLeft', 'PageUp'].includes(e.key)) {
                e.preventDefault()
                if (['ArrowLeft', 'PageUp'].includes(e.key) || (e.key === ' ' && e.shiftKey)) this.prev()
                else this.next()
            }
            if (e.key === 'Escape') this.dispatchEvent(new Event('escape'))
        })
        doc.addEventListener('pointerdown', () => {
            // 书页在 iframe 里，浮层的外侧收起监听收不到这里的按下，翻页与收目录会同时发生。
            // 记下这一次，让 click 只用来收起浮层；700ms 后自动失效，拖拽选词不会误吞下一次点击。
            if (this.pageTurnGuard?.()) this.turnSwallowAt = Date.now()
            this.dispatchEvent(new Event('pagepointerdown'))
            this.dispatchEvent(new Event('manualnavigation'))
        }, {passive:true})
        doc.addEventListener('wheel', e => {
            activity()
            if(e.ctrlKey || !e.deltaY)return
            this.dispatchEvent(new Event('manualnavigation'))
            if(view.renderer.scrolled)return // Let the browser handle pixel scrolling and trackpad inertia.
            e.preventDefault()
            // 分页模式：滚轮=翻一页，不悄悄切换阅读模式。
            // 650ms 惯性锁 + 40px 起翻阈值，触控板连续滚动/惯性尾巴不会连环翻页。
            const now = Date.now()
            if (this._wheelLockUntil && now < this._wheelLockUntil) return
            const delta=e.deltaY*(e.deltaMode===1?20:e.deltaMode===2?view.renderer.size:1)
            if (Math.abs(delta) < 40) return
            this._wheelLockUntil = now + 650
            if (delta > 0) this.next()
            else this.prev()
        }, { passive: false })
        let touch, swipedAt = 0
        doc.addEventListener('touchstart', e => {
            const t = e.touches[0]
            touch = e.touches.length === 1 ? { x: t.clientX, y: t.clientY } : null
        }, { passive: true })
        doc.addEventListener('touchend', e => {
            if (view.renderer.scrolled || !touch || !e.changedTouches[0]) return
            const t = e.changedTouches[0], dx = t.clientX - touch.x, dy = t.clientY - touch.y
            touch = null
            if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.5) {
                swipedAt = Date.now()
                dx < 0 ? this.next() : this.prev()
            }
        }, { passive: true })
        doc.addEventListener('click', e => {
            activity()
            if (this.turnSwallowAt && Date.now() - this.turnSwallowAt < 700) { this.turnSwallowAt = 0; return }
            if (view.renderer.scrolled || Date.now() - swipedAt < 500 || e.target.closest('a,button,input,textarea,select') ||
                doc.getSelection()?.toString() || view !== this.view) return
            const x = e.clientX / (doc.defaultView.innerWidth || 1)
            if (x < 0.16) this.prev()
            else if (x > 0.84) this.next()
        })
    }

    styles() {
        const { fontSize: preferredFontSize, lineHeight, fontFamily } = this.layout
        const compactBook = this.bookSpread && this.container.clientWidth < 640
        const fontSize = compactBook ? Math.max(14, preferredFontSize * .76) : preferredFontSize
        return `
            ${compactBook ? 'h1, h2, h3 { font-size: 1.1rem !important; line-height: 1.6 !important; margin-block: .7em !important; }' : ''}
            html[data-reader-flow="scrolled"] body::after { content:"";display:block;height:${Math.round(fontSize*lineHeight*5)}px;clear:both;pointer-events:none; }
            html { font-size: ${fontSize}px !important; }
            html, body { background: transparent !important; }
            body { line-height: ${lineHeight} !important; ${this.bookSpread ? 'padding:0 !important;margin:0 !important;max-width:none !important;' : ''} }
            body, body * { color: var(--reader-ink) !important;
                background-color: transparent !important; background-image: none !important;
                text-shadow: none !important; opacity: 1 !important;
                font-family: ${FONTS[fontFamily] || FONTS.song} !important; }
            p, li, blockquote, dd, dt {
                font-size: 1rem !important; line-height: ${lineHeight} !important;
                white-space: normal !important; word-break: normal !important;
                overflow-wrap: break-word !important; letter-spacing: normal !important;
                text-align: start !important;
            }
            p { margin-block: 0 .7em !important; }
            a { text-decoration: underline !important; }
            ::selection { background: rgba(128,128,128,.3); }`
    }

    applyColorToDoc(doc) {
        doc?.documentElement?.style.setProperty('--reader-ink', this.textTheme.textColor)
    }
    applyColor(view = this.view) {
        for (const { doc } of view?.renderer?.getContents() || []) this.applyColorToDoc(doc)
    }
    setTextTheme(theme) {
        this.textTheme = theme
        // Color alone must never repaginate the book.
        this.applyColor()
    }
    // 翻页双页：一屏正好两栏，中缝对准书页中线。滚动模式仍是单栏。
    configureColumns(view = this.view) {
        if (!view?.renderer) return
        const spread = this.bookSpread && this.flow !== 'scrolled'
        const pageWidth = Math.max(160, Math.floor(view.clientWidth || this.container.clientWidth || 0))
        this.pinSpreadFrame(view, spread)
        view.renderer.setAttribute('max-column-count', spread ? '2' : '1')
        view.renderer.setAttribute('margin', '0')
        if (spread) {
            const { gutter } = spreadColumnMetrics(pageWidth)
            const gapPct = Math.min(8, Math.max(3, (gutter / pageWidth) * 100))
            view.renderer.setAttribute('gap', `${gapPct.toFixed(2)}%`)
            view.renderer.setAttribute('max-inline-size', `${Math.floor(pageWidth / 2)}px`)
        } else {
            view.renderer.setAttribute('gap', '7%')
            view.renderer.setAttribute('max-inline-size', `${this.layout.maxWidth}px`)
        }
    }
    // 去掉分页器两侧的百分比留白，让这一屏的宽度等于书页，避免右页再露出下一栏。
    pinSpreadFrame(view, spread) {
        const top = view?.renderer?.__readerShadow?.getElementById('top')
        if (!top) return
        if (spread) top.style.setProperty('grid-template-columns', '0px 0px minmax(0, 1fr) 0px 0px')
        else top.style.removeProperty('grid-template-columns')
    }
    setBookSpread(enabled) {
        if (this.bookSpread === enabled) return Promise.resolve()
        this.bookSpread = enabled
        return this.setLayout({})
    }
    beginViewportResize() {
        if (!this.view?.renderer || this._resizePending) return
        this._layoutAnchorCFI = this.lastProgress?.cfi || this.view.lastLocation?.cfi || this._layoutAnchorCFI
        this._resizePending = true
    }
    // 排版请求入口：语义上是「可高频调用」。字号/行距/列宽滑块一次拖动会产生 30-60 个
    // input 事件，每个都要 render()+2×settle()+goTo()（50-150ms）＋落盘；这里在内部合并：
    // 只有一轮排版真正进队列，期间到达的调用只更新 this.layout 并把这一轮标记为需要重跑，
    // 全部返回同一个 Promise。松手后最多再排一次，也不会让「回书架/换书」等整条队列。
    setLayout(layout) {
        this.layout = { ...this.layout, ...layout }
        return this.requestLayout()
    }
    requestLayout() {
        const pending = this._layoutPass
        if (pending) { pending.stale = true; return pending.promise }
        const pass = { stale: false, promise: null }
        const seq = ++this._layoutSeq
        pass.promise = this.enqueue(() => this.#runLayoutPass(seq, pass))
            .finally(() => { if (this._layoutPass === pass) this._layoutPass = null })
            .catch(error => this.report(error, '排版调整失败'))
        this._layoutPass = pass
        return pass.promise
    }
    async #runLayoutPass (seq, pass) {
        const generation = this._generation
        // 这一轮 render 期间用户又拖了滑块（pass.stale）→ 用最新的 this.layout 再排一次；
        // recordScreen/savePosition 只在最后一轮做，避免每帧都开一次 IDB 事务＋磁盘镜像。
        do {
            pass.stale = false
            const view = this.view
            if (!view?.renderer || generation !== this._generation) return
            if (seq !== this._layoutSeq) return // 换书/关书作废排队中的排版请求
            this._layoutBusy = true
            try {
                const cfi = this._layoutAnchorCFI || this.lastProgress?.cfi
                this._resizePending = false
                this.configureColumns(view)
                for (const { doc } of view.renderer.getContents()) {
                    const style = doc.querySelector('[data-reader-style]')
                    if (style) style.textContent = this.styles()
                }
                view.renderer.render()
                await this.settle(view)
                if (seq !== this._layoutSeq) return
                if (cfi) await view.renderer.goTo(view.resolveNavigation(cfi))
                await this.settle(view)
                if (seq !== this._layoutSeq) return
            } finally { this._resizePending = false; this._layoutBusy = false }
        } while (pass.stale)
        this.recordScreen({ preserveLayoutAnchor: true })
    }
    async settle(view) {
        for (const { doc } of view?.renderer?.getContents() || []) await doc?.fonts?.ready
        await frame()
        await frame()
    }
    navigate(method, target) {
        this.dispatchEvent(new Event('manualnavigation'))
        if (method === 'next' || method === 'prev') return this.turnPage(method)
        const generation = this._generation
        return this.enqueue(async () => {
            const view = this.view
            if (!view?.renderer || generation !== this._generation) return
            this._layoutBusy = true
            try {
                const resolved = view.resolveNavigation(target)
                if (!resolved) throw new Error('找不到这个章节')
                await view.renderer.goTo(resolved)
                await this.settle(view)
                this.recordScreen()
            } finally { this._layoutBusy = false }
        }).catch(error => this.report(error, '翻页失败'))
    }
    // 连点合并：翻页进行中再点，只把方向累加，不并发进入分页器。
    // 不这样做的话 foliate 的 #locked 会把进行中的点击静默吞掉——连点三下只翻两页；
    // 反过来全部排队又会在停手后继续翻。累加还让「点一下下一页、马上点上一页」相互抵消。
    turnPage (method) {
        const dir = method === 'next' ? 1 : -1
        if (this._turning) {
            this._queuedTurn = Math.max(-3, Math.min(3, this._queuedTurn + dir))
            return this._turning
        }
        const generation = this._generation
        const run = async () => {
            try {
                await this.#doTurn(method, dir, generation)
            } finally {
                this._turning = null
                const queued = this._queuedTurn
                this._queuedTurn = 0
                if (queued && generation === this._generation) {
                    this.turnPage(queued > 0 ? 'next' : 'prev')
                }
            }
        }
        this._turning = this.enqueue(run)
        return this._turning
    }
    async #doTurn (method, dir, generation) {
        const view = this.view
        if (!view?.renderer || generation !== this._generation) return
        this._layoutBusy = true
        this.container.dataset.turning = dir > 0 ? 'next' : 'prev'
        try {
            await this.turn.run(view, () => view[method](), dir)
            await this.settle(view)
            this.recordScreen()
        } finally {
            delete this.container.dataset.turning
            this._layoutBusy = false
        }
    }
    goTo(target) { return this.navigate('goTo', target) }
    next() { return this.navigate('next') }
    prev() { return this.navigate('prev') }
    get toc() { return this.view?.book?.toc || [] }
    get sectionCount() { return this.view?.book?.sections?.length || 0 }
    flushProgress() {
        if (this.bookId && this.lastProgress && this._savedCFI !== this.lastProgress.cfi) this.savePosition(this.bookId, this.lastProgress)
        return this._save
    }
    setFlow(flow) {
        return this.enqueue(async () => {
            const view=this.view;if(!view?.renderer)return
            this._layoutBusy = true
            try {
                const cfi=this._layoutAnchorCFI || this.lastProgress?.cfi
                this.flow=flow;this._autoScrollTarget=null;this._autoEndSince=null
                view.renderer.setAttribute('flow',flow)
                this.configureColumns(view)
                for(const {doc} of view.renderer.getContents())doc.documentElement.dataset.readerFlow=flow
                view.renderer.render()
                await this.settle(view)
                if(cfi)await view.renderer.goTo(view.resolveNavigation(cfi))
                await this.settle(view)
                this.recordScreen({ preserveLayoutAnchor: true })
            } finally { this._layoutBusy = false }
        })
    }
    autoAdvance(mode,distance,current,endDwellMs=8000) {
        return this.enqueue(async () => {
            if(!current()||!this.view?.renderer)return false
            this._layoutBusy = true
            try {
            const r=this.view.renderer,index=r.getContents()[0]?.index
            const more=this.view.book.sections.some((s,i)=>i>index&&s.linear!=='no')
            if(mode==='page') {
                if(r.atEnd)return true
                await this.turn.run(this.view, () => this.view.next(), 1)
                await this.settle(this.view);this.recordScreen();return false
            }
            if(r.viewSize-r.end<=2) {
                // Leave the last lines on screen before changing sections, including the final section.
                const key=this.bookId+':'+index
                if(this._autoEndKey!==key||this._autoEndSince==null){this._autoEndKey=key;this._autoEndSince=performance.now()}
                if(performance.now()-this._autoEndSince<endDwellMs)return false
                this._autoEndSince=null
                if(!more)return true
                this._autoScrollTarget=null
                await r.nextSection();await this.settle(this.view);this.recordScreen();return false
            }
            this._autoEndSince=null
            this._autoStep=true
            // Keep fractional pixels across frames; scrollTop itself is device-pixel rounded.
            this._autoScrollTarget=Math.min(r.viewSize-r.size,(this._autoScrollTarget ?? r.start)+distance)
            try {await r.scrollToAnchor(this._autoScrollTarget/r.viewSize)}
            finally {this._autoStep=false}
            this.recordScreen()
            return false
            } finally { this._layoutBusy = false }
        })
    }
    async dispose() {
        await this.flushProgress().catch(() => {})
        // 关书/回书架：未读满 30s 的计时取消，秒针也停掉，不留残余计时器。
        this._stopDwellClock()
        this._dwell.cancel()
        this.turn.destroy()
        const view = this.view
        if (view) {
            await this.settle(view)
            try { view.close() } catch { /* Partially initialized renderer. */ }
            view.book?.destroy?.()
            view.remove()
        }
        this.view = null
        this.bookId = null
        this._layoutAnchorCFI = null
        this._resizePending = false
    }
    close() {
        this.dispatchEvent(new Event('manualnavigation'))
        ++this._generation
        // 与 open() 同理：让排队/进行中的排版轮次立刻作废，回书架不能排在整条排版队列后面
        ++this._layoutSeq
        this._layoutPass = null
        return this.enqueue(() => this.dispose())
    }
    report(error, label) {
        console.error(label, error)
        this.dispatchEvent(new CustomEvent('readererror', { detail: `${label}：${error.message}` }))
    }
}
