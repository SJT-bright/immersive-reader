// 已读页进度模型（js/reading-stats.js）单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeRanges, addRange, coverageOf, sectionSizesFrom,
    readFraction, initReadMapFromPercent, sanitizeReadMap,
    DwellMeter, PAGE_DWELL_MS, DWELL_TICK_MS, DWELL_MAX_GAP_MS, DWELL_BAND_TOLERANCE,
} from '../js/reading-stats.js'

test('normalizeRanges 排序合并相邻与重叠区间并裁剪到 [0,1]', () => {
    assert.deepEqual(normalizeRanges([[0.5, 0.7], [0.1, 0.3], [0.3, 0.4]]),
        [[0.1, 0.4], [0.5, 0.7]])
    assert.deepEqual(normalizeRanges([[0.2, 0.8], [0.4, 0.6]]), [[0.2, 0.8]])
    assert.deepEqual(normalizeRanges([[-0.2, 0.3], [0.9, 1.5]]), [[0, 0.3], [0.9, 1]])
    assert.deepEqual(normalizeRanges([[0.5, 0.5], [0.7, 0.6], null, 'x']), [])
})

test('addRange 记录页区间；重复覆盖返回原对象', () => {
    let map = {}
    map = addRange(map, 3, 0, 0.25)
    assert.deepEqual(map, { 3: [[0, 0.25]] })
    const same = addRange(map, 3, 0.1, 0.2) // 被既有区间包含
    assert.equal(same, map)
    map = addRange(map, 3, 0.25, 0.5)
    assert.deepEqual(map, { 3: [[0, 0.5]] })
    map = addRange(map, 1, 0, 1)
    assert.deepEqual(map, { 1: [[0, 1]], 3: [[0, 0.5]] })
    assert.equal(addRange(map, -1, 0, 1), map) // 非法 index 原样返回
})

test('coverageOf 统计区间覆盖长度', () => {
    assert.equal(coverageOf([[0.1, 0.3], [0.5, 0.8]]), 0.5)
    assert.equal(coverageOf([[0, 1]]), 1)
    assert.equal(coverageOf([]), 0)
    assert.equal(coverageOf(undefined), 0)
})

test('sectionSizesFrom 沿用 foliate 权重规则', () => {
    assert.deepEqual(sectionSizesFrom([
        { size: 100 }, { size: 0 }, { size: 50, linear: 'no' }, { size: 200 },
    ]), [100, 0, 0, 200])
    assert.deepEqual(sectionSizesFrom(null), [])
})

test('readFraction 加权已读比例：跳过的 section 不计入', () => {
    const sizes = [100, 100, 100, 100] // sizeTotal=400
    const readMap = { 0: [[0, 1]], 3: [[0, 1]] } // 读了第 1、4 章，跳过 2、3
    assert.equal(readFraction(readMap, sizes), 0.5)
    assert.equal(readFraction({ 1: [[0, 0.5]] }, sizes), 0.125) // 半章
    assert.equal(readFraction({}, sizes), 0)
    assert.equal(readFraction({ 0: [[0, 1]] }, [0, 0, 0]), 0) // 全零权重
    assert.equal(readFraction(null, sizes), 0)
})

test('readFraction 字符串键兼容（JSON 反序列化）', () => {
    assert.equal(readFraction({ '2': [[0, 1]] }, [1, 1, 1]), 1 / 3)
})

test('initReadMapFromPercent 旧位置比例迁移', () => {
    const sizes = [100, 100, 100]
    // 25% 全书位置 = 第 1 章 75% 处 → 第 1 章前 75% 已读
    assert.deepEqual(initReadMapFromPercent(0.25, sizes), { 0: [[0, 0.75]] })
    // 40% → 第 1 章全读 + 第 2 章前 20%
    assert.deepEqual(initReadMapFromPercent(0.4, sizes), { 0: [[0, 1]], 1: [[0, 0.2]] })
    // 50% → 第 1 章全读 + 第 2 章半读
    assert.deepEqual(initReadMapFromPercent(0.5, sizes), { 0: [[0, 1]], 1: [[0, 0.5]] })
    // 100% → 全书
    assert.deepEqual(initReadMapFromPercent(1, sizes), { 0: [[0, 1]], 1: [[0, 1]], 2: [[0, 1]] })
    // 0 / 空权重 → 空
    assert.deepEqual(initReadMapFromPercent(0, sizes), {})
    assert.deepEqual(initReadMapFromPercent(0.5, []), {})
    assert.deepEqual(initReadMapFromPercent(0.5, [0, 0]), {})
})

