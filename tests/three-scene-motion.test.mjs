import test from 'node:test'
import assert from 'node:assert/strict'
import { ThreeSceneRenderer } from '../js/three-scene.js'

test('关闭动态停止离屏帧，重新开启从暂停时间续播', () => {
    const originals = {
        document: globalThis.document,
        performance: globalThis.performance,
        requestAnimationFrame: globalThis.requestAnimationFrame,
        cancelAnimationFrame: globalThis.cancelAnimationFrame,
    }
    let now = 1000
    let nextId = 1
    const frames = new Map()
    const gradient = { addColorStop () {} }
    const ctx = new Proxy({}, { get: (_, key) => key === 'createLinearGradient' || key === 'createRadialGradient'
        ? () => gradient : () => {} })
    globalThis.document = { hidden: false, createElement: () => ({ getContext: () => ctx }) }
    globalThis.performance = { now: () => now }
    globalThis.requestAnimationFrame = callback => { const id = nextId++; frames.set(id, callback); return id }
    globalThis.cancelAnimationFrame = id => frames.delete(id)
    const advance = time => {
        now = time
        const [id, callback] = frames.entries().next().value
        frames.delete(id)
        callback(now)
    }
    try {
        const renderer = new ThreeSceneRenderer()
        renderer.start('three:mountains-dawn', { motion: false })
        assert.equal(frames.size, 0, '静态首帧之后不能排队下一帧')
        renderer.setMotionEnabled(true)
        renderer.setMotionEnabled(true)
        assert.equal(frames.size, 1, '重复启用不能产生两个循环')
        advance(1035)
        assert.equal(renderer.elapsedMs, 35)
        assert.equal(frames.size, 1)
        now = 1040
        renderer.setMotionEnabled(false)
        assert.equal(frames.size, 0, '关闭动态应取消待执行帧')
        assert.equal(renderer.elapsedMs, 40)
        now = 5000
        renderer.setMotionEnabled(true)
        advance(5035)
        assert.equal(renderer.elapsedMs, 75, '续播不得跳过暂停期间的时间')
        const previousCanvas = renderer.canvas
        renderer.start('three:mountains-dawn', { motion: false })
        assert.notEqual(renderer.canvas, previousCanvas, '新场景不能搬走旧图层的画布')
        assert.equal(frames.size, 0, '旧场景的帧循环应停止')
        renderer.stop()
        assert.equal(frames.size, 0, '离开场景应取消待执行帧')
    } finally {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[key]
            else globalThis[key] = value
        }
    }
})
