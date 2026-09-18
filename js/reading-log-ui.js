// 左上角手动计时条，以及设置面板里的阅读记录 / 成就。

import { icon } from './icons.js'
import {
    formatClock, formatDuration,
} from './reading-log.js?v=1.0.0'

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

function avgLabel (avg) {
    if (!avg) return '0'
    return avg < 10 ? avg.toFixed(1).replace(/\.0$/, '') : String(Math.round(avg))
}

export function renderTimer (el, snap) {
    const cur = snap.current
    const running = !!cur?.running
    const paused = !!cur && !cur.running
    const clock = cur ? formatClock(cur.elapsedMs) : formatClock(snap.todayMs)
    const sub = cur
        ? (cur.pauses ? `中断 ${cur.pauses}` : (running ? '计时中' : '已暂停'))
        : (snap.todayMs ? `今日 ${formatDuration(snap.todayMs)}` : '今日未计时')
    const toggleLabel = running ? '暂停计时' : (paused ? '继续计时' : '开始计时')
    el.dataset.state = running ? 'running' : paused ? 'paused' : 'idle'
    el.innerHTML = `
        <span class="timer-dot" aria-hidden="true"></span>
        <span class="timer-copy">
            <span class="timer-clock">${clock}</span>
            <span class="timer-sub">${escapeHtml(sub)}</span>
        </span>
        <button type="button" class="timer-toggle" data-log="toggle" aria-label="${toggleLabel}" title="${toggleLabel}">${icon(running ? 'pause' : 'play')}</button>
        ${cur ? `<button type="button" class="timer-end" data-log="end" aria-label="结束本次阅读" title="结束本次">${icon('close')}</button>` : ''}
    `
}

export function renderLogPanel (body, snap) {
    const cur = snap.current
    const sessionLine = cur
        ? `本次 ${formatDuration(cur.elapsedMs)} · 中断 ${cur.pauses} 次${cur.bookTitle ? ` · 《${cur.bookTitle}》` : ''}${cur.running ? ' · 计时中' : ' · 已暂停'}`
        : '当前没有进行中的阅读。点左上角开始，自己按下暂停。'
    const recent = snap.recent.length
        ? `<ol class="log-sessions">${snap.recent.map(s => {
            const longest = Math.max(0, ...(s.runs || []))
            const book = s.bookTitle ? `《${escapeHtml(s.bookTitle)}》` : '未打开书'
            return `<li>
                <span class="log-when">${escapeHtml(whenLabel(s.startedAt))}</span>
                <span class="log-book">${book}</span>
                <span class="log-meta">${escapeHtml(formatDuration(s.elapsedMs))} · 中断 ${s.pauses} 次${longest ? ` · 最长连续 ${escapeHtml(formatDuration(longest))}` : ''}</span>
            </li>`
        }).join('')}</ol>`
        : '<p class="hint">还没有结束过的阅读。开始后，用结束记下这一次。</p>'

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
        : '<p class="hint">九个名称都已记下。</p>'

    body.innerHTML = `
        <section>
            <h3>时长</h3>
            <p class="hint">计时是手动的：开始、暂停、结束都由你按。暂停记一次中断，方便回头看自己有没有坐住，不是评分。</p>
            <dl class="log-stats">
                <div><dt>今日</dt><dd id="log-today">${escapeHtml(formatDuration(snap.todayMs))}</dd></div>
                <div><dt>累计</dt><dd id="log-total">${escapeHtml(formatDuration(snap.totalMs))}</dd></div>
            </dl>
            <p class="log-session" id="log-session">${escapeHtml(sessionLine)}</p>
        </section>
        <section>
            <h3>中断</h3>
            <p class="log-interrupt">${snap.sessions ? `共 ${snap.sessions} 次阅读，中断 ${snap.pauses} 次，平均每次 ${escapeHtml(avgLabel(snap.avgPauses))} 次。` : '还没有中断记录。'}</p>
            <p class="hint">最长一次不中断：${snap.longestRunMs ? escapeHtml(formatDuration(snap.longestRunMs)) : '—'}。空格隐藏按钮时，左上角计时仍在，方便暂停。</p>
        </section>
        <section>
            <h3>最近阅读</h3>
            ${recent}
        </section>
        <section>
            <h3>名称</h3>
            <p class="hint">按累计阅读时长记下的名称，在后台慢慢亮起。</p>
            <ol class="log-achs">${ach}</ol>
            ${next}
        </section>`
}

export function patchLogPanel (body, snap) {
    const today = body.querySelector('#log-today')
    const total = body.querySelector('#log-total')
    const session = body.querySelector('#log-session')
    if (!today || !total || !session) return false
    today.textContent = formatDuration(snap.todayMs)
    total.textContent = formatDuration(snap.totalMs)
    const cur = snap.current
    session.textContent = cur
        ? `本次 ${formatDuration(cur.elapsedMs)} · 中断 ${cur.pauses} 次${cur.bookTitle ? ` · 《${cur.bookTitle}》` : ''}${cur.running ? ' · 计时中' : ' · 已暂停'}`
        : '当前没有进行中的阅读。点左上角开始，自己按下暂停。'
    return true
}
