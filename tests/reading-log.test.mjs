import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
    emptyLog, normalizeReadingLog, formatClock, formatDuration,
    startSession, pauseSession, resumeSession, endSession, toggleSession,
    tickLog, recoverLog, creditSpan, totalMs, todayMs, localDayKey, storedMs,
    startOfLocalDay, nextLocalDay, unlockAchievements, ACHIEVEMENTS,
    longestRunMs, summarize, setSessionBook, streakDays, setDailyGoal, clearReadingHistory,
} from '../js/reading-log.js'
import { normalizeSettings, DEFAULT_SETTINGS } from '../js/settings.js'

const t0 = Date.parse('2026-09-17T10:00:00+08:00')

// 真实运行时 main.js 每 1 秒 tickLog 一次，相邻两跳之间不会超过 SUSPEND_MS。
// 早先用「一次 tick 跳 30 分钟 / 9 小时」的写法把时钟直接推到目标点，那种数据在运行时不可能出现，
// 它只是恰好绕过了空洞判定；这里按小于 SUSPEND_MS 的步长推进，让用例走真实可达的时间线。
const SUSPEND_MS = 15 * 60 * 1000
function tickStepping (log, from, to, stepMs = 60_000, collect) {
    if (stepMs > SUSPEND_MS) throw new Error('步长必须小于空洞上限，否则造的是休眠空洞不是阅读')
    let t = from
    const events = []
    while (t < to) {
        t = Math.min(to, t + stepMs)
        const r = tickLog(log, t)
        r.events.forEach(e => events.push(e))
        if (collect) collect(t, r)
        if (!log.current?.running) break // 已被 run-cap 或 suspended 停住
    }
    return { events, endedAt: t }
}

test('daily goal survives clearing mistaken reading history', () => {
    const log = emptyLog()
    assert.equal(setDailyGoal(log, 30), true)
    assert.equal(setDailyGoal(log, -1), false)
    startSession(log, t0)
    tickStepping(log, t0, t0 + 30 * 60_000)
    assert.equal(log.current.elapsedMs, 30 * 60_000, '30 分钟应按秒级推进真实落账')
    assert.equal(summarize(log, t0 + 30 * 60_000).goalMet, true)
    clearReadingHistory(log)
    assert.equal(log.goalMinutes, 30)
    assert.equal(log.current, null)
    assert.deepEqual(log.days, {})
    assert.deepEqual(log.unlocked, [])
    assert.equal(normalizeReadingLog(log).goalMinutes, 30)
})

test('clock and duration formatting', () => {
    assert.equal(formatClock(0), '0:00:00')
    assert.equal(formatClock(1000), '0:00:01')
    assert.equal(formatClock(65_000), '0:01:05')
    assert.equal(formatClock(3725_000), '1:02:05')
    assert.equal(formatClock(-4), '0:00:00')
    assert.equal(formatDuration(20_000), '不足 1 分钟')
    assert.equal(formatDuration(5 * 60_000), '5 分钟')
    assert.equal(formatDuration(2 * 3600_000), '2 小时')
    assert.equal(formatDuration(2 * 3600_000 + 5 * 60_000), '2 小时 5 分')
})

test('start pause resume end records runs without pause counting', () => {
    const log = emptyLog()
    startSession(log, t0, { id: 'book-1', title: '山中的信' })
    tickLog(log, t0 + 10 * 60_000)
    pauseSession(log, t0 + 10 * 60_000)
    assert.equal(log.current.running, false)
    assert.equal(log.current.elapsedMs, 10 * 60_000)
    assert.equal(log.current.pauses, undefined, '暂停计数已按需求删除')
    assert.deepEqual(log.current.runs, [10 * 60_000])
    resumeSession(log, t0 + 12 * 60_000)
    tickLog(log, t0 + 20 * 60_000)
    const ended = endSession(log, t0 + 20 * 60_000)
    assert.equal(ended.ok, true)
    assert.equal(log.current, null)
    assert.equal(ended.session.pauses, undefined)
    assert.equal(ended.session.elapsedMs, 18 * 60_000)
    assert.deepEqual(ended.session.runs, [10 * 60_000, 8 * 60_000])
    assert.equal(longestRunMs(log, t0 + 20 * 60_000), 10 * 60_000)
})

test('toggle starts then pauses then resumes', () => {
    const log = emptyLog()
    toggleSession(log, t0)
    assert.equal(log.current.running, true)
    toggleSession(log, t0 + 1000)
    assert.equal(log.current.running, false)
    assert.equal(log.current.pauses, undefined)
    toggleSession(log, t0 + 2000)
    assert.equal(log.current.running, true)
})

