// 已读页进度模型（js/reading-stats.js）单元测试
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    normalizeRanges, addRange, coverageOf, sectionSizesFrom,
    readFraction, initReadMapFromPercent, sanitizeReadMap,
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
