// 阅读计时与成就 v2.0.0：按「自然日」记账，左上角展示今日累计（24 点自动翻新）。
// v2.0.0：按用户要求删除暂停计数——前后台都不再记录暂停次数；隐藏/退出自动真暂停不计时。
// 数据随设置备份；本模块无 DOM，可供 node:test 直接调用。

export const ACHIEVEMENTS = Object.freeze([
    { id: 'kaijuan', ms: 10 * 60 * 1000, name: '开卷', need: '累计 10 分钟', line: '坐下来，翻开第一页。', image: 'assets/achievements/kaijuan.jpg' },
    { id: 'yizhan', ms: 30 * 60 * 1000, name: '一盏茶', need: '累计 30 分钟', line: '一盏茶的工夫，字已落进心里。', image: 'assets/achievements/yizhan.jpg' },
    { id: 'banjuan', ms: 60 * 60 * 1000, name: '半卷', need: '累计 1 小时', line: '半卷在手，窗外还在下雨。', image: 'assets/achievements/banjuan.jpg' },
    { id: 'dengxia', ms: 3 * 60 * 60 * 1000, name: '灯下', need: '累计 3 小时', line: '灯还亮着，人还在书里。', image: 'assets/achievements/dengxia.jpg' },
    { id: 'yedu', ms: 8 * 60 * 60 * 1000, name: '夜读', need: '累计 8 小时', line: '一夜的安静，都给了这几页。', image: 'assets/achievements/yedu.jpg' },
    { id: 'zhouye', ms: 24 * 60 * 60 * 1000, name: '一昼夜', need: '累计 24 小时', line: '一个昼夜的时辰，叠成自己的课。', image: 'assets/achievements/zhouye.jpg' },
    { id: 'shijuan', ms: 50 * 60 * 60 * 1000, name: '十卷', need: '累计 50 小时', line: '五十个小时，已经不是偶然坐下。', image: 'assets/achievements/shijuan.jpg' },
    { id: 'baiye', ms: 100 * 60 * 60 * 1000, name: '百夜', need: '累计 100 小时', line: '百夜灯火，书声未歇。', image: 'assets/achievements/baiye.jpg' },
    { id: 'suidu', ms: 365 * 60 * 60 * 1000, name: '岁读', need: '累计 365 小时', line: '一年的光阴，有一部分只属于阅读。', image: 'assets/achievements/suidu.jpg' },
])

const MAX_SESSIONS = 200
const MAX_DAYS = 400
const MAX_RUNS = 200
const SUSPEND_MS = 15 * 60 * 1000
const RUN_CAP_MS = 8 * 60 * 60 * 1000
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/
const ID = /^[a-zA-Z0-9:_-]{1,120}$/

const object = x => x && typeof x === 'object' && !Array.isArray(x) ? x : null
const finite = (x, fallback = 0) => typeof x === 'number' && Number.isFinite(x) ? x : fallback
const nonneg = (x, fallback = 0) => Math.max(0, finite(x, fallback))
const intNonneg = (x, fallback = 0) => Math.max(0, Math.floor(nonneg(x, fallback)))
const clip = (s, max = 200) => typeof s === 'string' ? s.slice(0, max) : ''

export function emptyLog () {
    return { current: null, days: {}, sessions: [], unlocked: [], goalMinutes: 0 }
}

export function setDailyGoal (log, minutes) {
    const value = Number(minutes)
    if (!Number.isInteger(value) || value < 0 || value > 1440) return false
    log.goalMinutes = value
    return true
}

export function clearReadingHistory (log) {
    const goalMinutes = log.goalMinutes || 0
    Object.assign(log, emptyLog(), { goalMinutes })
}

export function localDayKey (ts = Date.now()) {
    const d = new Date(ts)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
}

export function startOfLocalDay (ts) {
    const d = new Date(ts)
    d.setHours(0, 0, 0, 0)
    return d.getTime()
}

export function nextLocalDay (ts) {
    const d = new Date(startOfLocalDay(ts))
    d.setDate(d.getDate() + 1)
    return d.getTime()
}

export function formatClock (ms) {
    const n = Math.max(0, Math.floor(nonneg(ms) / 1000))
    const h = Math.floor(n / 3600)
    const m = Math.floor((n % 3600) / 60)
    const s = n % 60
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function formatDuration (ms) {
    const n = Math.max(0, Math.floor(nonneg(ms) / 1000))
    if (n < 60) return '不足 1 分钟'
    const h = Math.floor(n / 3600)
    const m = Math.floor((n % 3600) / 60)
    if (!h) return `${m} 分钟`
    if (!m) return `${h} 小时`
    return `${h} 小时 ${m} 分`
}

function newId () {
    try { return crypto.randomUUID() } catch { return 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8) }
}

function normalizeRuns (list) {
    if (!Array.isArray(list)) return []
    return list.slice(0, MAX_RUNS).map(x => nonneg(x)).filter(x => x > 0)
}

