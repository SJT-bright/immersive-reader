import './ui-layout.js'
import { createBookLighting } from './book-lighting.js'
import { startGlassContrast } from './glass-contrast.js'
import { sampleRegion, relativeLuminance } from './readability.js'
import { Ambience } from './ambience.js'
import { AutoReading } from './auto-reading.js'
import { AUTO_PRESETS, activePresetSpeed } from './auto-preset.js'
// 主装配：工具栏/面板 UI、自动淡出、键盘、全屏、导入导出、音乐互斥。
// v1.9.3：主页目录面板（不开书查看任意书的目录与每章进度）、目录每章已读百分比、
//        整体进度归零（书内与主页均可，清 journal + DB progress，笔记保留）。

import { loadSettings, saveSettings, DEFAULT_SETTINGS } from './settings.js'
import {
    recoverLog, startSession, pauseSession, resumeSession, endSession, toggleSession,
    setSessionBook, tickLog, summarize, ACHIEVEMENTS, formatDuration, setDailyGoal, clearReadingHistory,
} from './reading-log.js'
import { renderTimer, renderLogPanel, patchLogPanel } from './reading-log-ui.js'
import * as db from './db.js'
import { SceneController, BUILTIN_BACKGROUNDS, SLOT_ORDER, SLOT_LABELS, isFirstPersonRef } from './background.js'
import { Reader } from './reader.js'
import { coverageOf } from './reading-stats.js'
import {
    LocalAudioPlayer, parseNeteaseLink,
} from './music.js'
import { MusicUI } from './music-ui.js'
import { BUILTIN_TRACKS, builtinTrackByKey } from './builtin-music.js'
import { importBook, friendlyImportError, importErrorInfo, ensureSampleBook, extractEpubCover } from './library.js'
import { shelfHTML, shelfListHTML, filterSortBooks, timeAgoLabel } from './bookshelf.js'
import { READING_PRESETS, ENV_PRESETS, capturePresetSnapshot, restorePresetSnapshot, applyReadingPreset, settingsMatchPreset } from './reading-preset.js'
import {
    passageFromText, placeLabel, noteCounts,
    makeQuoteNote, makeBookmarkNote,
} from './notes.js'
import { getDraft, setDraft, clearDraft, pruneDrafts } from './note-drafts.js'

// 书架搜索与排序偏好（会话内记忆，不落盘）
let shelfQuery = ''
let shelfSort = 'recent'
let notesBookId = ''
// 封面 object URL 按书籍缓存：欢迎页与面板共用，删除/替换封面时才轮换
const coverUrlCache = new Map() // book.id -> { cover: Blob, url }
const coverScans = new Set()
async function backfillMissingCovers (books) {
    for (const book of books) {
        if (book.id === 'sample-book' || book.format !== 'epub' || book.cover instanceof Blob ||
            !(book.data instanceof Blob) || coverScans.has(book.id)) continue
        coverScans.add(book.id)
        const cover = await extractEpubCover(book.data)
        if (!cover) continue
        try {
            if (await db.updateBookCover(book.id, cover)) {
                await refreshRecent()
                if ($('#panel-recent')?.isConnected) await renderPanelRecent()
            }
        } catch (error) { console.error('旧书封面补取失败', error) }
    }
}
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
import * as backup from './backup.js'
import { resolveBookLink } from './book-link.js'

import { AtmosphereUI } from './atmosphere-ui.js'
import { isVideo, validateBackground } from './background-media.js'
import { installButtonFx, revealSurface, dismissSurface } from './button-fx.js'
import { installLiquidMotion } from './liquid-motion.js'
import { installTocHover, animateTocPages } from './toc-interaction.js'
import { directoryModel, currentDirectoryKey, directoryMatches, pageWindow, savedDirectoryModel } from './toc-model.js'

const $ = sel => document.querySelector(sel)
const bookLighting = createBookLighting($('#reader-host'))
window.addEventListener('pagehide', e => { if (!e.persisted) bookLighting.destroy() })

let settings = loadSettings()
let autoReading = null
let reader = null
let scene = null
const ambience = new Ambience()
let localAudio = null
let musicUI = null
let atmosphereUI = null
let activePanel = null
let toolbarTimer = null
let toastTimer = null
let openRequest = 0
// 「返回刚才阅读位置」：正常阅读位置锚点；跳转（目录/搜索/笔记/书内链接）视为临时查阅，
// 悬挂锚点更新并显示返回入口，回跳后恢复正常跟踪。
let readingAnchor = null
let anchorSuspended = false
// 阅读预设切换前的自定义环境快照（可恢复旧设置）
let presetSnapshot = null

// ---------- 工具 ----------
function toast (msg, ms = 3800) {
    const el = $('#toast')
    el.textContent = msg
    el.classList.remove('hidden')
    revealSurface(el, { dy: 10, blur: 6 })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => dismissSurface(el, () => el.classList.add('hidden')), ms)
}

// 带撤销按钮的提示：点「撤销」执行回调，超时自动消失。
function toastWithUndo (msg, onUndo, ms = 6500) {
    const el = $('#toast')
    el.replaceChildren()
    const text = document.createElement('span')
    text.textContent = msg
    const undo = document.createElement('button')
    undo.type = 'button'
    undo.className = 'toast-undo'
    undo.textContent = '撤销'
    undo.onclick = () => {
        clearTimeout(toastTimer)
        el.classList.add('hidden')
        try { onUndo() } catch (e) { toast('撤销失败：' + e.message) }
    }
    el.append(text, undo)
    el.classList.remove('hidden')
    revealSurface(el, { dy: 10, blur: 6 })
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => dismissSurface(el, () => { el.classList.add('hidden'); el.replaceChildren() }), ms)
}

// 可取消的长任务提示：渲染「文案 [取消]」，返回的 update() 只替换文案、按钮原地保留。
// 用于大文件导入——进度可见，且导错了随时能取消整批。
function toastCancellable (msg, onCancel, ms = 60000) {
    const el = $('#toast')
    const text = document.createElement('span')
    text.textContent = msg
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'toast-undo'
    btn.textContent = '取消'
    btn.onclick = () => {
        clearTimeout(toastTimer)
        try { onCancel() } catch { /* 取消本身不再报错 */ }
    }
    el.replaceChildren(text, btn)
    el.classList.remove('hidden')
    revealSurface(el, { dy: 10, blur: 6 })
    const update = next => {
        text.textContent = next
        clearTimeout(toastTimer)
        toastTimer = setTimeout(() => dismissSurface(el, () => { el.classList.add('hidden'); el.replaceChildren() }), ms)
    }
    update(msg)
    return update
}

// ---------- 返回刚才阅读位置 ----------
function updateReadingAnchor (progress) {
    if (anchorSuspended) return
    if (progress?.cfi) readingAnchor = { cfi: progress.cfi, label: progress.tocLabel || '' }
}

function showBackToReading () {
    const el = $('#back-reading')
    // 没有锚点就没有可返回的位置，按钮也不该出现。返回 false 让调用方（tempJump）把
    // anchorSuspended 放开：否则悬挂状态只能靠 hideBackToReading() 复位，
    // "刚才的位置"整场会话静默失效直到换书（F3-10）。
    if (!el || !readingAnchor) return false
    const appearing = el.hidden
    el.hidden = false
    if (appearing) revealSurface(el, { dy: 8, blur: 6 })
    return true
}

// 临时查阅跳转：悬挂锚点更新；提供返回入口，回跳后恢复
let tempJumpToken = 0
async function tempJump (go) {
    const token = ++tempJumpToken
    const wasSuspended = anchorSuspended
    if (!anchorSuspended && reader?.lastProgress?.cfi) readingAnchor = { cfi: reader.lastProgress.cfi, label: reader.lastProgress.tocLabel || '' }
    anchorSuspended = true
    try {
        const moved = await go()
        if (token !== tempJumpToken) return false
        if (moved === false) { anchorSuspended = wasSuspended; return false }
    } catch (e) {
        if (token === tempJumpToken) { toast('跳转失败：' + e.message); anchorSuspended = wasSuspended }
        return false
    }
    if (!showBackToReading()) anchorSuspended = false
    return true
}

function hideBackToReading () {
    anchorSuspended = false
    const el = $('#back-reading')
    if (el && !el.hidden) dismissSurface(el, () => { el.hidden = true })
}

// 阅读面几何：书打开时是阅读列，否则是欢迎卡片
function currentSurface () {
    return $('#reader-column').classList.contains('hidden')
        ? (document.body.classList.contains('fp-mode') ? $('#welcome .welcome-intro') : $('#welcome .welcome-card'))
        : $('#reader-host')
}

function setMaskGeometry () {
    if (!scene) return
    const rect = currentSurface().getBoundingClientRect()
    // Solid plateau covers the complete reading rectangle; only the area outside is feathered.
    const welcomeOnLandscape = document.body.classList.contains('fp-mode') && $('#reader-column').classList.contains('hidden')
    const bleed = Math.min(welcomeOnLandscape ? 60 : 100, window.innerWidth * 0.14)
    scene.maskEl.style.setProperty('--feather', `${bleed}px`)
    scene.maskEl.style.left = `${rect.left - bleed}px`
    scene.maskEl.style.top = `${rect.top - bleed}px`
    scene.maskEl.style.width = `${rect.width + bleed * 2}px`
    scene.maskEl.style.height = `${rect.height + bleed * 2}px`

}

function applyInk ({ textColor }) {
    // 第一人称场景的书页用深色墨；欢迎页仍按背景画面选择墨色。
    const onPaper = document.body.classList.contains('fp-mode') && !$('#reader-column').classList.contains('hidden')
    const ink = onPaper ? '#33281c' : textColor
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
    if (wasFp !== fp) setMaskGeometry()
    bookLighting.setScene(fp ? scene.currentRef : null)
    reader?.setBookSpread(fp)
    if (fp) {
        if (!$('#reader-column').classList.contains('hidden')) applyInk({ textColor: '#33281c' })
        // recomputeReadability 会发出 scenechange；只在进入纸面模式时重算，避免递归。
        if (!wasFp) scene.recomputeReadability()
    } else if (wasFp) {
        scene.recomputeReadability() // 离开第一人称：按真实背景重新选墨色
    }
}

const readingControls = '#top-actions, #toolbar, #panel, #atmosphere-panel, #reading-toc-popover, #reading-speed-popover, #reading-dock, #reading-timer, #mini-player, #live-player, #selection-tools, #shortcut-help, button, summary, input, select, textarea, a[href], [role="button"]'
const hoveringReadingControls = () => Boolean(document.querySelector(`:is(${readingControls}):hover`))

