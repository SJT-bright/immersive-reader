import test from 'node:test'
import assert from 'node:assert/strict'
import {
    emptyLog, normalizeReadingLog, formatClock, formatDuration,
    startSession, pauseSession, resumeSession, endSession, toggleSession,
    tickLog, recoverLog, creditSpan, totalMs, todayMs, localDayKey,
    startOfLocalDay, nextLocalDay, unlockAchievements, ACHIEVEMENTS,
    longestRunMs, summarize, setSessionBook, streakDays, setDailyGoal, clearReadingHistory,
} from '../js/reading-log.js'
import { normalizeSettings, DEFAULT_SETTINGS } from '../js/settings.js'

const t0 = Date.parse('2026-09-17T10:00:00+08:00')

test('daily goal survives clearing mistaken reading history', () => {
    const log = emptyLog()
    assert.equal(setDailyGoal(log, 30), true)
    assert.equal(setDailyGoal(log, -1), false)
    startSession(log, t0)
    tickLog(log, t0 + 30 * 60_000)
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
    const events = tickLog(log, t0 + 9 * 3600_000).events
    assert.equal(events.includes('run-cap'), true)
    assert.equal(log.current.running, false)
    assert.equal(log.current.elapsedMs, 8 * 3600_000)
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
    tickLog(log, t0 + 70 * 60_000)
    endSession(log, t0 + 71 * 60_000)
    const snap = summarize(log, t0 + 71 * 60_000)
    assert.equal(snap.streak, 3)
    assert.equal(snap.days[localDayKey(t0)].ms > 0, true)
    assert.equal(snap.next.id, 'dengxia', '累计 91 分钟已过 60 分钟档')
    assert.ok(snap.achievements.find(a => a.id === 'yizhan').unlocked)
    assert.equal(snap.recent[0].bookTitle, '甲')
    assert.equal(snap.pauses, undefined, '暂停统计已删除')
    // 今天中断阅读后隔天再算：streak 不把未读的今天算进去（从昨天回溯）
    const tomorrow = t0 + day + 60_000
    assert.equal(streakDays(log, tomorrow), 3)
})
