import test from 'node:test'
import assert from 'node:assert/strict'
import {
    puckOnDisc, snapPuck, clampPuck, DISC, REST, VIEW, PUCK_R, PIVOT, ARM_LENGTH,
    GROOVE_INNER, GROOVE_OUTER, OUTER_STYLUS, INNER_STYLUS,
    stylusAtProgress, stylusOnGrooves, stepSpin, DEG_PER_SEC, shortLabel,
} from '../js/vinyl-deck.js'

test('把手在唱片圆心为播放，停在托架为暂停', () => {
    assert.equal(puckOnDisc(DISC.x, DISC.y), true)
    assert.equal(puckOnDisc(REST.x, REST.y), false)
    assert.equal(puckOnDisc(DISC.x + DISC.label + 4, DISC.y), false)
})

test('松手时吸附到较近的圆心或托架', () => {
    assert.deepEqual(snapPuck(DISC.x + 8, DISC.y - 4), { x: DISC.x, y: DISC.y, on: true })
    assert.deepEqual(snapPuck(REST.x - 6, REST.y + 2), { x: REST.x, y: REST.y, on: false })
})

test('拖动手把不出唱机范围', () => {
    const m = PUCK_R + 2
    const a = clampPuck(-20, 80)
    const b = clampPuck(400, 400)
    assert.ok(a.x >= m && a.y >= m)
    assert.ok(b.x <= VIEW.w - m && b.y <= VIEW.h - m)
})

test('针尖在沟槽区，不落在标签或盘外', () => {
    assert.ok(OUTER_STYLUS && INNER_STYLUS)
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
        const tip = stylusAtProgress(p)
        assert.equal(stylusOnGrooves(tip), true, 'progress ' + p)
        const toPivot = Math.hypot(tip.x - PIVOT.x, tip.y - PIVOT.y)
        assert.ok(Math.abs(toPivot - ARM_LENGTH) < 0.001)
        const toCenter = Math.hypot(tip.x - DISC.x, tip.y - DISC.y)
        assert.ok(toCenter > DISC.label + 4)
        assert.ok(toCenter < DISC.r - 3)
    }
    assert.ok(GROOVE_INNER > DISC.label)
    assert.ok(GROOVE_OUTER < DISC.r)
})

test('转速按时间积分，跨越整圈不倒转，停转不回跳', () => {
    assert.equal(DEG_PER_SEC, 200)
    let angle = 0, omega = 0
    for (let i = 0; i < 45; i++) {
        const s = stepSpin(angle, omega, DEG_PER_SEC, 1 / 60)
        assert.ok(s.angle >= angle)
        angle = s.angle
        omega = s.omega
    }
    assert.ok(Math.abs(omega - 200) < 0.01, '0.75s 应达到稳定转速')
    const before = angle
    for (let i = 0; i < 60; i++) {
        const s = stepSpin(angle, omega, DEG_PER_SEC, 1 / 60)
        assert.ok(s.angle >= angle)
        angle = s.angle
        omega = s.omega
    }
    assert.ok(angle - before > 190, '稳定后约 200°/s')
    const coastFrom = angle
    for (let i = 0; i < 70; i++) {
        const s = stepSpin(angle, omega, 0, 1 / 60)
        assert.ok(s.angle >= angle - 1e-9)
        angle = s.angle
        omega = s.omega
    }
    assert.equal(omega, 0)
    assert.ok(angle > coastFrom)
    assert.ok(angle - coastFrom < 200)
})

test('标签用曲目名，不编造歌手', () => {
    assert.equal(shortLabel('tone.wav'), 'tone')
    assert.equal(shortLabel(''), 'SIDE A')
    assert.ok(shortLabel('一首很长的本地音乐名字').endsWith('…'))
})