function normalizeSession (raw, ended) {
    const src = object(raw)
    if (!src) return null
    const id = ID.test(src.id) ? src.id : newId()
    const startedAt = intNonneg(src.startedAt, Date.now())
    const elapsedMs = intNonneg(src.elapsedMs)
    const bookId = ID.test(src.bookId) ? src.bookId : ''
    const bookTitle = clip(src.bookTitle, 200)
    const runs = normalizeRuns(src.runs)
    if (ended) {
        return { id, startedAt, endedAt: intNonneg(src.endedAt, startedAt + elapsedMs), elapsedMs, bookId, bookTitle, runs }
    }
    return {
        id, startedAt, elapsedMs, bookId, bookTitle, runs,
        running: src.running === true,
        lastTickAt: intNonneg(src.lastTickAt, startedAt),
        runStartedAt: intNonneg(src.runStartedAt, startedAt),
    }
}

function normalizeDays (raw) {
    const src = object(raw) || {}
    const out = {}
    for (const [key, val] of Object.entries(src)) {
        if (!DAY_KEY.test(key)) continue
        const d = object(val)
        if (!d) continue
        out[key] = { ms: intNonneg(d.ms) }
    }
    return pruneDays(out)
}

function pruneDays (days, now = Date.now()) {
    const keys = Object.keys(days).sort()
    if (keys.length <= MAX_DAYS) return days
    const cutoff = localDayKey(now - MAX_DAYS * 86400000)
    const out = {}
    for (const key of keys) if (key >= cutoff) out[key] = days[key]
    const kept = Object.keys(out).sort()
    if (kept.length > MAX_DAYS) for (const key of kept.slice(0, kept.length - MAX_DAYS)) delete out[key]
    return out
}

export function normalizeReadingLog (raw) {
    const src = object(raw) || {}
    const unlocked = Array.isArray(src.unlocked)
        ? [...new Set(src.unlocked.filter(id => ACHIEVEMENTS.some(a => a.id === id)))]
        : []
    const sessions = Array.isArray(src.sessions)
        ? src.sessions.map(s => normalizeSession(s, true)).filter(Boolean).slice(-MAX_SESSIONS)
        : []
    return {
        current: normalizeSession(src.current, false),
        days: normalizeDays(src.days),
        sessions,
        unlocked,
        goalMinutes: Number.isInteger(src.goalMinutes) && src.goalMinutes >= 0 && src.goalMinutes <= 1440 ? src.goalMinutes : 0,
    }
}

function ensureDay (log, key) {
    if (!log.days[key]) log.days[key] = { ms: 0 }
    return log.days[key]
}

export function creditSpan (log, from, to) {
    let t = from
    const end = Math.max(from, to)
    while (t < end) {
        const next = nextLocalDay(t)
        const chunk = Math.min(end, next)
        ensureDay(log, localDayKey(t)).ms += chunk - t
        t = chunk
    }
}

export function liveElapsed (current, now) {
    if (!current) return 0
    if (!current.running) return current.elapsedMs
    return current.elapsedMs + Math.max(0, now - current.lastTickAt)
}

export function liveRunMs (current, now) {
    if (!current) return 0
    if (!current.running) return 0
    return Math.max(0, now - current.runStartedAt)
}

function applyTick (log, now) {
    const cur = log.current
    if (!cur?.running) return []
    const from = cur.lastTickAt
    if (now <= from) return []
    let creditTo = now
    const runMs = (now - cur.runStartedAt)
    let capped = false
    if (runMs >= RUN_CAP_MS) {
        creditTo = cur.runStartedAt + RUN_CAP_MS
        capped = true
    }
    const delta = Math.max(0, creditTo - from)
    cur.elapsedMs += delta
    creditSpan(log, from, creditTo)
    cur.lastTickAt = creditTo
    if (!capped) return []
    // 单段连续计时满 8 小时：自动暂停一次，避免忘记关掉。
    closeRun(cur, creditTo)
    cur.running = false
    return ['run-cap']
}

function closeRun (cur, now) {
    const ms = Math.max(0, (cur.running ? now : cur.lastTickAt) - cur.runStartedAt)
    if (ms > 0) cur.runs.push(ms)
    if (cur.runs.length > MAX_RUNS) cur.runs = cur.runs.slice(-MAX_RUNS)
}

export function recoverLog (log, now = Date.now()) {
    const cur = log.current
    if (!cur?.running) return { events: [] }
    const gap = now - cur.lastTickAt
    if (gap > SUSPEND_MS) {
        cur.running = false
        return { events: ['suspended'] }
    }
    return { events: applyTick(log, now) }
}

export function startSession (log, now = Date.now(), book = null) {
    if (log.current?.running) return { ok: false, reason: 'running' }
    if (log.current && !log.current.running) return resumeSession(log, now)
    const id = newId()
    log.current = {
        id,
        startedAt: now,
        elapsedMs: 0,
        bookId: book?.id && ID.test(book.id) ? book.id : '',
        bookTitle: clip(book?.title, 200),
        runs: [],
        running: true,
        lastTickAt: now,
        runStartedAt: now,
    }
    return { ok: true, events: unlockAchievements(log, now) }
}

