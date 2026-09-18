import { startGlassContrast } from './glass-contrast.js?v=1.8.7'
import { sampleRegion, relativeLuminance } from './readability.js?v=1.4.0'
import { Ambience } from './ambience.js?v=1.1.0'
import { AutoReading } from './auto-reading.js?v=1.4.0'
// 主装配：工具栏/面板 UI、自动淡出、键盘、全屏、导入导出、音乐互斥。
// v1.7.3：TXT 导入成功 toast 展示转换报告（章节数与识别出的编码）。

import { loadSettings, saveSettings } from './settings.js?v=2.2.0'
import {
    recoverLog, startSession, pauseSession, endSession, toggleSession,
    setSessionBook, tickLog, summarize, ACHIEVEMENTS, formatDuration,
} from './reading-log.js?v=1.1.0'
import { renderTimer, renderLogPanel, patchLogPanel } from './reading-log-ui.js?v=1.1.0'
import * as db from './db.js?v=1.13.0'
import { SceneController, BUILTIN_BACKGROUNDS, SLOT_ORDER, SLOT_LABELS, isFirstPersonRef } from './background.js?v=2.2.4'
import { Reader } from './reader.js?v=1.8.2'
import {
    LocalAudioPlayer, parseNeteaseLink,
} from './music.js?v=1.6.0'
import { MusicUI } from './music-ui.js?v=1.7.2'
import { importBook, friendlyImportError, ensureSampleBook } from './library.js?v=1.8.1'
import { shelfHTML, filterSortBooks } from './bookshelf.js?v=1.5.0'
import {
    passageFromText, placeLabel, noteCounts,
    makeQuoteNote, makeBookmarkNote,
} from './notes.js?v=1.0.0'

// 书架搜索与排序偏好（会话内记忆，不落盘）
let shelfQuery = ''
let shelfSort = 'recent'
let notesBookId = ''
// 封面 object URL 按书籍缓存：欢迎页与面板共用，删除/替换封面时才轮换
const coverUrlCache = new Map() // book.id -> { cover: Blob, url }
function attachCoverUrls (books) {
    return books.map(b => {
        if (!(b.cover instanceof Blob)) return b
        const cached = coverUrlCache.get(b.id)
        if (cached && cached.cover === b.cover) return { ...b, coverUrl: cached.url }
        if (cached) URL.revokeObjectURL(cached.url)
        const url = URL.createObjectURL(b.cover)
        coverUrlCache.set(b.id, { cover: b.cover, url })
        return { ...b, coverUrl: url }
    })
}
import * as backup from './backup.js?v=1.9.4'
import { resolveBookLink } from './book-link.js?v=1.7.5'

import { AtmosphereUI } from './atmosphere-ui.js?v=2.0.0'
import { isVideo, validateBackground } from './background-media.js?v=1.5.0'
import { installButtonFx } from './button-fx.js?v=1.0.0'

const $ = sel => document.querySelector(sel)

let settings = loadSettings()
let autoReading = null
let reader = null
let scene = null
let localAudio = null
let musicUI = null
let atmosphereUI = null
let activePanel = null
let toolbarTimer = null
let toastTimer = null
let openRequest = 0

// ---------- 工具 ----------
function toast (msg, ms = 3800) {
    const el = $('#toast')
    el.textContent = msg
    el.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms)
}

// 阅读面几何：书打开时是阅读列，否则是欢迎卡片
function currentSurface () {
    return $('#reader-column').classList.contains('hidden')
        ? $('#welcome .welcome-card')
        : $('#reader-host')
}

function setMaskGeometry () {
    if (!scene) return
    const rect = currentSurface().getBoundingClientRect()
    // Solid plateau covers the complete reading rectangle; only the area outside is feathered.
    const bleed = Math.min(100, window.innerWidth * 0.14)
    scene.maskEl.style.setProperty('--feather', `${bleed}px`)
    scene.maskEl.style.left = `${rect.left - bleed}px`
    scene.maskEl.style.top = `${rect.top - bleed}px`
    scene.maskEl.style.width = `${rect.width + bleed * 2}px`
    scene.maskEl.style.height = `${rect.height + bleed * 2}px`

}

function applyInk ({ textColor }) {
    // 第一人称场景：正文落在浅色纸面上，无论背景明暗都强制深色墨
    const ink = document.body.classList.contains('fp-mode') ? '#33281c' : textColor
    document.documentElement.style.setProperty('--ink', ink)
    document.documentElement.style.setProperty('--ink-soft', ink)
    reader?.setTextTheme({ textColor: ink })
}

// 第一人称场景：当前背景属于 builtin:fp-* 时，阅读列化作桌面上的纸面，
// 背景随指针产生轻微视差（3D 纵深感）
function syncFirstPersonMode () {
    const wasFp = document.body.classList.contains('fp-mode')
    const fp = isFirstPersonRef(scene?.currentRef)
    document.body.classList.toggle('fp-mode', fp)
    document.body.dataset.fpScene = fp ? String(scene.currentRef) : ''
    if (fp) {
        applyInk({ textColor: '#33281c' })
        // recomputeReadability 会发出 scenechange；只在进入纸面模式时重算，避免递归。
        if (!wasFp) scene.recomputeReadability()
    } else if (wasFp) {
        scene.recomputeReadability() // 离开第一人称：按真实背景重新选墨色
    }
}

const fpParallax = (() => {
    let last = 0
    return e => {
        if (!document.body.classList.contains('fp-mode')) return
        const now = performance.now()
        if (now - last < 40) return
        last = now
        const k = settings.atmosphere.parallax ?? 1
        const nx = e.clientX / Math.max(1, innerWidth) - .5
        const ny = e.clientY / Math.max(1, innerHeight) - .5
        document.documentElement.style.setProperty('--fp-x', `${(nx * -22 * k).toFixed(1)}px`)
        document.documentElement.style.setProperty('--fp-y', `${(ny * -14 * k).toFixed(1)}px`)
    }
})()

function applyLayoutSettings () {
    document.documentElement.style.setProperty('--col-width', `${settings.layout.maxWidth}px`)
    reader?.setLayout(settings.layout)
    clearTimeout(applyLayoutSettings._t)
    applyLayoutSettings._t = setTimeout(() => {
        setMaskGeometry()
        scene?.recomputeReadability()
    }, 260)
}

const persist = () => { try { saveSettings(settings) } catch { toast('设置未能保存，请检查浏览器可用空间') } }

function currentBookMeta () {
    if (!reader?.bookId) return null
    const title = $('#reading-title')?.textContent || ''
    return { id: reader.bookId, title }
}

let logSavedAt = 0
function persistLog (force = false) {
    const now = Date.now()
    if (!force && now - logSavedAt < 12000) return
    logSavedAt = now
    persist()
}

function logSnapshot () {
    return summarize(settings.readingLog)
}

function paintTimer (fullPanel = false) {
    const el = $('#reading-timer')
    if (!el) return
    const snap = logSnapshot()
    renderTimer(el, snap)
    if (activePanel === 'log') {
        const body = $('#panel-body')
        if (fullPanel || !patchLogPanel(body, snap)) renderLogPanel(body, snap)
    }
}

function noteLogEvents (events) {
    for (const id of events || []) {
        if (id === 'run-cap') toast('这段已连续计时 8 小时，已暂停。还在读的话请按继续。')
        else if (id === 'suspended') toast('计时在离开期间已停住，未把空白时间算进去。')
        else {
            const a = ACHIEVEMENTS.find(x => x.id === id)
            if (a) toast(`记下名称：${a.name} — ${a.line}`)
        }
    }
}

function handleLogAction (action) {
    const now = Date.now()
    const log = settings.readingLog
    let result
    if (action === 'toggle') result = toggleSession(log, now, currentBookMeta())
    else if (action === 'end') result = endSession(log, now)
    else if (action === 'pause') result = pauseSession(log, now)
    else if (action === 'start') result = startSession(log, now, currentBookMeta())
    else return
    if (action === 'end' && result?.ok && result.session) {
        toast(`记下这次阅读 ${formatDuration(result.session.elapsedMs)}，中断 ${result.session.pauses} 次`)
    }
    noteLogEvents(result?.events)
    persistLog(true)
    paintTimer(true)
}

// ---------- 本地音乐：顺序与播放位置 ----------

// 曲目顺序按 settings.music.order 排列，未记录的按导入时间排在后面。
function sortTracks (tracks) {
    const order = settings.music.order || []
    if (!order.length) return tracks
    const rank = new Map(order.map((id, i) => [id, i]))
    return [...tracks].sort((a, b) => {
        const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER
        const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER
        if (ra !== rb) return ra - rb
        return (a.addedAt || 0) - (b.addedAt || 0)
    })
}

async function reloadTracks () {
    const tracks = sortTracks(await db.listAudioTracks())
    localAudio.setTracks(tracks)
    return tracks
}

// 播放位置记在 localStorage（写入频繁，不适合走设置对象），刷新后恢复但不自动播放。
const POS_KEY = 'immersive-reader-audio-position'
let posSavedAt = 0

function saveAudioPosition (force = false) {
    const st = localAudio.getState()
    if (!st.currentId) return
    const now = Date.now()
    if (!force && now - posSavedAt < 3000) return
    posSavedAt = now
    try {
        localStorage.setItem(POS_KEY, JSON.stringify({ id: st.currentId, time: st.time, at: now }))
    } catch { /* 存不下就算了，不影响播放 */ }
}

function loadAudioPosition () {
    try {
        const raw = JSON.parse(localStorage.getItem(POS_KEY))
        if (!raw || !raw.id) return null
        return raw
    } catch { return null }
}

