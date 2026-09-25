import test from 'node:test'
import assert from 'node:assert/strict'
import { AUTO_PRESETS, activePresetSpeed } from '../js/auto-preset.js'

test('翻页预设按速度取向排布：越快停留越短', () => {
    assert.deepEqual(AUTO_PRESETS.map(p => [p.speed, p.seconds, p.label]), [[10, 70, '慢'], [20, 50, '适中'], [40, 30, '快']])
    const seconds = AUTO_PRESETS.map(p => p.seconds)
    assert.deepEqual([...seconds].sort((a, b) => a - b), [30, 50, 70])
    assert.ok(seconds[0] > seconds[1] && seconds[1] > seconds[2], '停留秒数必须随速度档递减')
})

test('每档预设写入后，高亮判定回到同一档', () => {
    for (const p of AUTO_PRESETS) {
        assert.equal(activePresetSpeed({ mode: 'page', pageSeconds: p.seconds, pixelsPerSecond: 20 }), p.speed)
        assert.equal(activePresetSpeed({ mode: 'scroll', pageSeconds: 50, pixelsPerSecond: p.speed }), p.speed)
    }
})

test('翻页模式按停留秒数分档，与滚动模式的像素/秒互不串档', () => {
    for (const [s, expected] of [[30, 40], [40, 40], [41, 20], [50, 20], [60, 20], [61, 10], [70, 10], [120, 10], [5, 40]])
        assert.equal(activePresetSpeed({ mode: 'page', pageSeconds: s }), expected, `page ${s}s`)
    for (const [v, expected] of [[5, 10], [12, 10], [13, 20], [30, 20], [31, 40], [80, 40]])
        assert.equal(activePresetSpeed({ mode: 'scroll', pixelsPerSecond: v }), expected, `scroll ${v}px`)
    // 模式没切到翻页时，停留秒数不参与判断
    assert.equal(activePresetSpeed({ mode: 'scroll', pageSeconds: 70, pixelsPerSecond: 40 }), 40)
})