const fpParallax = (() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const targets = [$('#bg-root'), $('#reader-column')].filter(Boolean)
    let last = 0, frame = 0, point = null, lastX = '', lastY = ''
    const enabled = () => document.body.classList.contains('fp-mode') && !document.hidden &&
        settings.atmosphere.motion !== false && !reduced.matches
    const apply = time => {
        frame = 0
        if (!enabled() || !point) return
        if (time - last < 40) { frame = requestAnimationFrame(apply); return }
        last = time
        const k = settings.atmosphere.parallax ?? 1
        const nx = point.x / Math.max(1, innerWidth) - .5
        const ny = point.y / Math.max(1, innerHeight) - .5
        const x = `${(nx * -22 * k).toFixed(1)}px`, y = `${(ny * -14 * k).toFixed(1)}px`
        point = null
        // Scope these inherited variables to their two consumers. Setting them
        // on <html> invalidates all glass controls as the pointer moves.
        for (const target of targets) {
            if (x !== lastX) target.style.setProperty('--fp-x', x)
            if (y !== lastY) target.style.setProperty('--fp-y', y)
        }
        lastX = x; lastY = y
    }
    window.addEventListener('pagehide', () => { if (frame) cancelAnimationFrame(frame) }, { once: true })
    return e => {
        if (!enabled() || (e.target instanceof Element && e.target.closest(readingControls))) {
            point = null
            if (frame) { cancelAnimationFrame(frame); frame = 0 }
            return
        }
        point = { x: e.clientX, y: e.clientY }
        if (!frame) frame = requestAnimationFrame(apply)
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
    syncQuickDock()
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

// 计时 tick 的句柄与开关（F3-3）。以前 init() 里的 setInterval 不存句柄、也从不清理，
// 每秒无条件 paintTimer()，而 renderTimer 是整块 innerHTML 重建：
// 左上角「暂停计时 / 结束本次」两个按钮每秒被换掉一次，键盘用户 Tab 上来一秒内就丢焦点，
// :focus-visible 与点击高光每秒重置，还顺带做一次 syncTimerSpan() 的布局测量。
// 现在：句柄存下来（后台/关页即停），并把这一秒要渲染的东西压成签名，签名不变就不重画、不落盘。
let logTimer = null
let lastTickSig = ''
function timerSignature () {
    const snap = logSnapshot()
    const cur = snap.current
    return [
        snap.todayMs, snap.totalMs, snap.streak, snap.goalMinutes, snap.goalMet ? 1 : 0,
        cur ? (cur.running ? 1 : 0) : 0, cur ? Math.floor(cur.elapsedMs / 1000) : 0,
        cur?.bookTitle || '',
        settings.misc.showReadingTimer ? 1 : 0,
        $('#reader-column').classList.contains('hidden') ? 0 : 1,
        activePanel === 'log' ? 1 : 0,
    ].join('|')
}
function startLogTick () {
    if (logTimer) return
    logTimer = setInterval(() => {
        if (document.hidden) return
        const { events } = tickLog(settings.readingLog, Date.now())
        if (events.length) noteLogEvents(events)
        const sig = timerSignature()
        const changed = sig !== lastTickSig
        lastTickSig = sig
        // persistLog 只在计时运行且确有变化时调用
        if (settings.readingLog.current?.running && changed) persistLog(false)
        if (changed) paintTimer()
    }, 1000)
}
function stopLogTick () {
    if (!logTimer) return
    clearInterval(logTimer)
    logTimer = null
}

function paintTimer (fullPanel = false) {
    const el = $('#reading-timer')
    if (!el) return
    // 计时器可见性可选：设置或专注预设隐藏；没打开书（欢迎页）也不显示
    const reading = !$('#reader-column').classList.contains('hidden')
    if (!settings.misc.showReadingTimer || !reading) {
        if (!el.hidden) dismissSurface(el, () => { el.hidden = true; el.replaceChildren() })
        else el.replaceChildren()
    } else {
        const appearing = el.hidden
        el.hidden = false
        const snap = logSnapshot()
        renderTimer(el, snap)
        if (appearing) revealSurface(el, { dy: 8, blur: 5 })
    }
    syncTimerSpan()
    if (activePanel === 'log') {
        const body = $('#panel-body')
        if (fullPanel || !patchLogPanel(body, logSnapshot())) renderLogPanel(body, logSnapshot(), { showTimer: settings.misc.showReadingTimer !== false })
    }
}

function syncTimerSpan () {
    const el = $('#reading-timer')
    const width = el && !el.hidden ? Math.ceil(el.getBoundingClientRect().width) : 0
    document.documentElement.style.setProperty('--timer-span', width ? `${width + 16}px` : '0px')
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
        toast(`记下这次阅读 ${formatDuration(result.session.elapsedMs)}`)
    }
    noteLogEvents(result?.events)
    persistLog(true)
    paintTimer(true)
}

// 自动阅读驱动计时：真正开始跑就起计（或接上未结束的这次），真正停下就暂停。
// 只跟随启停的跳变，所以未开自动阅读时的 stop() 调用不会误暂停手动计时。
let timerFollowsAutoReading = false
function linkTimerToAutoReading (active) {
    if (active === timerFollowsAutoReading) return
    timerFollowsAutoReading = active
    const log = settings.readingLog
    const now = Date.now()
    let result
    if (active) result = !log.current ? startSession(log, now, currentBookMeta()) : resumeSession(log, now)
    else result = log.current?.running ? pauseSession(log, now) : null
    if (!result?.ok) return
    noteLogEvents(result.events)
    persistLog(true)
    paintTimer()
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
    // 换书前显式停掉自动阅读：reader.open() 一进来就派发 manualnavigation → AutoReading.restart()，
    // running 还是 true 的话自动翻页直接续跑进新书。「回书架」那条路径本来就是先 stop() 的（F3-5）。
    autoReading?.stop()
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
        const opened = await reader.open(rec, { lastLocation: cfi || rec.progress?.cfi || null, useJournal: !cfi })
        if (request !== openRequest || !opened) return
        $('#reading-title').textContent = rec.title
        setSessionBook(settings.readingLog, { id: rec.id, title: rec.title })
        paintTimer()
        notesBookId = rec.id
        try { localStorage.setItem('immersive-reader-last-book', rec.id) } catch { /* Position is still saved to DB. */ }
        persistTocFlat(rec.id) // 主页目录：开卷即持久化扁平目录（内容相同则跳过写盘）
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
    closeReadingToc()
    if (!preserveLastBook) {
        try { localStorage.removeItem('immersive-reader-last-book') } catch { /* unavailable storage */ }
    }
    setMaskGeometry()
    scene.recomputeReadability()
}

async function refreshRecent () {
    const books = attachCoverUrls(await db.listBooks())
    void backfillMissingCovers(books)
    const list = $('#recent-list')
    // 继续阅读卡片：有书且读过的最近一本，突出书名、章节与时间
    const cont = $('#continue-reading')
    if (cont) {
        const last = books.find(b => b.id !== 'sample-book' && b.lastOpenedAt) || books.find(b => b.lastOpenedAt)
        if (last) {
            const pct = Math.round((last.progress?.percent || 0) * 100)
            const bits = [last.progress?.tocLabel ? `读到「${last.progress.tocLabel}」` : '', pct > 0 ? `已读 ${pct}%` : ''].filter(Boolean).join(' · ')
            cont.hidden = false
            cont.innerHTML = `继续阅读《${escapeHtml(last.title)}》${bits ? ' · ' + escapeHtml(bits) : ''}<small>${escapeHtml(timeAgoLabel(last.lastOpenedAt))}</small>`
            cont.onclick = () => openBookRecord(last)
        } else {
            cont.hidden = true
        }
    }
    if (!books.length) {
        list.innerHTML = '<p class="recent-empty">还没有书籍，点上方按钮导入 EPUB、TXT 或 PDF。</p>'
        return
    }
    list.innerHTML = shelfBooksHTML(books)
}

function shelfBooksHTML (books) {
    return settings.misc.shelfView === 'list'
        ? shelfListHTML(books)
        : `<div class="shelf">${shelfHTML(books)}</div>`
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
let panelMotion = null
let panelHiding = false
function openPanel (name) {
    $('#reading-speed-details').open = false
    // 抽屉与读书页的目录浮层不能同时挂着：两套目录树并存在文档里既重复（同名控件、双份焦点环），
    // 也让「外侧收起」的判断含糊。开抽屉先把浮层收起来（F3-7）。
    closeReadingToc()
    if (activePanel === name) return
    // 修复：同名早退前不能先关大气面板，否则「已是窗外天气再点天」会把面板藏掉且不恢复。
    atmosphereUI?.close(false)
    try { localStorage.setItem('reader-last-panel',name) } catch {}
    activePanel = name
    // 次级面板（场景/天气/音乐/记录）打开时展开次级行
    if (['scene','rain','music','log','auto'].includes(name)) setNavSecondary(true)
    $('#top-settings').setAttribute('aria-expanded','true')
    $('#toolbar').hidden=false
    panelMotion?.cancel()
    $('#panel').inert = false
    const wasHidden = $('#panel').classList.contains('hidden')
    $('#panel').classList.remove('hidden')
    // 退场动画进行中又点开：cancel 掉退场只让面板停在半透明，必须重放入场
    if (wasHidden || panelHiding) panelMotion = revealSurface($('#panel'))
    panelHiding = false
    showToolbar()
    renderPanel({ animate: !wasHidden })
    musicUI?.syncLiveDock()
}

function closePanel () {
    ++tocRenderToken
    activePanel = null
    atmosphereUI?.close(false)
    $('#top-settings').setAttribute('aria-expanded','false')
    const panel = $('#panel')
    panelMotion?.cancel()
    panel.inert = true
    // 退场动画结束后才真正隐藏；期间若用户又点开面板，openPanel 会 cancel 掉这条，
    // 回调不再执行，面板不会被藏回去。
    panelHiding = true
    panelMotion = dismissSurface(panel, () => {
        panel.classList.add('hidden')
        panelMotion = null
        panelHiding = false
        musicUI?.syncLiveDock()
    })
    if (!panelMotion) { panel.classList.add('hidden'); panelHiding = false }
    $('#toolbar').querySelectorAll('button').forEach(b => b.classList.remove('active'))
    // 关面板时收起次级行，导航恢复紧凑
    setNavSecondary(false)
    musicUI?.syncLiveDock()
}

// 两级导航：主入口常驻，场景/天气/音乐/记录/全屏收进「更多」
function setNavSecondary (open) {
    const sec = $('#nav-secondary')
    const more = $('#nav-more')
    if (!sec || !more) return
    sec.hidden = !open
    more.setAttribute('aria-expanded', String(open))
}
function toggleNavSecondary () { setNavSecondary($('#nav-secondary')?.hidden) }

const PANEL_TITLES = { open: '书籍与备份', toc: '目录', scene: '阅读环境', font: '字体与排版', music: '音乐', auto: '自动阅读', rain: '环境高级设置', notes: '笔记书签', log: '阅读记录' }

function renderPanel ({ animate = false } = {}) {
    if (!activePanel) return
    if (activePanel !== 'toc') ++tocRenderToken
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
    else if (activePanel === 'log') renderLogPanel(body, logSnapshot(), { showTimer: settings.misc.showReadingTimer !== false })
    else if (activePanel === 'music') { musicUI.renderPanel($('#music-panel-body')); syncGlobalMuteButton() }
    // .music-pane 与 #atmosphere-panel 自己带 surface-appear（css/experience.css），
    // 外层再叠一次会出现两段位移，这里只给纯 JS 渲染的分页做入场。
    if (animate && activePanel !== 'music' && activePanel !== 'rain') revealSurface(body)
}

// File picker and drops share one queue, including batches dropped during an import.
let bookImportQueue = Promise.resolve()
// 导入失败卡片：持续可见直到用户处理，不只一闪而过的 toast
let importErrors = [] // { id, title, hint, file }
function addImportError (info, file) {
    importErrors = [{ id: 'err-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6), ...info, file }, ...importErrors].slice(0, 6)
    if (activePanel === 'open') renderPanel()
    else openPanel('open')
}
function importBookFiles(files) {
    if (!files.length) return bookImportQueue
    bookImportQueue = bookImportQueue.catch(() => {}).then(async () => {
        // 整批取消：进度提示上的「取消」中止整批（比只取消当前文件更符合
        // 「这批文件我不要了」的直觉）。各协作循环在让步点抛 AbortError。
        const batch = new AbortController()
        for (const file of files) {
            try {
                const updateToast = toastCancellable(`正在导入「${file.name}」…`, () => batch.abort())
                let lastProgressAt = 0
                const rec = await importBook(file, { signal: batch.signal, onProgress: p => {
                    if (!p || typeof p !== 'object') return
                    const now = Date.now()
                    if (now - lastProgressAt < 300) return
                    lastProgressAt = now
                    const label = p.stage
                        ? `${p.stage} ${p.done}/${p.total}`
                        : p.totalLines ? `已读入 ${Math.min(99, Math.round(p.lines / Math.max(1, p.totalLines) * 100))}%` : ''
                    if (label) updateToast(`正在导入「${file.name}」· ${label}`)
                } })
                await refreshRecent()
                renderPanelRecent()
                refreshDiskStatus()
                // 书已保存：渲染失败不掩盖「已保存」的事实
                try {
                    await openBookRecord(rec)
                } catch (openErr) {
                    console.error(openErr)
                    addImportError({ title: `《${rec.title}》已保存到书库，但本次打开失败`, hint: `书籍数据没有丢，重启应用或在书架重新点击即可再次打开。原因：${openErr.message}` }, null)
                    continue
                }
                // TXT 转换报告：章节数与识别出的编码（如 GB18030）；其他格式保持原 toast
                if (rec.format === 'txt' && rec.txtReport) toast(`已导入「${rec.title}」· ${rec.txtReport.chapters} 章 · ${String(rec.txtReport.encoding).toUpperCase()} 编码`)
                else toast(`已导入「${rec.title}」`)
            } catch (err) {
                if (err?.name === 'AbortError') { toast('已取消导入'); break }
                console.error(err)
                refreshDiskStatus()
                const info = importErrorInfo(err, file)
                addImportError(info, file)
                toast(info.title)
            }
        }
    })
    return bookImportQueue
}
// 面板顶部的本机资料库状态是导入/删除时才变化的字符串：磁盘镜像异常等情况下
// 及时刷新，用户能在界面上看到「书籍先存浏览器、重启应用自动补同步」的状态。
function refreshDiskStatus () {
    const el = $('#disk-status')
    if (el) el.textContent = db.diskStatus()
}
// 保存失败重试：重新连接本机资料库并补同步（不用重启应用）
async function retryDiskSync () {
    toast('正在重新连接本机资料库…', 8000)
    try {
        const ok = await db.initDiskLibrary()
        refreshDiskStatus()
        if (activePanel === 'open') renderPanel()
        toast(ok ? '已重新连接本机资料库' : '本机资料库仍不可用；内容已保存在浏览器，可继续阅读或导出备份')
    } catch (e) { toast('重试失败：' + e.message) }
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
let backupInspection = 0
let backupBusy = false // 导出进行中：面板按钮在长导出期间可被重复点击，用它挡住
let pendingBackup = null // { payload, counts, name }：选择备份文件后待用户选恢复方式
// 备份类长任务的进度提示：toast 会原地替换文本，按 300ms 节流刷新即可
function backupProgressToaster (label) {
    let last = 0
    return p => {
        const now = Date.now()
        if (!p || now - last < 300) return
        last = now
        toast(`${label} ${p.done}/${p.total}`, 60000)
    }
}
function renderOpenPanel (body) {
    const diskOk = !/仅存浏览器|暂时|未完成/.test(db.diskStatus())
    const scrollTop = body.scrollTop
    const prevRecent = body.querySelector('#panel-recent')?.innerHTML || $('#recent-list')?.innerHTML || ''
    const prevInstant = body.querySelector('.shelf-fold')?.classList.contains('fold-instant')
    body.innerHTML = `
        <p class="hint" role="status" id="disk-status">${escapeHtml(db.diskStatus())}${diskOk ? '' : ' <button class="link-btn" data-action="retry-disk">重试连接</button>'}</p>
        ${importErrors.length ? `
        <section class="import-errors" aria-label="导入或打开失败">
            <h3>导入 / 打开失败</h3>
            ${importErrors.map(err => `
            <div class="import-error-card" data-err="${err.id}">
                <p class="ie-title">${escapeHtml(err.title)}</p>
                <p class="hint">${escapeHtml(err.hint || '')}</p>
                <div class="row">
                    ${err.file ? `<button data-action="retry-import" data-err="${err.id}">重试</button>` : ''}
                    <button data-action="dismiss-import-error" data-err="${err.id}">知道了</button>
                </div>
            </div>`).join('')}
        </section>` : ''}
        ${reader.bookId ? '<div class="row"><button data-action="return-home" title="保存阅读位置并返回首页">← 返回首页</button></div>' : ''}
        <section id="book-drop-zone" role="group" aria-label="拖入 EPUB、TXT 或 PDF 书籍">
            <div class="row">
                <button data-action="pick-book" class="primary" title="支持 EPUB、UTF-8/GBK 文本，以及 PDF 文字提取（不保留图片与版式；扫描件需先 OCR）">导入书籍</button>
            </div>
            <p class="hint">拖入 EPUB / TXT / PDF，或点按钮选择。TXT 自动识别编码并转成 EPUB 阅读排版。PDF 只提取文字。</p>
        </section>
        <section>
            <div class="shelf-fold${prevInstant ? ' fold-instant' : ''}">
            <h3>最近书籍</h3>
            <div class="row shelf-tools">
                <input id="shelf-search" type="search" value="${escapeHtml(shelfQuery)}" placeholder="搜索书名或作者" aria-label="搜索书架">
                <select id="shelf-sort" aria-label="排序方式">
                    <option value="recent" ${shelfSort === 'recent' ? 'selected' : ''}>最近打开</option>
                    <option value="added" ${shelfSort === 'added' ? 'selected' : ''}>导入时间</option>
                    <option value="title" ${shelfSort === 'title' ? 'selected' : ''}>书名</option>
                    <option value="progress" ${shelfSort === 'progress' ? 'selected' : ''}>进度</option>
                </select>
            </div>
            <div class="row view-toggle" role="group" aria-label="书架视图">
                <button data-action="shelf-view" data-view="shelf" class="${settings.misc.shelfView !== 'list' ? 'on' : ''}" aria-pressed="${settings.misc.shelfView !== 'list'}">3D 书架</button>
                <button data-action="shelf-view" data-view="list" class="${settings.misc.shelfView === 'list' ? 'on' : ''}" aria-pressed="${settings.misc.shelfView === 'list'}">紧凑列表</button>
            </div>
            <div id="panel-recent">${prevRecent}</div>
            </div>
        </section>
        <section>
            <h3>备份</h3>
            ${pendingBackup ? `
            <div class="backup-ready">
                <p class="hint">已读取「${escapeHtml(pendingBackup.name)}」：${pendingBackup.counts.books} 本书、${pendingBackup.counts.backgrounds} 张背景、${pendingBackup.counts.audio} 首本地音乐。</p>
                <div class="row">
                    <button data-action="backup-merge" class="primary">合并到现有资料</button>
                    <button data-action="backup-overwrite">覆盖恢复</button>
                    <button data-action="backup-cancel">取消</button>
                </div>
                <p class="hint">合并：保留现有全部资料，只补充缺失的书与内容；同一本书保留较新的进度，笔记按条合并，不改动当前设置。<br>
                覆盖：用备份替换当前全部数据与设置。<br>
                两种方式执行前都会自动下载「恢复前快照」，可随时用它回退。</p>
            </div>` : ''}
            <div class="row">
                <button data-action="backup-export" class="primary">导出备份</button>
                <button data-action="pick-backup">导入备份</button>
            </div>
            <p class="hint">备份是导出到本机的 JSON 文件，包含全部书籍、背景、本地音乐、阅读位置与设置。
               使用本机启动器时资料同时保存在本机资料库；建议定期导出一份独立备份。</p>
            <p class="hint" id="last-backup"></p>
        </section>`
    bindBookDropZone(body.querySelector("#book-drop-zone"))
    if (scrollTop) body.scrollTop = scrollTop
    renderPanelRecent().then(applied => {
        if (applied && scrollTop) requestAnimationFrame(() => { body.scrollTop = scrollTop })
    }).catch(() => {})
    db.getMeta('lastBackupAt').then(async t => {
        const el = $('#last-backup')
        if (!el) return
        // 示例书不算自己的资料：只有示例书视为空书库，不催促备份
        const bookCount = (await db.listBooks()).filter(b => b.id !== 'sample-book').length
        if (t) {
            el.textContent = `上次导出：${new Date(t).toLocaleString('zh-CN')}`
            if (bookCount && Date.now() - t > 7 * 86400000) {
                el.textContent += ' · 已超过 7 天，建议导出一份'
                el.classList.add('stale')
            }
        } else if (bookCount) {
            el.textContent = '还没有导出过备份，建议现在就导出一份'
            el.classList.add('stale')
        }
    })
}

let panelRecentToken = 0
function renderPanelRecent () {
    const el = $('#panel-recent')
    if (!el) return Promise.resolve(false)
    const token = ++panelRecentToken
    return db.listBooks().then(async books => {
        if (token !== panelRecentToken || !el.isConnected) return false
        const shown = filterSortBooks(attachCoverUrls(books), shelfQuery, shelfSort)
        if (!shown.length) {
            el.innerHTML = `<p class="recent-empty">${books.length ? '没有匹配的书，换个关键词试试。' : '暂无书籍'}</p>`
            return true
        }
        el.innerHTML = shelfBooksHTML(shown)
        return true
    })
}

// 视口里第一本可见的书；书都滚出画面时改锚定切换按钮，避免换视图后跳回列表开头。
function shelfScrollAnchor (root) {
    const scroller = root?.closest('.panel-content')
    if (!scroller) return null
    const viewTop = scroller.getBoundingClientRect().top
    const viewBottom = scroller.getBoundingClientRect().bottom
    for (const book of root.querySelectorAll('[data-action="open-book"]')) {
        const rect = book.getBoundingClientRect()
        if (rect.height < 8) continue
        if (rect.bottom <= viewTop + 4) continue
        if (rect.top >= viewBottom - 4) break
        return { kind: 'book', id: book.dataset.id, top: rect.top }
    }
    const toggle = scroller.querySelector('.view-toggle')
    return toggle ? { kind: 'toggle', top: toggle.getBoundingClientRect().top } : null
}

function restoreShelfScroll (root, anchor) {
    const scroller = root?.closest('.panel-content')
    if (!scroller || !anchor) return
    let top = null
    if (anchor.kind === 'book' && anchor.id) {
        const safe = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(anchor.id) : String(anchor.id).replace(/["\\]/g, '\\$&')
        top = root.querySelector(`[data-action="open-book"][data-id="${safe}"]`)?.getBoundingClientRect().top
    } else if (anchor.kind === 'toggle') {
        top = scroller.querySelector('.view-toggle')?.getBoundingClientRect().top
    }
    if (top == null) return
    scroller.scrollTop += top - anchor.top
}

function syncShelfViewToggle () {
    const list = settings.misc.shelfView === 'list'
    document.querySelectorAll('[data-action="shelf-view"]').forEach(button => {
        const on = (button.dataset.view === 'list') === list
        button.classList.toggle('on', on)
        button.setAttribute('aria-pressed', String(on))
    })
}

// ----- 书内全文搜索 -----
let bookSearchToken = 0
let bookSearchCache = { bookId: null, query: '', html: '', count: null, progress: '' }

function clearBookSearchCache () {
    bookSearchToken++ // 旧书或上一次搜索的异步结果不再写入新面板
    bookSearchCache = { bookId: null, query: '', html: '', count: null, progress: '' }
}

function searchResultHtml (label, excerpt, cfi) {
    const text = [excerpt.pre, excerpt.match, excerpt.post]
        .map(s => String(s ?? '')).join('').replace(/\s+/g, ' ').trim()
    const where = label ? `〔${label}〕` : ''
    return `<li><button data-action="search-go" data-cfi="${escapeHtml(cfi)}"><span class="s-where">${escapeHtml(where)}</span>…${escapeHtml(text)}…</button></li>`
}

async function runBookSearch (query) {
    const body = $('#panel-body')
    if (!reader.view || !query.trim()) return
    const token = ++bookSearchToken
    const bookId = reader.bookId
    view: {
        try {
            const listEl = body.querySelector('#book-search-results')
            if (!listEl) break view
            listEl.innerHTML = ''
            bookSearchCache = { bookId, query, html: '', count: 0, progress: '扫描中…' }
            const row = body.querySelector('#book-search .row')
            if (row && !row.querySelector('[data-action="book-search-clear"]')) {
                const clear = document.createElement('button')
                clear.type = 'button'
                clear.dataset.action = 'book-search-clear'
                clear.textContent = '清除'
                row.append(clear)
            }
            const progressEl = body.querySelector('#book-search-progress')
            for await (const result of reader.view.search({
                query: query.trim(), matchCase: false, matchDiacritics: false, matchWholeWords: false,
            })) {
                if (token !== bookSearchToken || bookId !== reader.bookId) return
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
            if (token !== bookSearchToken || bookId !== reader.bookId) return
            bookSearchCache.progress = `共找到 ${bookSearchCache.count} 处`
            if (progressEl) progressEl.textContent = bookSearchCache.progress
            if (!bookSearchCache.count) listEl.innerHTML = '<p class="hint">没有找到匹配内容。</p>'
        } catch (error) {
            if (token === bookSearchToken && bookId === reader.bookId) toast('搜索出错：' + error.message)
        }
    }
}

function renderSearchBox (body) {
    const cached = bookSearchCache.bookId === reader.bookId && bookSearchCache.query ? bookSearchCache : null
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
// 解析 toc 项对应 section 序号（用于当前章高亮与已读状态）
function persistTocFlat (bookId) {
    const book = reader.view?.book
    if (!book) return
    const flat = directoryModel(book).entries.map(({ label, href, index, depth }) => ({ label, href, index, depth }))
    if (flat.length) db.updateBookToc(bookId, flat).catch(e => console.error('目录持久化失败', e))
}

// 主页目录用已读数据：journal（最新，含未落盘到 DB 的翻页）优先，DB progress 兜底
function storedProgressOf (bookId, saved) {
    try {
        const raw = JSON.parse(localStorage.getItem('immersive-reader-position:' + bookId))
        if (raw && typeof raw === 'object' && (raw.readMap != null || raw.percent != null) &&
            (!saved?.at || !raw.at || raw.at >= saved.at)) return raw
    } catch { /* 读不到就退回 DB */ }
    return null
}

const chapterPctOf = (cov) => `${Math.round(Math.max(0, Math.min(1, cov || 0)) * 100)}%`

// ==== 页级进度纯函数 ====
// tests/toc-pages.test.mjs 按 TOC-PURE-START / TOC-PURE-END 两行标记抽取这段源码单独跑测，
// 段内只能用参数和局部变量：不碰 DOM、不读 reader，也不引入外部函数，改签名会打断那条测试通道。
// ==== TOC-PURE-START ====

// 第 p 页（1 起）在本章占 [(p-1)/pages, p/pages]。把已读区间逐页求重叠，
// 返回长度 = pages 的数组，每项是这一页已读的比例（0-1）。
// pages 不是正整数时返回 []——这就是「拿不到页数就不展开页明细」的降级出口。
function tocPageCoverage (ranges, pages) {
    const n = Number.isInteger(pages) && pages > 0 ? pages : 0
    if (!n) return []
    const out = new Array(n).fill(0)
    // 区间先裁剪到 [0,1] 再归并（与 reading-stats.normalizeRanges 同规则；
    // 这里自带一份，是为了让这个函数能脱离模块导入被抽出来单测）。
    const list = []
    for (const r of Array.isArray(ranges) ? ranges : []) {
        if (!Array.isArray(r) || r.length < 2) continue
        const from = Number(r[0]), to = Number(r[1])
        if (!Number.isFinite(from) || !Number.isFinite(to)) continue
        const lo = Math.max(0, Math.min(1, from)), hi = Math.max(0, Math.min(1, to))
        if (hi > lo) list.push([lo, hi])
    }
    list.sort((x, y) => x[0] - y[0] || x[1] - y[1])
    const merged = []
    for (const [a, b] of list) {
        const last = merged[merged.length - 1]
        if (last && a <= last[1] + 1e-9) { if (b > last[1]) last[1] = b } else merged.push([a, b])
    }
    for (const [a, b] of merged) {
        const first = Math.min(n - 1, Math.max(0, Math.floor(a * n)))
        const last = Math.min(n - 1, Math.max(first, Math.floor(b * n - 1e-9)))
        for (let p = first; p <= last; p++) {
            // 重叠长度 / 页宽（页宽 = 1/n）就是这一页的阅读比例
            const overlap = Math.min(b, (p + 1) / n) - Math.max(a, p / n)
            if (overlap > 0) out[p] = Math.min(1, out[p] + overlap * n)
        }
    }
    return out
}

// 页状态沿用目录圆点的三态语言：读满 / 部分 / 未读。
// 98% 的容差是给滚动模式的边界页和浮点尾数留的余量，不是把半读算成读满。
function tocPageState (ratio) {
    const r = Number.isFinite(ratio) ? Math.max(0, Math.min(1, ratio)) : 0
    return r >= 0.98 ? 'read' : r > 0 ? 'part' : 'none'
}

// 跳第 page 页要用的「章内比例」：取页中点，不取页首。
// foliate 分页模式落在 round(anchor*(T-1))+1 页、滚动模式落在 floor(anchor*T)+1 页，
// (p-0.5)/T 在两种口径下都精确命中第 p 页；而且严格落在 (0,1) 内部，
// 避开全书 fraction 反解章节时的边界歧义（正好压在章首会变成上一章末页，章尾会变成下一章章首）。
function tocPageAnchor (page, pages) {
    const n = Number.isInteger(pages) && pages > 0 ? pages : 0
    const p = Number.isInteger(page) && page >= 1 && page <= n ? page : 0
    if (!n || !p || n === 1) return 0
    return (p - 0.5) / n
}

// (章节序号, 页码) → foliate 的全书 fraction：reader.goTo({ fraction }) 会把它反解成
// { index, anchor } 再定位，不需要在这里拼 CFI。
// sizes 是各 section 的字符权重（reading-stats.sectionSizesFrom 口径，与 foliate SectionProgress 同源）。
// 章节定位不了（序号越界 / 权重为 0 / 结果压到 0 或 1 的边界）时返回 null，
// 由调用方退化成「跳到本章开头」，绝不猜一个可能跳错位置的数。
function tocChapterPageFraction (index, page, pages, sizes) {
    if (!Number.isInteger(index) || index < 0) return null
    if (!Array.isArray(sizes) || index >= sizes.length) return null
    const sizeIn = Number(sizes[index]) || 0
    if (!(sizeIn > 0)) return null
    let sizeBefore = 0, sizeTotal = 0
    for (let i = 0; i < sizes.length; i++) {
        const s = Number(sizes[i]) || 0
        if (i < index) sizeBefore += s
        sizeTotal += s
    }
    if (!(sizeTotal > 0)) return null
    const f = (sizeBefore + tocPageAnchor(page, pages) * sizeIn) / sizeTotal
    return f > 0 && f < 1 ? f : null
}
// ==== TOC-PURE-END ====

// 本章页数：优先用 Reader 的新接口 chapterPages(index)（另一个会话在补，可能还没上线）。
// 接口不存在或返回 0 时，只对「当前已经排版好的那一章」从分页器实时取页数——
// 其余章节不猜，返回 0，那一行就不显示展开入口（优雅降级）。
// 排版过的章才有真实页数：新接口优先，其次本地按分页器实时取（口径与 reader.screenRange / pageText 一致：
// 滚动模式按 pages 计，分页模式两侧各有一屏留白，正文页 = pages - 2）。
function exactPageCount (index) {
    if (!Number.isInteger(index) || index < 0) return 0
    let viaApi = 0
    try { viaApi = reader.chapterPages?.(index) || 0 } catch { viaApi = 0 }
    if (Number.isInteger(viaApi) && viaApi > 0) return viaApi
    const view = reader.view
    const r = view?.renderer
    if (!r || view?.lastLocation?.section?.current !== index) return 0
    if (r.scrolled) return Number.isInteger(r.pages) && r.pages > 0 ? r.pages : 0
    return r.pages > 2 ? r.pages - 2 : 0
}

// 引擎一次只排版一个 section，其余章拿不到真实页数。这里用当前章标定「每页多少字符」，
// 再按各 section 的字符量估算，让所有章节都能展开。估算必然有 ±1 页误差，
// 所以额外带回 estimated 标记，由界面如实写成「约」，不冒充精确值。
function chapterPageInfo (index, stats = reader.readStats) {
    const exact = exactPageCount(index)
    if (exact > 0) return { pages: exact, estimated: false }
    const current = reader.view?.lastLocation?.section?.current
    const curPages = exactPageCount(current)
    const sizes = stats?.sizes || []
    if (!(curPages > 0) || !sizes[current] || !Number.isInteger(index) || !sizes[index]) return { pages: 0, estimated: false }
    const perPage = sizes[current] / curPages
    if (!(perPage > 0)) return { pages: 0, estimated: false }
    return { pages: Math.max(1, Math.round(sizes[index] / perPage)), estimated: true }
}


// 页级明细的 HTML：一行小结 + 页码芯片。点开一章才构建一次，上百篇的书也不会一次生成几千个节点。
function tocPagesHTML (index, pages, estimated, start = 1) {
    if (estimated) return '<p class="toc-pages-hint">页数为估算。先点击章节标题打开正文，再选择实际页码。</p>'
    const list = tocPageCoverage(reader.readStats?.readMap?.[index], pages)
    const win = pageWindow(pages, start)
    let read = 0, part = 0
    for (const ratio of list) {
        if (tocPageState(ratio) === 'read') read++
        else if (tocPageState(ratio) === 'part') part++
    }
    const chips = win.pages.map(p => {
        const ratio = list[p - 1], state = tocPageState(ratio), pct = Math.round(ratio * 100)
        return `<button type="button" class="toc-page ${state}" data-action="toc-page-go"` +
            ` data-section="${index}" data-page="${p}" data-pages="${pages}"` +
            ` data-reader-static-control title="第 ${p} 页 · 已读 ${pct}%" aria-label="跳到第 ${p} 页，已读 ${pct}%"><span>${p}</span></button>`
    }).join('')
    const pager = pages > 80 ? `<div class="toc-pages-pager">
        <button type="button" data-reader-static-control data-action="toc-pages-window" data-start="${Math.max(1, win.start - 80)}" ${win.start === 1 ? 'disabled' : ''}>上一组</button>
        <span>${win.start}–${win.end} / ${pages} 页</span>
        <button type="button" data-reader-static-control data-action="toc-pages-window" data-start="${win.end + 1}" ${win.end === pages ? 'disabled' : ''}>下一组</button></div>` : ''
    return `<p class="toc-pages-hint"><span>${pages} 页</span><span>读满 ${read} · 部分 ${part} · 未读 ${list.length - read - part}</span><span class="toc-pages-tip">点页码跳转</span></p>` +
        `<div class="toc-page-grid">${chips}</div>${pager}`
}

// 展开某一章：填充页明细（重渲染后也走这里，保证百分比跟着最新已读区间）
function openTocRow (li, { animate = true } = {}) {
    const box = li?.querySelector(':scope > .toc-pages')
    const btn = li?.querySelector('.toc-expand')
    if (!box || !btn) return false
    if (li.classList.contains('toc-expanded')) return true
    const index = Number(li.dataset.section), pages = Number(li.dataset.pages)
    if (!(pages > 0) || !Number.isInteger(index)) return false
    box.innerHTML = tocPagesHTML(index, pages, li.dataset.pagesEst === '1', Number(li.dataset.pageStart) || 1)
    box.dataset.pagesKey = `${pages}|${li.dataset.pagesEst === '1'}`
    btn.setAttribute('aria-expanded', 'true')
    li.classList.add('toc-expanded')
    animateTocPages(box, true, { animate })
    return true
}

function closeTocRow (li) {
    const box = li?.querySelector(':scope > .toc-pages')
    const btn = li?.querySelector('.toc-expand')
    if (!li?.classList.contains('toc-expanded')) return
    if (btn) btn.setAttribute('aria-expanded', 'false')
    li?.classList.remove('toc-expanded')
    if (box) animateTocPages(box, false)
}

// 展开/收起：独立小控件，不与整行的「跳章」按钮抢点击；收起浮层由浮层外的监听负责，这里不动它
function toggleTocRow (li) {
    if (!li) return
    if (tocHover?.activateRow?.(li)) return
    if (li.classList.contains('toc-expanded')) closeTocRow(li)
    else openTocRow(li)
}

// 页内跳转：把 (章, 页) 折成全书 fraction 走现成的 reader.goTo({fraction})，
// 拿不到可靠比例时退化为「跳到本章开头」——宁可退一步，也不跳到一个错的位置。
async function goToChapterPage ({ section, page, pages, href }) {
    if (section !== reader.lastProgress?.section || exactPageCount(section) !== pages) {
        toast('页码已随排版变化，请先打开这一章，再选择实际页码')
        return false
    }
    // Direct section navigation works even for a section with zero character weight.
    if (reader.goToChapterPage) return tempJump(() => reader.goToChapterPage(section, page))
    const fraction = tocChapterPageFraction(section, page, pages, reader.readStats?.sizes)
    const target = fraction != null ? { fraction } : href
    if (!target) { toast('这一章暂时无法定位到页，请打开后再试'); return false }
    return tempJump(() => reader.goTo(target))
}

// 目录过滤（书内版与主页版共用）：即时匹配 li[data-label]
// 容器不同、id 也不同：抽屉里用 toc-*，读书页浮层用 reading-toc-*。
// 两边同名会在文档里造出重复 id（HTML 非法，AT 的 label/controls 归属歧义，F3-7）。
const TOC_FILTER_PANEL = { input: '#toc-filter', list: '#toc-list', hint: '#toc-filter-hint' }
const TOC_FILTER_POPOVER = { input: '#reading-toc-filter', list: '#reading-toc-list', hint: '#reading-toc-filter-hint' }
function bindTocFilter (body, total, labels, sel = TOC_FILTER_PANEL) {
    const filterInput = body.querySelector(sel.input)
    if (!filterInput) return
    const rows = [...body.querySelectorAll(`${sel.list} li`)]
    const entries = rows.map((li, key) => ({ key, label: li.dataset.label || '', parent: Number(li.dataset.parent ?? -1) }))
    const hint = body.querySelector(sel.hint)
    const filter = () => {
        const q = filterInput.value.trim()
        const { visible, count } = directoryMatches(entries, q)
        rows.forEach((li, key) => { li.hidden = !visible.has(key) })
        if (hint) {
            hint.textContent = q ? (count ? `匹配 ${count} / ${total} 条` : '没有匹配的目录') : labels.all
            if (sel === TOC_FILTER_POPOVER) hint.hidden = !q
        }
    }
    filterInput.addEventListener('input', filter)
    filter()
}

// 主页目录正在查看哪本书（书架「目录」按钮与选书列表设置；书打开时优先书内实时数据）
let homeTocBookId = null
// 异步目录渲染竞态防护：换书/切面板时旧请求的结果不再写入面板
let tocRenderToken = 0
let bookTocPanelState = null

function renderTocPanel (body) {
    const token = ++tocRenderToken
    bookTocPanelState = null
    body.replaceChildren() // 面板重渲染不清理会叠加重复的搜索框与目录
    if (reader.view?.book && reader.bookId && (homeTocBookId === null || homeTocBookId === reader.bookId))
        return renderBookTocPanel(body)
    renderHomeTocPanel(body, token)
}

// 书内目录：搜索框、过滤、当前章高亮、每章已读百分比与整体进度归零
function renderBookTocPanel (body) {
    renderSearchBox(body)
    const toc = reader?.toc || []
    if (!toc.length) {
        body.insertAdjacentHTML('beforeend', '<p class="hint">当前书籍没有目录信息。</p>')
        return
    }
    const stats = reader.readStats || { readMap: {}, sizes: [] }
    const currentSection = reader.lastProgress?.section
    const isPdf = reader.bookFormat === 'pdf'
    const model = directoryModel(reader.view.book)
    const currentKey = currentDirectoryKey(model, { section: currentSection,
        href: reader.view.lastLocation?.tocItem?.href, label: reader.lastProgress?.tocLabel })
    const flat = model.entries.map(t => {
        const cov = t.statistics ? coverageOf(stats.readMap?.[t.index]) : null
        return { ...t, cov, read: cov >= 0.99 ? 'read' : cov > 0 ? 'part' : 'none' }
    })
    const total = flat.length
    const hintAll = `共 ${total} 条，点击标题定位；右侧百分比按正文段统计，同段小节不重复统计`
    body.insertAdjacentHTML('beforeend', `
        <section id="toc-nav">
            <div class="row">
                <input id="toc-filter" type="search" placeholder="过滤目录（标题或页码）" aria-label="过滤目录">
                ${isPdf ? `<input id="toc-jump-input" type="number" min="1" max="${reader.sourcePageCount || total}" placeholder="页码" aria-label="跳到原书页"><button data-action="toc-jump" class="primary">跳页</button>` : ''}
            </div>
            <div class="row toc-reset-row">
                <p class="hint" id="toc-filter-hint">${hintAll}</p>
                <button data-action="reset-progress" data-id="${escapeHtml(reader.bookId || '')}" title="清空全部已读记录与阅读位置，从书的开头重新开始；笔记与划线保留">整体进度归零</button>
            </div>
            <ul class="toc-list" id="toc-list">
                ${flat.map((t, i) => `
                <li class="${t.key === currentKey ? 'current' : ''}" data-label="${escapeHtml(t.label)}" data-parent="${t.parent}" data-plain="${i}">
                    <button data-action="toc-go" data-href="${escapeHtml(t.href || '')}" ${t.key === currentKey ? 'aria-current="location"' : ''} data-reader-static-control style="padding-left:${6 + t.depth * 14}px"><i class="toc-dot ${t.read}" aria-hidden="true"></i>${escapeHtml(t.label)}</button>
                    <span class="toc-pct" title="${t.statistics ? '所属正文段已读进度' : '小节点击标题定位'}">${t.cov == null ? '—' : chapterPctOf(t.cov)}</span>
                </li>`).join('')}
            </ul>
        </section>`)
    bindTocFilter(body, total, { all: hintAll })
    bookTocPanelState = { body, book: reader.view.book, model, rows:
        [...body.querySelectorAll('#toc-list > li')].map(li => ({
            li, go: li.querySelector('[data-action="toc-go"]'),
            dot: li.querySelector('.toc-dot'), pct: li.querySelector('.toc-pct'),
        })) }
    // 跳页（PDF 书：原书页码 → 对应目录项）
    if (isPdf) {
        const jump = () => {
            const n = parseInt(body.querySelector('#toc-jump-input').value, 10)
            const pages = reader.sourcePageCount || flat.length
            if (!Number.isInteger(n) || n < 1 || n > pages) { toast(`请输入 1–${pages} 之间的页码`); return }
            const index = reader.pdfSectionForPage(n)
            if (index < 0) { toast('这一原书页暂时无法定位'); return }
            tempJump(() => reader.goTo(index)); closePanel()
        }
        body.querySelector('#toc-jump-input').addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.stopPropagation(); jump() }
        })
        body.querySelector('[data-action="toc-jump"]').addEventListener('click', jump)
    }
    // 当前章滚动定位到可视中部
    const cur = body.querySelector('#toc-list li.current')
    if (cur) cur.scrollIntoView({ block: 'center' })
}

function refreshBookTocPanel () {
    const state = bookTocPanelState
    if (activePanel !== 'toc' || !state?.body.isConnected ||
        state.book !== reader.view?.book || !state.body.querySelector('#toc-list')) return
    const stats = reader.readStats || { readMap: {} }
    const currentKey = currentDirectoryKey(state.model, {
        section: reader.lastProgress?.section, href: reader.view.lastLocation?.tocItem?.href,
        label: reader.lastProgress?.tocLabel,
    })
    state.model.entries.forEach((entry, key) => {
        const refs = state.rows[key], current = key === currentKey
        const cov = entry.statistics ? coverageOf(stats.readMap?.[entry.index]) : null
        refs.li.classList.toggle('current', current)
        if (current) refs.go.setAttribute('aria-current', 'location')
        else refs.go.removeAttribute('aria-current')
        const dot = `toc-dot ${cov >= .99 ? 'read' : cov > 0 ? 'part' : 'none'}`
        if (refs.dot.className !== dot) refs.dot.className = dot
        const pct = cov == null ? '—' : chapterPctOf(cov)
        if (refs.pct.textContent !== pct) refs.pct.textContent = pct
    })
}

let readingTocBook = null
let readingTocRows = []
let readingTocFrame = null
function scheduleReadingToc () {
    if (readingTocFrame != null) return
    readingTocFrame = requestAnimationFrame(() => {
        readingTocFrame = null
        if ($('#reading-toc-popover')?.matches(':popover-open')) renderReadingToc()
        refreshBookTocPanel()
    })
}

function renderReadingToc ({ scrollCurrent = false } = {}) {
    const pop = $('#reading-toc-popover'), book = reader?.view?.book
    if (!pop) return
    const model = directoryModel(book), flat = model.entries
    if (!book || !flat.length) {
        if (readingTocBook !== book || !pop.querySelector('.hint')) pop.innerHTML = '<p class="hint">这本书没有目录。</p>'
        readingTocBook = book
        readingTocRows = []
        return
    }
    if (readingTocBook !== book) {
        readingTocBook = book
        tocHover?.reset()
        const shared = [...model.groups.values()].some(group => group.length > 1)
        pop.innerHTML = `
            <p class="reading-toc-head"></p><p class="reading-toc-now"></p>
            <input id="reading-toc-filter" type="search" placeholder="过滤章节" aria-label="过滤目录">
            <button type="button" class="reading-toc-reset" data-reader-static-control data-action="reset-progress" data-id="${escapeHtml(reader.bookId || '')}">清空这本书的阅读进度</button>
            ${shared ? '<p class="toc-scope-hint">页数与百分比按正文段统计；同段小节点击标题定位。</p>' : ''}
            <p class="hint" id="reading-toc-filter-hint" hidden></p>
            <ul class="toc-list" id="reading-toc-list">
            ${flat.map((t, i) => `<li data-label="${escapeHtml(t.label)}" data-parent="${t.parent}" data-plain="${i}" data-section="${t.index}">
                <div class="toc-row" style="--toc-indent:${Math.min(6, t.depth)}">
                    <button type="button" data-action="toc-go" data-href="${escapeHtml(t.href)}" data-reader-static-control title="${escapeHtml(t.label)}"><i class="toc-dot none" aria-hidden="true"></i><span class="toc-label">${escapeHtml(t.label)}</span></button>
                    <span class="toc-pct" title="${t.statistics ? '所属正文段已读进度' : '小节点击标题定位'}">—</span>
                    ${t.statistics ? `<button type="button" class="toc-expand toc-page-chip" data-reader-static-control data-action="toc-toggle-pages" aria-expanded="false" hidden><span class="toc-chip-label"></span><span class="toc-chip-chevron" aria-hidden="true">⌄</span></button>` : ''}
                </div>${t.statistics ? '<div class="toc-pages" hidden></div>' : ''}</li>`).join('')}
            </ul>`
        readingTocRows = [...pop.querySelectorAll('#reading-toc-list > li')].map(li => ({
            li, dot: li.querySelector('.toc-dot'), pct: li.querySelector('.toc-pct'),
            go: li.querySelector('[data-action="toc-go"]'), chip: li.querySelector('.toc-page-chip'),
            chipLabel: li.querySelector('.toc-chip-label'), box: li.querySelector('.toc-pages'), stamp: '', pageStamp: '',
        }))
        bindTocFilter(pop, flat.length, { all: `共 ${flat.length} 项` }, TOC_FILTER_POPOVER)
    }
    const stats = reader.readStats || { readMap: {}, sizes: [] }
    const currentSection = reader.lastProgress?.section
    const currentKey = currentDirectoryKey(model, { section: currentSection,
        href: reader.view.lastLocation?.tocItem?.href, label: reader.lastProgress?.tocLabel })
    const pct = Math.round((stats.percent || 0) * 100)
    const count = reader.bookFormat === 'pdf' && reader.sourcePageCount
        ? `共 ${reader.sourcePageCount} 原书页 · ${flat.length} 项` : `共 ${flat.length} 项`
    const head = `总目录 · ${count} · 已读 ${pct}%`
    const here = reader.lastProgress?.tocLabel || ''
    const now = `读到${here ? `「${here}」` : '这里'} · 已读 ${pct}%`
    const text = (el, value) => { if (el.textContent !== value) el.textContent = value }
    text(pop.querySelector('.reading-toc-head'), head)
    text(pop.querySelector('.reading-toc-now'), now)
    const pageMatch = (reader.lastProgress?.pageLabel || '').match(/(\d+)\s*\/\s*(\d+)/)
    const sectionInfo = new Map()
    for (const [index] of model.groups) sectionInfo.set(index, {
        ...chapterPageInfo(index, stats), cov: coverageOf(stats.readMap?.[index]),
    })
    flat.forEach((t, i) => {
        const refs = readingTocRows[i], { li, chip, box } = refs
        const info = t.statistics ? sectionInfo.get(t.index) : null
        const current = t.key === currentKey
        const pages = info?.pages || 0, cov = info?.cov
        const label = info && pages > 1 ? (t.index === currentSection && pageMatch
            ? `${pageMatch[1]} / ${pages} 页` : `${info.estimated ? '约 ' : ''}${pages} 页`) : ''
        const stamp = `${current}|${cov}|${label}|${pages}|${info?.estimated}`
        if (refs.stamp !== stamp) {
            refs.stamp = stamp
            li.classList.toggle('current', current)
            if (current) refs.go.setAttribute('aria-current', 'location')
            else refs.go.removeAttribute('aria-current')
            refs.dot.className = `toc-dot ${cov >= .99 ? 'read' : cov > 0 ? 'part' : 'none'}`
            text(refs.pct, cov == null ? '—' : chapterPctOf(cov))
            if (chip) {
                chip.hidden = !label
                text(refs.chipLabel, label)
                chip.setAttribute('aria-label', `${t.label}：${label}，展开页码`)
                li.dataset.pages = pages
                li.dataset.pagesEst = info.estimated ? '1' : '0'
            }
        }
        if (box && li.classList.contains('toc-expanded')) {
            const pageStamp = `${pages}|${info.estimated}|${JSON.stringify(stats.readMap?.[t.index] || [])}`
            if (refs.pageStamp !== pageStamp) {
                refs.pageStamp = pageStamp
                const html = tocPagesHTML(t.index, pages, info.estimated, Number(li.dataset.pageStart) || 1)
                // Stable buttons keep pointerdown/click and keyboard focus intact during dwell updates.
                if (box.dataset.pagesKey === `${pages}|${info.estimated}`) {
                    const coverage = tocPageCoverage(stats.readMap?.[t.index], pages)
                    for (const btn of box.querySelectorAll('.toc-page')) {
                        const p = Number(btn.dataset.page), ratio = coverage[p - 1] || 0, percent = Math.round(ratio * 100)
                        btn.className = `toc-page ${tocPageState(ratio)}`
                        btn.title = `第 ${p} 页 · 已读 ${percent}%`
                        btn.setAttribute('aria-label', `跳到第 ${p} 页，已读 ${percent}%`)
                    }
                    const oldHint = box.querySelector('.toc-pages-hint')
                    if (oldHint) {
                        const tpl = document.createElement('template'); tpl.innerHTML = html
                        oldHint.replaceChildren(...tpl.content.querySelector('.toc-pages-hint').childNodes)
                    }
                } else if (!box.contains(document.activeElement)) {
                    box.innerHTML = html
                    box.dataset.pagesKey = `${pages}|${info.estimated}`
                } else refs.pageStamp = ''
            }
        }
    })
    if (scrollCurrent) readingTocRows[currentKey]?.li.scrollIntoView({ block: 'center' })
}
async function resetBookProgress (id) {
    const rec = await db.getBook(id)
    if (!rec) return false
    if (!confirm(`把《${rec.title}》的整体阅读进度归零？\n已读记录与阅读位置会全部清空（下次从头开始），笔记、划线与书签保留。`)) return false
    let returnedToStart = true
    if (reader.bookId === id && reader.view?.book) {
        hideBackToReading()
        readingAnchor = null
        returnedToStart = await reader.resetProgress()
        await reader.flushProgress()
    } else {
        try { localStorage.removeItem('immersive-reader-position:' + id) } catch { /* DB 仍会更新 */ }
        await db.touchBook(id, {
            cfi: null, fraction: 0, percent: 0, readMap: {},
            section: Number.isInteger(rec.progress?.section) ? rec.progress.section : 0,
            tocLabel: '', location: null, pageItemLabel: '', pageLabel: '',
        })
    }
    await refreshRecent()
    renderPanelRecent()
    if (activePanel) renderPanel()
    toast(returnedToStart ? `已把《${rec.title}》的阅读进度归零`
        : '已清空已读记录，但未能回到开头；请重新打开这本书。')
    return !!returnedToStart
}

function positionReadingToc () {
    const btn = $('#reading-toc')?.getBoundingClientRect()
    const pop = $('#reading-toc-popover')
    if (!btn || !pop) return
    const gap = 10
    const width = Math.min(360, innerWidth - 16)
    let left = Math.min(btn.right, innerWidth - 8) - width
    left = Math.max(8, left)
    const top = Math.round(btn.bottom + gap)
    let limit = innerHeight - 12
    const dock = document.querySelector('#reading-dock')?.getBoundingClientRect()
    if (dock && dock.height > 8 && dock.top > top) limit = Math.min(limit, dock.top - 8)
    const player = document.querySelector('#mini-player')?.getBoundingClientRect()
    if (player && player.height > 8 && player.top > top && left < player.right && left + width > player.left) {
        limit = Math.min(limit, player.top - 8)
    }
    const set = (name, value) => pop.style.setProperty(name, value, 'important')
    set('position', 'fixed')
    set('inset', 'auto')
    set('margin', '0')
    set('height', 'auto')
    set('width', `${width}px`)
    set('left', `${Math.round(left)}px`)
    set('top', `${top}px`)
    set('max-height', `${Math.max(160, Math.round(limit - top))}px`)
}
let tocMotion = null
let tocOpen = false
let tocHover = null
function animateReadingToc (pop, expanding, done) {
    const start = getComputedStyle(pop)
    const opacity = start.opacity, translate = start.translate
    tocMotion?.cancel()
    tocMotion = null
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { done?.(); return }
    const motion = pop.animate([
        { opacity: expanding && !pop.dataset.tocVisible ? 0 : opacity, translate: expanding && !pop.dataset.tocVisible ? '0 -4px' : translate },
        { opacity: expanding ? 1 : 0, translate: expanding ? '0 0' : '0 -4px' },
    ], { duration: 180, easing: 'cubic-bezier(.22,.72,.28,1)' })
    tocMotion = motion
    motion.finished.then(() => {
        if (tocMotion !== motion) return
        tocMotion = null
        done?.()
    }, () => {})
}
function closeReadingToc ({ immediate = false } = {}) {
    const pop = $('#reading-toc-popover')
    $('#reading-toc')?.setAttribute('aria-expanded', 'false')
    if (!pop) return
    if (immediate) {
        tocOpen = false
        tocMotion?.cancel()
        tocMotion = null
        if (pop.matches(':popover-open')) pop.hidePopover()
        delete pop.dataset.tocVisible
        tocHover?.reset()
        return
    }
    if (!tocOpen) return
    tocOpen = false
    tocHover?.reset()
    // popover 的隐藏是 display 级的，必须先播完退场再真正收起
    animateReadingToc(pop, false, () => {
        if (!tocOpen && pop.matches(':popover-open')) pop.hidePopover()
        delete pop.dataset.tocVisible
    })
}
function openReadingToc () {
    const pop = $('#reading-toc-popover')
    const btn = $('#reading-toc')
    if (!pop || !btn || tocOpen || !reader.view?.book) return
    const visible = pop.matches(':popover-open')
    $('#reading-speed-details').open = false
    const speedPop = $('#reading-speed-popover')
    if (speedPop.matches(':popover-open')) speedPop.hidePopover()
    tocOpen = true
    if (!visible) { renderReadingToc(); pop.showPopover() }
    btn.setAttribute('aria-expanded', 'true')
    positionReadingToc()
    if (!visible) requestAnimationFrame(() => {
        if (tocOpen && pop.matches(':popover-open')) {
            const current = readingTocRows.find(refs => refs.li.classList.contains('current'))?.li
            if (current) pop.scrollTop = Math.max(0, current.offsetTop - pop.clientHeight / 2 + current.offsetHeight / 2)
        }
    })
    animateReadingToc(pop, true)
    pop.dataset.tocVisible = 'true'
}
function toggleReadingToc () {
    if (tocHover?.activateTrigger?.()) return
    tocHover?.reset()
    if (tocOpen) closeReadingToc()
    else openReadingToc()
}
// 浮层用 popover="manual"：auto 的 light dismiss 会抢在点击处理之前把浮层收掉，
// 「目录」按钮第二次点击因此变成"关掉又立刻重开"，看起来像没反应。
// 收与放改由这里统一负责，退场动画也才播得完整。
function installReadingTocDismiss () {
    const pop = $('#reading-toc-popover')
    if (!pop) return
    pop.addEventListener('toggle', e => { if (e.newState === 'closed') tocOpen = false })
    document.addEventListener('pointerdown', e => {
        if (!tocOpen) return
        if (pop.contains(e.target) || e.target.closest('#reading-toc')) return
        closeReadingToc()
    }, true)
    // 书页在 iframe 内，上面的外侧 capture 收不到；由 Reader 报上来：
    // 目录开着时落在书页上的这次点击只负责收起浮层，不再顺带翻页。
    reader.pageTurnGuard = () => tocOpen
    reader.addEventListener('pagepointerdown', () => { if (tocOpen) closeReadingToc() })
}

// 主页目录（书未打开）：选书列表 → 某本书的目录（每章进度 / 过滤 / 归零 / 点击章节开卷跳转）
async function renderHomeTocPanel (body, token) {
    if (!homeTocBookId) return renderHomeTocPicker(body, token)
    const book = await db.getBook(homeTocBookId)
    if (token !== tocRenderToken || activePanel !== 'toc') return
    if (!book) { homeTocBookId = null; return renderHomeTocPicker(body, token) }
    const flat = savedDirectoryModel(book.tocFlat).entries
    if (!flat?.length) {
        $('#panel-title').textContent = '目录'
        body.insertAdjacentHTML('beforeend', `
            <section id="toc-nav">
                <p class="hint">${book.tocCacheOmitted ? `《${escapeHtml(book.title)}》目录过长，打开书后可查看完整目录。` : `《${escapeHtml(book.title)}》的目录还没有生成：打开一次这本书，之后不必开卷也能在这里查看目录与每章进度。`}</p>
                <div class="row">
                    <button data-action="open-book-id" data-id="${escapeHtml(book.id)}" class="primary">打开这本书</button>
                    <button data-action="home-toc-back">返回选择</button>
                </div>
            </section>`)
        return
    }
    const stored = storedProgressOf(book.id, book.progress)
    const readMap = stored?.readMap ?? book.progress?.readMap ?? {}
    const percent = stored?.percent ?? book.progress?.percent ?? 0
    $('#panel-title').textContent = `《${book.title}》目录`
    const total = flat.length
    const hintAll = `全书已读 ${chapterPctOf(percent)} · 共 ${total} 条 · 点击章节打开书并跳转`
    body.insertAdjacentHTML('beforeend', `
        <section id="toc-nav">
            <div class="row">
                <button data-action="home-toc-back" title="回到书的列表">← 换书</button>
                <input id="toc-filter" type="search" placeholder="过滤目录（标题或页码）" aria-label="过滤目录">
            </div>
            <div class="row toc-reset-row">
                <p class="hint" id="toc-filter-hint">${hintAll}</p>
                <button data-action="reset-progress" data-id="${escapeHtml(book.id)}" title="清空全部已读记录与阅读位置，从书的开头重新开始；笔记与划线保留">整体进度归零</button>
            </div>
            <ul class="toc-list" id="toc-list">
                ${flat.map((t, i) => {
                    const cov = t.statistics ? coverageOf(readMap?.[t.index]) : null
                    return `
                <li data-label="${escapeHtml(t.label)}" data-parent="${t.parent}" data-plain="${i}">
                    <button data-action="home-toc-go" data-id="${escapeHtml(book.id)}" data-href="${escapeHtml(t.href || '')}" style="padding-left:${6 + (t.depth || 0) * 14}px">${escapeHtml(t.label || '(无标题)')}</button>
                    <span class="toc-pct">${cov == null ? '—' : chapterPctOf(cov)}</span>
                </li>` }).join('')}
            </ul>
        </section>`)
    bindTocFilter(body, total, { all: hintAll })
}

// 主页目录·选书列表：列出全部书与各自的整体进度
async function renderHomeTocPicker (body, token) {
    $('#panel-title').textContent = '目录'
    const books = await db.listBooks()
    if (token !== tocRenderToken || activePanel !== 'toc') return
    if (!books.length) {
        body.insertAdjacentHTML('beforeend', '<p class="hint">还没有书籍。先在书架导入 EPUB、TXT 或 PDF，打开一次后即可在这里查看目录。</p>')
        return
    }
    const rows = books.map(b => {
        const stored = storedProgressOf(b.id, b.progress)
        const pct = Math.round(Math.max(0, Math.min(1, stored?.percent ?? b.progress?.percent ?? 0)) * 100)
        const hasToc = Array.isArray(b.tocFlat) && b.tocFlat.length
        return `
        <li data-label="${escapeHtml(b.title)}">
            <button data-action="home-toc-pick" data-id="${escapeHtml(b.id)}">${escapeHtml(b.title)}${hasToc ? '' : ' <span class="toc-wait">（打开一次生成目录）</span>'}</button>
            <span class="toc-pct">${pct}%</span>
        </li>`}).join('')
    body.insertAdjacentHTML('beforeend', `
        <section id="toc-nav">
            <p class="hint">选择一本书查看目录与每章进度；书架中每本书也带「目录」按钮。</p>
            <ul class="toc-list" id="toc-list">${rows}</ul>
        </section>`)
}

// ----- 场景 -----
// 「更多环境声」的展开状态记在模块级：选声音触发 renderPanel() 重建后不塌缩
let envAmbienceMoreOpen = false
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
                    : isVideo(scene.userBgs.find(b => b.id === refId)?.data) ? '<span class="video-thumb">▷ VIDEO</span>' : `<img src="${url}" alt="">`}<span class="n">${escapeHtml(scene.refName(refId))}${isBuiltin && !['builtin:fluid', 'builtin:fp-valley'].includes(refId) ? '（示意）' : ''}</span>
            </button>${del}
        </div>`
    }).join('')

    body.innerHTML = `
        <section>
            <h3>阅读环境</h3>
            <div class="env-presets" role="group" aria-label="阅读预设">
                ${READING_PRESETS.map(p => `<button type="button" data-action="reading-preset" data-key="${p.key}" class="env-chip${settings.misc.readingPreset === p.key ? ' on' : ''}" title="${p.hint}">${p.label}</button>`).join('')}
                ${(presetSnapshot || settings.misc.readingPreset === 'custom') ? `<button type="button" data-action="reading-preset" data-key="custom" class="env-chip${settings.misc.readingPreset === 'custom' ? ' on' : ''}" title="恢复预设之前的自定义设置">恢复自定义</button>` : ''}
            </div>
            <p class="hint">${escapeHtml(READING_PRESETS.find(p => p.key === settings.misc.readingPreset)?.hint || '当前为自定义环境设置。')}</p>
            <div class="env-presets" role="group" aria-label="组合环境预设">
                ${ENV_PRESETS.map(p => `<button type="button" data-action="env-preset" data-key="${p.key}" class="env-chip sub">${p.label}</button>`).join('')}
            </div>
            <div class="row env-quick">
                <span class="preset-cap">天气</span>
                ${[['rain','雨'],['snow','雪'],['clear','晴']].map(([w,l]) => `<button type="button" data-action="env-weather" data-key="${w}" class="env-chip${settings.atmosphere.weather === w && settings.atmosphere.enabled ? ' on' : ''}">${l}</button>`).join('')}
                <span class="preset-cap" style="margin-left:8px">强度</span>
                <input id="env-intensity" type="range" min="0" max="1" step="0.01" value="${settings.atmosphere.weather === 'snow' ? settings.atmosphere.snow : settings.atmosphere.rain}" aria-label="天气强度">
                <label class="env-inline"><input type="checkbox" id="env-motion" ${settings.atmosphere.motion ? 'checked' : ''}> 动态</label>
            </div>
            <div class="row env-quick">
                <span class="preset-cap">声音</span>
                ${[['rain','雨声'],['snow','落雪'],['waves','海浪'],['wind','山风']].map(([k,l]) => `<button type="button" data-action="env-ambience" data-key="${k}" class="env-chip${settings.ambience.enabled && settings.ambience.kind === k ? ' on' : ''}">${l}</button>`).join('')}
                <button type="button" class="env-chip sub${envAmbienceMoreOpen ? ' on' : ''}" data-action="env-ambience-more" aria-expanded="${envAmbienceMoreOpen}" title="更多环境声、声量与雷声">更多</button>
                <button type="button" data-action="env-advanced" class="env-chip sub">高级环境设置</button>
            </div>
            <div class="env-ambience-more" role="group" aria-label="更多环境声" ${envAmbienceMoreOpen ? '' : 'hidden'}>
                ${[['stream','溪流'],['fire','篝火'],['crickets','虫鸣'],['white','白噪'],['pink','粉噪'],['brown','棕噪']].map(([k,l]) => `<button type="button" data-action="env-ambience" data-key="${k}" class="env-chip${settings.ambience.enabled && settings.ambience.kind === k ? ' on' : ''}">${l}</button>`).join('')}
                <label class="env-inline">声量 <input id="env-ambience-volume" type="range" min="0" max="1" step="0.01" value="${settings.ambience.volume}" aria-label="环境声声量"></label>
                <label class="env-inline"><input type="checkbox" id="env-ambience-thunder" ${settings.ambience.thunder ? 'checked' : ''}> 闪电配闷雷</label>
            </div>
        </section>
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
    // 环境快选：强度滑杆与动态开关
    const intensity = body.querySelector('#env-intensity')
    if (intensity) intensity.addEventListener('input', () => {
        const v = Number(intensity.value)
        if (settings.atmosphere.weather === 'snow') settings.atmosphere.snow = v
        else settings.atmosphere.rain = v
        if (ambience.running) ambience.setRainAmount(settings.atmosphere.enabled && settings.atmosphere.weather === 'rain' ? v : 0)
        persist(); scene.onSettingsChanged()
    })
    const motion = body.querySelector('#env-motion')
    if (motion) motion.addEventListener('change', () => {
        settings.atmosphere.motion = motion.checked
        persist(); scene.onSettingsChanged()
    })
    // 「更多环境声」：内联绑定（不走 onPanelClick）；展开状态记模块变量，重建面板后不塌缩
    const moreBtn = body.querySelector('[data-action="env-ambience-more"]')
    if (moreBtn) moreBtn.addEventListener('click', () => {
        envAmbienceMoreOpen = !envAmbienceMoreOpen
        renderPanel()
    })
    const ambVolume = body.querySelector('#env-ambience-volume')
    if (ambVolume) ambVolume.addEventListener('input', () => {
        const v = Number(ambVolume.value)
        settings.ambience.volume = v
        ambience.setVolume(ambiencePlayVolume())
        persist()
    })
    const ambThunder = body.querySelector('#env-ambience-thunder')
    if (ambThunder) ambThunder.addEventListener('change', () => {
        settings.ambience.thunder = ambThunder.checked
        persist()
    })
    updateReadStatus()
}

function updateReadStatus () {
    const el = $('#read-status')
    if (!el || !scene?.currentPlan) return
    const p = scene.currentPlan
    el.textContent = `${p.theme === 'dark-text' ? '深色文字' : '浅色文字'} · 自动保持清晰`
}

// ----- 速度预设（坞内与面板共用同一档位表）-----
function syncPresetButtons (scope = document) {
    const key = activePresetSpeed(settings.autoRead)
    const page = settings.autoRead.mode === 'page'
    scope.querySelectorAll('[data-action="auto-preset"]').forEach(b => {
        const p = AUTO_PRESETS.find(x => x.speed === Number(b.dataset.speed))
        b.classList.toggle('on', p.speed === key)
        b.title = page ? `${p.label}：每页停留 ${p.seconds} 秒` : `${p.label}：${p.speed} 像素/秒`
    })
}
// 预设点一次可能同时影响坞内滑块与面板滑块，两边一起刷新，避免读到旧值
function syncAutoSliders () {
    const a = settings.autoRead
    const panelSpeed = $('#auto-speed'), panelSeconds = $('#auto-seconds')
    if (panelSpeed) {
        panelSpeed.value = a.pixelsPerSecond
        $('#auto-speed-value').textContent = `${a.pixelsPerSecond} 像素/秒`
    }
    if (panelSeconds) {
        panelSeconds.value = a.pageSeconds
        $('#auto-seconds-value').textContent = `${a.pageSeconds} 秒`
    }
    syncReadingDock()
}
function applyAutoPreset (preset) {
    const a = settings.autoRead
    const found = AUTO_PRESETS.find(p => p.speed === Number(preset.dataset.speed))
    if (a.mode === 'page') a.pageSeconds = found.seconds
    else a.pixelsPerSecond = found.speed
    persist()
    syncAutoSliders()
    const unit = a.mode === 'page' ? `每页 ${a.pageSeconds} 秒` : `${a.pixelsPerSecond} 像素/秒`
    return `${found.label} · ${unit}`
}

// ----- 字体 -----
function renderFontPanel (body) {
    const l = settings.layout
    const a = settings.autoRead
    body.innerHTML = `
        <section><h3>阅读方式</h3>
            <div class="row"><label for="reading-flow">正文浏览</label><select id="reading-flow"><option value="paginated" ${a.flow==='paginated'?'selected':''}>左右翻页</option><option value="scrolled" ${a.flow==='scrolled'?'selected':''}>连续滚动（滚轮）</option></select></div>
            <p class="hint">两种方式都保存选择；分页模式下滚轮是翻页（带惯性保护），不会切换方式。</p>
        </section>
        <section><h3>自动阅读</h3>
            <div class="row"><label for="auto-mode">阅读方式</label><select id="auto-mode"><option value="scroll" ${a.mode==='scroll'?'selected':''}>连续下滑</option><option value="page" ${a.mode==='page'?'selected':''}>定时翻页</option></select></div>
            <div class="row preset-row" role="group" aria-label="速度预设">
                <span class="preset-cap">速度预设</span>
                ${AUTO_PRESETS.map(p => `<button data-action="auto-preset" data-speed="${p.speed}" class="preset${activePresetSpeed(a)===p.speed?' on':''}">${p.label}</button>`).join('')}
            </div>
            <div class="row"><label for="auto-speed">细调速度</label><input id="auto-speed" type="range" min="5" max="80" step="1" value="${a.pixelsPerSecond}"><span id="auto-speed-value" class="value">${a.pixelsPerSecond} 像素/秒</span></div>
            <div class="row"><label for="auto-seconds">每页停留</label><input id="auto-seconds" type="range" min="5" max="120" step="1" value="${a.pageSeconds}"><span id="auto-seconds-value" class="value">${a.pageSeconds} 秒</span></div>
            <div class="row"><label for="auto-dwell">章末停留</label><input id="auto-dwell" type="range" min="3" max="15" step="1" value="${a.endDwellSeconds}"><span id="auto-dwell-value" class="value">${a.endDwellSeconds} 秒</span></div>
            <button data-action="auto-start" class="primary">${autoReading?.running?'暂停自动阅读':'开始自动阅读'}</button>
            <p class="hint">「连续下滑」下预设给 10/20/40 像素/秒；「定时翻页」下预设给每页停留 70/50/30 秒（越快停留越短）。细调滑块可精确定制。滚动到章末后停留「章末停留」设置的秒数再换章，末尾留有约五行缓冲。换书、手动操作或离开页面会暂停；刷新后不会自动开始。</p>
        </section>
        <section>
            <h3>排版密度</h3>
            <div class="row" role="group" aria-label="排版密度">
                <button data-action="layout-density" data-density="comfortable" aria-pressed="${l.fontSize===21 && l.lineHeight===1.9}">舒适</button>
                <button data-action="layout-density" data-density="compact" aria-pressed="${l.fontSize===17 && l.lineHeight===1.6}">紧凑 · 更多文字</button>
            </div>
            <p class="hint">紧凑使用 17px 字号、1.6 倍行距；下方还可以继续微调。设置自动保存。${reader?.bookSpread ? '双页以中间书缝为界，左页、右页各一栏；改字号或行距后仍按这条书缝重新分页。' : ''}</p>
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
            <h3>${reader?.bookSpread ? '单页宽度' : '正文宽度'}</h3>
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
    syncPresetButtons(body)
}

// ---------- 工具栏自动淡出 ----------
function showToolbar () {
    for (const element of [$('#toolbar'), $('#reader-chrome')]) {
        if (element.classList.contains('faded')) element.classList.remove('faded')
    }
    if (musicUI?.mini?.classList.contains('faded')) musicUI.setFaded(false)
    showToolbar.idleAt = Date.now() + 3500
    if (toolbarTimer) return
    const fadeWhenIdle = () => {
        const remaining = showToolbar.idleAt - Date.now()
        if (remaining > 0) { toolbarTimer = setTimeout(fadeWhenIdle, remaining); return }
        toolbarTimer = null
        if (!activePanel && !$('#reading-speed-details').open && !$('#reading-toc-popover')?.matches(':popover-open') && !$('#reading-dock').matches(':focus-within') && !settings.misc.keepToolbarWhenIdle && !$('#panel').matches(':focus-within') &&
            !$('#toolbar').matches(':focus-within') && !hoveringReadingControls()) {
            $('#toolbar').classList.add('faded')
            $('#reader-chrome').classList.add('faded')
            musicUI?.setFaded(true)
        }
    }
    toolbarTimer = setTimeout(fadeWhenIdle, 3500)
}

function toggleControls() {
    const hidden=document.body.classList.toggle('controls-hidden')
    if(hidden){
        closePanel(); closeReadingToc(); $('#toolbar').hidden=true;$('#top-settings').setAttribute('aria-expanded','false')
        $('#atmosphere-panel').hidden=true
        if(document.activeElement instanceof HTMLElement)document.activeElement.blur()
    } else showToolbar()
}

// 下滑速度旁的换算展示：按当前速度滚过一屏要多久，让「像素/秒」有体感；
// 定时翻页模式下 label 本身就是「每页停留」，这行隐藏避免重复。
function syncSpeedDwell () {
    const el = $('#reading-speed-dwell')
    if (!el) return
    if (settings.autoRead.mode === 'page') { el.hidden = true; return }
    const rect = currentSurface().getBoundingClientRect()
    const h = rect.height > 80 ? rect.height : window.innerHeight
    const seconds = Math.max(1, Math.round(h / Math.max(1, Number(settings.autoRead.pixelsPerSecond) || 20)))
    el.textContent = `每屏约 ${seconds} 秒`
    el.hidden = false
}
window.addEventListener('resize', syncSpeedDwell)

function syncReadingDock() {
    document.body.classList.toggle('scroll-reading',settings.autoRead.flow==='scrolled')
    // 滚动渐隐可关闭（专注预设）
    document.body.classList.toggle('no-scroll-fade', settings.misc.scrollFade === false)
    const page=settings.autoRead.mode==='page', speed=$('#reading-speed')
    speed.max=page?'120':'80';speed.value=page?settings.autoRead.pageSeconds:settings.autoRead.pixelsPerSecond
    $('#reading-speed-label').textContent=page?'每页停留':'下滑速度'
    $('#reading-speed-value').textContent=speed.value+(page?' 秒':' 像素/秒')
    syncSpeedDwell()
    // 预设高亮跟当前模式的实际档位
    syncPresetButtons()
    syncQuickDock()
}
// 坞内字号、字体、行距、阅读方式高亮。节点还没写进页面时跳过；不改设置、不提示。
function syncQuickDock () {
    const size = $('#quick-font-size')
    if (size) size.textContent = String(settings.layout.fontSize)
    const press = (button, on) => {
        button.classList.toggle('on', on)
        button.setAttribute('aria-pressed', on ? 'true' : 'false')
    }
    document.querySelectorAll('[data-action="quick-font"]').forEach(button => {
        press(button, button.dataset.font === settings.layout.fontFamily)
    })
    const lh = Number(settings.layout.lineHeight)
    const leading = Math.abs(lh - 1.6) < 0.05 ? 'tight'
        : Math.abs(lh - 1.9) < 0.05 ? 'comfort'
        : Math.abs(lh - 2.4) < 0.05 ? 'loose' : ''
    document.querySelectorAll('[data-action="quick-leading"]').forEach(button => {
        press(button, !!leading && button.dataset.leading === leading)
    })
    document.querySelectorAll('[data-action="quick-flow"]').forEach(button => {
        press(button, button.dataset.flow === settings.autoRead.flow)
    })
}
function applyReadingFocus() {
    // 专注位已退休（F3-12）：唯一写入者 #reading-focus-toggle 被 CSS 永久 display:none，
    // 界面里没有退出入口，而这个位又会改书页几何、还随备份跨版本带回来。
    // 现在 normalizeSettings 一律把它压回 false（存量 true 首次读取即清理），
    // 这里只据此清掉可能残留在 DOM 上的 class；原来往隐藏元素写 textContent/aria-pressed 的死代码删掉。
    document.body.classList.toggle('reading-focus', !!settings.misc.hideReadingTools)
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
        // 豁免表与下面 window 上的全局快捷键处理取同一套元素：button / summary / a[href] 必须留给原生激活。
        // 少了它们，任何聚焦的 <button> 都无法用空格按下；「字号与速度」浮层被 Esc 收起后
        // js/ui-layout.js 刻意把焦点交还 summary，此时按空格反而把全部控件藏掉（F3-6）。
        if(e.ctrlKey||e.metaKey||e.altKey||e.isComposing||e.target?.closest?.('input,textarea,select,button,summary,a[href],[contenteditable]:not([contenteditable="false"])'))return
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
    // Esc 分层收起：先浮层、再抽屉。下面 window 上的全局快捷键处理早就有输入守卫，
    // 这里原来一个都没有：在笔记心得 textarea、书内搜索、目录过滤、书架搜索、跳页输入、
    // 背景改名里按 Esc（用户以为只是"取消这次输入"）会把整个抽屉关掉；关完又把焦点交给还被
    // visibility:hidden 盖住的 #top-settings，focus() 失败后焦点掉回 body，
    // 后续按键继续落入全局快捷键（F3-1）。
    document.addEventListener('keydown', e => {
        if (e.key !== 'Escape') return
        if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return
        // 键盘收起路径：外侧收起只挂在 pointerdown 上，键盘用户按 Enter 激活不产生 pointerdown；
        // 焦点还在浮层里时 Esc 只收浮层，抽屉保持打开（F3-7）。
        if (e.target?.closest?.('#reading-toc-popover')) {
            e.stopPropagation()
            closeReadingToc()
            $('#reading-toc')?.focus()
            return
        }
        // 输入控件里的 Esc 属于"取消这次输入"，不动抽屉
        if (e.target?.matches?.('input, select, textarea') || e.target?.isContentEditable) return
        if (!activePanel && !tocOpen) return
        closeReadingToc()
        closePanel()
        // 抽屉退场动画期间 #top-actions 还被 visibility:hidden 盖着，立刻 focus() 按不到；
        // 等动画结束再交还焦点，中途重新打开抽屉则 cancel 掉、不抢焦点。
        const handBack = () => $('#top-settings')?.focus?.()
        if (panelMotion?.finished) panelMotion.finished.then(handBack, () => {})
        else handBack()
    })
    $('#toolbar').addEventListener('click', e => {
        const more = e.target.closest('#nav-more')
        if (more) { toggleNavSecondary(); return }
        const btn=e.target.closest('button[data-cmd]')
        if(!btn)return
        if(btn.dataset.cmd==='fullscreen'){toggleFullscreen();return}
        // 次级面板打开时保持次级行展开，方便看到当前位置
        if (['scene','rain','music','log'].includes(btn.dataset.cmd)) setNavSecondary(true)
        // 目录随当前上下文：书开着看书内实时目录，主页则回到书的列表
        if (btn.dataset.cmd === 'toc')
            homeTocBookId = reader.view?.book && reader.bookId ? reader.bookId : null
        openPanel(btn.dataset.cmd)
    })

    // 阅读坞：字号与速度（dock 在面板外，单独委托）
    $('#reading-dock').addEventListener('click', async e => {
        const preset = e.target.closest('[data-action="auto-preset"]')
        if (preset) {
            const label = applyAutoPreset(preset)
            toast(autoReading?.running ? `速度已调整为${label}` : `速度预设：${label}`)
            return
        }
        if (e.target.closest('[data-action="auto-settings"]')) { openPanel('auto'); return }
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const action = btn.dataset.action
        if (action === 'font-minus' || action === 'font-plus' || action === 'add-bookmark') {
            await onPanelClick(e)
            return
        }
        if (action === 'quick-font-panel') { openPanel('font'); return }
        // 浮层「常用」里的快捷入口：书架/音乐/阅读环境一步直达，不用猜右上角图标
        if (action === 'quick-shelf') { openPanel('open'); return }
        if (action === 'quick-music') { openPanel('music'); return }
        if (action === 'quick-scene') { openPanel('scene'); return }
        const refreshLayoutPanel = () => {
            if (activePanel === 'font' || activePanel === 'auto') renderPanel()
        }
        if (action === 'quick-font') {
            const font = btn.dataset.font
            const label = { song: '宋体', hei: '黑体', kai: '楷体' }[font]
            if (!label) return
            settings.layout.fontFamily = font
            persist()
            applyLayoutSettings()
            refreshLayoutPanel()
            toast(`字体：${label}`)
            return
        }
        if (action === 'quick-leading') {
            const leading = btn.dataset.leading
            const lineHeight = { tight: 1.6, comfort: 1.9, loose: 2.4 }[leading]
            const label = { tight: '紧凑', comfort: '舒适', loose: '宽松' }[leading]
            if (lineHeight == null) return
            settings.layout.lineHeight = lineHeight
            persist()
            applyLayoutSettings()
            refreshLayoutPanel()
            toast(`行距：${label}`)
            return
        }
        if (action !== 'quick-flow') return
        const flow = btn.dataset.flow
        if (flow !== 'paginated' && flow !== 'scrolled') return
        if (settings.autoRead.flow === flow) return
        autoReading.stop()
        if (!reader.view?.renderer) { toast('请先打开一本书'); return }
        btn.disabled = true
        try {
            await reader.setFlow(flow)
            reader.flow = flow
            settings.autoRead.flow = flow
            settings.autoRead.mode = flow === 'scrolled' ? 'scroll' : 'page'
            persist()
            syncReadingDock()
            refreshLayoutPanel()
            toast(flow === 'scrolled' ? '已切换为上下滚动，阅读位置保持不变' : '已切换为左右翻页，阅读位置保持不变')
        } catch (error) {
            toast('阅读方式切换失败：'+error.message)
        } finally {
            btn.disabled = false
        }
    })
    // 面板内的预设按钮走同一处理
    $('#panel').addEventListener('click', e => {
        const preset = e.target.closest('[data-action="auto-preset"]')
        if (preset) toast(`速度预设：${applyAutoPreset(preset)}`)
    })

    applyReadingFocus();syncReadingDock()
    // 原来的 #reading-focus-toggle onclick 已删除（F3-12）：入口被 CSS 永久隐藏，
    // 却仍会写 settings.misc.hideReadingTools 并改书页几何，界面里没有退出路径。
    $('#reading-toc')?.addEventListener('click', toggleReadingToc)
    $('#reading-speed-details').addEventListener('toggle', event => {
        if (event.target.open) closeReadingToc({ immediate: true })
    })
    installReadingTocDismiss()
    $('#reading-toc-popover')?.addEventListener('focusout', scheduleReadingToc)
    tocHover = installTocHover({
        trigger: $('#reading-toc'), surface: $('#reading-toc-popover'),
        open: openReadingToc, close: closeReadingToc,
        isOpen: () => $('#reading-toc-popover').matches(':popover-open'),
        openRow: openTocRow, closeRow: closeTocRow,
    })
    $('#reading-toc-popover')?.addEventListener('toggle', e => {
        if (e.newState === 'closed') $('#reading-toc')?.setAttribute('aria-expanded', 'false')
    })
    $('#reading-toc-popover')?.addEventListener('click', async e => {
        const reset = e.target.closest('[data-action="reset-progress"]')
        if (reset) {
            if (reset.disabled) return
            reset.disabled = true; reset.setAttribute('aria-busy', 'true')
            try { await resetBookProgress(reset.dataset.id); renderReadingToc() }
            finally { reset.disabled = false; reset.removeAttribute('aria-busy') }
            return
        }
        const pager = e.target.closest('[data-action="toc-pages-window"]')
        if (pager) {
            const li = pager.closest('li'), box = li.querySelector('.toc-pages')
            li.dataset.pageStart = pager.dataset.start
            box.innerHTML = tocPagesHTML(Number(li.dataset.section), Number(li.dataset.pages), false, Number(pager.dataset.start))
            box.scrollTop = 0
            box.querySelector('.toc-page')?.focus({ preventScroll: true })
            return
        }
        // 行尾小箭头：只展开/收起页明细，不碰跳转，也不收浮层
        const toggle = e.target.closest('[data-action="toc-toggle-pages"]')
        if (toggle) { toggleTocRow(toggle.closest('li')); return }
        // 页码芯片：跳到这一页
        const chip = e.target.closest('[data-action="toc-page-go"]')
        if (chip) {
            await goToChapterPage({
                section: Number(chip.dataset.section),
                page: Number(chip.dataset.page),
                pages: Number(chip.dataset.pages),
                href: chip.closest('li')?.querySelector('[data-action="toc-go"]')?.dataset.href,
            })
            return
        }
        const button = e.target.closest('[data-action="toc-go"]')
        if (!button?.dataset.href) return
        // 跳转后保留目录浮层：relocate 会重绘当前章高亮，方便连续翻章
        const row = button.closest('li')
        const pending = String(Number(row.dataset.pending || 0) + 1)
        row.dataset.pending = pending
        row.classList.add('toc-pending'); button.setAttribute('aria-busy', 'true')
        try { await tempJump(() => reader.goTo(button.dataset.href)) }
        finally { if (row.dataset.pending === pending) { row.classList.remove('toc-pending'); button.removeAttribute('aria-busy') } }
    })
    window.addEventListener('resize', () => {
        if ($('#reading-toc-popover')?.matches(':popover-open')) positionReadingToc()
    })
    $('#book-spread-toggle').onclick = async () => {
        autoReading.stop()
        try {
            await reader.setFlow('paginated')
            settings.autoRead.flow = 'paginated'
            settings.autoRead.mode = 'page'
            persist(); syncReadingDock()
            toast('已展开左右双页，阅读位置保持不变')
        } catch (error) { toast('双页未能展开：' + error.message) }
    }
    $('#reading-speed-details').ontoggle=syncReadingDock
    $('#reading-speed').oninput=e=>{
        const key=settings.autoRead.mode==='page'?'pageSeconds':'pixelsPerSecond'
        settings.autoRead[key]=Number(e.target.value);persist();syncReadingDock()
    }
    // 点击直达开始/暂停；右键或触屏长按才打开设置面板（设置由用户主动调）。
    const autoToggle = $('#auto-reading-toggle')
    autoToggle.title = '点击开始或暂停自动阅读；右键（或长按）打开设置'
    let longPressTimer = 0
    let longPressed = false
    autoToggle.addEventListener('click', () => {
        if (longPressed) { longPressed = false; return }
        if (autoReading.running || autoReading.starting) autoReading.stop()
        else { closePanel(); autoReading.start() }
    })
    autoToggle.addEventListener('contextmenu', e => { e.preventDefault(); openPanel('auto') })
    autoToggle.addEventListener('pointerdown', e => {
        if (e.pointerType === 'mouse') return
        longPressed = false
        clearTimeout(longPressTimer)
        longPressTimer = setTimeout(() => { longPressed = true; openPanel('auto') }, 500)
    })
    const cancelLongPress = () => clearTimeout(longPressTimer)
    autoToggle.addEventListener('pointerup', cancelLongPress)
    autoToggle.addEventListener('pointercancel', cancelLongPress)
    reader.addEventListener('textselection',e=>{
        pendingQuote=e.detail;$('#selection-tools').hidden=false
    })
    reader.addEventListener('bookopen',()=>{$('#selection-tools').hidden=true;pendingQuote=null})
    $('#cancel-quote').onclick=()=>{$('#selection-tools').hidden=true;pendingQuote=null}
    // 划线与写想法共用一条保存路径；写想法保存后直接展开心得输入框。
    const saveSelectionQuote=async({thenNote=false}={})=>{
        const selection=pendingQuote
        if(!selection)return
        $('#save-quote').disabled=true;$('#note-quote').disabled=true
        try {
            const record=await db.getBook(selection.bookId)
            const dup=record.notes?.some(n=>n.type==='quote'&&n.cfi===selection.cfi)
            let noteId=null
            // dup（已划线）与新建同样要指向当前书：否则面板停在别的书时，写想法找不到笔记、输入框不展开
            notesBookId = selection.bookId
            if(!dup){
                const note=makeQuoteNote(selection)
                noteId=note.id
                const notes=await db.updateBookNote(selection.bookId, note)
                if(reader.bookId===selection.bookId){reader.notes=notes;await reader.drawNotes()}
            } else if(thenNote){
                noteId=record.notes.find(n=>n.type==='quote'&&n.cfi===selection.cfi)?.id||null
            }
            $('#selection-tools').hidden=true;pendingQuote=null
            toast(dup?'这段文字已收藏':'已划线并保存到本书笔记')
            if(thenNote&&noteId){
                focusNoteId=noteId
                // 面板已在笔记页时 openPanel 会同名早退，直接重渲染以展开新笔记
                if (activePanel === 'notes') renderPanel()
                else openPanel('notes')
            }
            else if(activePanel==='notes')renderPanel()
        } catch(e){toast('笔记保存失败：'+e.message)}finally{$('#save-quote').disabled=false;$('#note-quote').disabled=false}
    }
    $('#save-quote').onclick=()=>saveSelectionQuote()
    $('#note-quote').onclick=()=>saveSelectionQuote({thenNote:true})
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
        const foldBody = details.closest('.shelf-fold')?.querySelector(':scope > .fold-body')
        if (!details.open) {
            details.classList.remove('fold-instant')
            if (foldBody) foldBody.hidden = false
            details.open = true
            // 强制同步重排，确保 0fr 起始态已布局，再过渡到 1fr（后台标签页 rAF 不可靠）
            void (foldBody || details).offsetWidth
            details.classList.add('fold-open')
        } else {
            details.classList.remove('fold-open')
            let done = false
            const finish = (ev) => {
                if (ev && ev.propertyName && ev.propertyName !== 'grid-template-rows') return
                if (done) return
                done = true
                details.removeEventListener('transitionend', finish)
                if (!details.classList.contains('fold-open')) {
                    details.open = false
                    if (foldBody) foldBody.hidden = true
                }
            }
            details.addEventListener('transitionend', finish)
            setTimeout(finish, 550)
        }
    }
    document.addEventListener('click', onFoldClick, true)
    // 全局按钮点击脉冲（虚化渐入）；悬停浮动在 glass-ui.css
    installButtonFx()
    // 展开的内容沿触点向外铺开；没有新表面的操作只保留按钮按压反馈。
    installLiquidMotion({ bindings: [
        { trigger: '#top-settings, #btn-welcome-background, #atmosphere-toggle, #mini-player [data-action="open-panel"], #reading-dock [data-action="auto-settings"]', surface: '#panel' },
        { trigger: '#reading-speed-details > summary', surface: '#reading-speed-popover' },
        { trigger: '#nav-more', surface: '#nav-secondary' },
        { trigger: '#welcome .books-fold > summary', surface: '#welcome .books-fold > .fold-body' },
        { trigger: '#toolbar button[data-cmd]:not([data-cmd="fullscreen"]):not([data-cmd="music"]):not([data-cmd="rain"])', surface: '#panel-body', replayWhenVisible: true, when: trigger => !trigger.classList.contains('active') },
        { trigger: '#toolbar button[data-cmd="music"]', surface: '#music-panel-body', replayWhenVisible: true, when: trigger => !trigger.classList.contains('active') },
        { trigger: '#toolbar button[data-cmd="rain"]', surface: '#atmosphere-panel', replayWhenVisible: true, when: trigger => !trigger.classList.contains('active') },
        { trigger: '.music-tabs [data-tab="local"]', surface: '.music-pane[data-pane="local"]' },
        { trigger: '.music-tabs [data-tab="netease"]', surface: '.music-pane[data-pane="netease"]' },
        { trigger: '.music-tabs [data-tab="qq"]', surface: '.music-pane[data-pane="qq"]' },
        { trigger: '[data-action="rename-track"]', surface: '.track-item.editing' },
        { trigger: '[data-action="rename-bg"]', surface: trigger => trigger.closest('.bg-thumb')?.querySelector('.bg-edit') },
        { trigger: '.note-fold', surface: trigger => trigger.closest('.note-card')?.querySelector('textarea'), when: trigger => trigger.getAttribute('aria-expanded') !== 'true' },
    ] })

    $('#reading-timer').addEventListener('click', e => {
        const btn = e.target.closest('[data-log]')
        if (!btn) return
        handleLogAction(btn.dataset.log)
    })
    // 左键点计时器本体（非按钮区）直接打开「阅读记录」：右键菜单位置太深没人发现
    $('#reading-timer').addEventListener('click', e => {
        if (e.target.closest('[data-log]')) return
        openPanel('log')
        requestAnimationFrame(() => {
            $('#log-goal-settings')?.scrollIntoView({ block: 'center' })
        })
    })
    $('#reading-timer').addEventListener('contextmenu', e => {
        e.preventDefault()
        openPanel('log')
        requestAnimationFrame(() => {
            $('#log-goal-settings')?.scrollIntoView({ block: 'center' })
            $('#log-goal-minutes')?.focus({ preventScroll: true })
        })
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
    $('#file-audio').addEventListener('change', e => {
        const files = [...e.target.files]
        e.target.value = ''
        importAudioFiles(files)
    })
    $('#file-backup').addEventListener('change', async e => {
        const inspection = ++backupInspection
        const file = e.target.files[0]
        e.target.value = ''
        if (!file) return
        toast('正在读取备份…', 60000)
        const check = await backup.inspectBackup(file, { onProgress: backupProgressToaster('正在读取备份…') })
        if (inspection !== backupInspection) return
        if (!check.ok) { toast(`备份读取失败：${check.error}`); return }
        // 先选择恢复方式，不再直接覆盖
        pendingBackup = { payload: check.payload, counts: check.counts, name: file.name }
        if (activePanel !== 'open') openPanel('open')
        else renderPanel()
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
        updateReadingAnchor(reader.lastProgress)
        const pct = Math.round((reader.readStats.percent || 0) * 100)
        // PDF 的目录项本身就是「第 N 页」，与页码信息重复，不再单独显示章节名
        const parts = []
        if (reader.bookFormat !== 'pdf' && d.tocItem?.label) parts.push(d.tocItem.label)
        const page = reader.lastProgress?.pageLabel
        if (page) parts.push(page)
        parts.push(`已读 ${pct}%`)
        $('#reading-progress').textContent = parts.join(' · ')
        if (activePanel === 'toc' || $('#reading-toc-popover')?.matches(':popover-open')) scheduleReadingToc()
    })
    // 书内链接跳转视为临时查阅
    reader.addEventListener('linkjump', () => {
        tempJump(() => Promise.resolve())
    })
    // 返回刚才阅读位置
    $('#back-reading').addEventListener('click', async () => {
        const anchor = readingAnchor
        hideBackToReading()
        if (anchor?.cfi) {
            try { await reader.goTo(anchor.cfi) } catch (e) { toast('返回失败：' + e.message) }
        }
    })
    reader.addEventListener('bookopen', hideBackToReading)
    reader.addEventListener('bookopen', clearBookSearchCache)
    reader.addEventListener('bookopen', () => paintTimer())
    $('#page-prev').addEventListener('click', () => reader.prev())
    $('#page-next').addEventListener('click', () => reader.next())

    window.addEventListener('pagehide', () => reader.flushProgress())

    // 场景事件
    startGlassContrast(() => scene.currentImage)
    // 场景平均亮度 → 雨窗联动（亮场景雨滴高光更亮、雾感更明显）
    // 只有动态源（VIDEO/CANVAS）的亮度会随时间变化，才需要按秒重采样；静态图片背景下每次采样
    // 都只能得到同一个常数，却要付出一张全视口 drawImage + getImageData + 约 2.3 万次 Math.pow。
    // 门控与 js/background.js 里两个 watcher 的 /VIDEO|CANVAS/ 判断同口径（F3-14）。
    const isDynamicScene = () => /VIDEO|CANVAS/.test(scene.currentImage?.tagName || '')
    const sampleSceneLuminance = () => {
        if (document.hidden || !scene.currentImage) return
        try {
            const sample = sampleRegion(scene.currentImage, { x: 0, y: 0, width: innerWidth, height: innerHeight }, innerWidth, innerHeight)
            if (!sample || !sample.n) return
            let sum = 0
            for (let i = 0; i < sample.n; i++) sum += relativeLuminance(sample.pixels.slice(i * 4, i * 4 + 3))
            scene.rain.setLuminance(sum / sample.n)
        } catch { /* 采样不可用时保持默认亮度 */ }
    }
    const sceneLumTimer = setInterval(() => { if (isDynamicScene()) sampleSceneLuminance() }, 2000)
    // 静态源：换背景之后算一次就够（图刚换上时可能还没解码完，补一次）
    scene.addEventListener('scenechange', () => {
        if (isDynamicScene()) return
        sampleSceneLuminance()
        setTimeout(sampleSceneLuminance, 400)
    })
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
        if (e.key === 'Escape') { autoReading.stop(); closeReadingToc(); closePanel(); return }
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
            if (e.key === 'ArrowRight' || e.key === 'PageDown') { reader.next() }
            else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { reader.prev() }
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
        pauseSession(settings.readingLog, Date.now()) // 退出/关闭页面：真暂停，不把关掉后的时间计进去
        persistLog(true)
    })
    // 应用切到后台或退出：自动暂停、停止计时（此前后台节流的 1s tick 会继续记账）。
    // 回到前台恢复刚才被我们暂停的计时；用户自己在左上角按的暂停不被越权恢复。
    let logPausedByHide = false
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            saveAudioPosition(true)
            // 后台不需要每秒重画：计时条已在结算里暂停，句柄先停掉（F3-3）
            stopLogTick()
            const log = settings.readingLog
            if (log.current?.running) {
                pauseSession(log, Date.now())
                logPausedByHide = true
            }
            persistLog(true)
        } else {
            const rec = recoverLog(settings.readingLog, Date.now())
            noteLogEvents(rec.events)
            if (logPausedByHide) {
                logPausedByHide = false
                resumeSession(settings.readingLog, Date.now())
            }
            persistLog(true)
            paintTimer()
            lastTickSig = ''
            startLogTick()
        }
    })
    window.addEventListener('resize', () => {
        syncTimerSpan()
        // 不再只在双页态通知 Reader：js/reader.js 的 compactBook 用 container.clientWidth<640 判档，
        // 只在 setLayout 时重算。窗口宽度跨过 640px 而没触发行距/字号变化时，
        // 字号缩放与书缝几何就再也不刷新了。只要有渲染器就把布局变化报上去（F3-15）。
        if (reader?.view?.renderer) {
            reader.beginViewportResize()
            clearTimeout(syncFirstPersonMode.resizeTimer)
            syncFirstPersonMode.resizeTimer = setTimeout(() => reader.setLayout({}), 160)
        }
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
            case 'log-save-goal': {
                const input = $('#log-goal-minutes')
                if (!setDailyGoal(settings.readingLog, input?.value)) { toast('目标请输入 0 到 1440 的整数分钟'); break }
                persistLog(true); paintTimer(true)
                toast(settings.readingLog.goalMinutes ? `每日目标已设为 ${settings.readingLog.goalMinutes} 分钟` : '每日目标已关闭')
                break
            }
            case 'log-clear-history': {
                if (!confirm('清空全部阅读时长、每日热力图和成就记录？书籍进度、笔记、划线及每日目标会保留。')) break
                clearReadingHistory(settings.readingLog)
                persistLog(true); paintTimer(true)
                toast('阅读时长记录已清空')
                break
            }
            case 'pick-book': $('#file-book').click(); break
            case 'return-home': {
                if (!reader.bookId) break
                target.disabled = true
                ++openRequest
                autoReading.stop()
                hideBackToReading()
                closePanel()
                await reader.close()
                const url = new URL(location.href)
                url.searchParams.delete('book')
                url.searchParams.delete('note')
                history.replaceState(history.state, '', url.pathname + url.search + url.hash)
                showWelcome()
                await refreshRecent()
                break
            }
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
                if (href) { await tempJump(() => reader.goTo(href)); closePanel() }
                break
            case 'book-toc': // 书架里某本书的「目录」按钮：不开书查看目录
            case 'home-toc-pick': // 主页目录·选书列表
                homeTocBookId = id
                if (activePanel === 'toc') renderPanel()
                else openPanel('toc')
                break
            case 'home-toc-back': // 主页目录：返回选书列表
                homeTocBookId = null
                renderPanel()
                break
            case 'home-toc-go': { // 主页目录：点击章节 → 开卷并跳到该章
                const rec = await db.getBook(id)
                if (!rec) break
                closePanel()
                await openBookRecord(rec, { cfi: href || null })
                break
            }
            case 'reset-progress': await resetBookProgress(id); break
            case 'book-search': {
                const input = $('#book-search-input')
                if (input) await runBookSearch(input.value)
                break
            }
            case 'book-search-clear': {
                clearBookSearchCache()
                try { reader.view?.clearSearch() } catch { /* 视图已关闭 */ }
                renderPanel()
                break
            }
            case 'search-go':
                if (target.dataset.cfi) await tempJump(() => reader.view?.goTo(target.dataset.cfi))
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
                const card = target.closest('.note-card')
                // 与自动保存共用一条路径（内部有防抖取消与竞态防护）
                const ok = await card?._saveComment?.()
                if (ok !== false) toast('笔记已保存')
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
                else await tempJump(() => reader.goTo(note.cfi))
                break
            }
            case 'delete-note': {
                const bookId = target.dataset.id
                const noteId = target.dataset.noteId
                const rec = await db.getBook(bookId)
                const note = rec?.notes?.find(n => n.id === noteId)
                if (!note) break
                clearDraft(bookId, noteId)
                const notes = await db.updateBookNote(bookId, note, true)
                if (reader.bookId === bookId) {
                    reader.notes = notes
                    if (note.type === 'quote') {
                        try { await reader.view.deleteAnnotation({ value: note.cfi }) } catch { /* 标注层可能未就绪 */ }
                    }
                }
                renderPanel()
                // 删除撤销：完整恢复原文锚点、摘录、心得与标注（镜像同步走同一条原子路径）
                toastWithUndo('已删除' + (note.type === 'quote' ? '划线' : '书签'), async () => {
                    try {
                        const fresh = await db.getBook(bookId)
                        if (!fresh) { toast('书籍已不存在，无法撤销'); return }
                        // 撤销即恢复：editedAt 提到当前，合并时作为较新版本
                        const restored = await db.updateBookNote(bookId, { ...note, editedAt: Date.now() })
                        if (reader.bookId === bookId) {
                            reader.notes = restored
                            await reader.drawNotes()
                        }
                        if (activePanel === 'notes') renderPanel()
                        toast('已恢复删除的' + (note.type === 'quote' ? '划线' : '书签'))
                    } catch (e) { toast('撤销失败：' + e.message) }
                })
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
                if (backupBusy) { toast('已有一次备份在进行中，请等它完成'); break }
                backupBusy = true
                try {
                    await reader.flushProgress()
                    toast('正在导出备份…', 60000)
                    const r = await backup.exportBackup({ onProgress: backupProgressToaster('正在导出备份…') })
                    await db.setMeta('lastBackupAt', Date.now())
                    toast(`备份已导出：${r.books} 本书、${r.backgrounds} 张背景、${r.audio} 首音乐、${r.qqTracks} 条 QQ 歌曲（${(r.bytes / 1048576).toFixed(1)}MB）`)
                    if (activePanel === 'open') renderOpenPanel($('#panel-body'))
                } finally { backupBusy = false }
                break
            }
            case 'pick-backup': $('#file-backup').click(); break
            case 'shelf-view': {
                const view = target.dataset.view === 'list' ? 'list' : 'shelf'
                if (settings.misc.shelfView === view) break
                const panelRecent = $('#panel-recent')
                const anchor = shelfScrollAnchor(panelRecent)
                settings.misc.shelfView = view
                persist()
                // 只换书本节点：切视图不该重播一遍错落入场
                document.querySelector('#panel .shelf-fold')?.classList.add('fold-instant')
                syncShelfViewToggle()
                await refreshRecent()
                const applied = await renderPanelRecent()
                if (applied && panelRecent?.isConnected) {
                    const snap = () => restoreShelfScroll(panelRecent, anchor)
                    snap()
                    requestAnimationFrame(snap)
                    // 点到的按钮在内容变高后可能被再次滚进画面，稍后再对齐一次。
                    setTimeout(snap, 60)
                }
                toast(view === 'list' ? '已切换为紧凑列表（偏好已保存）' : '已切换为 3D 书架（偏好已保存）')
                break
            }
            case 'reading-preset': {
                const key = target.dataset.key
                if (key === 'custom') {
                    if (restorePresetSnapshot(settings, presetSnapshot)) {
                        presetSnapshot = null
                        settings.misc.readingPreset = 'custom'
                        persist(); scene.onSettingsChanged(); syncReadingDock(); paintTimer(); renderPanel()
                        toast('已恢复你预设之前的自定义设置')
                    } else {
                        // 无快照可恢复时不再静默 break：告诉用户到底发生了什么（F3-17）。
                        toast('没有可恢复的快照：预设快照只存在内存里，刷新页面就清空了。当前设置保持原样。')
                        renderPanel()
                    }
                    break
                }
                // 切预设前先存下当前的自定义设置。判定必须看真实字段，不能看芯片上的 .on 标签：
                // misc.readingPreset 还挂着「轻氛围」时用户可能早已把雨势、闪电调过，
                // 按标签比较就不留快照，直接盖掉用户设置且再也回不去（F3-17）。
                if (!presetSnapshot && !settingsMatchPreset(settings, key)) presetSnapshot = capturePresetSnapshot(settings)
                const changed = applyReadingPreset(settings, key)
                if (!changed && key === 'full' && presetSnapshot) {
                    // 完整场景 = 恢复用户自己的全部设置
                    restorePresetSnapshot(settings, presetSnapshot)
                }
                settings.misc.readingPreset = key
                persist(); scene.onSettingsChanged(); syncReadingDock(); paintTimer(); renderPanel()
                const p = READING_PRESETS.find(x => x.key === key)
                toast(`已切换：${p ? p.label : key} · ${p ? p.hint : ''}`)
                break
            }
            case 'env-preset': {
                const p = ENV_PRESETS.find(x => x.key === target.dataset.key)
                if (!p) break
                const a = settings.atmosphere
                a.weather = p.set.weather
                if (p.set.weather !== 'clear') { a.enabled = true; if (p.set.rain != null) a.rain = p.set.rain; if (p.set.snow != null) a.snow = p.set.snow; if (p.set.fog != null) a.fog = p.set.fog; if (p.set.wind != null) a.wind = p.set.wind }
                else a.enabled = false
                if (p.set.ambience === null) { settings.ambience.enabled = false; ambience.stop() }
                else if (p.set.ambience) {
                    settings.ambience.enabled = true; settings.ambience.kind = p.set.ambience
                    try { await ambience.play(p.set.ambience); ambience.setVolume(ambiencePlayVolume()) } catch { /* 需用户手势 */ }
                }
                persist(); scene.onSettingsChanged(); renderPanel()
                toast(`环境预设：${p.label}`)
                break
            }
            case 'env-weather': {
                const w = target.dataset.key
                settings.atmosphere.weather = w
                settings.atmosphere.enabled = w !== 'clear'
                // 切回「雪」时补雪量兜底：#env-intensity 的 min=0 会把 snow 写成 0，
                // 而 js/rain-glass.js 用 (settings.snow ?? 0) > 0 判定天气是否生效——
                // 强度拉到 0 后切走再切回"雪"，雪景就永久死掉且没有任何提示（F3-13）。
                // 这条兜底原本在 10-05 去重时随被删的天气按钮一起消失了，这里补回。
                if (w === 'snow' && (settings.atmosphere.snow ?? 0) < .08) settings.atmosphere.snow = DEFAULT_SETTINGS.atmosphere.snow
                if (ambience.running) ambience.setRainAmount(settings.atmosphere.enabled && w === 'rain' ? settings.atmosphere.rain : 0)
                persist(); scene.onSettingsChanged(); renderPanel()
                break
            }
            case 'env-ambience': {
                const kind = target.dataset.key
                if (settings.ambience.enabled && settings.ambience.kind === kind) { settings.ambience.enabled = false; ambience.stop() }
                else { settings.ambience.enabled = true; settings.ambience.kind = kind; await ambience.play(kind); ambience.setVolume(ambiencePlayVolume()) }
                persist(); renderPanel()
                break
            }
            case 'env-advanced':
                openPanel('rain')
                break
            case 'backup-cancel': ++backupInspection; pendingBackup = null; renderPanel(); break
            case 'backup-merge': {
                if (!pendingBackup) break
                const target = pendingBackup
                ++backupInspection
                pendingBackup = null
                try {
                    await reader.flushProgress()
                    // 恢复前快照：可随时回退
                    toast('正在生成恢复前快照…', 60000)
                    await backup.downloadPreRestoreSnapshot({ onProgress: backupProgressToaster('正在生成恢复前快照…') })
                    await reader.close()
                    localAudio.stop()
                    toast('正在合并备份…', 60000)
                    const { added, mergedBooks } = await backup.mergeBackup(target.payload, { onProgress: backupProgressToaster('正在合并备份…') })
                    await refreshRecent()
                    renderPanelRecent()
                    refreshDiskStatus()
                    renderPanel()
                    const parts = []
                    if (added.books) parts.push(`新增 ${added.books} 本书`)
                    if (mergedBooks) parts.push(`合并 ${mergedBooks} 本已有书`)
                    if (added.backgrounds) parts.push(`新增 ${added.backgrounds} 张背景`)
                    if (added.audio) parts.push(`新增 ${added.audio} 首音乐`)
                    toast(parts.length ? `合并完成：${parts.join('、')}` : '备份内容已全部存在，无新增')
                } catch (err) {
                    console.error(err)
                    const partial = err.partial
                    const done = partial ? Object.values(partial.added).reduce((s, n) => s + n, 0) + partial.mergedBooks : 0
                    toast(done ? `合并中断：已写入 ${done} 条后失败（${err.message}）。按 id 幂等，重试同一备份是安全的` : `备份合并失败：${err.message}`)
                }
                break
            }
            case 'backup-overwrite': {
                if (!pendingBackup) break
                const target = pendingBackup
                ++backupInspection
                pendingBackup = null
                try {
                    await reader.flushProgress()
                    // 恢复前快照：可随时回退
                    toast('正在生成恢复前快照…', 60000)
                    await backup.downloadPreRestoreSnapshot({ onProgress: backupProgressToaster('正在生成恢复前快照…') })
                    await reader.close()
                    localAudio.stop()
                    musicUI.unmountNetease(false)
                    toast('正在恢复备份…', 60000)
                    const { verify, warnings, settingsSaved } = await backup.restoreBackup(target.payload, { onProgress: backupProgressToaster('正在恢复备份…') })
                    if (!Object.values(verify).every(Boolean)) throw new Error('恢复后的文件内容校验不一致；资料库可能已被替换，如异常请用恢复前快照回退')
                    // 设置写入失败时不自动刷新：刷新会丢掉这条提示，让用户自己决定时机
                    if (settingsSaved && !warnings.length) {
                        // A full rehydrate also replaces cached Blob URLs and the persistent music panel.
                        location.reload()
                        break
                    }
                    toast(warnings.join('；') + '。确认后手动刷新页面（⌘R）完成收尾', 15000)
                } catch (err) {
                    console.error(err)
                    toast(`备份恢复失败：${err.message}`)
                }
                break
            }
            case 'retry-disk': await retryDiskSync(); break
            case 'dismiss-import-error': {
                importErrors = importErrors.filter(x => x.id !== target.dataset.err)
                renderPanel()
                break
            }
            case 'retry-import': {
                const err = importErrors.find(x => x.id === target.dataset.err)
                if (!err?.file) break
                importErrors = importErrors.filter(x => x.id !== err.id)
                renderPanel()
                importBookFiles([err.file])
                break
            }
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
            case 'layout-density': {
                const compact = target.dataset.density === 'compact'
                settings.layout.fontSize = compact ? 17 : 21
                settings.layout.lineHeight = compact ? 1.6 : 1.9
                persist(); applyLayoutSettings(); renderPanel()
                toast(compact ? '已切换紧凑排版，每页可显示更多文字' : '已切换舒适排版')
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
    if (t.id === 'auto-speed' || t.id === 'auto-seconds' || t.id === 'auto-dwell') {
        const map = { 'auto-speed': 'pixelsPerSecond', 'auto-seconds': 'pageSeconds', 'auto-dwell': 'endDwellSeconds' }
        const key = map[t.id]
        settings.autoRead[key] = Number(t.value); persist()
        $('#'+t.id+'-value').textContent = t.value + (key === 'pixelsPerSecond' ? ' 像素/秒' : ' 秒')
        // 预设高亮跟手（按当前模式的档位判断）
        syncReadingDock()
    } else if (t.dataset.layout) {
        const key = t.dataset.layout
        const value = Number(t.value)
        settings.layout[key] = value
        persist()
        applyLayoutSettings()
        const label = { fontSize: '#v-font', lineHeight: '#v-line', maxWidth: '#v-width' }[key]
        const el = label && $(label)
        if (el) el.textContent = key === 'lineHeight' ? value : `${value}px`
        document.querySelectorAll('[data-action="layout-density"]').forEach(button => {
            const compact = button.dataset.density === 'compact'
            button.setAttribute('aria-pressed', String(settings.layout.fontSize === (compact ? 17 : 21) && settings.layout.lineHeight === (compact ? 1.6 : 1.9)))
        })
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
    if (t.id === 'shelf-sort') {
        shelfSort = t.value
        renderPanelRecent()
        return
    }
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
            toast(flow==='scrolled'?'已切换为上下滚动，阅读位置保持不变':'已切换为左右翻页，阅读位置保持不变')
        } catch(error) {toast('阅读方式切换失败：'+error.message);renderPanel()}
    } else if (t.id === 'log-timer-toggle') {
        // 计时器是否显示（可选；专注阅读下也可隐藏）
        settings.misc.showReadingTimer = t.checked
        persist(); paintTimer()
    } else if (t.id === 'auto-mode') {
        autoReading.stop(); settings.autoRead.mode=t.value; persist()
        // 预设档位含义随模式改变，坞与面板都要重画
        syncReadingDock(); renderPanel()
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

// 文件选择与外部拖入共用串行队列，连续多批导入不会覆盖排序。
let audioImportQueue = Promise.resolve()
function importAudioFiles (files) {
    audioImportQueue = audioImportQueue.catch(() => {}).then(async () => {
        let added = 0
        const before = localAudio.tracks.map(t => t.id)
        for (const file of files) {
            try {
                if (!/\.(mp3|wav|ogg|m4a|aac|flac|opus|webm)$/i.test(file.name)) throw new Error('请选择 MP3 / WAV / OGG / M4A 等音频文件')
                if (!file.size || file.size > 200 * 1024 * 1024) throw new Error('请选择非空且不超过 200MB 的音频')
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
            toast(`已保存 ${added} 首音乐，重新打开仍可播放`)
        }
    }).catch(error => toast('音乐保存失败：' + error.message))
    return audioImportQueue
}

// 音乐面板里需要读写 IndexedDB 的动作由这里处理（MusicUI 只发意图）。
let globalMuteSnapshot = null
// 「静音全部 / 恢复声音」按钮由 music-ui.js 渲染成静态文案，main.js 负责按真实状态改写
// （F3-4：刷新后快照只能从 settings.music.systemMute 复原，否则按钮会说谎）。
function syncGlobalMuteButton () {
    const btn = document.querySelector('#btn-global-mute')
    if (!btn) return
    btn.setAttribute('aria-pressed', String(!!globalMuteSnapshot))
    btn.textContent = globalMuteSnapshot ? '恢复声音' : '静音全部'
}
// 全局静音状态下（包括刷新后从 settings.music.systemMute 复原的状态）环境声一律 0：
// 否则面板写着「环境声：已全局静音」而环境声还在响，状态反向说谎（F3-4）。
const ambiencePlayVolume = () => globalMuteSnapshot ? 0 : settings.ambience.volume
async function handleMusicAction (action, payload = {}) {
    try {
        switch (action) {
            case 'open-panel':
                openPanel('music')
                break
            case 'pick-audio':
                $('#file-audio').click()
                break
            case 'import-audio':
                await importAudioFiles(payload.files)
                break
            case 'builtin-audio': {
                await audioImportQueue
                const wanted = (payload.keys?.length ? payload.keys : BUILTIN_TRACKS.map(t => t.key))
                    .map(k => builtinTrackByKey(k)).filter(Boolean)
                const missing = wanted.filter(t => !localAudio.tracks.some(x => x.name === `${t.title}.mp3`))
                if (!missing.length) { toast('这些内置音乐已在播放列表中'); break }
                const files = []
                const failed = []
                for (const t of missing) {
                    // 单曲失败不再拖垮整批：成功的照常入库，失败的攒起来最后如实报告
                    try {
                        const response = await fetch(t.file)
                        if (!response.ok) throw new Error(`HTTP ${response.status}`)
                        files.push(new File([await response.blob()], `${t.title}.mp3`, { type: 'audio/mpeg' }))
                    } catch (error) {
                        console.warn('内置音乐加载失败：', t.title, error)
                        failed.push(t.title)
                    }
                }
                if (files.length) {
                    await importAudioFiles(files)
                    if (failed.length) toast(`有 ${failed.length} 首内置音乐加载失败（${failed.join('、')}），其余已加入播放列表`)
                } else {
                    throw new Error(`内置音乐加载失败：${failed.join('、')}`)
                }
                break
            }
            case 'download-track': {
                const track = localAudio.tracks.find(t => t.id === payload.id)
                if (!track?.data) break
                const url = URL.createObjectURL(track.data)
                const link = document.createElement('a')
                link.href = url; link.download = track.name
                link.click(); setTimeout(() => URL.revokeObjectURL(url), 10000)
                break
            }
            case 'global-mute': {
                // 一键静音全部声音：本地音乐 + 环境声 +（可用时）系统音量，覆盖官方播放器等一切来源。
                // 恢复时回到静音前的各自状态，不要求重启。
                const syncBtn = syncGlobalMuteButton
                if (!globalMuteSnapshot) {
                    const snap = { musicMuted: localAudio.muted, ambVolume: settings.ambience.volume, ambEnabled: settings.ambience.enabled, ambKind: settings.ambience.kind, sys: null }
                    try {
                        const r = await fetch('/_reader/volume')
                        const state = await r.json()
                        if (r.ok && state) snap.sys = { volume: state.volume, muted: state.muted, byUs: false }
                    } catch { /* 无系统音量接口（非启动器/非 macOS）：本地与环境声仍可静音 */ }
                    localAudio.setMuted(true)
                    settings.music.muted = true
                    try { ambience.running && ambience.setVolume(0) } catch { /* 环境声可能未初始化 */ }
                    // byUs：这次系统静音确实是我们按下去的。系统本来就静音时我们一个字节都没改，
                    // 恢复时也就不能替用户把它打开——只有 byUs 为真才需要把 muted 写回 false（F3-4）。
                    if (snap.sys && !snap.sys.muted) {
                        try {
                            const r = await fetch('/_reader/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: snap.sys.volume, muted: true }) })
                            snap.sys.byUs = r.ok
                        } catch {}
                    }
                    globalMuteSnapshot = snap
                    // 快照落盘（F3-4）：settings.music.muted 本就持久化，快照只存内存的话
                    // 静音后刷新/关页 → Mac 还静音着但没人知道，按钮显示"静音全部"（状态说谎），
                    // 用户再点一次时 !snap.sys.muted 为假、连 POST 都不发，于是永远解不开。
                    settings.music.systemMute = snap.sys ? { ...snap.sys } : null
                    persist(); syncBtn()
                    toast(snap.sys ? '已静音全部声音（含电脑音量）' : '已静音乐与环境声；官方播放器声音请调电脑音量或在其面板暂停')
                } else {
                    const snap = globalMuteSnapshot
                    globalMuteSnapshot = null
                    localAudio.setMuted(false)
                    settings.music.muted = false
                    settings.music.systemMute = null
                    if (ambience.running) ambience.setVolume(snap.ambVolume ?? settings.ambience.volume)
                    // 明确发 muted:false，而不是回放捕获到的标志位（那套写法在刷新后会把
                    // muted:true 原样发回去，界面提示"声音已恢复"、系统却仍然静音，F3-4）。
                    if (snap.sys?.byUs && Number.isInteger(snap.sys.volume)) {
                        try { await fetch('/_reader/volume', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ volume: snap.sys.volume, muted: false }) }) } catch {}
                    }
                    persist(); syncBtn()
                    toast(snap.sys?.byUs ? '声音已恢复（含电脑音量）' : '声音已恢复')
                }
                break
            }
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
    // 欢迎页存储说明只基于真实连接结果：不说「已保存」除非本机资料库可用
    {
        const note = $('#storage-note')
        if (note) {
            const s = db.diskStatus()
            note.textContent = /已保存到本机/.test(s)
                ? '书籍与风景保存在本机资料库，可导出备份随身携带。'
                : /暂时没有保存/.test(s)
                    ? '本机资料库暂时不可写，内容先保存在浏览器；恢复后自动补同步。'
                    : '当前仅在浏览器中保存；用本机启动器打开即可保存到本机资料库。'
        }
    }
    // 持久存储：书籍/背景/音频本就落在本机资料库，这里再为浏览器侧 IndexedDB 申请保底
    try{
        const state=await db.requestDurableStorage()
        if(state==='default'){
            const est=await db.storageEstimateMB()
            console.warn('[reader] 浏览器未授予持久存储' + (est?`（已用 ${est.usage}MB / 配额 ${est.quota}MB）`:'') + '；书籍镜像在本机资料库，浏览器侧缓存可能被系统清理')
        }
    }catch{/* 存储探测失败不影响使用 */}
    reader = new Reader($('#reader-host'))
    window.__readerInstance = reader // 自动化验证与调试句柄
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
        linkTimerToAutoReading(active)
    })
    scene = new SceneController({
        settings,
        getRect: () => currentSurface().getBoundingClientRect(),
        onToast: msg => toast(msg),
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
        // 声音来源行：如实描述环境声当前状态
        getAmbienceInfo: () => globalMuteSnapshot
            ? '环境声：已全局静音'
            : (settings.ambience?.enabled && ambience?.running
                ? `环境声：${({rain:'雨声',snow:'落雪',waves:'海浪',stream:'溪流',fire:'篝火',crickets:'虫鸣',wind:'山风',white:'白噪',pink:'粉噪',brown:'棕噪'})[settings.ambience.kind] || settings.ambience.kind}（${Math.round((settings.ambience.volume ?? 0.5) * 100)}%）`
                : '环境声：关闭'),
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
    localAudio.setPlayMode(settings.music.playMode)
    localAudio.setFadeMs(settings.music.fadeMs)
    localAudio.setFadeEnabled(!reduced)
    if (settings.music.muted) localAudio.setMuted(true)
    // 全局静音的状态要跨刷新活着（F3-4）：以前快照只在内存里，静音后刷新 →
    // 电脑仍静音、按钮却显示「静音全部」，再点一次时系统已静音所以连 POST 都不发，
    // 于是「恢复声音」把捕获到的 muted:true 原样回放，界面说恢复了、系统还是静音。
    // 现在从 settings.music.systemMute 复原快照，按钮文案与「恢复声音」的下发都基于真实状态。
    if (settings.music.muted) {
        globalMuteSnapshot = {
            musicMuted: true,
            ambVolume: settings.ambience.volume,
            ambEnabled: settings.ambience.enabled,
            ambKind: settings.ambience.kind,
            sys: settings.music.systemMute || null,
        }
        syncGlobalMuteButton()
    }
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

    window.__readerAmbience = ambience // 自动化验证与调试句柄
    window.__readerDb = db // 自动化验证与调试句柄
    atmosphereUI = new AtmosphereUI({settings, scene, persist, ambience, onOpen: () => {
        // 入口决策（F3-16）：#atmosphere-toggle 在 css/glass-ui.css 里长期 display:none，
        // 右上角并没有雨滴按钮；这条回调只剩 atmosphere-ui.js 内部与抽屉里的路径会用到。
        // 天气与背景对用户唯一的入口是抽屉里的「阅读环境 / 环境高级设置」，
        // 抽屉内 #atmosphere-panel 的标题与引导语已经放开显示（glass-ui.css）。
        if (activePanel === 'scene') closePanel()
        else openPanel('scene')
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
    lastTickSig = timerSignature()
    startLogTick()
    window.addEventListener('pagehide', stopLogTick, { once: true })

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
    helpEl.addEventListener('click', () => { if (!helpEl.hidden) dismissSurface(helpEl, () => { helpEl.hidden = true }) })
    window.addEventListener('keydown', e => {
        if (e.key === '?' && !e.metaKey && !e.ctrlKey && !e.altKey &&
            !e.target.matches('input, select, textarea, button') && !e.target.isContentEditable) {
            e.preventDefault()
            if (helpEl.hidden) { helpEl.hidden = false; revealSurface(helpEl) }
            else dismissSurface(helpEl, () => { helpEl.hidden = true })
        }
    })

    // 光标只在正文空闲时隐藏；按钮/浮层悬停期间保留光标与控件。
    let cursorTimer = null
    let cursorIdleAt = 0
    const hideIdleCursor = () => {
        cursorTimer = null
        const remaining = cursorIdleAt - Date.now()
        if (remaining > 0) { cursorTimer = setTimeout(hideIdleCursor, remaining); return }
        if ($('#reader-column').classList.contains('hidden') || activePanel || hoveringReadingControls() ||
            $('#reading-speed-details').open || $('#reading-toc-popover')?.matches(':popover-open')) return
        document.body.classList.add('cursor-idle')
    }
    const wakeCursor = () => {
        if (document.body.classList.contains('cursor-idle')) document.body.classList.remove('cursor-idle')
        cursorIdleAt = Date.now() + 3000
        if (!cursorTimer) cursorTimer = setTimeout(hideIdleCursor, 3000)
    }
    window.addEventListener('pointermove', wakeCursor, { passive: true })
    window.addEventListener('pointerdown', wakeCursor, { passive: true })
    window.addEventListener('keydown', wakeCursor)
    window.addEventListener('pagehide', () => clearTimeout(cursorTimer), { once: true })
    wakeCursor()

    // PWA：添加到主屏幕；离线时网络优先、缓存兜底
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* 注册失败不影响使用 */ })
    }

    // HTML 先把入口显示为准备中；待资料、场景与事件都就绪后再开放点击。
    for (const id of ['btn-welcome-open', 'continue-reading', 'btn-welcome-background', 'top-settings']) {
        $('#' + id).disabled = false
    }
    $('#btn-welcome-open').removeAttribute('title')
    $('#top-settings').title = '书架、阅读、场景与音乐'

    console.log('[reader] 初始化完成')
}

init().catch(err => {
    console.error('初始化失败', err)
    toast('初始化失败，请刷新页面或查看控制台')
})


let pendingQuote=null
let focusNoteId=null
// 选书下拉的外点收起：全局只装一次的捕获监听（委托判断），面板反复重渲染也不会叠监听
function installNotesBookDismiss () {
    if (installNotesBookDismiss.done) return
    installNotesBookDismiss.done = true
    document.addEventListener('pointerdown', e => {
        if (e.target.closest?.('.notes-book-wrap')) return
        for (const list of document.querySelectorAll('.notes-book-list:not([hidden])')) {
            list.hidden = true
            list.parentElement?.querySelector('.notes-book-btn')?.setAttribute('aria-expanded', 'false')
        }
    }, true)
}
// 代次 token（F3-9）：笔记面板是唯一"await 之后才 append"却没有令牌的面板渲染，
// 而且下面用的是 body.append 而不是覆盖。连点下拉里的两本书（第二次发生在第一次
// db.listBooks() resolve 之前）会把两份列表叠加在抽屉里。tocRenderToken / panelRecentToken /
// bookSearchToken 都已经是这个范式，这里补齐。
let notesRenderToken = 0
async function renderNotesPanel(body) {
    const token = ++notesRenderToken
    body.replaceChildren()
    const books = await db.listBooks()
    if (token !== notesRenderToken || activePanel !== 'notes') return
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
    if (!record || token !== notesRenderToken || activePanel !== 'notes') return
    const counts = noteCounts(record.notes)

    // 自定义选书下拉：原生 <select> 在两套主题里都突兀，改为暖纸色按钮 + 浮层列表
    installNotesBookDismiss()
    const wrap = document.createElement('div')
    wrap.className = 'notes-book-wrap'
    const bookBtn = document.createElement('button')
    bookBtn.type = 'button'
    bookBtn.className = 'notes-book-btn'
    bookBtn.setAttribute('aria-haspopup', 'listbox')
    bookBtn.setAttribute('aria-expanded', 'false')
    bookBtn.setAttribute('aria-label', '选择要查看笔记的书')
    bookBtn.textContent = `《${record.title}》 · 划线 ${counts.quotes} · 书签 ${counts.bookmarks} ▾`
    const bookList = document.createElement('div')
    bookList.className = 'notes-book-list'
    bookList.setAttribute('role', 'listbox')
    bookList.hidden = true
    for (const b of books) {
        const c = noteCounts(b.notes)
        const row = document.createElement('button')
        row.type = 'button'
        row.setAttribute('role', 'option')
        row.setAttribute('aria-selected', String(b.id === notesBookId))
        row.dataset.id = b.id
        if (b.id === notesBookId) row.classList.add('current')
        const mark = document.createElement('span')
        mark.className = 'cur-mark'
        mark.textContent = b.id === notesBookId ? '✓' : ''
        const name = document.createElement('span')
        name.className = 'book-name'
        name.textContent = `《${b.title}》`
        const meta = document.createElement('small')
        meta.textContent = `划线 ${c.quotes} · 书签 ${c.bookmarks}`
        row.append(mark, name, meta)
        bookList.append(row)
    }
    const bookRows = () => [...bookList.querySelectorAll('button[data-id]')]
    const openBookList = (focusFirst = false) => {
        bookList.hidden = false
        bookBtn.setAttribute('aria-expanded', 'true')
        if (!focusFirst) return
        const rows = bookRows()
        const current = rows.find(r => r.classList.contains('current'))
        ;(current || rows[0])?.focus()
    }
    const closeBookList = ({ backToButton = false } = {}) => {
        if (bookList.hidden) return
        bookList.hidden = true
        bookBtn.setAttribute('aria-expanded', 'false')
        if (backToButton) bookBtn.focus()
    }
    bookBtn.addEventListener('click', () => {
        if (bookList.hidden) openBookList()
        else closeBookList()
    })
    // 键盘路径（F3-8）：这个下拉是 role=listbox + role=option，却只有 pointerdown 的外点收起，
    // 没有 Esc、没有方向键——键盘用户既选不了书，按 Esc 还会一路把抽屉关掉。
    // 现在：按钮上 ↓/↑/Enter/空格展开并把焦点送进列表，列表里 ↑↓ 移动、Esc 收起并交还焦点，
    // 且 Esc 就地 stopPropagation，不再触发抽屉级的收起。
    bookBtn.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            if (bookList.hidden) return
            e.preventDefault(); e.stopPropagation()
            closeBookList({ backToButton: true })
            return
        }
        if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key) && bookList.hidden) {
            e.preventDefault() // 拦住原生激活，否则 click 会紧接着把刚展开的列表又收回去
            openBookList(true)
        }
    })
    bookList.addEventListener('keydown', e => {
        const rows = bookRows()
        if (!rows.length) return
        const at = rows.indexOf(document.activeElement)
        if (e.key === 'Escape') {
            e.preventDefault(); e.stopPropagation()
            closeBookList({ backToButton: true })
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); rows[(at + 1 + rows.length) % rows.length].focus()
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); rows[(at - 1 + rows.length) % rows.length].focus()
        } else if (e.key === 'Home') {
            e.preventDefault(); rows[0].focus()
        } else if (e.key === 'End') {
            e.preventDefault(); rows[rows.length - 1].focus()
        }
    })
    bookList.addEventListener('click', e => {
        const row = e.target.closest('button[data-id]')
        if (!row) return
        notesBookId = row.dataset.id
        renderPanel()
    })
    wrap.append(bookBtn, bookList)
    body.append(wrap)

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
        // 分区框：划线与书签是两类积累物，各自装进带色系的框（quote 琥珀 / bookmark 青碧）
        const group = document.createElement('section')
        group.className = `notes-group ${type}`
        const heading = document.createElement('h3')
        heading.textContent = (type === 'quote' ? '划线笔记' : '书签') + ' · ' + notes.length
        group.append(heading)
        if (!notes.length) {
            const empty = document.createElement('p')
            empty.className = 'hint'
            empty.textContent = type === 'quote' ? '这本书还没有划线。' : '这本书还没有书签。'
            group.append(empty)
            body.append(group)
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
            // 心得折叠：默认收起为与时间并排的小箭头；有心得时先展示心得文本。
            const metaRow = document.createElement('div')
            metaRow.className = 'note-meta'
            const meta = document.createElement('small')
            meta.textContent = new Date(note.createdAt || Date.now()).toLocaleString('zh-CN')
            const fold = document.createElement('button')
            fold.type = 'button'
            fold.className = 'note-fold' + (note.comment ? ' has' : '')
            fold.setAttribute('aria-expanded', 'false')
            fold.textContent = '心得 ▸'
            // 保存状态：保存中 / 已保存 / 保存失败，可重试
            const status = document.createElement('span')
            status.className = 'note-status'
            metaRow.append(meta, fold, status)
            card.append(metaRow)
            if (note.comment) {
                const shown = document.createElement('p')
                shown.className = 'note-comment'
                shown.textContent = note.comment
                card.append(shown)
            }
            const comment = document.createElement('textarea')
            // 草稿优先：上次未保存完的输入自动恢复
            const draft = getDraft(notesBookId, note.id, note.comment || '')
            comment.value = draft || note.comment || ''
            comment.placeholder = '写下你的想法…'
            comment.setAttribute('aria-label', '笔记心得')
            comment.hidden = true
            card.append(comment)

            const savedComment = note.comment || ''
            let lastSaved = savedComment
            let saveSeq = 0
            let saveTimer = 0
            const refreshFold = () => {
                const text = lastSaved
                fold.classList.toggle('has', !!text)
                let shownEl = card.querySelector('.note-comment')
                if (text) {
                    if (!shownEl) {
                        shownEl = document.createElement('p')
                        shownEl.className = 'note-comment'
                        card.insertBefore(shownEl, comment)
                    }
                    shownEl.textContent = text
                } else if (shownEl) shownEl.remove()
            }
            const setStatus = (text, cls, retry = false) => {
                status.textContent = text
                status.className = 'note-status' + (cls ? ' ' + cls : '')
                status.dataset.retry = retry ? '1' : ''
            }
            const flashSaved = () => {
                setStatus('已保存', 'ok')
                setTimeout(() => { if (status.textContent === '已保存') setStatus('') }, 2500)
            }
            const doSave = async () => {
                const text = comment.value
                if (text === lastSaved) return true
                const mySeq = ++saveSeq
                setStatus('保存中…', 'saving')
                try {
                    // 重新读取最新记录：合并期间别处的修改，只覆盖心得字段
                    const rec = await db.getBook(notesBookId)
                    const fresh = rec?.notes?.find(n => n.id === note.id)
                    if (!fresh) throw new Error('这条笔记已不存在')
                    const notes = await db.updateBookNote(notesBookId, { ...fresh, comment: text, editedAt: Date.now() })
                    if (mySeq !== saveSeq) return true // 过时响应：更新的编辑会自行展示状态
                    if (reader.bookId === notesBookId) reader.notes = notes
                    lastSaved = text
                    clearDraft(notesBookId, note.id)
                    refreshFold()
                    flashSaved()
                    return true
                } catch (e) {
                    if (mySeq !== saveSeq) return true
                    // 草稿已留（input 时即时写入），输入不丢，不展示虚假成功
                    setStatus('保存失败，可重试', 'err', true)
                    return false
                }
            }
            comment.addEventListener('input', () => {
                const text = comment.value
                // 即时落草稿：切栏目 / 换书 / 关面板 / 重启都保得住
                if (text === savedComment) clearDraft(notesBookId, note.id)
                else setDraft(notesBookId, note.id, text)
                fold.classList.toggle('draft', !!text && text !== savedComment)
                if (status.classList.contains('err') || status.classList.contains('saving')) setStatus('')
                clearTimeout(saveTimer)
                saveTimer = setTimeout(doSave, 900) // 短暂防抖自动保存
            })
            status.addEventListener('click', () => {
                if (status.dataset.retry) { clearTimeout(saveTimer); doSave() }
            })
            fold.addEventListener('click', () => {
                const expand = comment.hidden
                comment.hidden = !expand
                fold.setAttribute('aria-expanded', String(expand))
                fold.textContent = expand ? '收起 ▾' : '心得 ▸'
                if (expand) comment.focus()
            })
            // 面板重建时自动补存遗留草稿（上次未完成保存的输入）
            if (draft && draft !== savedComment) {
                saveTimer = setTimeout(doSave, 1200)
            }
            // 保存按钮与自动保存共用一条路径，避免双写竞态
            card._saveComment = () => { clearTimeout(saveTimer); return doSave() }
            for (const [label, action] of [['保存笔记', 'save-note'], ['回到原文', 'go-note'], ['删除', 'delete-note']]) {
                const button = document.createElement('button')
                button.textContent = label
                button.dataset.action = action
                button.dataset.id = notesBookId
                button.dataset.noteId = note.id
                card.append(button)
            }
            group.append(card)
            // 「写想法」入口：保存划线后展开这条的输入框并聚焦
            if (focusNoteId && note.id === focusNoteId) {
                comment.hidden = false
                fold.setAttribute('aria-expanded', 'true')
                fold.textContent = '收起 ▾'
                card.scrollIntoView({ block: 'center' })
                setTimeout(() => comment.focus(), 50)
            }
        }
        body.append(group)
    }
    // 现存笔记之外的草稿清掉；写想法聚焦只生效一次
    if (focusNoteId) { focusNoteId = null }
    const validPairs = []
    for (const b of books) for (const n of (b.notes || [])) validPairs.push([b.id, n.id])
    pruneDrafts(validPairs)
}