// ---------- 书籍 ----------
async function openBookRecord(rec, { preserveLastBookOnError = false, cfi = null } = {}) {
    const request = ++openRequest
    closePanel()
    // 开场仪式感：欢迎页淡出，阅读列轻柔放大淡入；减少动态偏好由 CSS 关闭
    const welcomeEl = $('#welcome')
    if (!welcomeEl.classList.contains('hidden')) {
        welcomeEl.classList.add('leaving')
        // 仅当仍处于"离开中"才隐藏；若打开失败已回到欢迎页，竞态定时器不得把它藏掉
        setTimeout(() => {
            if (welcomeEl.classList.contains('leaving')) {
                welcomeEl.classList.add('hidden')
                welcomeEl.classList.remove('leaving')
            }
        }, 380)
    }
    $('#reader-column').classList.remove('hidden')
    $('#reader-column').classList.add('opening')
    setTimeout(() => $('#reader-column').classList.remove('opening'), 700)
    $('#reading-title').textContent = `正在打开《${rec.title}》…`
    setMaskGeometry()
    scene.recomputeReadability()
    try {
        const opened = await reader.open(rec, { lastLocation: cfi || rec.progress?.cfi || null })
        if (request !== openRequest || !opened) return
        $('#reading-title').textContent = rec.title
        setSessionBook(settings.readingLog, { id: rec.id, title: rec.title })
        paintTimer()
        notesBookId = rec.id
        try { localStorage.setItem('immersive-reader-last-book', rec.id) } catch { /* Position is still saved to DB. */ }
        await refreshRecent()
        renderPanelRecent()
        showToolbar()
    } catch (e) {
        if (request !== openRequest) return
        console.error(e)
        toast(friendlyImportError(e, { name: rec.title }))
        showWelcome({ preserveLastBook: preserveLastBookOnError })
    }
}
function showWelcome({ preserveLastBook = false } = {}) {
    const welcomeEl = $('#welcome')
    welcomeEl.classList.remove('hidden')
    welcomeEl.classList.remove('leaving') // 取消进行中的淡出，欢迎页恢复可见
    $('#reader-column').classList.add('hidden')
    if (!preserveLastBook) {
        try { localStorage.removeItem('immersive-reader-last-book') } catch { /* unavailable storage */ }
    }
    setMaskGeometry()
    scene.recomputeReadability()
}

async function refreshRecent () {
    const books = attachCoverUrls(await db.listBooks())
    const list = $('#recent-list')
    if (!books.length) {
        list.innerHTML = '<p class="recent-empty">还没有书籍，点上方按钮导入 EPUB、TXT 或 PDF。</p>'
        return
    }
    list.innerHTML = `<div class="shelf">${shelfHTML(books)}</div>`
}

function escapeHtml (s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]))
}

// ---------- 背景列表 ----------
async function refreshUserBgs () {
    const list = await db.listBackgrounds()
    await scene.setUserBackgrounds(list)
}

function bgOptions (selectedId) {
    const opts = [
        ...BUILTIN_BACKGROUNDS.map(b => ({ id: b.id, name: `${b.name}（示意）` })),
        ...scene.userBgs.map(b => ({ id: b.id, name: b.name })),
    ]
    return opts.map(o =>
        `<option value="${escapeHtml(o.id)}" ${o.id === selectedId ? 'selected' : ''}>${escapeHtml(o.name)}</option>`)
        .join('')
}

// ---------- 面板 ----------
function openPanel (name) {
    atmosphereUI?.close(false)
    if (activePanel === name) return
    try { localStorage.setItem('reader-last-panel',name) } catch {}
    activePanel = name
    $('#top-settings').setAttribute('aria-expanded','true')
    $('#toolbar').hidden=false
    $('#panel').classList.remove('hidden')
    showToolbar()
    renderPanel()
    musicUI?.syncLiveDock()
}

function closePanel () {
    activePanel = null
    atmosphereUI?.close(false)
    $('#top-settings').setAttribute('aria-expanded','false')
    $('#panel').classList.add('hidden')
    $('#toolbar').querySelectorAll('button').forEach(b => b.classList.remove('active'))
    musicUI?.syncLiveDock()
}

const PANEL_TITLES = { open: '书籍与备份', toc: '目录', scene: '场景', font: '字体与排版', music: '音乐', auto: '自动阅读', rain: '窗外天气', notes: '笔记书签', log: '阅读记录' }

function renderPanel () {
    if (!activePanel) return
    $('#panel-title').textContent = PANEL_TITLES[activePanel] || ''
    $('#toolbar').querySelectorAll('button').forEach(b =>
        b.classList.toggle('active', b.dataset.cmd === activePanel))
    const body = $('#panel-body')
    body.hidden = activePanel === 'music' || activePanel === 'rain'
    $('#atmosphere-panel').hidden = activePanel !== 'rain'
    atmosphereUI?.toggle.setAttribute('aria-expanded', String(activePanel === 'rain'))
    $('#music-panel-body').hidden = activePanel !== 'music'
    if (activePanel === 'open') renderOpenPanel(body)
    else if (activePanel === 'toc') renderTocPanel(body)
    else if (activePanel === 'scene') renderScenePanel(body)
    else if (activePanel === 'font' || activePanel === 'auto') {
        renderFontPanel(body)
        for (const section of [...body.querySelectorAll('section')]) {
            const isAuto=section.querySelector('h3')?.textContent==='自动阅读'
            if ((activePanel==='auto')!==isAuto) section.remove()
        }
        if(activePanel==='auto') body.querySelector('[data-action="auto-start"]').textContent=autoReading.running?'暂停自动阅读':'开始自动阅读'

    }
    else if (activePanel === 'notes') renderNotesPanel(body)
    else if (activePanel === 'log') renderLogPanel(body, logSnapshot())
    else if (activePanel === 'music') musicUI.renderPanel($('#music-panel-body'))
}

// File picker and drops share one queue, including batches dropped during an import.
let bookImportQueue = Promise.resolve()
function importBookFiles(files) {
    if (!files.length) return bookImportQueue
    bookImportQueue = bookImportQueue.catch(() => {}).then(async () => {
        for (const file of files) {
            try {
                toast(`正在导入「${file.name}」…`, 15000)
                const rec = await importBook(file)
                await refreshRecent()
                renderPanelRecent()
                refreshDiskStatus()
                await openBookRecord(rec)
                // TXT 转换报告：章节数与识别出的编码（如 GB18030）；其他格式保持原 toast
                if (rec.format === 'txt' && rec.txtReport) toast(`已导入「${rec.title}」· ${rec.txtReport.chapters} 章 · ${String(rec.txtReport.encoding).toUpperCase()} 编码`)
                else toast(`已导入「${rec.title}」`)
            } catch (err) {
                console.error(err)
                refreshDiskStatus()
                toast(friendlyImportError(err, file))
            }
        }
    })
    return bookImportQueue
}
// 面板顶部的本机资料库状态是导入/删除时才变化的字符串：磁盘镜像异常等情况下
// 及时刷新，用户能在界面上看到「书籍先存浏览器、重启应用自动补同步」的状态。
function refreshDiskStatus () {
    const el = $('#disk-status')
    if (el) el.textContent = `${db.diskStatus()} · 本机 data/library.sqlite3`
}
function hasDraggedFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files') }
let backgroundImportQueue=Promise.resolve()
function importBackgroundFiles(files){
    if(!files.length){toast('请拖入图片或视频文件，不支持文件夹');return}
    backgroundImportQueue=backgroundImportQueue.catch(()=>{}).then(async()=>{
        let added = 0
        const picker = $('#file-image')
        picker.disabled = true
        for (const file of files) {
            try {
                toast(`正在打开「${file.name}」…`, 15000)
                const data = await validateBackground(file)
                const rec = await db.addBackground({ name: file.name.replace(/\.[^.]+$/, ''), data })
                settings.background.mode = 'fixed'
                settings.background.fixedId = rec.id
                added++
            } catch (err) { toast(`「${file.name}」无法添加：${err.message}`) }
        }
        picker.disabled = false
        if (added) {
            await refreshUserBgs()
            persist()
            await scene.applyDesired()
            if (activePanel === 'scene') renderPanel()
            toast(`已添加 ${added} 张背景，已切换到新背景`)
        }
    }).catch(error=>toast('背景导入失败：'+error.message)).finally(()=>{$('#file-image').disabled=false})
    return backgroundImportQueue
}

function bindBookDropZone(zone) {
    let entered = 0
    const clear = () => { entered = 0; zone.classList.remove('drag-over') }
    zone.addEventListener('dragenter', e => {
        if (!hasDraggedFiles(e)) return
        e.preventDefault(); entered++; zone.classList.add('drag-over')
    })
    zone.addEventListener('dragover', e => {
        if (!hasDraggedFiles(e)) return
        e.preventDefault(); e.dataTransfer.dropEffect = 'copy'
    })
    zone.addEventListener('dragleave', () => {
        if (--entered <= 0) clear()
    })
    zone.addEventListener('drop', e => {
        if (!hasDraggedFiles(e)) return
        e.preventDefault(); clear()
        const files = [...e.dataTransfer.files]
        if (files.length) importBookFiles(files)
        else toast('请拖入 EPUB、TXT 或 PDF 文件，不支持文件夹')
    })
}

