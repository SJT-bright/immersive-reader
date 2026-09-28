// 左上角阅读计时条（展示「今日累计」，24 点自动翻新），以及设置面板里的阅读记录 /
// 蓝色热力图（类 GitHub 贡献图：颜色越深＝当天读得越久）与成就。

import { icon } from './icons.js'
import {
    formatClock, formatDuration, localDayKey,
} from './reading-log.js?v=2026.9.18.1'

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

// 热力图蓝色阶：颜色越深＝当天阅读越久（主体基调为蓝）
const HEAT_STEPS = [15, 30, 60, 120] // 分钟阈值：L1..L4
const HEAT_COLORS = ['#152a3d', '#1d466b', '#2c6fa8', '#4d9bd6', '#8fc7ee']

function heatColor (ms) {
    const minutes = ms / 60000
    let level = 0
    for (const t of HEAT_STEPS) if (minutes >= t) level++
    return HEAT_COLORS[level]
}

// 最近 N 周热力图：列=周（旧→新），行=周一..周日；今天的高亮描边
function heatGrid (days, now) {
    const weeks = 16
    const today = new Date(now)
    today.setHours(0, 0, 0, 0)
    const weekday = (today.getDay() + 6) % 7 // 周一=0..周日=6
    const lastMonday = today.getTime() - (weekday + (weeks - 1) * 7) * 86400000
    const cells = []
    for (let w = 0; w < weeks; w++) {
        for (let d = 0; d < 7; d++) {
            const ts = lastMonday + (w * 7 + d) * 86400000
            if (ts > today.getTime()) break
            const key = localDayKey(ts)
            const ms = days[key]?.ms || 0
            cells.push(`<i class="log-heat-cell${ts === today.getTime() ? ' today' : ''}" style="background:${heatColor(ms)}" title="${key} · ${ms ? escapeHtml(formatDuration(ms)) : '未阅读'}"></i>`)
        }
        cells.push('\n')
    }
    return cells.join('')
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
    el.innerHTML = `
        <span class="timer-dot" aria-hidden="true"></span>
        <span class="timer-copy">
            <span class="timer-clock">${clock}</span>
            <span class="timer-sub">${escapeHtml(sub)}</span>
        </span>
        <button type="button" class="timer-toggle" data-log="toggle" aria-label="${toggleLabel}" title="${toggleLabel}">${icon(running ? 'pause' : 'play')}</button>
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
            <p class="log-heat" role="img" aria-label="近 16 周每日阅读热力图，颜色越深代表当天阅读越久">${heatGrid(snap.days, snap.now)}</p>
            <p class="hint log-heat-legend">浅 <i class="log-heat-cell" style="background:${HEAT_COLORS[0]}"></i><i class="log-heat-cell" style="background:${HEAT_COLORS[1]}"></i><i class="log-heat-cell" style="background:${HEAT_COLORS[2]}"></i><i class="log-heat-cell" style="background:${HEAT_COLORS[3]}"></i><i class="log-heat-cell" style="background:${HEAT_COLORS[4]}"></i> 深 · 每格一天，颜色越深读得越久（15/30/60/120 分钟分档）</p>
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
    return true
}