test('initReadMapFromPercent 迁移结果与 readFraction 自洽', () => {
    const sizes = [100, 100, 100, 100]
    for (const p of [0, 0.1, 0.35, 0.5, 0.77, 1]) {
        const map = initReadMapFromPercent(p, sizes)
        assert.ok(Math.abs(readFraction(map, sizes) - p) < 1e-9, `迁移 ${p} 应保持等值`)
    }
})

test('sanitizeReadMap 结构校验', () => {
    assert.equal(sanitizeReadMap(null), null)
    assert.equal(sanitizeReadMap('x'), null)
    assert.equal(sanitizeReadMap([[0, 1]]), null)
    assert.equal(sanitizeReadMap({}), null)
    assert.deepEqual(sanitizeReadMap({ 1: [[0, 0.5]], x: [[0, 1]], 2: [] }), { 1: [[0, 0.5]] })
    assert.deepEqual(sanitizeReadMap({ '3': [[0.9, 0.95], [0.1, 0.2]] }), { 3: [[0.1, 0.2], [0.9, 0.95]] })
})

test('端到端口径：跳读场景进度只算已读页', () => {
    // PDF 书：每页一个 section，size 全 1
    const sizes = Array.from({ length: 10 }, () => 1)
    let map = {}
    // 顺序读 1-3 页（每页整屏 = 全覆盖）
    for (const i of [0, 1, 2]) map = addRange(map, i, 0, 1)
    assert.equal(readFraction(map, sizes), 0.3)
    // 从目录直接跳到第 10 页：只有第 10 页变已读
    map = addRange(map, 9, 0, 1)
    assert.equal(readFraction(map, sizes), 0.4)
    // 回到第 5 页补读
    map = addRange(map, 4, 0, 1)
    assert.equal(readFraction(map, sizes), 0.5)
})

test('端到端口径：长章节部分阅读', () => {
    // TXT 章：section 0 有 20 屏页，读了前 3 屏（每屏 1/20）
    const sizes = [20, 20]
    let map = {}
    map = addRange(map, 0, 0, 0.05)  // 第 1 屏 [0, 1/20]
    map = addRange(map, 0, 0.05, 0.1) // 第 2 屏
    map = addRange(map, 0, 0.1, 0.15) // 第 3 屏
    assert.ok(Math.abs(readFraction(map, sizes) - 0.075) < 1e-9)
    // 跳到第 2 章末页（第 20 屏）
    map = addRange(map, 1, 0.95, 1)
    assert.ok(Math.abs(readFraction(map, sizes) - (0.15 + 0.05) / 2) < 1e-9)
})

// ── 停留计时（读满 30 秒才算一页）───────────────────────────────
// 产品规则：进入一页不等于读过这一页，必须连续停留满 PAGE_DWELL_MS 才计入。
// 时间由用例注入（now 参数），所以这些用例毫秒级跑完，不需要真的等 30 秒。
const TICK = DWELL_TICK_MS

// 从 fromMs 起，每 TICK 采样一次同一屏，返回途中产生的全部计入
function dwellOn (meter, index, a, b, fromMs, seconds, discrete = true) {
    const commits = []
    for (let i = 0; i <= seconds; i++) commits.push(...meter.observe(index, a, b, fromMs + i * TICK, discrete))
    return commits
}

test('PAGE_DWELL_MS 是产品规则的 30 秒，采样间隔 1 秒', () => {
    assert.equal(PAGE_DWELL_MS, 30_000)
    assert.equal(DWELL_TICK_MS, 1_000)
    assert.ok(DWELL_MAX_GAP_MS >= DWELL_TICK_MS)
    assert.ok(DWELL_BAND_TOLERANCE > 1)
})

test('DwellMeter 分页：不满 30s 就换屏不计入，读满 30s 的那一屏才计入', () => {
    const meter = new DwellMeter()
    // 第 1 屏只停 19s → 换第 2 屏
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 0, 19), [])
    assert.equal(meter.pending.elapsed, 19_000)
    // 换屏取消旧计时：第 2 屏要重新数满 30s
    assert.deepEqual(dwellOn(meter, 0, 0.05, 0.1, 20_000, 25), []) // 20s..45s，含换屏那一次
    assert.equal(meter.pending.elapsed, 25_000)
    const commits = dwellOn(meter, 0, 0.05, 0.1, 46_000, 5)       // 46s..51s → 累计满 30s
    assert.deepEqual(commits, [[0, 0.05, 0.1]])
    assert.equal(meter.pending.credited, undefined) // pending 只暴露累计值，内部计数不外泄
})

test('DwellMeter 分页：停留刚满 30 秒即计入，早一秒都不算', () => {
    const meter = new DwellMeter()
    assert.deepEqual(dwellOn(meter, 2, 0.4, 0.45, 1_000, 28), []) // 到 29s
    assert.deepEqual(dwellOn(meter, 2, 0.4, 0.45, 30_000, 0), []) // 30s 这一次累计 29s
    const late = dwellOn(meter, 2, 0.4, 0.45, 31_000, 0)          // 31s 这一次累计满 30s
    assert.deepEqual(late, [[2, 0.4, 0.45]])
})