// ----- 打开书籍 / 备份 -----
function renderOpenPanel (body) {
    body.innerHTML = `
        <p class="hint" role="status" id="disk-status">${escapeHtml(db.diskStatus())} · 本机 data/library.sqlite3</p>
        <section id="book-drop-zone" role="group" aria-label="拖入 EPUB、TXT 或 PDF 书籍">
            <div class="row">
                <button data-action="pick-book" class="primary" title="支持 EPUB、UTF-8/GBK 文本，以及 PDF 文字提取（不保留图片与版式；扫描件需先 OCR）">导入书籍</button>
            </div>
            <p class="hint">拖入 EPUB / TXT / PDF，或点按钮选择。TXT 自动识别编码并转成 EPUB 阅读排版。PDF 只提取文字。</p>
        </section>
        <section>
            <details class="books-fold"><summary aria-label="展开或收起最近书籍" title="最近书籍"><svg viewBox="0 0 24 24" width="25" height="25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5.5C8 3 4 3 2 4v15c3-1 7-.5 10 1.5 3-2 7-2.5 10-1.5V4c-2-1-6-1-10 1.5Z"/><path d="M12 5.5v15"/></svg></summary>
            <div class="fold-body"><div id="panel-recent">${$('#recent-list').innerHTML}</div></div>
            </details>
            <div class="row shelf-tools">
                <input id="shelf-search" type="search" placeholder="搜索书名或作者" aria-label="搜索书架">
                <select id="shelf-sort" aria-label="排序方式">
                    <option value="recent" ${shelfSort === 'recent' ? 'selected' : ''}>最近打开</option>
                    <option value="added" ${shelfSort === 'added' ? 'selected' : ''}>导入时间</option>
                    <option value="title" ${shelfSort === 'title' ? 'selected' : ''}>书名</option>
                    <option value="progress" ${shelfSort === 'progress' ? 'selected' : ''}>进度</option>
                </select>
            </div>
        </section>
        <section>
            <h3>备份</h3>
            <div class="row">
                <button data-action="backup-export" class="primary">导出备份</button>
                <button data-action="pick-backup">导入备份</button>
            </div>
            <p class="hint">备份包含全部书籍、背景、本地音乐、阅读位置与设置，导出为 JSON 文件保存在本机。
               使用本机启动器时，资料同时保存到 data/library.sqlite3；请保留该目录，并定期导出备份。</p>
            <p class="hint" id="last-backup"></p>
        </section>`
    bindBookDropZone(body.querySelector("#book-drop-zone"))
    renderPanelRecent()
    db.getMeta('lastBackupAt').then(t => {
        const el = $('#last-backup')
        if (!el) return
        if (t) {
            el.textContent = `上次导出：${new Date(t).toLocaleString('zh-CN')}`
            if (Date.now() - t > 7 * 86400000) {
                el.textContent += ' · 已超过 7 天，建议导出一份'
                el.classList.add('stale')
            }
        } else {
            el.textContent = '还没有导出过备份，建议现在就导出一份'
            el.classList.add('stale')
        }
    })
}

function renderPanelRecent () {
    const el = $('#panel-recent')
    if (!el) return
    db.listBooks().then(async books => {
        const shown = filterSortBooks(attachCoverUrls(books), shelfQuery, shelfSort)
        if (!shown.length) {
            el.innerHTML = `<p class="recent-empty">${books.length ? '没有匹配的书，换个关键词试试。' : '暂无书籍'}</p>`
            return
        }
        el.innerHTML = `<div class="shelf">${shelfHTML(shown)}</div>`
    })
}

// ----- 书内全文搜索 -----
let bookSearchToken = 0
let bookSearchCache = { query: '', html: '', count: null, progress: '' }

function searchResultHtml (label, excerpt, cfi) {
    const text = [excerpt.pre, excerpt.match, excerpt.post]
        .map(s => String(s ?? '')).join('').replace(/\s+/g, ' ').trim()
    const where = label ? `〔${label}〕` : ''
    return `<li><button data-action="search-go" data-cfi="foliate-search:${escapeHtml(cfi)}"><span class="s-where">${escapeHtml(where)}</span>…${escapeHtml(text)}…</button></li>`
}

async function runBookSearch (query) {
    const body = $('#panel-body')
    if (!reader.view || !query.trim()) return
    const token = ++bookSearchToken
    view: {
        try {
            const listEl = body.querySelector('#book-search-results')
            if (!listEl) break view
            listEl.innerHTML = ''
            bookSearchCache = { query, html: '', count: 0, progress: '扫描中…' }
            const progressEl = body.querySelector('#book-search-progress')
            for await (const result of reader.view.search({
                query: query.trim(), matchCase: false, matchDiacritics: false, matchWholeWords: false,
            })) {
                if (token !== bookSearchToken) return
                if (result.progress != null) {
                    bookSearchCache.progress = `已扫描 ${Math.round(result.progress * 100)}%`
                    if (progressEl) progressEl.textContent = bookSearchCache.progress
                    continue
                }
                const add = (label, item) => {
                    bookSearchCache.count++
                    const html = searchResultHtml(label, item.excerpt, item.cfi)
                    bookSearchCache.html += html
                    listEl.insertAdjacentHTML('beforeend', html)
                }
                if (result.subitems) for (const sub of result.subitems) add(result.label, sub)
                else if (result.cfi) add(result.label || '', result)
                if (progressEl) progressEl.textContent = `找到 ${bookSearchCache.count} 处`
            }
            if (token !== bookSearchToken) return
            bookSearchCache.progress = `共找到 ${bookSearchCache.count} 处`
            if (progressEl) progressEl.textContent = bookSearchCache.progress
            if (!bookSearchCache.count) listEl.innerHTML = '<p class="hint">没有找到匹配内容。</p>'
        } catch (error) {
            if (token === bookSearchToken) toast('搜索出错：' + error.message)
        }
    }
}

function renderSearchBox (body) {
    const cached = bookSearchCache.query ? bookSearchCache : null
    body.insertAdjacentHTML('afterbegin', `
        <section id="book-search">
            <h3>书内搜索</h3>
            <div class="row">
                <input id="book-search-input" type="search" placeholder="搜索全书文字" value="${escapeHtml(cached?.query || '')}" aria-label="书内搜索关键词">
                <button data-action="book-search" class="primary">搜索</button>
                ${cached ? '<button data-action="book-search-clear">清除</button>' : ''}
            </div>
            <p class="hint" id="book-search-progress" role="status">${escapeHtml(cached?.progress || '支持中文与英文，跨章节扫描全书')}</p>
            ${cached?.count ? `<p class="hint">找到 ${cached.count} 处，点击跳转：</p><ol id="book-search-results">${cached.html}</ol>` : '<ol id="book-search-results"></ol>'}
        </section>`)
    const input = body.querySelector('#book-search-input')
    input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.stopPropagation(); runBookSearch(input.value) }
    })
}

// ----- 目录 -----
function renderTocPanel (body) {
    renderSearchBox(body)
    const toc = reader?.toc || []
    if (!toc.length) {
        body.insertAdjacentHTML('beforeend', '<p class="hint">当前书籍没有目录信息。</p>')
        return
    }
    const item = (t, depth = 0) => `
        <li>
            <button data-action="toc-go" data-href="${escapeHtml(t.href || '')}">${escapeHtml(t.label)}</button>
            ${(t.subitems?.length ? `<ul>${t.subitems.map(s => item(s, depth + 1)).join('')}</ul>` : '')}
        </li>`
    body.insertAdjacentHTML('beforeend', `<ul class="toc-list">${toc.map(t => item(t)).join('')}</ul>`)
}

// ----- 场景 -----
function renderScenePanel (body) {
    const bg = settings.background
    const thumbs = id => scene.allRefs().map(refId => {
        const url = scene.urlOf(refId)
        const cur = scene.currentRef === refId
        const isBuiltin = scene.isBuiltin(refId)
        const del = !isBuiltin ? `<button class="del" data-action="del-bg" data-id="${escapeHtml(refId)}" title="删除 ${escapeHtml(scene.refName(refId))}">✕</button>
            <button class="rename" data-action="rename-bg" data-id="${escapeHtml(refId)}">改名</button>
            <div class="bg-edit" hidden><input class="bg-name" type="text" maxlength="80" aria-label="背景名称" value="${escapeHtml(scene.refName(refId))}">
            <button data-action="save-bg-name" data-id="${escapeHtml(refId)}">保存</button></div>` : ''
        return `<div class="bg-thumb ${cur ? 'current' : ''}" data-id="${escapeHtml(refId)}">
            <button class="bg-pick" data-action="set-fixed" data-id="${escapeHtml(refId)}" aria-label="使用背景 ${escapeHtml(scene.refName(refId))}" aria-pressed="${cur}">
                ${refId.startsWith('three:') ? `<span class="three-thumb"><img src="${scene.scenePreview(refId)}" alt="" aria-hidden="true"><i class="badge">3D</i></span>`
                    : isVideo(scene.userBgs.find(b => b.id === refId)?.data) ? '<span class="video-thumb">▷ VIDEO</span>' : `<img src="${url}" alt="">`}<span class="n">${escapeHtml(scene.refName(refId))}${isBuiltin && refId !== 'builtin:fluid' ? '（示意）' : ''}</span>
            </button>${del}
        </div>`
    }).join('')

    body.innerHTML = `
        <section>
            <h3>背景模式</h3>
            <div class="row">
                <label><input type="radio" name="bgmode" value="fixed" ${bg.mode === 'fixed' ? 'checked' : ''}> 固定一张</label>
                <label><input type="radio" name="bgmode" value="slot" ${bg.mode === 'slot' ? 'checked' : ''}> 按时段</label>
                <label><input type="radio" name="bgmode" value="rotate" ${bg.mode === 'rotate' ? 'checked' : ''}> 按分钟轮换</label>
            </div>
            <div class="row" id="row-fixed" ${bg.mode === 'fixed' ? '' : 'hidden'}>
                <label>固定图</label>
                <select data-setting="fixedId">${bgOptions(bg.fixedId)}</select>
            </div>
            <div id="rows-slot" ${bg.mode === 'slot' ? '' : 'hidden'}>
                ${SLOT_ORDER.map(slot => `
                    <div class="slot-row">
                        <span class="sl">${SLOT_LABELS[slot]}</span>
                        <select data-slot="${slot}">${bgOptions(bg.slotMap[slot])}</select>
                    </div>`).join('')}
            </div>
            <div class="row" id="row-rotate" ${bg.mode === 'rotate' ? '' : 'hidden'}>
                <label>每</label>
                <select data-setting="rotateMinutes">
                    ${[1, 5, 10, 15, 30, 60].map(m => `<option value="${m}" ${bg.rotateMinutes === m ? 'selected' : ''}>${m} 分钟</option>`).join('')}
                </select>
                <span class="hint">在全部背景间顺序轮换</span>
            </div>
            <div class="row">
                <label><input type="checkbox" data-setting="animate" ${bg.animate !== false ? 'checked' : ''}> 背景切换过渡动画</label>
            </div>
        </section>
        <section>
            <h3>背景图库</h3>
            <div class="background-drop" data-background-drop role="group" aria-label="拖入背景图片或视频"><p class="hint">将图片或视频拖到这里，松开即可设为背景</p><div class="row"><button data-action="pick-image" class="primary">上传图片或视频</button></div></div>
            <div class="bg-grid">${thumbs()}</div>
            <p class="hint">选择一张风景或视频。双色流体随时间缓慢流动，其余内置图为示意插画。雨滴参数在右上角调整。</p>
        </section>
        <section>
            <h3>文字与背景</h3>
            <div class="row">
                <label><input type="radio" name="readtheme" value="auto" ${settings.readability.theme === 'auto' ? 'checked' : ''}> 自动（按画面明暗）</label>
            </div>
            <div class="row">
                <label><input type="radio" name="readtheme" value="dark-text" ${settings.readability.theme === 'dark-text' ? 'checked' : ''}> 深色文字</label>
                <label><input type="radio" name="readtheme" value="light-text" ${settings.readability.theme === 'light-text' ? 'checked' : ''}> 浅色文字</label>
            </div>
            <div class="row">
                <label>阅读底色浓度</label>
                <input type="range" data-setting="maskBias" min="-1" max="1" step="0.1" value="${settings.readability.maskBias}">
                <span class="value">${settings.readability.maskBias}</span>
            </div>
            <p class="hint">当前状态：<span id="read-status">—</span></p>
        </section>`
    updateReadStatus()
}

