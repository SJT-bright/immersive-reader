// 左上角阅读计时条（展示「今日累计」，24 点自动翻新），以及设置面板里的阅读记录 /
// 蓝色热力图（类 GitHub 贡献图：颜色越亮＝当天读得越久）与成就。

import { icon } from './icons.js'
import {
    formatClock, formatDuration, localDayKey,
} from './reading-log.js'

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]))

function whenLabel (ts) {
    const d = new Date(ts)
    const now = new Date()
    const sameDay = d.toDateString() === now.toDateString()
    const yesterday = new Date(now)
    yesterday.setDate(now.getDate() - 1)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    if (sameDay) return `今天 ${hh}:${mm}`
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hh}:${mm}`
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
}

// 0 与有阅读的日期分开；颜色只作分档，提示始终使用原始时长算分钟。
const HEAT_STEPS = [15, 30, 60, 120]
const HEAT_COLORS = ['#152a3d', '#1d466b', '#245780', '#2c6fa8', '#4d9bd6', '#8fc7ee']

function heatColor (ms) {
    const minutes = ms / 60000
    let level = ms > 0 ? 1 : 0
    for (const t of HEAT_STEPS) if (minutes >= t) level++
    return HEAT_COLORS[level]
}

const heatPanels = new WeakMap()
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const heatMs = ms => Number.isFinite(ms) ? Math.max(0, ms) : 0
const heatMinutes = ms => Math.floor(heatMs(ms) / 60000)
const heatDate = key => {
    const [year, month, day] = key.split('-').map(Number)
    return `${year}年${month}月${day}日`
}
const heatDuration = ms => `阅读 ${heatMinutes(ms)} 分钟${ms > 0 && ms < 60000 ? '（不足 1 分钟）' : ''}`

// 列=周（旧→新），行=周一..周日。todayMs 含仍在进行的计时尾差，
// days 则已经记入到 lastTickAt 的时长；不能再次叠加 current.elapsedMs。
function heatCalendar (snap) {
    const weeks = 16
    const today = new Date(snap.now)
    today.setHours(0, 0, 0, 0)
    const weekday = (today.getDay() + 6) % 7 // 周一=0..周日=6
    // 用日期对象逐格推进而不是固定 86400000ms：夏令时区一天可能只有 23 小时，
    // 固定毫秒步进会让后续格子整体漂移、「今天」高亮错位
    const cursor = new Date(today)
    cursor.setDate(cursor.getDate() - (weekday + (weeks - 1) * 7))
    const cells = []
    const months = []
    let previousMonth = -1
    for (let w = 0; w < weeks; w++) {
        if (cursor.getMonth() !== previousMonth) {
            months.push({ column: w + 1, text: `${cursor.getMonth() + 1}月` })
            previousMonth = cursor.getMonth()
        }
        for (let d = 0; d < 7; d++) {
            const ts = cursor.getTime()
            if (ts > today.getTime()) break
            const key = localDayKey(ts)
            const isToday = ts === today.getTime()
            const ms = heatMs(isToday ? snap.todayMs : snap.days[key]?.ms)
            cells.push({ key, ms, isToday, column: w + 1, row: d + 1 })
            cursor.setDate(cursor.getDate() + 1)
        }
    }
    return { cells, months }
}

function heatCellMarkup (day) {
    return `<button type="button" class="log-heat-cell${day.isToday ? ' today' : ''}" data-heat-day="${day.key}" data-reader-static-control tabindex="${day.isToday ? 0 : -1}"${day.isToday ? ' aria-current="date"' : ''} aria-label="${escapeHtml(`${heatDate(day.key)}，${heatDuration(day.ms)}`)}" style="--heat-color:${heatColor(day.ms)};grid-column:${day.column};grid-row:${day.row}"></button>`
}

function heatMarkup (snap) {
    const calendar = heatCalendar(snap)
    return `<div class="log-heat-wrap">
        <div class="log-heat-heading"><span>近 16 周</span><span data-heat-summary>今天 · ${heatMinutes(snap.todayMs)} 分钟</span></div>
        <div class="log-heat-scroll">
            <div class="log-heat-board">
                <div class="log-heat-weekdays" aria-hidden="true">${WEEKDAYS.map(day => `<span>${day}</span>`).join('')}</div>
                <div class="log-heat" role="group" aria-label="近 16 周每日阅读记录" aria-describedby="log-heat-help">${calendar.cells.map(heatCellMarkup).join('')}</div>
                <div class="log-heat-months" aria-hidden="true">${calendar.months.map(month => `<span style="grid-column:${month.column}">${month.text}</span>`).join('')}</div>
            </div>
        </div>
        <div class="log-heat-tooltip" id="log-heat-tooltip" role="tooltip" hidden><span class="log-heat-tooltip-date"></span><span class="log-heat-tooltip-duration"></span></div>
    </div>`
}

function positionHeatTooltip (state) {
    const cell = state.cells.get(state.active)
    if (!cell || state.tooltip.hidden || !state.root.isConnected) return
    const frame = state.root.getBoundingClientRect()
    const rect = cell.getBoundingClientRect()
    const tooltip = state.tooltip.getBoundingClientRect()
    const left = Math.max(8, Math.min(rect.left - frame.left + rect.width / 2 - tooltip.width / 2, frame.width - tooltip.width - 8))
    const above = rect.top - frame.top - tooltip.height - 9
    const top = above >= 6 ? above : rect.bottom - frame.top + 9
    state.tooltip.style.left = `${Math.round(left)}px`
    state.tooltip.style.top = `${Math.round(top)}px`
}

function showHeatDay (state, key) {
    const cell = state.cells.get(key)
    if (!cell) {
        state.cells.get(state.active)?.removeAttribute('aria-describedby')
        state.active = null
        if (!state.tooltip.hidden) state.tooltip.hidden = true
        return
    }
    const changingDay = state.active !== key
    if (changingDay) state.cells.get(state.active)?.removeAttribute('aria-describedby')
    state.active = key
    const date = state.tooltip.querySelector('.log-heat-tooltip-date')
    const duration = state.tooltip.querySelector('.log-heat-tooltip-duration')
    const dateText = `${heatDate(key)}${cell.classList.contains('today') ? ' · 今天' : ''}`
    const durationText = heatDuration(Number(cell.dataset.heatMs))
    const changingText = date.textContent !== dateText || duration.textContent !== durationText
    if (date.textContent !== dateText) date.textContent = dateText
    if (duration.textContent !== durationText) duration.textContent = durationText
    if (cell.getAttribute('aria-describedby') !== state.tooltip.id) cell.setAttribute('aria-describedby', state.tooltip.id)
    const appearing = state.tooltip.hidden
    if (appearing) state.tooltip.hidden = false
    if (changingDay || changingText || appearing) positionHeatTooltip(state)
}

function preferredHeatDay (state) {
    return state.hover || state.focus || state.pinned
}

function bindHeatPanel (body) {
    heatPanels.get(body)?.resize?.disconnect()
    const root = body.querySelector('.log-heat-wrap')
    if (!root) return null
    const state = {
        root, grid: root.querySelector('.log-heat'), tooltip: root.querySelector('.log-heat-tooltip'),
        cells: new Map([...root.querySelectorAll('[data-heat-day]')].map(cell => [cell.dataset.heatDay, cell])),
        active: null, hover: null, focus: null, pinned: null,
    }
    heatPanels.set(body, state)
    const eventCell = event => event.target.closest?.('[data-heat-day]')
    state.grid.addEventListener('pointerover', event => {
        if (event.pointerType === 'touch') return
        const cell = eventCell(event)
        if (!cell) return
        state.hover = cell.dataset.heatDay
        showHeatDay(state, state.hover)
    })
    state.grid.addEventListener('pointerleave', event => {
        if (event.pointerType === 'touch') return
        state.hover = null
        showHeatDay(state, preferredHeatDay(state))
    })
    state.grid.addEventListener('focusin', event => {
        const cell = eventCell(event)
        if (!cell) return
        state.cells.forEach(button => { button.tabIndex = button === cell ? 0 : -1 })
        state.focus = cell.dataset.heatDay
        showHeatDay(state, state.focus)
    })
    state.grid.addEventListener('focusout', event => {
        if (state.grid.contains(event.relatedTarget)) return
        state.focus = null
        showHeatDay(state, preferredHeatDay(state))
    })
    state.grid.addEventListener('click', event => {
        const cell = eventCell(event)
        if (!cell) return
        state.pinned = cell.dataset.heatDay
        showHeatDay(state, state.pinned)
    })
    root.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
            state.hover = state.focus = state.pinned = null
            showHeatDay(state, null)
            event.preventDefault()
            event.stopPropagation()
            return
        }
        const cell = eventCell(event)
        if (!cell) return
        const buttons = [...state.cells.values()]
        const index = buttons.indexOf(cell)
        const offsets = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }
        const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : event.key in offsets ? Math.max(0, Math.min(buttons.length - 1, index + offsets[event.key])) : null
        if (nextIndex === null) return
        event.preventDefault()
        const next = buttons[nextIndex]
        next.focus({ preventScroll: true })
        next.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        positionHeatTooltip(state)
    })
    root.querySelector('.log-heat-scroll').addEventListener('scroll', () => positionHeatTooltip(state), { passive: true })
    if (typeof ResizeObserver === 'function') {
        state.resize = new ResizeObserver(() => positionHeatTooltip(state))
        state.resize.observe(root)
    }
    return state
}

function patchHeatPanel (body, snap) {
    const state = heatPanels.get(body)
    if (!state || state.root !== body.querySelector('.log-heat-wrap')) return
    const calendar = heatCalendar(snap)
    const keys = new Set(calendar.cells.map(day => day.key))
    // 同一天每秒只改数值与颜色；不替换按钮，悬停目标与键盘焦点始终保留。
    // 日期翻新时也保留仍在范围内的节点，只移除过期日期并补上新一天。
    for (const [key, cell] of state.cells) {
        if (!keys.has(key)) { cell.remove(); state.cells.delete(key) }
    }
    for (const slot of ['hover', 'focus', 'pinned']) if (state[slot] && !keys.has(state[slot])) state[slot] = null
    for (const day of calendar.cells) {
        let cell = state.cells.get(day.key)
        if (!cell) {
            const template = body.ownerDocument.createElement('template')
            template.innerHTML = heatCellMarkup(day)
            cell = template.content.firstElementChild
            state.grid.append(cell)
            state.cells.set(day.key, cell)
        }
        const label = `${heatDate(day.key)}，${heatDuration(day.ms)}`
        if (cell.getAttribute('aria-label') !== label) cell.setAttribute('aria-label', label)
        const color = heatColor(day.ms)
        if (cell.style.getPropertyValue('--heat-color') !== color) cell.style.setProperty('--heat-color', color)
        if (cell.dataset.heatMs !== String(day.ms)) cell.dataset.heatMs = String(day.ms)
        cell.classList.toggle('today', day.isToday)
        if (day.isToday && cell.getAttribute('aria-current') !== 'date') cell.setAttribute('aria-current', 'date')
        else if (!day.isToday && cell.hasAttribute('aria-current')) cell.removeAttribute('aria-current')
        if (cell.style.gridColumn !== String(day.column)) cell.style.gridColumn = String(day.column)
        if (cell.style.gridRow !== String(day.row)) cell.style.gridRow = String(day.row)
    }
    if (![...state.cells.values()].some(cell => cell.tabIndex === 0)) state.cells.get(localDayKey(snap.now)).tabIndex = 0
    const months = state.root.querySelector('.log-heat-months')
    const monthMarkup = calendar.months.map(month => `<span style="grid-column:${month.column}">${month.text}</span>`).join('')
    if (months.dataset.calendar !== monthMarkup) {
        months.innerHTML = monthMarkup
        months.dataset.calendar = monthMarkup
    }
    const summary = state.root.querySelector('[data-heat-summary]')
    const summaryText = `今天 · ${heatMinutes(snap.todayMs)} 分钟`
    if (summary.textContent !== summaryText) summary.textContent = summaryText
    // 最后一次交互决定当前提示；鼠标留在旧格子时，键盘新焦点不能被下一秒 tick 抢回。
    if (state.active) showHeatDay(state, state.cells.has(state.active) ? state.active : preferredHeatDay(state))
}

export function renderTimer (el, snap) {
    // 左上角只展示「今日累计」：每天 0 点按日期键自动翻新；暂停次数按需求删除，前台不再显示
    const running = !!snap.current?.running
    const clock = formatClock(snap.todayMs)
    const sub = snap.goalMinutes > 0
        ? `今日${snap.goalMet ? '已达标' : `还差 ${formatDuration(Math.max(0, snap.goalMinutes * 60000 - snap.todayMs))}`}`
        : (snap.todayMs > 0 ? `今日 ${formatDuration(snap.todayMs)}` : '右键设置每日目标')
    const toggleLabel = running ? '暂停计时' : '开始计时'
    el.dataset.state = running ? 'running' : 'idle'
    el.dataset.goal = snap.goalMet ? 'met' : 'pending'
    el.title = '右键设置每日阅读目标'
    // patch 路径（F3-3）：骨架已经在了就只改文本与图标。整块 innerHTML 每秒重建会把
    // .timer-toggle / .timer-end 两个按钮换成新节点，键盘用户 Tab 上来一秒内就被换掉焦点，
    // 几乎按不到；同时 :focus-visible 与点击高光每秒被重置一次。
    const clockEl = el.querySelector('.timer-clock')
    const subEl = el.querySelector('.timer-sub')
    const toggle = el.querySelector('.timer-toggle')
    const end = el.querySelector('.timer-end')
    if (clockEl && subEl && toggle && end && el.children.length === 4) {
        if (clockEl.textContent !== clock) clockEl.textContent = clock
        if (subEl.textContent !== sub) subEl.textContent = sub
        if (toggle.getAttribute('aria-label') !== toggleLabel) {
            toggle.setAttribute('aria-label', toggleLabel)
            toggle.title = toggleLabel
            const want = running ? 'pause' : 'play'
            if (toggle.dataset.icon !== want) {
                toggle.dataset.icon = want
                toggle.innerHTML = icon(want)
            }
        }
        return
    }
    el.innerHTML = `
        <span class="timer-dot" aria-hidden="true"></span>
        <span class="timer-copy">
            <span class="timer-clock">${clock}</span>
            <span class="timer-sub">${escapeHtml(sub)}</span>
        </span>
        <button type="button" class="timer-toggle" data-log="toggle" data-icon="${running ? 'pause' : 'play'}" aria-label="${toggleLabel}" title="${toggleLabel}">${icon(running ? 'pause' : 'play')}</button>
        <button type="button" class="timer-end" data-log="end" aria-label="结束本次记录" title="结束本次">${icon('close')}</button>
    `
}

export function renderLogPanel (body, snap, opts = {}) {
    const cur = snap.current
    const sessionLine = cur
        ? `本次 ${formatDuration(cur.elapsedMs)}${cur.bookTitle ? ` · 《${cur.bookTitle}》` : ''}${cur.running ? ' · 计时中' : ' · 已暂停'}`
        : '当前没有进行中的阅读。开自动阅读会自动开始计时，也可以按左上角自己开始。'
    const recent = snap.recent.length
        ? `<ol class="log-sessions">${snap.recent.map(s => {
            const longest = Math.max(0, ...(s.runs || []))
            const book = s.bookTitle ? `《${escapeHtml(s.bookTitle)}》` : '未打开书'
            return `<li>
                <span class="log-when">${escapeHtml(whenLabel(s.startedAt))}</span>
                <span class="log-book">${book}</span>
                <span class="log-meta">${escapeHtml(formatDuration(s.elapsedMs))}${longest ? ` · 最长连续 ${escapeHtml(formatDuration(longest))}` : ''}</span>
            </li>`
        }).join('')}</ol>`
        : '<p class="hint">还没有结束过的阅读记录。</p>'

    const ach = snap.achievements.map(a => {
        const state = a.unlocked ? 'on' : 'off'
        const remain = a.unlocked ? a.line : `还差 ${formatDuration(a.remainMs)}（${a.need}）`
        const img = a.image
            ? `<img class="log-ach-img" src="${escapeHtml(a.image)}" alt="" width="56" height="56">`
            : ''
        return `<li class="log-ach ${state}">
            ${img}
            <span class="log-ach-name">${escapeHtml(a.name)}</span>
            <span class="log-ach-need">${escapeHtml(a.need)}</span>
            <span class="log-ach-line">${escapeHtml(remain)}</span>
        </li>`
    }).join('')

    const next = snap.next
        ? `<p class="hint">下一档「${escapeHtml(snap.next.name)}」还差 ${escapeHtml(formatDuration(snap.next.remainMs))}。</p>`
        : '<p class="hint">九个名称都已点亮。</p>'

    body.innerHTML = `
        <section>
            <h3>时长</h3>
            <p class="hint">开自动阅读就自动开始计时；应用切到后台或退出时自动暂停，不计入时长。左上角显示的是「今日累计」，每天 0 点自动翻新，也可以自己开始或暂停。</p>
            <dl class="log-stats">
                <div><dt>今天</dt><dd id="log-today">${escapeHtml(formatDuration(snap.todayMs))}</dd></div>
                <div><dt>累计</dt><dd id="log-total">${escapeHtml(formatDuration(snap.totalMs))}</dd></div>
                <div><dt>连续天数</dt><dd id="log-streak">${escapeHtml(String(snap.streak))} 天</dd></div>
            </dl>
            <p class="log-session" id="log-session">${escapeHtml(sessionLine)}</p>
            <div class="row"><label class="env-inline"><input type="checkbox" id="log-timer-toggle" ${opts.showTimer !== false ? 'checked' : ''}> 显示左上角计时器</label></div>
            <div class="log-goal" id="log-goal-settings">
                <label for="log-goal-minutes">每天阅读目标（分钟）</label>
                <div class="row"><input id="log-goal-minutes" type="number" min="0" max="1440" step="1" value="${snap.goalMinutes || 0}"><button type="button" data-action="log-save-goal">保存目标</button></div>
                <p class="hint">设为 0 可关闭目标；今日达到目标后，左上角会显示“已达标”。</p>
            </div>
            <div class="log-clear"><button type="button" data-action="log-clear-history">清空阅读时长记录</button><p class="hint">清空今日、历史时长和成就；每日目标保留。书籍进度、笔记和划线不受影响。</p></div>
        </section>
        <section>
            <h3>每日记录</h3>
            ${heatMarkup(snap)}
            <p class="hint log-heat-help" id="log-heat-help">每格一天，移入或点按查看日期与分钟数；键盘方向键按天或周查看，Esc 收起。</p>
            <p class="hint log-heat-legend">少 ${HEAT_COLORS.map(color => `<i class="log-heat-cell" style="background:${color}" aria-hidden="true"></i>`).join('')} 多 · 颜色越亮读得越久（15/30/60/120 分钟分档）</p>
        </section>
        <section>
            <h3>最近阅读</h3>
            ${recent}
        </section>
        <section>
            <h3>成就</h3>
            <p class="hint">按累计阅读时长点亮，记录都存在本机数据库里。</p>
            <ol class="log-achs">${ach}</ol>
            ${next}
        </section>`
    bindHeatPanel(body)
    patchHeatPanel(body, snap)
}

export function patchLogPanel (body, snap) {
    const today = body.querySelector('#log-today')
    const total = body.querySelector('#log-total')
    const streak = body.querySelector('#log-streak')
    const session = body.querySelector('#log-session')
    if (!today || !total || !session) return false
    today.textContent = formatDuration(snap.todayMs)
    total.textContent = formatDuration(snap.totalMs)
    if (streak) streak.textContent = `${snap.streak} 天`
    const cur = snap.current
    session.textContent = cur
        ? `本次 ${formatDuration(cur.elapsedMs)}${cur.bookTitle ? ` · 《${cur.bookTitle}》` : ''}${cur.running ? ' · 计时中' : ' · 已暂停'}`
        : '当前没有进行中的阅读。开自动阅读会自动开始计时，也可以按左上角自己开始。'
    patchHeatPanel(body, snap)
    return true
}