test('DwellMeter 分页：原地久读会重复命中同一屏，交给 addRange 幂等去重', () => {
    const meter = new DwellMeter()
    const commits = dwellOn(meter, 0, 0, 0.05, 0, 75) // 75 秒
    assert.ok(commits.length >= 2)
    assert.ok(commits.every(c => JSON.stringify(c) === JSON.stringify([0, 0, 0.05])))
    let map = {}
    for (const [index, a, b] of commits) {
        const next = addRange(map, index, a, b)
        if (next !== map) map = next
    }
    assert.deepEqual(map, { 0: [[0, 0.05]] }) // 覆盖没有二次增长
})

test('DwellMeter 换章取消旧屏计时，新章重新数满 30s', () => {
    const meter = new DwellMeter()
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 0, 20), [])
    // 点目录跳到第 3 章：第 0 章的 20s 作废
    assert.deepEqual(dwellOn(meter, 3, 0, 0.05, 21_000, 20), [])
    const commits = dwellOn(meter, 3, 0, 0.05, 42_000, 10)
    assert.deepEqual(commits, [[3, 0, 0.05]])
})

test('DwellMeter 页面隐藏期间不累积时长，恢复可见后继续累计', () => {
    const meter = new DwellMeter()
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 0, 10), [])       // 读了 10s
    meter.pause(11_000)
    // 挂着不管的 3 分钟：定时器照跑，但一秒都不算
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 12_000, 180), [])
    assert.equal(meter.pending.elapsed, 10_000)
    assert.equal(meter.paused, true)
    meter.resume(200_000)
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 201_000, 14), []) // 只补到 25s
    const commits = dwellOn(meter, 0, 0, 0.05, 216_000, 5)        // 20s 起算满 30s
    assert.deepEqual(commits, [[0, 0, 0.05]])
})

test('DwellMeter cancel 丢弃未读满的计时，重新开书不捡回旧时长', () => {
    const meter = new DwellMeter()
    dwellOn(meter, 0, 0, 0.05, 0, 25)
    meter.cancel()                       // 关书 / 回书架 / 整体进度归零
    assert.equal(meter.pending, null)
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 26_000, 20), [])
    assert.equal(meter.pending.elapsed, 20_000) // 从 cancel 后第一次采样重新数
})

test('DwellMeter 采样空洞（系统休眠、定时器节流）不计入任何一屏', () => {
    const meter = new DwellMeter()
    meter.observe(0, 0, 0.05, 0)
    assert.deepEqual(meter.observe(0, 0, 0.05, 600_000), []) // 十分钟没声音
    assert.equal(meter.pending.elapsed, DWELL_MAX_GAP_MS)   // 只补一个空洞上限，不倒推 30s
})

test('DwellMeter 忽略非法入参：坏 index、空区间、非数字时间', () => {
    const meter = new DwellMeter()
    assert.deepEqual(meter.observe(-1, 0, 0.05, 0), [])
    assert.deepEqual(meter.observe('x', 0, 0.05, 0), [])
    assert.deepEqual(meter.observe(0, 0.2, 0.2, 0), [])     // 零宽度
    assert.deepEqual(meter.observe(0, 0, 0.05, Number.NaN), [])
    assert.equal(meter.pending, null)
})

test('DwellMeter 滚动：连续慢读把 30 秒内扫过的区间并集计入', () => {
    const meter = new DwellMeter()
    const screen = 0.05
    const commits = []
    // 100 秒滑一整屏：每秒前进 1% 屏，属于正常慢读
    for (let s = 0; s <= 90; s++) {
        const a = Math.min(0.5, s * screen / 100)
        commits.push(...meter.observe(0, a, a + screen, s * TICK, false))
    }
    assert.ok(commits.length >= 1, '连续慢读必须产生计入')
    const [index, a, b] = commits[0]
    assert.equal(index, 0)
    assert.ok(a <= 1e-9 && b > screen, `首个计入应是滑动窗口并集，实际 [${a}, ${b}]`)
    // 计入的并集不超过窗口内真实扫过的范围（30s × 1% 屏 + 一屏）
    assert.ok(b <= screen * 1.4, `不应把没看过的内容也算进去，实际右端 ${b}`)
    // 注意：coverageOf 自带 Math.min(1, …) 封顶，写 `coverageOf(...) <= 1` 是恒真断言，
    // 什么都判不出来。这里改判两件真有得失的事：
    //   ①反复命中同一段并进 readMap 后覆盖不二次膨胀；②计入范围不越过实际滑过的右端。
    let map = {}
    for (const [i, x, y] of commits) { const next = addRange(map, i, x, y); if (next !== map) map = next }
    const merged = coverageOf(map[0])
    assert.ok(merged > 0, '慢读必须产生有效覆盖')
    assert.equal(merged, coverageOf(commits.map(([, x, y]) => [x, y])), '并入 readMap 后覆盖不应大于原始并集')
    assert.ok(Math.max(...commits.map(c => c[2])) <= 0.5 + screen + 1e-9,
        '计入的右端不得越过本轮实际滑到的位置')
})