function updateReadStatus () {
    const el = $('#read-status')
    if (!el || !scene?.currentPlan) return
    const p = scene.currentPlan
    el.textContent = `${p.theme === 'dark-text' ? '深色文字' : '浅色文字'} · 自动保持清晰`
}

// ----- 字体 -----
function renderFontPanel (body) {
    const l = settings.layout
    const a = settings.autoRead
    body.innerHTML = `
        <section><h3>阅读方式</h3>
            <div class="row"><label for="reading-flow">正文浏览</label><select id="reading-flow"><option value="paginated" ${a.flow==='paginated'?'selected':''}>左右翻页</option><option value="scrolled" ${a.flow==='scrolled'?'selected':''}>连续滚动（滚轮）</option></select></div>
            <p class="hint">滚轮动多少，文字就移动多少；不会触发整页跳转。直接使用竖向滚轮也会进入连续滚动。</p>
        </section>
        <section><h3>自动阅读</h3>
            <div class="row"><label for="auto-mode">阅读方式</label><select id="auto-mode"><option value="scroll" ${a.mode==='scroll'?'selected':''}>连续下滑</option><option value="page" ${a.mode==='page'?'selected':''}>定时翻页</option></select></div>
            <div class="row"><label for="auto-speed">下滑速度</label><input id="auto-speed" type="range" min="5" max="80" step="1" value="${a.pixelsPerSecond}"><span id="auto-speed-value" class="value">${a.pixelsPerSecond} 像素/秒</span></div>
            <div class="row"><label for="auto-seconds">每页停留</label><input id="auto-seconds" type="range" min="5" max="120" step="1" value="${a.pageSeconds}"><span id="auto-seconds-value" class="value">${a.pageSeconds} 秒</span></div>
            <button data-action="auto-start" class="primary">开始自动阅读</button>
            <p class="hint">可随时暂停。滚动到章末后停留8秒再换章，末尾留有约五行缓冲。换书、手动操作或离开页面会暂停；刷新后不会自动开始。</p>
        </section>
        <section>
            <h3>字号</h3>
            <div class="row">
                <button data-action="font-minus">A－</button>
                <input type="range" data-layout="fontSize" min="15" max="34" step="1" value="${l.fontSize}">
                <span class="value" id="v-font">${l.fontSize}px</span>
                <button data-action="font-plus">A＋</button>
            </div>
            <h3>行距</h3>
            <div class="row">
                <input type="range" data-layout="lineHeight" min="1.5" max="2.8" step="0.1" value="${l.lineHeight}">
                <span class="value" id="v-line">${l.lineHeight}</span>
            </div>
            <h3>正文宽度</h3>
            <div class="row">
                <input type="range" data-layout="maxWidth" min="420" max="860" step="20" value="${l.maxWidth}">
                <span class="value" id="v-width">${l.maxWidth}px</span>
            </div>
            <h3>字体</h3>
            <div class="row">
                <label><input type="radio" name="fontfam" value="song" ${l.fontFamily === 'song' ? 'checked' : ''}> 宋体</label>
                <label><input type="radio" name="fontfam" value="hei" ${l.fontFamily === 'hei' ? 'checked' : ''}> 黑体</label>
                <label><input type="radio" name="fontfam" value="kai" ${l.fontFamily === 'kai' ? 'checked' : ''}> 楷体</label>
            </div>
            <div class="row"><button data-action="font-reset">恢复默认排版</button></div>
        </section>`
}

// ---------- 工具栏自动淡出 ----------
function showToolbar () {
    $('#toolbar').classList.remove('faded')
    $('#reader-chrome').classList.remove('faded')
    musicUI?.setFaded(false)
    clearTimeout(toolbarTimer)
    toolbarTimer = setTimeout(() => {
        if (!activePanel && !settings.misc.keepToolbarWhenIdle && !$('#panel').matches(':focus-within') &&
            !$('#toolbar').matches(':focus-within')) {
            $('#toolbar').classList.add('faded')
            $('#reader-chrome').classList.add('faded')
            musicUI?.setFaded(true)
        }
    }, 3500)
}

function toggleControls() {
    const hidden=document.body.classList.toggle('controls-hidden')
    if(hidden){
        closePanel();$('#toolbar').hidden=true;$('#top-settings').setAttribute('aria-expanded','false')
        $('#atmosphere-panel').hidden=true
        if(document.activeElement instanceof HTMLElement)document.activeElement.blur()
    } else showToolbar()
}

function syncReadingDock() {
    document.body.classList.toggle('scroll-reading',settings.autoRead.flow==='scrolled')
    const page=settings.autoRead.mode==='page', speed=$('#reading-speed')
    speed.max=page?'120':'80';speed.value=page?settings.autoRead.pageSeconds:settings.autoRead.pixelsPerSecond
    $('#reading-speed-label').textContent=page?'每页停留':'下滑速度'
    $('#reading-speed-value').textContent=speed.value+(page?' 秒':' 像素/秒')
}
function applyReadingFocus() {
    document.body.classList.toggle('reading-focus',!!settings.misc.hideReadingTools)
    $('#reading-focus-toggle').textContent=settings.misc.hideReadingTools?'显示工具':'隐藏工具'
    $('#reading-focus-toggle').setAttribute('aria-pressed',String(!!settings.misc.hideReadingTools))
}

