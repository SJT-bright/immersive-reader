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
import { touchBook } from './db.js?v=1.13.0'
import { nextSentenceFromRange } from './notes.js?v=1.0.0'

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

export class Reader extends EventTarget {
    constructor(container) {
        super()
        this.container = container
        this.view = null
        this.flow = 'paginated'
        this.bookId = null
        this.layout = { fontSize: 21, lineHeight: 1.9, maxWidth: 640, fontFamily: 'song' }
        this.textTheme = { textColor: '#2b2620' }
        this._queue = Promise.resolve()
        this._save = Promise.resolve()
        this._generation = 0
        this._wheelAt = 0
        this.lastProgress = null
    }

    enqueue(fn) {
        const task = this._queue.then(fn)
        this._queue = task.catch(() => {})
        return task
    }

    async open(record, { lastLocation } = {}) {
        this.dispatchEvent(new Event('manualnavigation'))
        const generation = ++this._generation
        return this.enqueue(async () => {
            await this.dispose()
            if (generation !== this._generation) return false
            const view = document.createElement('foliate-view')
            this.view = view
            this.notes = record.notes || []
            this.bookId = record.id
            this.bookFormat = record.format
            this.lastProgress = null
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
                if (current()) this.goTo(e.detail.href)
            })
            view.addEventListener('draw-annotation',e=>e.detail.draw(dashedUnderline,{color:'#e3b95e',writingMode:e.detail.doc.defaultView.getComputedStyle(e.detail.doc.body).writingMode}))
            view.addEventListener('create-overlay',()=>setTimeout(()=>{
                if(current())this.drawNotes()
            },0))
            this.container.append(view)
            try {
                const file = new File([record.data], 'book.epub', { type: 'application/epub+zip' })
                this.container.dataset.state = 'parsing'
                await view.open(file)
                this.container.dataset.state = 'layout'
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
                view.renderer.setAttribute('max-inline-size', `${this.layout.maxWidth}px`)
                view.renderer.setAttribute('max-column-count', '1')
                view.renderer.setAttribute('margin', '0')
                // Our load handler owns each chapter's style element. The pinned paginator's
                // setStyles schedules an uncancellable RAF that can outlive close() (1113).
                // Avoid that path, including its internal call on chapter load; render() below
                // repaginates synchronously and onLoad supplies styles before chapter layout.
                view.renderer.setStyles = () => {}
                try {
                    const journal = JSON.parse(localStorage.getItem(JOURNAL + record.id))
                    if (journal?.cfi) lastLocation = journal.cfi
                } catch { /* IndexedDB position remains the fallback. */ }
                const target = lastLocation && view.resolveNavigation(lastLocation)
                if (target && target.index >= 0 && target.index < view.book.sections.length) {
                    await timeout(view.renderer.goTo(target), 15000)
                } else await timeout(view.init({ showTextStart: true }), 15000)
                this.container.dataset.state = 'settling'
                await this.settle(view)
                this.container.dataset.state = 'ready'
                if (!current()) return false
                this.applyColor(view)
                this.dispatchEvent(new CustomEvent('bookopen', { detail: { title: record.title, author: record.author } }))
                return true
            } catch (error) {
                await this.dispose()
                throw error
            }
        })
    }

    onRelocate(id, detail) {
        const progress = {
            cfi: detail.cfi || null,
            fraction: detail.fraction || 0,
            percent: detail.fraction || 0,
            section: detail.index,
            tocLabel: detail.tocItem?.label || '',
            location: detail.location ?? null,
            pageItemLabel: detail.pageItem?.label || '',
        }
        this.lastProgress = progress
        if (!this._autoStep || Date.now() - (this._lastSavedAt || 0) >= 1000) this.savePosition(id, progress)
        this.dispatchEvent(new CustomEvent('relocate', { detail }))
    }
    savePosition(id, progress) {
        this._lastSavedAt = Date.now(); this._savedCFI = progress.cfi
        // Synchronous journal closes the last-page gap on reload/tab close; each ID is captured here.
        try { localStorage.setItem(JOURNAL + id, JSON.stringify(progress)) } catch { /* DB remains available. */ }
        this._save = this._save.catch(() => {}).then(() => touchBook(id, progress))
        this._save.catch(error => this.report(error, '阅读位置未能保存'))
    }

    async drawNotes() {
        for(const note of this.notes||[])if(note.type==='quote') {
            try {await this.view?.addAnnotation({value:note.cfi})} catch {} 
        }
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

        this.container.dataset.state = 'chapter-loaded'
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
        doc.addEventListener('pointerdown', () => this.dispatchEvent(new Event('manualnavigation')), {passive:true})
        doc.addEventListener('wheel', e => {
            activity()
            if(e.ctrlKey || !e.deltaY)return
            this.dispatchEvent(new Event('manualnavigation'))
            if(view.renderer.scrolled)return // Let the browser handle pixel scrolling and trackpad inertia.
            e.preventDefault()
            const delta=e.deltaY*(e.deltaMode===1?20:e.deltaMode===2?view.renderer.size:1)
            if(this._wheelSwitch){this._wheelDistance+=delta;return}
            this._wheelDistance=delta;this._wheelSwitch=true
            this.setFlow('scrolled').then(async()=>{
                if(view!==this.view)return
                const r=view.renderer,target=Math.max(0,Math.min(Math.max(0,r.viewSize-r.size),r.start+this._wheelDistance))
                await r.scrollToAnchor(target/r.viewSize)
                this.dispatchEvent(new Event('flowchange'))
            }).catch(error=>this.report(error,'滚动切换失败')).finally(()=>{this._wheelSwitch=false;this._wheelDistance=0})
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
            if (view.renderer.scrolled || Date.now() - swipedAt < 500 || e.target.closest('a,button,input,textarea,select') ||
                doc.getSelection()?.toString() || view !== this.view) return
            const x = e.clientX / (doc.defaultView.innerWidth || 1)
            if (x < 0.16) this.prev()
            else if (x > 0.84) this.next()
        })
    }

    styles() {
        const { fontSize, lineHeight, fontFamily } = this.layout
        return `
            html[data-reader-flow="scrolled"] body::after { content:"";display:block;height:${Math.round(fontSize*lineHeight*5)}px;clear:both;pointer-events:none; }
            html { font-size: ${fontSize}px !important; }
            html, body { background: transparent !important; }
            body { line-height: ${lineHeight} !important; }
            body, body * { color: var(--reader-ink) !important;
                background-color: transparent !important; background-image: none !important;
                text-shadow: none !important; opacity: 1 !important;
                font-family: ${FONTS[fontFamily] || FONTS.song} !important; }
            p, li, blockquote, dd, dt { font-size: 1rem !important; line-height: ${lineHeight} !important; }
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
    setLayout(layout) {
        this.layout = { ...this.layout, ...layout }
        const generation = this._generation
        return this.enqueue(async () => {
            const view = this.view
            if (!view?.renderer || generation !== this._generation) return
            const cfi = this.lastProgress?.cfi
            view.renderer.setAttribute('max-inline-size', `${this.layout.maxWidth}px`)
            for (const { doc } of view.renderer.getContents()) {
                const style = doc.querySelector('[data-reader-style]')
                if (style) style.textContent = this.styles()
            }
            view.renderer.render()
            await this.settle(view)
            if (cfi) await view.renderer.goTo(view.resolveNavigation(cfi))
            await this.settle(view)
        }).catch(error => this.report(error, '排版调整失败'))
    }
    async settle(view) {
        for (const { doc } of view?.renderer?.getContents() || []) await doc?.fonts?.ready
        await frame()
        await frame()
    }
    navigate(method, target) {
        this.dispatchEvent(new Event('manualnavigation'))
        const generation = this._generation
        return this.enqueue(async () => {
            const view = this.view
            if (!view?.renderer || generation !== this._generation) return
            if (method === 'goTo') {
                const resolved = view.resolveNavigation(target)
                if (!resolved) throw new Error('找不到这个章节')
                await view.renderer.goTo(resolved)
            } else await view[method]()
            await this.settle(view)
        }).catch(error => this.report(error, '翻页失败'))
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
            const cfi=this.lastProgress?.cfi
            this.flow=flow;this._autoScrollTarget=null;this._autoEndSince=null
            view.renderer.setAttribute('flow',flow)
            for(const {doc} of view.renderer.getContents())doc.documentElement.dataset.readerFlow=flow
            view.renderer.render()
            await this.settle(view)
            if(cfi)await view.renderer.goTo(view.resolveNavigation(cfi))
            await this.settle(view)
        })
    }
    autoAdvance(mode,distance,current) {
        return this.enqueue(async () => {
            if(!current()||!this.view?.renderer)return false
            const r=this.view.renderer,index=r.getContents()[0]?.index
            const more=this.view.book.sections.some((s,i)=>i>index&&s.linear!=='no')
            if(mode==='page') {
                if(r.atEnd)return true
                await this.view.next();await this.settle(this.view);return false
            }
            if(r.viewSize-r.end<=2) {
                // Leave the last lines on screen before changing sections, including the final section.
                const key=this.bookId+':'+index
                if(this._autoEndKey!==key||this._autoEndSince==null){this._autoEndKey=key;this._autoEndSince=performance.now()}
                if(performance.now()-this._autoEndSince<8000)return false
                this._autoEndSince=null
                if(!more)return true
                this._autoScrollTarget=null
                await r.nextSection();await this.settle(this.view);return false
            }
            this._autoEndSince=null
            this._autoStep=true
            // Keep fractional pixels across frames; scrollTop itself is device-pixel rounded.
            this._autoScrollTarget=Math.min(r.viewSize-r.size,(this._autoScrollTarget ?? r.start)+distance)
            try {await r.scrollToAnchor(this._autoScrollTarget/r.viewSize)}
            finally {this._autoStep=false}
            return false
        })
    }
    async dispose() {
        await this.flushProgress().catch(() => {})
        const view = this.view
        if (view) {
            await this.settle(view)
            try { view.close() } catch { /* Partially initialized renderer. */ }
            view.book?.destroy?.()
            view.remove()
        }
        this.view = null
        this.bookId = null
    }
    close() {
        this.dispatchEvent(new Event('manualnavigation'))
        ++this._generation
        return this.enqueue(() => this.dispose())
    }
    report(error, label) {
        console.error(label, error)
        this.dispatchEvent(new CustomEvent('readererror', { detail: `${label}：${error.message}` }))
    }
}