export function pauseSession (log, now = Date.now()) {
    const cur = log.current
    if (!cur?.running) return { ok: false, reason: 'idle' }
    const events = applyTick(log, now)
    if (cur.running) {
        closeRun(cur, now)
        cur.running = false
        cur.lastTickAt = now
    }
    return { ok: true, events: events.concat(unlockAchievements(log, now)) }
}

export function resumeSession (log, now = Date.now()) {
    const cur = log.current
    if (!cur) return startSession(log, now)
    if (cur.running) return { ok: false, reason: 'running' }
    cur.running = true
    cur.lastTickAt = now
    cur.runStartedAt = now
    return { ok: true, events: [] }
}

export function endSession (log, now = Date.now()) {
    const cur = log.current
    if (!cur) return { ok: false, reason: 'idle' }
    if (cur.running) {
        applyTick(log, now)
        if (cur.running) closeRun(cur, now)
    }
    const session = {
        id: cur.id,
        startedAt: cur.startedAt,
        endedAt: now,
        elapsedMs: cur.elapsedMs,
        bookId: cur.bookId,
        bookTitle: cur.bookTitle,
        runs: cur.runs.slice(),
    }
    log.sessions.push(session)
    if (log.sessions.length > MAX_SESSIONS) log.sessions = log.sessions.slice(-MAX_SESSIONS)
    log.current = null
    log.days = pruneDays(log.days, now)
    return { ok: true, session, events: unlockAchievements(log, now) }
}

export function toggleSession (log, now = Date.now(), book = null) {
    if (!log.current) return startSession(log, now, book)
    if (log.current.running) return pauseSession(log, now)
    return resumeSession(log, now)
}

export function setSessionBook (log, book) {
    const cur = log.current
    if (!cur || !book) return
    if (!cur.bookId && book.id && ID.test(book.id)) {
        cur.bookId = book.id
        cur.bookTitle = clip(book.title, 200)
    }
}

export function tickLog (log, now = Date.now()) {
    const events = applyTick(log, now)
    events.push(...unlockAchievements(log, now))
    return { events }
}

export function storedMs (log) {
    let total = 0
    for (const day of Object.values(log.days)) total += day.ms || 0
    return total
}

export function totalMs (log, now = Date.now()) {
    const cur = log.current
    if (!cur?.running) return storedMs(log)
    // days already include elapsed up to lastTickAt; add the unsaved live gap
    return storedMs(log) + Math.max(0, now - cur.lastTickAt)
}

export function todayMs (log, now = Date.now()) {
    const key = localDayKey(now)
    const stored = log.days[key]?.ms || 0
    const cur = log.current
    if (!cur?.running) return stored
    // 跨过 24 点：日期键换成新的一天，这里自然从 0 重新累计；
    // 未落账的跨天尾差由下一次 applyTick 经 creditSpan 归入昨天
    return stored + Math.max(0, now - cur.lastTickAt)
}

export function unlockAchievements (log, now = Date.now()) {
    const total = totalMs(log, now)
    const fresh = []
    for (const a of ACHIEVEMENTS) {
        if (total >= a.ms && !log.unlocked.includes(a.id)) {
            log.unlocked.push(a.id)
            fresh.push(a.id)
        }
    }
    return fresh
}

export function longestRunMs (log, now = Date.now()) {
    let max = 0
    const consider = runs => { for (const n of runs || []) if (n > max) max = n }
    for (const s of log.sessions) consider(s.runs)
    const cur = log.current
    if (cur) {
        consider(cur.runs)
        if (cur.running) max = Math.max(max, liveRunMs(cur, now))
    }
    return max
}

// 连续阅读天数：从今天（若今天还没读则从昨天）往回数，每天 ms>0 才算，断一天即断
export function streakDays (log, now = Date.now()) {
    let dayStart = startOfLocalDay(now)
    if (!(log.days[localDayKey(dayStart)]?.ms > 0)) dayStart -= 86400000
    let streak = 0
    for (;;) {
        if (!(log.days[localDayKey(dayStart)]?.ms > 0)) break
        streak++
        dayStart -= 86400000
    }
    return streak
}

export function summarize (log, now = Date.now()) {
    const cur = log.current
    const total = totalMs(log, now)
    const today = todayMs(log, now)
    const achievements = ACHIEVEMENTS.map(a => ({
        ...a,
        unlocked: log.unlocked.includes(a.id),
        remainMs: Math.max(0, a.ms - total),
    }))
    const next = achievements.find(a => !a.unlocked) || null
    const recent = [...log.sessions].reverse().slice(0, 12)
    return {
        now,
        todayMs: today,
        goalMinutes: log.goalMinutes || 0,
        goalMet: (log.goalMinutes || 0) > 0 && today >= log.goalMinutes * 60000,
        totalMs: total,
        days: { ...log.days },
        streak: streakDays(log, now),
        current: cur ? {
            ...cur,
            elapsedMs: liveElapsed(cur, now),
            runMs: liveRunMs(cur, now),
        } : null,
        longestRunMs: longestRunMs(log, now),
        recent,
        achievements,
        next,
    }
}