// ---------- 事件接线 ----------
function wireEvents () {
    $('#btn-welcome-background').addEventListener('click', () => {
        openPanel('scene')
        const grid = $('.bg-grid')
        const scroller = grid?.closest('.panel-content')
        if (grid && scroller) scroller.scrollTop = Math.max(0, grid.offsetTop - 12)
    })
    // 欢迎屏按钮同样接受拖入的图片/视频，与面板内的背景拖放区行为一致
    const welcomeBgBtn = $('#btn-welcome-background')
    welcomeBgBtn.setAttribute('data-background-drop', '')
    welcomeBgBtn.setAttribute('title', '点击打开场景图库，或把图片/视频拖到这个按钮上')
    window.addEventListener('keydown',e=>{
        if(e.code!=='Space'&&e.key!==' ')return
        if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing||e.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return
        e.preventDefault();e.stopImmediatePropagation()
        if(!e.repeat)toggleControls()
    },true)
    // The navigation stays inside the drawer; changing tabs preserves music DOM.
    $('#panel').append($('#atmosphere-panel'))
    $('#top-settings').onclick=()=>{
        if(activePanel){closePanel();return}
        let last='open'
        try {last=localStorage.getItem('reader-last-panel')||'open'} catch {}
        openPanel(PANEL_TITLES[last]?last:'open')
    }
    document.addEventListener('keydown',e=>{if(e.key==='Escape'){closePanel();$('#top-settings').focus()}})
    $('#toolbar').addEventListener('click', e => {
        const btn=e.target.closest('button[data-cmd]')
        if(!btn)return
        if(btn.dataset.cmd==='fullscreen'){toggleFullscreen();return}
        openPanel(btn.dataset.cmd)
    })

    applyReadingFocus();syncReadingDock()
    $('#reading-focus-toggle').onclick=()=>{
        settings.misc.hideReadingTools=!settings.misc.hideReadingTools
        closePanel();$('#atmosphere-panel').hidden=true
        applyReadingFocus();persist()
    }
    $('#reading-speed-details').ontoggle=syncReadingDock
    $('#reading-speed').oninput=e=>{
        const key=settings.autoRead.mode==='page'?'pageSeconds':'pixelsPerSecond'
        settings.autoRead[key]=Number(e.target.value);persist();syncReadingDock()
    }
    $('#auto-reading-toggle').addEventListener('click', () => {
        if (autoReading.running || autoReading.starting) autoReading.stop()
        else openPanel('auto')
    })
    reader.addEventListener('textselection',e=>{
        pendingQuote=e.detail;$('#selection-tools').hidden=false
    })
    reader.addEventListener('bookopen',()=>{$('#selection-tools').hidden=true;pendingQuote=null})
    $('#cancel-quote').onclick=()=>{$('#selection-tools').hidden=true;pendingQuote=null}
    $('#save-quote').onclick=async()=>{
        const selection=pendingQuote
        if(!selection)return
        $('#save-quote').disabled=true
        try {
            const record=await db.getBook(selection.bookId)
            if(record.notes?.some(n=>n.type==='quote'&&n.cfi===selection.cfi)){toast('这段文字已经收藏');return}
            notesBookId = selection.bookId
            const notes=await db.updateBookNote(selection.bookId, makeQuoteNote(selection))
            if(reader.bookId===selection.bookId){reader.notes=notes;await reader.drawNotes()}
            $('#selection-tools').hidden=true;pendingQuote=null;toast('已划线并保存到本书笔记')
            if(activePanel==='notes')renderPanel()
        } catch(e){toast('笔记保存失败：'+e.message)}finally{$('#save-quote').disabled=false}
    }
    // 欢迎屏
    $('#btn-welcome-open').addEventListener('click', () => $('#file-book').click())
    // 欢迎屏最近列表（不在面板内，单独委托到同一处理函数）
    $('#recent-list').addEventListener('click', e => { onPanelClick(e) })

    // 折叠书架的动态展开：接管 summary 点击，高度平滑过渡 + 书本错落入场（css/bookshelf.css）
    // 捕获阶段执行，避免被其它冒泡阶段监听器影响
    const onFoldClick = e => {
        const target = e.target instanceof Element ? e.target : null
        const summary = target ? target.closest('summary') : null
        if (!summary || !summary.parentElement || !summary.parentElement.classList.contains('books-fold')) return
        const details = summary.parentElement
        e.preventDefault()
        if (!details.open) {
            details.open = true
            // 强制同步重排，确保 0fr 起始态已布局，再过渡到 1fr（后台标签页 rAF 不可靠）
            void details.offsetWidth
            details.classList.add('fold-open')
        } else {
            details.classList.remove('fold-open')
            let done = false
            const finish = () => {
                if (done) return
                done = true
                details.removeEventListener('transitionend', finish)
                if (!details.classList.contains('fold-open')) details.open = false
            }
            details.addEventListener('transitionend', finish)
            setTimeout(finish, 550)
        }
    }
    document.addEventListener('click', onFoldClick, true)
    // 全局按钮点击脉冲（虚化渐入）；悬停浮动在 glass-ui.css
    installButtonFx()

    $('#reading-timer').addEventListener('click', e => {
        const btn = e.target.closest('[data-log]')
        if (!btn) return
        handleLogAction(btn.dataset.log)
    })

    // 面板关闭
    $('#panel-close').addEventListener('click', closePanel)

    // 面板事件委托
    $('#panel').addEventListener('click', onPanelClick)
    $('#panel').addEventListener('input', onPanelInput)
    $('#panel').addEventListener('change', onPanelChange)

    // 文件选择
    // Prevent an external file drop from replacing the reader tab with a file URL.
    for (const event of ['dragover', 'drop']) document.addEventListener(event, e => {
        if (!hasDraggedFiles(e)) return
        e.preventDefault()
        if (event === 'dragover' && !e.target.closest?.('#book-drop-zone,[data-background-drop]')) e.dataTransfer.dropEffect = 'none'
        if (event === 'drop') document.querySelector('#book-drop-zone')?.classList.remove('drag-over')
    })
    window.addEventListener('dragend', () => document.querySelector('#book-drop-zone')?.classList.remove('drag-over'))
    const clearBackgroundDrop=()=>document.querySelectorAll('[data-background-drop]').forEach(zone=>zone.classList.remove('drag-over'))
    document.addEventListener('dragover',e=>{
        if(!hasDraggedFiles(e))return
        clearBackgroundDrop()
        const zone=e.target.closest?.('[data-background-drop]')
        if(zone){e.preventDefault();e.dataTransfer.dropEffect='copy';zone.classList.add('drag-over')}
    })
    document.addEventListener('dragleave',e=>{
        const zone=e.target.closest?.('[data-background-drop]')
        if(zone&&!zone.contains(e.relatedTarget))zone.classList.remove('drag-over')
    })
    document.addEventListener('drop',e=>{
        const zone=e.target.closest?.('[data-background-drop]');clearBackgroundDrop()
        if(!zone||!hasDraggedFiles(e))return
        e.preventDefault();importBackgroundFiles([...e.dataTransfer.files])
    })
    window.addEventListener('dragend',clearBackgroundDrop)

    $('#file-book').addEventListener('change', e => {
        const files = [...e.target.files]
        e.target.value = ''
        importBookFiles(files)
    })
    $('#file-image').addEventListener('change', e => {
        const files=[...e.target.files];e.target.value='';importBackgroundFiles(files)
    })
    $('#file-audio').addEventListener('change', async e => {
        const files = [...e.target.files]
        e.target.value = ''
        let added = 0
        const before = localAudio.tracks.map(t => t.id)
        for (const file of files) {
            try {
                if (!file.size || file.size > 500 * 1024 * 1024) throw new Error('请选择 500MB 以内的音频')
                await db.addAudioTrack({ name: file.name, data: file })
                added++
            } catch (err) { toast(`「${file.name}」未导入：${err.message}`) }
        }
        if (added) {
            // 新导入的曲目接在列表末尾，不打断正在播放的那首
            const tracks = await reloadTracks()
            const fresh = tracks.map(t => t.id).filter(id => !before.includes(id))
            if (fresh.length) {
                settings.music.order = [...before, ...fresh]
                persist()
                await reloadTracks()
            }
            if (!localAudio.getState().currentId) settings.music.lastTrackId = tracks[0]?.id || null
            persist()
            toast(`已导入 ${added} 首本地音乐`)
        }
    })
    $('#file-backup').addEventListener('change', async e => {
        const file = e.target.files[0]
        e.target.value = ''
        if (!file) return
        const check = await backup.inspectBackup(file)
        if (!check.ok) { toast(`备份导入失败：${check.error}`); return }
        const c = check.counts
        if (!confirm(`将导入 ${c.books} 本书、${c.backgrounds} 张背景、${c.audio} 首本地音乐，并覆盖当前的全部数据与设置。继续吗？`)) return
        try {
            await reader.close()
            localAudio.stop()
            musicUI.unmountNetease(false)
            const { verify } = await backup.restoreBackup(check.payload)
            if (!Object.values(verify).every(Boolean)) throw new Error('恢复后的文件内容校验不一致')
            // A full rehydrate also replaces cached Blob URLs and the persistent music panel.
            location.reload()

        } catch (err) {
            console.error(err)
            toast(`备份恢复失败：${err.message}`)
        }
    })

    // 本地音频状态 → 保存播放位置 + 网易云互斥
    localAudio.addEventListener('state', () => {
        const st = localAudio.getState()
        if (st.currentId) {
            settings.music.lastTrackId = st.currentId
            saveAudioPosition()
        }
        if (st.playing && musicUI.qq.mounted) {
            musicUI.qq.unmount()
            toast('已切换到本地音乐，与画面迷你条是同一路')
        }
        if (st.playing && musicUI.neteaseMounted) {
            musicUI.unmountNetease(false)
            toast('已切换到本地音乐，与画面迷你条是同一路')
        }
    })
    localAudio.addEventListener('audioerror', e => toast(e.detail))

    reader.addEventListener('activity', showToolbar)
    reader.addEventListener('togglecontrols',toggleControls)
    reader.addEventListener('escape', () => {autoReading.stop();closePanel()})
    reader.addEventListener('readererror', e => toast(e.detail))
    reader.addEventListener('externallink', () => toast('书中包含外部链接。阅读页不会自动跳转。'))
    reader.addEventListener('relocate', e => {
        const d = e.detail
        $('#reading-progress').textContent = `${d.tocItem?.label || ''} · ${Math.round((d.fraction || 0) * 100)}%`
    })
    // 翻页呼吸感：换页时正文轻微呼吸一下，减少跳页生硬
    const breathe = () => {
        const host = $('#reader-host')
        host.classList.remove('page-breathe')
        void host.offsetWidth
        host.classList.add('page-breathe')
    }
    $('#page-prev').addEventListener('click', () => { breathe(); reader.prev() })
    $('#page-next').addEventListener('click', () => { breathe(); reader.next() })

    window.addEventListener('pagehide', () => reader.flushProgress())

    // 场景事件
    startGlassContrast(() => scene.currentImage)
    // 场景平均亮度 → 雨窗联动（亮场景雨滴高光更亮、雾感更明显）
    const sceneLumTimer = setInterval(() => {
        if (document.hidden || !scene.currentImage) return
        try {
            const sample = sampleRegion(scene.currentImage, { x: 0, y: 0, width: innerWidth, height: innerHeight }, innerWidth, innerHeight)
            if (!sample || !sample.n) return
            let sum = 0
            for (let i = 0; i < sample.n; i++) sum += relativeLuminance(sample.pixels.slice(i * 4, i * 4 + 3))
            scene.rain.setLuminance(sum / sample.n)
        } catch { /* 采样不可用时保持默认亮度 */ }
    }, 2000)
    window.addEventListener('pagehide', () => clearInterval(sceneLumTimer), { once: true })
    // 远处闪电与闷雷：低频随机出现，遵循减少动态与页面隐藏；雷声需氛围声已开启
    const lightningCycle = () => {
        const a = settings.atmosphere
        const conditions = a.enabled && a.weather !== 'snow' && a.weather !== 'clear' && a.lightning && scene.rain.available && a.motion &&
            !scene.rain.reduced.matches && !document.hidden && a.rain > .05
        if (conditions) {
            scene.rain.strike(1)
            setTimeout(() => scene.rain.strike(.6), 130 + Math.random() * 180)
            if (ambience.running && settings.ambience.thunder) {
                setTimeout(() => ambience.thunder(.45 + Math.random() * .5), 500 + Math.random() * 1600)
            }
        }
        // 雷电频率滑块：0=稀疏(约100秒) 1=频繁(约20秒)
        const base = 20000 + (1 - (a.lightningEvery ?? .35)) * 80000
        lightningTimer = setTimeout(lightningCycle, base * (0.85 + Math.random() * 0.5))
    }
    let lightningTimer = setTimeout(lightningCycle, 12000 + Math.random() * 26000)
    window.addEventListener('pagehide', () => clearTimeout(lightningTimer), { once: true })
    scene.addEventListener('texttheme', e => applyInk(e.detail))
    scene.addEventListener('scenechange', e => {
        const p = e.detail.readability
        console.log(`[scene] 背景=${e.detail.name} 主题=${p.theme} 遮罩=${p.maskAlpha.toFixed(2)} 采样=${p.sampled}`)
        syncFirstPersonMode()
        updateReadStatus()
    })
    window.addEventListener('pointermove', fpParallax, { passive: true })

    // 工具栏淡出
    let lastMove = 0
    const onActivity = () => {
        const now = Date.now()
        if (now - lastMove < 120) return
        lastMove = now
        showToolbar()
    }
    window.addEventListener('pointermove', onActivity, { passive: true })
    window.addEventListener('touchstart', onActivity, { passive: true })
    window.addEventListener('keydown', e => {
        showToolbar()
        if (e.target.matches('input, select, textarea, button') || e.target.isContentEditable || e.metaKey || e.ctrlKey || e.altKey) return
        if (e.key === 'Escape') { autoReading.stop(); closePanel(); return }
        // 听音乐不打断阅读：M 键随时播放/暂停本地音乐
        if (e.key === 'm' || e.key === 'M') {
            if (localAudio.getState().trackCount) { e.preventDefault(); localAudio.toggle() }
            return
        }
        if (e.key === 't' || e.key === 'T') {
            e.preventDefault()
            handleLogAction('toggle')
            return
        }
        if (!activePanel && !$('#reader-column').classList.contains('hidden')) {
            if (e.key === 'ArrowRight' || e.key === 'PageDown') { breathe(); reader.next() }
            else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { breathe(); reader.prev() }
            else if (e.key === '+' || e.key === '=') {
                settings.layout.fontSize = Math.min(34, settings.layout.fontSize + 1)
                persist(); applyLayoutSettings()
            } else if (e.key === '-' || e.key === '_') {
                settings.layout.fontSize = Math.max(15, settings.layout.fontSize - 1)
                persist(); applyLayoutSettings()
            }

        }
    })
    // 离开页面时把播放位置落盘
    window.addEventListener('pagehide', () => {
        saveAudioPosition(true)
        tickLog(settings.readingLog, Date.now())
        persistLog(true)
    })
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveAudioPosition(true)
            tickLog(settings.readingLog, Date.now())
            persistLog(true)
        } else {
            const rec = recoverLog(settings.readingLog, Date.now())
            noteLogEvents(rec.events)
            persistLog(true)
            paintTimer()
        }
    })
    window.addEventListener('resize', () => {
        setMaskGeometry()
    })
    document.addEventListener('fullscreenchange', () => renderPanel())
}