test('day buckets split at local midnight', () => {
    const log = emptyLog()
    const dayEnd = nextLocalDay(t0)
    creditSpan(log, dayEnd - 30_000, dayEnd + 40_000)
    const a = localDayKey(dayEnd - 1)
    const b = localDayKey(dayEnd)
    assert.equal(log.days[a].ms, 30_000)
    assert.equal(log.days[b].ms, 40_000)
    assert.ok(a !== b)
    assert.equal(startOfLocalDay(dayEnd), dayEnd)
})

test('running tick credits today and total', () => {
    const log = emptyLog()
    startSession(log, t0)
    tickLog(log, t0 + 90_000)
    assert.equal(todayMs(log, t0 + 90_000), 90_000)
    assert.equal(totalMs(log, t0 + 90_000), 90_000)
    tickLog(log, t0 + 90_000)
    assert.equal(totalMs(log, t0 + 90_000), 90_000)
})

test('today counter rolls over at local midnight', () => {
    const log = emptyLog()
    const dayEnd = nextLocalDay(t0)
    startSession(log, dayEnd - 60_000)
    tickLog(log, dayEnd + 60_000) // 落账：creditSpan 把跨天部分分账到各自日期
    assert.equal(log.days[localDayKey(dayEnd - 60_000)].ms, 60_000, '跨天前的一分钟归昨天')
    assert.equal(log.days[localDayKey(dayEnd + 60_000)].ms, 60_000, '新一天只算 60 秒')
    assert.equal(todayMs(log, dayEnd + 60_000), 60_000)
})

test('recovering a stale running session freezes without counting the gap', () => {
    const log = emptyLog()
    startSession(log, t0)
    log.current.lastTickAt = t0
    const rec = recoverLog(log, t0 + 20 * 60_000)
    assert.equal(rec.events.includes('suspended'), true)
    assert.equal(log.current.running, false)
    assert.equal(log.current.elapsedMs, 0)
})

test('每秒 tickLog 路径遇到休眠空洞同样停住：不记账、不误解锁，且与 recoverLog 同口径', () => {
    const log = emptyLog()
    startSession(log, t0)
    tickStepping(log, t0, t0 + 3 * 60_000)          // 正常读了 3 分钟
    assert.equal(log.current.elapsedMs, 3 * 60_000)
    const unlockedBefore = log.unlocked.slice()
    // 合盖 50 分钟、标签页始终 visible（visibilitychange 不触发）；唤醒后 setInterval 的
    // 下一跳带着 Date.now() 的跳变直接进入 applyTick —— 缺陷版在这里会记满 3,000,000ms
    // 并连发 ['kaijuan','yizhan']。
    const holeEnd = t0 + 3 * 60_000 + 50 * 60_000
    const { events } = tickLog(log, holeEnd)
    assert.ok(events.includes('suspended'), `tickLog 路径必须报告 suspended，实际收到 ${JSON.stringify(events)}`)
    assert.equal(log.current.running, false, '空洞之后本次 run 必须停住')
    assert.equal(log.current.elapsedMs, 3 * 60_000, '50 分钟空洞不得计入阅读时长')
    assert.equal(storedMs(log), 3 * 60_000)
    assert.equal(todayMs(log, holeEnd), 3 * 60_000)
    assert.deepEqual(log.unlocked, unlockedBefore, '空洞不得解锁成就（3 分钟远不到 10 分钟的开卷）')
    assert.ok(!events.includes('kaijuan') && !events.includes('yizhan'))

    // 同一条判定：同一份数据走 recoverLog 得到完全一致的结果
    const log2 = emptyLog()
    startSession(log2, t0)
    tickStepping(log2, t0, t0 + 3 * 60_000)
    const rec = recoverLog(log2, holeEnd)
    assert.ok(rec.events.includes('suspended'))
    assert.equal(log2.current.elapsedMs, log.current.elapsedMs)
    assert.equal(storedMs(log2), storedMs(log))
    assert.equal(log2.current.running, false)

    // 空洞停住后再继续读，账本从实际读的那 3 分钟接着走，不被空洞污染
    resumeSession(log, holeEnd + 60_000)
    tickStepping(log, holeEnd + 60_000, holeEnd + 9 * 60_000)
    assert.equal(log.current.elapsedMs, 3 * 60_000 + 8 * 60_000)
})

test('空洞判定只卡跳跃，不卡连续的秒级计时', () => {
    const log = emptyLog()
    startSession(log, t0)
    // 15 分钟整点边界：<= SUSPEND_MS 仍应照常落账
    for (let s = 1; s <= 60; s++) tickLog(log, t0 + s * 15_000)
    assert.equal(log.current.running, true)
    assert.equal(log.current.elapsedMs, 60 * 15_000)
    assert.equal(todayMs(log, t0 + 60 * 15_000), 15 * 60_000)
    // 刚好越过上限：停住
    const { events } = tickLog(log, t0 + 60 * 15_000 + SUSPEND_MS + 1)
    assert.ok(events.includes('suspended'))
    assert.equal(log.current.elapsedMs, 15 * 60_000, '越界那一跳本身也不记账')
})