test('DwellMeter 滚动：快速来回拖动不积满 30s，不会把整章刷成已读', () => {
    const meter = new DwellMeter()
    const screen = 0.05
    const swept = []
    // 20 秒内从章首拖到章尾再拖回来，覆盖整章
    for (let lap = 0; lap < 2; lap++) {
        for (let s = 0; s <= 100; s++) {
            const ratio = lap === 0 ? s / 100 : 1 - s / 100
            const a = Math.max(0, Math.min(1 - screen, ratio))
            swept.push(meter.observe(0, a, a + screen, swept.length * 200, false))
        }
    }
    assert.deepEqual(swept.flat(), []) // 全程没有一次计入
    // 残留的计时最多是一条容差带，绝不会是整章
    assert.ok(meter.pending.b - meter.pending.a <= screen * DWELL_BAND_TOLERANCE)
    let map = {}
    for (const [index, a, b] of swept.flat()) map = addRange(map, index, a, b)
    assert.deepEqual(map, {}) // 拖动 40 秒：一章都没读
})

test('DwellMeter 滚动：拖完停下来读，只有停住那一屏读满 30s 才计入', () => {
    const meter = new DwellMeter()
    const screen = 0.05
    for (let s = 0; s <= 20; s++) assert.deepEqual(meter.observe(0, s * screen, s * screen + screen, s * 200, false), [])
    const from = 21 * 200
    assert.deepEqual(dwellOn(meter, 0, 0.9, 0.95, from, 20, false), [])
    const commits = dwellOn(meter, 0, 0.9, 0.95, from + 21_000, 20, false)
    assert.deepEqual(commits.map(c => c[0]), [0])
    assert.ok(Math.abs(commits[0][1] - 0.9) < 1e-9)
})

test('DwellMeter 滚动：停留不足 30s 就滚出容差带，旧带作废不计入', () => {
    const meter = new DwellMeter()
    const screen = 0.05
    assert.deepEqual(dwellOn(meter, 0, 0, screen, 0, 20, false), []) // 只停了 20s
    // 一下滚到三屏之外：冲出容差带 → 结算旧带，但没满 30s → 丢弃，从新位置重新计时
    assert.deepEqual(meter.observe(0, screen * 3, screen * 4, 21_000, false), [])
    assert.equal(meter.pending.a, screen * 3)
    assert.equal(meter.pending.elapsed, 0)
})

test('DwellMeter 滚动：带内积满 30s 就已计入，滚出容差带时残量不足不再补记', () => {
    const meter = new DwellMeter()
    const screen = 0.05
    assert.deepEqual(dwellOn(meter, 0, 0, screen, 0, 35, false), [[0, 0, screen]])
    assert.deepEqual(meter.observe(0, screen * 3, screen * 4, 36_000, false), [])
    assert.equal(meter.pending.a, screen * 3)
})

test('DwellMeter 切换阅读模式（分页↔滚动）取消旧计时', () => {
    const meter = new DwellMeter()
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 0, 20, true), [])
    assert.deepEqual(dwellOn(meter, 0, 0, 0.05, 21_000, 5, false), []) // 刚切滚动，重新数
    assert.equal(meter.pending.discrete, false)
    assert.equal(meter.pending.elapsed, 5_000)
})

test('停留计入与进度口径串联：读满一屏才增加那一屏的权重', () => {
    const sizes = [20, 20] // 两章各 20 屏
    const meter = new DwellMeter()
    let map = {}
    const commits = dwellOn(meter, 0, 0, 0.05, 0, 30)
    for (const [index, a, b] of commits) map = addRange(map, index, a, b)
    assert.deepEqual(map, { 0: [[0, 0.05]] })
    assert.ok(Math.abs(readFraction(map, sizes) - 0.025) < 1e-9)
})


test('跨屏时上一个采样间隔不赠送给新屏，必须从实际进入起满30秒', () => {
    const meter = new DwellMeter()
    dwellOn(meter, 0, 0, .1, 0, 29)
    assert.deepEqual(dwellOn(meter, 0, .1, .2, 30_000, 29), [])
    assert.deepEqual(meter.observe(0, .1, .2, 60_000), [[0, .1, .2]])
})