async function onPanelClick (e) {
    const target = e.target.closest('[data-action]')
    if (!target) return
    const action = target.dataset.action
    const id = target.dataset.id
    const href = target.dataset.href

    try {
        switch (action) {
            case 'pick-book': $('#file-book').click(); break
            case 'open-book':
            case 'open-book-id': {
                const rec = await db.getBook(id)
                if (rec) await openBookRecord(rec)
                break
            }
            case 'del-book': {
                const rec = await db.getBook(id)
                if (rec && confirm(`删除《${rec.title}》？阅读进度将一并删除。`)) {
                    if (reader.bookId === id) { ++openRequest; await reader.close(); showWelcome() }
                    localStorage.removeItem('immersive-reader-position:' + id)
                    await db.deleteBook(id)
                    const cached = coverUrlCache.get(id)
                    if (cached) { URL.revokeObjectURL(cached.url); coverUrlCache.delete(id) }
                    await refreshRecent()
                    renderPanelRecent()
                }
                break
            }
            case 'toc-go':
                if (href) { await reader.goTo(href); closePanel() }
                break
            case 'book-search': {
                const input = $('#book-search-input')
                if (input) await runBookSearch(input.value)
                break
            }
            case 'book-search-clear': {
                bookSearchToken++
                bookSearchCache = { query: '', html: '', count: null, progress: '' }
                try { reader.view?.clearSearch() } catch { /* 视图已关闭 */ }
                renderPanel()
                break
            }
            case 'search-go':
                if (target.dataset.cfi) await reader.view?.goTo(target.dataset.cfi)
                break
            case 'add-bookmark': {
                const id = notesBookId || reader.bookId
                if (!id || reader.bookId !== id) { toast('请先打开这本书，再收藏当前位置'); break }
                const progress = reader.lastProgress
                if (!progress?.cfi) { toast('请等待书页加载完成'); break }
                const fresh = await db.getBook(id)
                if (fresh.notes?.some(n => n.type === 'bookmark' && n.cfi === progress.cfi)) { toast('此位置已有书签'); break }
                let passage = { text: '', after: '' }
                try {
                    const contents = reader.view?.renderer?.getContents?.() || []
                    passage = passageFromText(contents.map(c => c.doc?.body?.innerText || '').join(' '))
                } catch { /* 没有可见正文时用章节名 */ }
                if (!passage.text) passage.text = progress.tocLabel || '阅读书签'
                reader.notes = await db.updateBookNote(id, makeBookmarkNote(progress, passage))
                renderPanel(); toast('书签已保存')
                break
            }
            case 'save-note': {
                const bookId = target.dataset.id
                const noteId = target.dataset.noteId
                const rec = await db.getBook(bookId)
                const note = rec?.notes?.find(n => n.id === noteId)
                if (!note) { toast('这条笔记已不存在'); break }
                const card = target.closest('.note-card')
                const comment = card?.querySelector('textarea')?.value || ''
                const notes = await db.updateBookNote(bookId, { ...note, comment })
                if (reader.bookId === bookId) reader.notes = notes
                toast('心得已保存')
                break
            }
            case 'go-note': {
                const bookId = target.dataset.id
                const noteId = target.dataset.noteId
                const rec = await db.getBook(bookId)
                const note = rec?.notes?.find(n => n.id === noteId)
                if (!note?.cfi) { toast('这条记录没有原文位置'); break }
                closePanel()
                if (reader.bookId !== bookId) await openBookRecord(rec, { cfi: note.cfi })
                else await reader.goTo(note.cfi)
                break
            }
            case 'delete-note': {
                const bookId = target.dataset.id
                const noteId = target.dataset.noteId
                const rec = await db.getBook(bookId)
                const note = rec?.notes?.find(n => n.id === noteId)
                if (!note) break
                const notes = await db.updateBookNote(bookId, note, true)
                if (reader.bookId === bookId) {
                    reader.notes = notes
                    if (note.type === 'quote') {
                        try { await reader.view.deleteAnnotation({ value: note.cfi }) } catch { /* 标注层可能未就绪 */ }
                    }
                }
                renderPanel()
                break
            }
            case 'export-notes': {
                const rec = notesBookId && await db.getBook(notesBookId)
                const notes = rec?.notes || []
                if (!rec || !notes.length) { toast('本书还没有可导出的笔记'); break }
                const quotes = notes.filter(n => n.type === 'quote')
                const marks = notes.filter(n => n.type === 'bookmark')
                const clean = s => String(s ?? '').replace(/\s+/g, ' ').trim()
                const lines = [`# 《${rec.title}》读书笔记`, '', `- 导出时间：${new Date().toLocaleString('zh-CN')}`, `- 划线 ${quotes.length} 条 · 书签 ${marks.length} 条`, '']
                if (quotes.length) {
                    lines.push('## 划线与心得', '')
                    for (const n of quotes) {
                        lines.push(`> ${clean(n.text)}`)
                        if (n.after) lines.push(`下一句：${clean(n.after)}`)
                        const loc = placeLabel(n)
                        const meta = [loc, n.comment ? `心得：${n.comment}` : ''].filter(Boolean).join(' · ')
                        if (meta) lines.push(`- ${meta}`)
                        lines.push('')
                    }
                }
                if (marks.length) {
                    lines.push('## 书签', '')
                    for (const n of marks) {
                        const loc = placeLabel(n)
                        lines.push(`- ${loc ? loc + ' · ' : ''}${clean(n.text)}`)
                        if (n.after) lines.push(`  下一句：${clean(n.after)}`)
                    }
                    lines.push('')
                }
                const blob = new Blob([lines.join('\n')], { type: 'text/markdown' })
                const a = document.createElement('a'), url = URL.createObjectURL(blob)
                a.href = url; a.download = `《${rec.title}》笔记.md`
                document.body.append(a); a.click(); a.remove()
                setTimeout(() => URL.revokeObjectURL(url), 30000)
                toast(`已导出 ${quotes.length} 条划线、${marks.length} 条书签`)
                break
            }
            case 'pick-image': $('#file-image').click(); break
            case 'set-fixed': {
                settings.background.mode = 'fixed'
                settings.background.fixedId = id
                persist()
                // 等背景真正应用后再重绘面板：高亮态跟手；失败时明确提示而不是无响应
                try { await scene.applyDesired({ force: true }) } catch (error) { toast('背景切换失败：' + error.message) }
                renderPanel()
                break
            }
            case 'del-bg': {
                const name = scene.refName(id)
                if (confirm(`删除背景「${name}」？`)) {
                    await db.deleteBackground(id)
                    await refreshUserBgs()
                    renderPanel()
                }
                break
            }
            case 'rename-bg': {
                const edit = target.closest('.bg-thumb').querySelector('.bg-edit')
                edit.hidden = !edit.hidden
                if (!edit.hidden) { edit.querySelector('input').focus(); edit.querySelector('input').select() }
                break
            }
            case 'save-bg-name': {
                const name = target.closest('.bg-thumb').querySelector('.bg-name').value.trim()
                if (name) {
                    await db.renameBackground(id, name)
                    await refreshUserBgs()
                    renderPanel()
                } else toast('请输入背景名称')
                break
            }
            case 'pick-audio': $('#file-audio').click(); break
            case 'backup-export': {
                await reader.flushProgress()
                const r = await backup.exportBackup()
                await db.setMeta('lastBackupAt', Date.now())
                toast(`备份已导出：${r.books} 本书、${r.backgrounds} 张背景、${r.audio} 首音乐、${r.qqTracks} 条 QQ 歌曲（${(r.bytes / 1048576).toFixed(1)}MB）`)
                if (activePanel === 'open') renderOpenPanel($('#panel-body'))
                break
            }
            case 'pick-backup': $('#file-backup').click(); break
            case 'auto-start':
                if (autoReading.running || autoReading.starting) autoReading.stop()
                else { closePanel(); autoReading.start() }
                break
            case 'font-minus':
            case 'font-plus': {
                const delta = action === 'font-plus' ? 1 : -1
                settings.layout.fontSize = Math.max(15, Math.min(34, settings.layout.fontSize + delta))
                persist()
                applyLayoutSettings()
                renderPanel()
                break
            }
            case 'font-reset': {
                settings.layout = { fontSize: 21, lineHeight: 1.9, maxWidth: 640, fontFamily: 'song' }
                persist()
                applyLayoutSettings()
                renderPanel()
                break
            }
        }
    } catch (err) {
        console.error(err)
        toast(`操作失败：${err.message}`)
    }
}