test('short refresh gap continues the same run', () => {
    const log = emptyLog()
    startSession(log, t0)
    recoverLog(log, t0 + 2000)
    assert.equal(log.current.running, true)
    assert.equal(log.current.elapsedMs, 2000)
})

test('eight hour single run auto pauses as a safety cap', () => {
    const log = emptyLog()
    startSession(log, t0)
    // 8 小时封顶只能由连续的秒级计时攒出来（运行时没有单次 9 小时的 tick），
    // 5 分钟一步、每步都远小于空洞上限。
    const { events, endedAt } = tickStepping(log, t0, t0 + 9 * 3600_000, 5 * 60_000)
    assert.equal(events.includes('run-cap'), true, '连续满 8 小时应触发 run-cap')
    assert.equal(log.current.running, false)
    assert.equal(log.current.elapsedMs, 8 * 3600_000)
    assert.equal(endedAt, t0 + 8 * 3600_000, '封顶应正好落在连续计时满 8 小时那一步')
    assert.equal(todayMs(log, t0), 8 * 3600_000, '封顶后超出部分不追记')
    assert.deepEqual(log.current.runs, [8 * 3600_000])
})

test('achievements unlock by cumulative time and stay after normalize', () => {
    const log = emptyLog()
    startSession(log, t0)
    tickLog(log, t0 + 10 * 60_000)
    assert.ok(log.unlocked.includes('kaijuan'))
    assert.ok(!log.unlocked.includes('yizhan'))
    const again = unlockAchievements(log, t0 + 10 * 60_000)
    assert.deepEqual(again, [])
    const copy = normalizeReadingLog(JSON.parse(JSON.stringify(log)))
    assert.ok(copy.unlocked.includes('kaijuan'))
    assert.equal(ACHIEVEMENTS[0].id, 'kaijuan')
    assert.equal(ACHIEVEMENTS.length, 9)
    for (const a of ACHIEVEMENTS) assert.match(a.image, /^assets\/achievements\/[a-z]+\.jpg$/)
})

test('malformed log and settings do not touch defaults; legacy pause fields are dropped', () => {
    const before = JSON.stringify(DEFAULT_SETTINGS)
    const log = normalizeReadingLog({ current: 'x', days: { bad: 1, '2026-09-17': { ms: -3, pauses: 'n' } }, sessions: [{ id: 1, pauses: 5 }], unlocked: ['nope', 'kaijuan'] })
    assert.equal(log.current, null)
    assert.equal(log.days['2026-09-17'].ms, 0)
    assert.equal('pauses' in log.days['2026-09-17'], false)
    assert.equal(log.sessions[0].pauses, undefined)
    assert.deepEqual(log.unlocked, ['kaijuan'])
    const s = normalizeSettings({ readingLog: { unlocked: ['kaijuan'], current: { running: true, elapsedMs: 12 } } })
    assert.equal(s.readingLog.current.running, true)
    assert.equal(s.readingLog.current.elapsedMs, 12)
    assert.equal(JSON.stringify(DEFAULT_SETTINGS), before)
})

test('setSessionBook only fills an empty book on the current sitting', () => {
    const log = emptyLog()
    startSession(log, t0)
    setSessionBook(log, { id: 'book-1', title: '第一本' })
    assert.equal(log.current.bookTitle, '第一本')
    setSessionBook(log, { id: 'book-2', title: '第二本' })
    assert.equal(log.current.bookId, 'book-1')
})

test('summarize exposes days, streak and next name', () => {
    const log = emptyLog()
    const day = 86400000
    // 昨天与前天各读了一些，今天 30 分钟：连续 3 天
    creditSpan(log, t0 - 2 * day, t0 - 2 * day + 20 * 60_000)
    creditSpan(log, t0 - day, t0 - day + 10 * 60_000)
    creditSpan(log, t0, t0 + 30 * 60_000)
    startSession(log, t0 + 40 * 60_000, { id: 'a', title: '甲' })
    tickStepping(log, t0 + 40 * 60_000, t0 + 70 * 60_000)
    endSession(log, t0 + 71 * 60_000)
    const snap = summarize(log, t0 + 71 * 60_000)
    assert.equal(snap.streak, 3)
    assert.equal(snap.totalMs, 91 * 60_000, '20+10+30+30+1 分钟，逐秒推进下应真实攒到 91 分钟')
    assert.equal(snap.days[localDayKey(t0)].ms, 61 * 60_000)
    assert.equal(snap.next.id, 'dengxia', '累计 91 分钟已过 60 分钟档')
    assert.ok(snap.achievements.find(a => a.id === 'yizhan').unlocked)
    assert.equal(snap.recent[0].bookTitle, '甲')
    assert.equal(snap.pauses, undefined, '暂停统计已删除')
    // 今天中断阅读后隔天再算：streak 不把未读的今天算进去（从昨天回溯）
    const tomorrow = t0 + day + 60_000
    assert.equal(streakDays(log, tomorrow), 3)
})