function onPanelInput (e) {
    const t = e.target
    if (t.id === 'shelf-search') {
        shelfQuery = t.value
        renderPanelRecent()
        return
    }
    if (t.id === 'shelf-sort') {
        shelfSort = t.value
        renderPanelRecent()
        return
    }
    if (t.id === 'auto-speed' || t.id === 'auto-seconds') {
        const key = t.id === 'auto-speed' ? 'pixelsPerSecond' : 'pageSeconds'
        settings.autoRead[key] = Number(t.value); persist()
        $('#'+t.id+'-value').textContent = t.value + (key === 'pageSeconds' ? ' 秒' : ' 像素/秒')
    } else if (t.dataset.layout) {
        const key = t.dataset.layout
        const value = key === 'maxWidth' ? Number(t.value) : Number(t.value)
        settings.layout[key] = value
        persist()
        applyLayoutSettings()
        const label = { fontSize: '#v-font', lineHeight: '#v-line', maxWidth: '#v-width' }[key]
        const el = label && $(label)
        if (el) el.textContent = key === 'lineHeight' ? value : `${value}px`
    } else if (t.dataset.setting === 'maskBias') {
        settings.readability.maskBias = Number(t.value)
        persist()
        scene.recomputeReadability()
        const v = t.parentElement.querySelector('.value')
        if (v) v.textContent = t.value
    }
}

async function onPanelChange (e) {
    const t = e.target
    if (t.id === 'notes-book') {
        notesBookId = t.value
        renderPanel()
        return
    }
    if (t.id === 'reading-flow') {
        autoReading.stop()
        const flow=t.value==='scrolled'?'scrolled':'paginated'
        t.disabled=true
        try {
            await reader.setFlow(flow)
            reader.flow=flow
            settings.autoRead.flow=flow
            settings.autoRead.mode=flow==='scrolled'?'scroll':'page'
            persist();syncReadingDock(); renderPanel()
        } catch(error) {toast('阅读方式切换失败：'+error.message);renderPanel()}
    } else if (t.id === 'auto-mode') {
        autoReading.stop(); settings.autoRead.mode=t.value; persist()
    } else if (t.name === 'bgmode') {
        settings.background.mode = t.value
        persist()
        scene.onSettingsChanged()
        renderPanel()
    } else if (t.dataset.slot) {
        settings.background.slotMap[t.dataset.slot] = t.value
        persist()
        scene.onSettingsChanged()
        renderPanel()
    } else if (t.dataset.setting === 'fixedId') {
        settings.background.fixedId = t.value
        persist()
        scene.onSettingsChanged()
        renderPanel()
    } else if (t.dataset.setting === 'rotateMinutes') {
        settings.background.rotateMinutes = Number(t.value)
        persist()
        scene.lastSwitchAt = Date.now() - Number(t.value) * 60000 // 立即看到第一次轮换
        scene.onSettingsChanged()
    } else if (t.dataset.setting === 'animate') {
        settings.background.animate = t.checked
        persist()
        scene.onSettingsChanged()
    } else if (t.name === 'readtheme') {
        settings.readability.theme = t.value
        persist()
        scene.recomputeReadability()
    } else if (t.name === 'fontfam') {
        settings.layout.fontFamily = t.value
        persist()
        applyLayoutSettings()
    }
}

// 音乐面板里需要读写 IndexedDB 的动作由这里处理（MusicUI 只发意图）。
async function handleMusicAction (action, payload = {}) {
    try {
        switch (action) {
            case 'open-panel':
                openPanel('music')
                break
            case 'pick-audio':
                $('#file-audio').click()
                break
            case 'delete-track': {
                const track = localAudio.tracks.find(t => t.id === payload.id)
                if (!track) break
                if (!confirm(`删除「${track.name}」？本机资料库中的副本也会删除，请确认已有备份。`)) break
                const wasCurrent = localAudio.currentId === payload.id
                await db.deleteAudioTrack(payload.id)
                settings.music.order = (settings.music.order || []).filter(id => id !== payload.id)
                if (settings.music.lastTrackId === payload.id) settings.music.lastTrackId = null
                persist()
                if (wasCurrent) localAudio.stop()
                await reloadTracks() // 曲目消失后 setTracks 会清空当前曲目
                break
            }
            case 'rename-track':
                await db.renameAudioTrack(payload.id, payload.name)
                await reloadTracks()
                break
            case 'reorder':
                settings.music.order = payload.ids
                persist()
                await reloadTracks()
                break
            case 'netease-embed': {
                const result = parseNeteaseLink(payload.value)
                if (!result.ok) { toast(`无法解析：${result.reason}`); break }
                musicUI.embedNetease(result)
                toast(`已嵌入网易云官方${result.label}播放器（ID ${result.id}）`)
                break
            }
        }
    } catch (err) {
        console.error(err)
        toast(`音乐操作失败：${err.message}`)
    }
}

async function toggleFullscreen () {
    try {
        if (document.fullscreenElement) await document.exitFullscreen()
        else await document.documentElement.requestFullscreen()
    } catch (e) {
        toast(`全屏失败：${e.message}`)
    }
}

// ---------- 启动 ----------
async function init () {
    try{await db.initDiskLibrary()}catch(error){toast('本机资料同步未完成：'+error.message,12000)}
    // 持久存储：书籍/背景/音频本就落在本机资料库，这里再为浏览器侧 IndexedDB 申请保底
    try{
        const state=await db.requestDurableStorage()
        if(state==='default'){
            const est=await db.storageEstimateMB()
            console.warn('[reader] 浏览器未授予持久存储' + (est?`（已用 ${est.usage}MB / 配额 ${est.quota}MB）`:'') + '；书籍镜像在本机资料库，浏览器侧缓存可能被系统清理')
        }
    }catch{/* 存储探测失败不影响使用 */}
    reader = new Reader($('#reader-host'))
    reader.flow=settings.autoRead.flow
    reader.addEventListener('flowchange',()=>{
        settings.autoRead.flow=reader.flow;settings.autoRead.mode='scroll';persist();syncReadingDock()
        if(activePanel==='font')renderPanel()
    })
    autoReading = new AutoReading(reader, settings.autoRead, toast, persist)
    autoReading.addEventListener('change', () => {
        const button=$('#auto-reading-toggle'), active=autoReading.running||autoReading.starting
        button.textContent=autoReading.starting?'准备中…':autoReading.running?'暂停自动阅读':'自动阅读'
        button.setAttribute('aria-pressed',String(active));document.body.classList.toggle('auto-reading',active);syncReadingDock()
    })
    scene = new SceneController({
        settings,
        getRect: () => currentSurface().getBoundingClientRect(),
    })
    window.__readerScene = scene // 自动化验证与调试句柄
    window.__readerMusic = null
    localAudio = new LocalAudioPlayer()
    musicUI = new MusicUI({
        player: localAudio,
        settings,
        persist,
        onToast: msg => toast(msg),
        onAction: handleMusicAction,
        // 迷你条出现/消失会改变正文高度，重算遮罩与背景可读性
        onLayoutChange: () => {
            setMaskGeometry()
            scene?.recomputeReadability()
        },
    })
    musicUI.mountMiniPlayer($('#mini-player-host'))
    window.__readerMusic = musicUI

    wireEvents()
    await reader.setLayout(settings.layout)

    // 播放设置：音量、循环、随机、淡入淡出（尊重"减少动态效果"）
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    localAudio.setVolume(settings.music.volume)
    localAudio.setLoop(settings.music.loop)
    localAudio.setShuffle(settings.music.shuffle)
    localAudio.setFadeEnabled(settings.music.fade && !reduced)
    if (settings.music.muted) localAudio.setMuted(true)
    await reloadTracks()

    // 恢复上次曲目与播放位置：只恢复到暂停状态，播放仍需用户点击。
    const saved = loadAudioPosition()
    const restoreId = saved?.id && localAudio.tracks.some(t => t.id === saved.id)
        ? saved.id
        : (localAudio.tracks.some(t => t.id === settings.music.lastTrackId) ? settings.music.lastTrackId : null)
    if (restoreId) {
        localAudio.currentId = restoreId
        localAudio.audio.src = localAudio.urlFor(restoreId)
        const t = Number(saved?.time) || 0
        if (t > 0) {
            localAudio.audio.addEventListener('loadedmetadata', () => {
                // 距结尾不到 5 秒就从头开始，避免"一按播放就结束"
                const d = localAudio.audio.duration
                localAudio.audio.currentTime = Number.isFinite(d) && d - t < 5 ? 0 : t
                localAudio.emit()
            }, { once: true })
        }
        localAudio.emit()
    }

    const ambience = new Ambience()
    window.__readerAmbience = ambience // 自动化验证与调试句柄
    window.__readerDb = db // 自动化验证与调试句柄
    atmosphereUI = new AtmosphereUI({settings, scene, persist, ambience, onOpen: () => {
        if (activePanel === 'rain') closePanel()
        else openPanel('rain')
    },
        pickMedia: () => $('#file-image').click(),
        useFluid: async () => {
            settings.background.mode = 'fixed';settings.background.fixedId = 'builtin:fluid';persist()
            try { await scene.applyDesired() } catch (error) { toast(error.message) }
        },
    })

    await ensureSampleBook()
    await refreshRecent()
    await refreshUserBgs()
    document.documentElement.style.setProperty('--col-width', `${settings.layout.maxWidth}px`)
    document.documentElement.style.setProperty('--paper-a', String(settings.atmosphere.paperOpacity))
    await scene.init()
    syncFirstPersonMode()
    setMaskGeometry()

    // 恢复上次的网易云嵌入（不自动播放）
    if (settings.music.netease) musicUI.setNetease(settings.music.netease)

    try {
        const link = await resolveBookLink(window.location.search, db.getBook)
        if (link.kind === 'ready') {
            await openBookRecord(link.book, { preserveLastBookOnError: true })
            const noteId = new URLSearchParams(location.search).get('note')
            if (noteId) {
                const note = link.book.notes?.find(item => item.id === noteId)
                if (note?.cfi) { await reader.goTo(note.cfi); openPanel('notes') }
                else toast('这条笔记已不存在，已打开书籍。')
            }
        } else if (link.kind === 'absent') {
            const lastId = localStorage.getItem('immersive-reader-last-book')
            const lastBook = lastId && await db.getBook(lastId)
            if (lastBook) await openBookRecord(lastBook)
        } else {
            // An invalid link must not silently open another book or erase its position.
            toast(link.message, 12000)
        }
    } catch (err) { toast(`书籍未能打开：${err.message}`) }

    // 工具栏初始可见，空闲后再淡出
    showToolbar()

    const recovered = recoverLog(settings.readingLog, Date.now())
    noteLogEvents(recovered.events)
    persistLog(true)
    paintTimer(true)
    setInterval(() => {
        const { events } = tickLog(settings.readingLog, Date.now())
        if (events.length) noteLogEvents(events)
        if (settings.readingLog.current?.running) persistLog(false)
        paintTimer()
    }, 1000)

    // 快捷键速查：? 键切换
    const helpEl = document.createElement('div')
    helpEl.id = 'shortcut-help'
    helpEl.hidden = true
    helpEl.setAttribute('role', 'dialog')
    helpEl.setAttribute('aria-label', '快捷键速查')
    helpEl.innerHTML = `<div class="help-card"><h3>快捷键</h3><dl>
        <dt>空格</dt><dd>显示 / 隐藏全部操作控件</dd>
        <dt>← → 或 PgUp / PgDn</dt><dd>上一页 / 下一页</dd>
        <dt>M</dt><dd>播放 / 暂停本地音乐</dd>
        <dt>T</dt><dd>开始 / 暂停阅读计时</dd>
        <dt>Esc</dt><dd>关闭面板、停止自动阅读</dd>
        <dt>?</dt><dd>打开 / 关闭本速查</dd>
        </dl><p class="hint">点击任意处关闭</p></div>`
    document.body.appendChild(helpEl)
    helpEl.addEventListener('click', () => { helpEl.hidden = true })
    window.addEventListener('keydown', e => {
        if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey &&
            !e.target.matches('input, select, textarea, button') && !e.target.isContentEditable) {
            e.preventDefault()
            helpEl.hidden = !helpEl.hidden
        }
    })

    // 光标静止自动隐藏：阅读时鼠标停 3 秒后隐藏光标，动一下即恢复
    let cursorTimer = null
    const wakeCursor = () => {
        document.body.classList.remove('cursor-idle')
        clearTimeout(cursorTimer)
        cursorTimer = setTimeout(() => {
            if ($('#reader-column').classList.contains('hidden') || activePanel) return
            document.body.classList.add('cursor-idle')
        }, 3000)
    }
    window.addEventListener('pointermove', wakeCursor, { passive: true })
    wakeCursor()

    // PWA：添加到主屏幕；离线时网络优先、缓存兜底
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* 注册失败不影响使用 */ })
    }

    console.log('[reader] 初始化完成')
}

init().catch(err => {
    console.error('初始化失败', err)
    toast('初始化失败，请刷新页面或查看控制台')
})


let pendingQuote=null
async function renderNotesPanel(body) {
    body.replaceChildren()
    const books = await db.listBooks()
    if (activePanel !== 'notes') return
    if (!books.length) {
        body.textContent = '先打开或导入一本书。每本书的划线和书签分开存放。'
        return
    }
    if (!notesBookId || !books.some(b => b.id === notesBookId)) {
        notesBookId = reader.bookId && books.some(b => b.id === reader.bookId)
            ? reader.bookId
            : (books.find(b => (b.notes || []).length)?.id || books[0].id)
    }
    const record = books.find(b => b.id === notesBookId)
    if (!record || activePanel !== 'notes') return
    const counts = noteCounts(record.notes)

    const picker = document.createElement('label')
    picker.className = 'notes-picker'
    const cap = document.createElement('span')
    cap.textContent = '选择书籍'
    const select = document.createElement('select')
    select.id = 'notes-book'
    select.setAttribute('aria-label', '选择要查看笔记的书')
    for (const b of books) {
        const c = noteCounts(b.notes)
        const opt = document.createElement('option')
        opt.value = b.id
        opt.textContent = `《${b.title}》 · 划线 ${c.quotes} · 书签 ${c.bookmarks}`
        if (b.id === notesBookId) opt.selected = true
        select.append(opt)
    }
    picker.append(cap, select)
    body.append(picker)

    const summary = document.createElement('p')
    summary.className = 'hint'
    summary.textContent = `《${record.title}》划线 ${counts.quotes} 条、书签 ${counts.bookmarks} 条。只显示这一本。`
    body.append(summary)

    if (reader.bookId === notesBookId) {
        const bookmark = document.createElement('button')
        bookmark.textContent = '＋ 收藏当前阅读位置'
        bookmark.dataset.action = 'add-bookmark'
        body.append(bookmark)
    }

    const exportBtn = document.createElement('button')
    exportBtn.textContent = '导出笔记 Markdown'
    exportBtn.dataset.action = 'export-notes'
    exportBtn.disabled = !counts.total
    if (!counts.total) exportBtn.title = '本书还没有笔记'
    body.append(exportBtn)

    const hint = document.createElement('p')
    hint.className = 'hint'
    hint.textContent = reader.bookId === notesBookId
        ? '选中文字后点击“划线并存入笔记”。会记下这一句和后面一句，存在本书资料里。'
        : '正在看另一本书的笔记。回到原文会打开这一本。'
    body.append(hint)

    for (const type of ['quote', 'bookmark']) {
        const notes = (record.notes || []).filter(n => n.type === type)
            .slice()
            .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
        const heading = document.createElement('h3')
        heading.textContent = (type === 'quote' ? '划线笔记' : '书签') + ' · ' + notes.length
        body.append(heading)
        if (!notes.length) {
            const empty = document.createElement('p')
            empty.className = 'hint'
            empty.textContent = type === 'quote' ? '这本书还没有划线。' : '这本书还没有书签。'
            body.append(empty)
            continue
        }
        for (const note of notes) {
            const card = document.createElement('section')
            card.className = 'note-card'
            card.dataset.noteId = note.id
            const place = placeLabel(note)
            if (place) {
                const loc = document.createElement('small')
                loc.className = 'note-place'
                loc.textContent = place
                card.append(loc)
            }
            const text = document.createElement('p')
            text.className = 'note-text'
            text.textContent = note.text || '（无摘录）'
            card.append(text)
            if (note.after) {
                const after = document.createElement('p')
                after.className = 'note-after'
                after.textContent = '下一句：' + note.after
                card.append(after)
            }
            const meta = document.createElement('small')
            meta.textContent = new Date(note.createdAt || Date.now()).toLocaleString('zh-CN')
            card.append(meta)
            const comment = document.createElement('textarea')
            comment.value = note.comment || ''
            comment.placeholder = '写下你的想法…'
            comment.setAttribute('aria-label', '笔记心得')
            card.append(comment)
            for (const [label, action] of [['保存心得', 'save-note'], ['回到原文', 'go-note'], ['删除', 'delete-note']]) {
                const button = document.createElement('button')
                button.textContent = label
                button.dataset.action = action
                button.dataset.id = notesBookId
                button.dataset.noteId = note.id
                card.append(button)
            }
            body.append(card)
        }
    }
}