// ── 审计第 12 条：截断方向、时区口径、三个_ms 自洽、图片真实存在 ──────────

test('跨零点：storedMs / totalMs / todayMs 三个口径自洽，running 时只补未落账的尾差', () => {
    const log = emptyLog()
    const dayEnd = nextLocalDay(t0)
    startSession(log, dayEnd - 30 * 60_000)                    // 23:30 开读
    tickStepping(log, dayEnd - 30 * 60_000, dayEnd + 30 * 60_000)  // 读到次日 00:30
    const now = dayEnd + 30 * 60_000
    assert.equal(log.days[localDayKey(dayEnd - 1)].ms, 30 * 60_000, '跨零点前的半小时归昨天')
    assert.equal(log.days[localDayKey(dayEnd)].ms, 30 * 60_000, '新的一天只算半小时')
    assert.equal(storedMs(log), 60 * 60_000)
    assert.equal(totalMs(log, now), storedMs(log), 'lastTickAt 已追平 now 时不该再补活口')
    assert.equal(todayMs(log, now), 30 * 60_000)
    // 再放一分钟未落账的尾差：total 与 today 都只多这一分钟，不重复计
    tickLog(log, now + 60_000)
    assert.equal(totalMs(log, now + 60_000), 61 * 60_000)
    assert.equal(todayMs(log, now + 60_000), 31 * 60_000)
    // localDayKey 必须跟着本地日历走，不能写成 UTC
    const d = new Date(dayEnd)
    assert.equal(localDayKey(dayEnd), `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    assert.match(localDayKey(dayEnd), /^\d{4}-\d{2}-\d{2}$/, 'localDayKey 必须落在 DAY_KEY 白名单格式里')
    assert.equal(localDayKey(dayEnd), new Intl.DateTimeFormat('en-CA', {
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).format(d), 'localDayKey 应与本地日历一致（不是 UTC 口径）')
    assert.equal(startOfLocalDay(dayEnd), dayEnd, 'nextLocalDay 与 startOfLocalDay 互逆')
})

test('runs / sessions 截断方向一致：都保留最近的，不把最新成果丢掉', () => {
    const runs = Array.from({ length: 250 }, (_, i) => 1000 + i)
    const normalized = normalizeReadingLog({
        current: { id: 'c', startedAt: t0, elapsedMs: 0, runs, running: false, lastTickAt: t0, runStartedAt: t0 },
    })
    assert.equal(normalized.current.runs.length, 200)
    assert.equal(normalized.current.runs[0], 1050, '应丢掉最老的 50 段而不是最新的')
    assert.equal(normalized.current.runs.at(-1), 1249, '最新的 run 必须留着')
    assert.equal(longestRunMs(normalized, t0), 1249, '最长的（最近的）run 不能因截断而丢')
    const sessions = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, startedAt: t0 + i, elapsedMs: 1000 }))
    const n2 = normalizeReadingLog({ sessions })
    assert.equal(n2.sessions.length, 200)
    assert.equal(n2.sessions[0].id, 's50')
    assert.equal(n2.sessions.at(-1).id, 's249')
})

test('空洞判定不会把跨天的 run 记错天：封顶发生在哪一天就归哪一天', () => {
    const log = emptyLog()
    const dayEnd = nextLocalDay(t0)
    startSession(log, dayEnd - 10 * 60_000)              // 23:50 开读
    tickLog(log, dayEnd - 5 * 60_000)                    // 正常 5 分钟
    const { events } = tickLog(log, dayEnd + 5 * 60_000 + 50 * 60_000)  // 跨零点 + 55 分钟空洞
    assert.ok(events.includes('suspended'))
    assert.equal(log.days[localDayKey(dayEnd - 1)].ms, 5 * 60_000, '昨天只记实际读的 5 分钟')
    assert.equal(log.days[localDayKey(dayEnd + 5 * 60_000)], undefined, '空洞那侧不该出现新的一天')
    assert.equal(storedMs(log), 5 * 60_000)
})

test('成就图片文件真实存在，点开不是碎图', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    assert.equal(ACHIEVEMENTS.length, 9)
    for (const a of ACHIEVEMENTS) {
        const p = resolve(root, a.image)
        assert.ok(existsSync(p), `缺少成就图片：${a.image}`)
        assert.ok(readFileSync(p).length > 1000, `${a.image} 小得异常，可能是占位文件`)
    }
})
