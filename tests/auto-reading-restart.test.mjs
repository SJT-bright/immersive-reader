import test from 'node:test'
import assert from 'node:assert/strict'
import { AutoReading } from '../js/auto-reading.js'

// auto-reading.js 构造时引用 document/window，Node 下需先垫全局。
// 修复后模块内不再有 cancelAnimationFrame（this.raf 是死代码），这里也不再垫。
globalThis.document = { addEventListener() {}, hidden: false }
globalThis.window = { addEventListener() {} }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// 关键桩：autoAdvance 里 await 一个「真实时长」，于是存在一个可被打断的 await 窗口。
// 旧桩写成 `async autoAdvance(){ this.advanceCalls++; return false }`，await 只等一个微任务，
// manualnavigation 永远落不进窗口，恰好绕开了 restart 双链缺陷；而且只数「进入」不数「返回」，
// 断言对 1 条链和 3 条链同样通过。这里同时数进入与返回，inFlight 差值可判定并发链。
class ReaderStub extends EventTarget {
    constructor (holdMs = 0) {
        super()
        this.holdMs = holdMs
        this.calls = 0        // autoAdvance 进入次数
        this.returns = 0      // autoAdvance 返回次数
        this.inFlight = 0
        this.maxInFlight = 0  // 观测到的最大并发数：>1 即证明并存着两条定时器链
        this.enterAt = []     // 每次进入的时刻，用于判定翻页节奏
        this.view = { renderer: { getContents: () => [{ doc: { body: {} } }] } }
        this.setFlow = async () => {}
        this.flushProgress = async () => {}
        this.flow = 'paginated'
    }
    async autoAdvance () {
        this.calls++
        this.inFlight++
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
        this.enterAt.push(performance.now())
        try {
            if (this.holdMs) await sleep(this.holdMs)
        } finally {
            this.inFlight--
            this.returns++
        }
        return false
    }
    // 相邻两次翻页的最小间隔：单链不可能快过 delay，双链会成倍挤进来
    minGap () {
        let min = Infinity
        for (let i = 1; i < this.enterAt.length; i++) min = Math.min(min, this.enterAt[i] - this.enterAt[i - 1])
        return this.enterAt.length < 2 ? null : min
    }
}

const makeSettings = (over = {}) => ({
    mode: 'page', pageSeconds: 0.05, pixelsPerSecond: 20, endDwellSeconds: 3, flow: 'paginated', ...over,
})
const makeHarness = (holdMs = 0, over = {}) => {
    const reader = new ReaderStub(holdMs)
    const errors = []
    const auto = new AutoReading(reader, makeSettings(over), e => errors.push(e), () => {})
    return { reader, auto, errors }
}

test('restart 落在 autoAdvance 的 await 窗口内：全程至多一次翻页在飞，且不派生第二条定时器链', async t => {
    const HOLD = 120, DELAY = 50, WINDOW = 700
    const { reader, auto, errors } = makeHarness(HOLD, { pageSeconds: DELAY / 1000 })
    t.after(() => auto.stop())
    await auto.start()

    // 先把时刻推进到「确有一次 autoAdvance 正在 await」，再翻页——这一步是旧测试从没做到的
    await sleep(DELAY + 20)
    assert.equal(reader.calls, 1, '前提：第一个周期应已进入 autoAdvance')
    assert.equal(reader.inFlight, 1, '前提：派发手动翻页时必须落在 await 窗口内')

    reader.dispatchEvent(new Event('manualnavigation'))
    assert.equal(auto.running, true, '手动翻页不得中断自动阅读')
    await sleep(WINDOW)

    assert.equal(reader.maxInFlight, 1,
        `任意时刻至多一次 autoAdvance 在飞，实测 ${reader.maxInFlight}——出现 2 说明 restart 派生了并发的第二条链`)
    assert.ok(reader.calls - reader.returns <= 1,
        `进入与返回之差 ${reader.calls - reader.returns}，>1 即有两条链同时在飞`)
    // 单链周期 = DELAY+HOLD = 170ms ⇒ 700ms 窗口约 4 次；缺陷版双链实测约 8 次
    assert.ok(reader.calls >= 2 && reader.calls <= 6,
        `翻页节奏异常：${WINDOW}ms 内 ${reader.calls} 次（单链约 4 次，双链实测约 8 次）`)
    assert.deepEqual(errors, [], 'restart 路径不应触发任何 onError')

    // stop 后在飞的那一次必须自然收尾，不留悬空链
    auto.stop()
    await sleep(HOLD + 30)
    assert.equal(reader.calls, reader.returns, 'stop 后不应留下永不返回的在飞调用')
})

test('await 窗口内连续手动翻页（scroll 33ms 节奏）依旧只有一条链', async t => {
    const HOLD = 60, DELAY = 33, WINDOW = 600
    const { reader, auto, errors } = makeHarness(HOLD, { mode: 'scroll', pageSeconds: 0.05 })
    t.after(() => auto.stop())
    await auto.start()
    await sleep(DELAY + 10)
    // 每 40ms 翻一次页，持续 300ms：scroll 的 await 窗口几乎常开，反复压这条路径
    for (let i = 0; i < 8; i++) {
        reader.dispatchEvent(new Event('manualnavigation'))
        await sleep(40)
    }
    await sleep(WINDOW)
    assert.equal(reader.maxInFlight, 1,
        `连续手动翻页后实测并发 ${reader.maxInFlight} 次在飞——链已分叉`)
    assert.equal(auto.running, true)
    // 单链周期 ≈ HOLD+DELAY = 93ms ⇒ 约 600/93≈6 次；缺陷版会成倍增长
    assert.ok(reader.calls >= 3 && reader.calls <= 12,
        `scroll 节奏异常：${reader.calls} 次（单链约 6-9 次，双链会成倍）`)
    assert.deepEqual(errors, [])
})

test('手动翻页把倒计时归零：下一次翻页不得早于设定间隔（绝不快于设定）', async t => {
    const HOLD = 40, DELAY = 100
    const { reader, auto } = makeHarness(HOLD, { pageSeconds: DELAY / 1000 })
    t.after(() => auto.stop())
    await auto.start()
    await sleep(DELAY + HOLD + 20)      // 让第一次完整收尾，此后没有在飞调用
    assert.equal(reader.inFlight, 0, '前提：此刻没有翻页在飞')
    const navAt = performance.now()
    reader.dispatchEvent(new Event('manualnavigation'))
    await sleep(DELAY / 2)
    assert.equal(reader.calls, 1, `翻页后仅过 ${DELAY / 2}ms 不该再来第二次（restart 必须从零重计）`)
    await sleep(DELAY)
    assert.equal(reader.calls, 2, '归零后的一个完整间隔应再次翻页')
    assert.ok(reader.minGap() >= DELAY * 0.8,
        `相邻两次翻页最小间隔 ${reader.minGap()?.toFixed(1)}ms 不应低于设定 ${DELAY}ms 太多`)
})

test('start 后手动翻页不打断自动阅读，且全程无 onError', async t => {
    const { reader, auto, errors } = makeHarness(0)
    t.after(() => auto.stop())
    await auto.start()
    reader.dispatchEvent(new Event('manualnavigation'))
    assert.equal(auto.running, true, '手动翻页后自动阅读必须仍在运行')
    await sleep(150)
    assert.equal(auto.running, true)
    assert.equal(reader.maxInFlight, 1)
    assert.deepEqual(errors, [], 'restart 路径不应触发任何 onError')
})

test('连续两次手动翻页，自动阅读依旧存活并继续周期翻页', async t => {
    const { reader, auto, errors } = makeHarness(0)
    t.after(() => auto.stop())
    await auto.start()
    await sleep(120)
    reader.dispatchEvent(new Event('manualnavigation'))
    await sleep(20)
    reader.dispatchEvent(new Event('manualnavigation'))
    const before = reader.calls
    await sleep(150)
    assert.equal(auto.running, true, '连续手动翻页后自动阅读不得停止')
    assert.ok(reader.calls > before, '手动翻页后计时器重启并再次触发翻页')
    assert.equal(reader.maxInFlight, 1)
    assert.deepEqual(errors, [])
})

test('stop 落在 await 窗口内：在飞的翻页收尾后不再产生任何新的定时器', async t => {
    const HOLD = 120, DELAY = 50
    const { reader, auto, errors } = makeHarness(HOLD, { pageSeconds: DELAY / 1000 })
    await auto.start()
    await sleep(DELAY + 20)
    assert.equal(reader.inFlight, 1, '前提：stop 必须落在 await 窗口内')
    auto.stop()
    assert.equal(auto.running, false)
    assert.equal(auto.starting, false)
    const afterStop = reader.calls
    await sleep(HOLD + DELAY * 3)
    assert.equal(reader.calls, afterStop, 'stop 后在飞的那条链不得续期')
    assert.equal(reader.inFlight, 0)
    assert.deepEqual(errors, [])
})

test('stop 后手动翻页不会重新启动：restart 在非运行时是 no-op', async t => {
    const { reader, auto } = makeHarness(0)
    await auto.start()
    await sleep(120)
    auto.stop()
    assert.equal(auto.running, false)
    const before = reader.calls
    reader.dispatchEvent(new Event('manualnavigation'))
    await sleep(100)
    assert.equal(auto.running, false, '停止后手动翻页绝不能重新拉起自动阅读')
    assert.equal(reader.calls, before, '不应产生任何新的翻页定时器')
})

test('start 被后续 stop 取代时 starting 必须归位（running||starting 契约）', async t => {
    const reader = new ReaderStub(0)
    let releaseFlow
    reader.setFlow = () => new Promise(r => { releaseFlow = () => r() })
    const errors = []
    const auto = new AutoReading(reader, makeSettings(), e => errors.push(e), () => {})
    t.after(() => auto.stop())
    const started = auto.start()
    assert.equal(auto.starting, true, 'setFlow 期间处于 starting')
    auto.stop()                      // 在 setFlow 的 await 里插入一次 stop → generation 不符
    releaseFlow()
    await started
    assert.equal(auto.running, false)
    assert.equal(auto.starting, false, 'generation 不符的 early-return 不得把 starting 留在 true')
})

test('从未 start 的实例收到 manualnavigation 不产生定时器副作用', async t => {
    const { reader, auto } = makeHarness(0)
    assert.equal(auto.running, false)
    reader.dispatchEvent(new Event('manualnavigation'))
    await sleep(100)
    assert.equal(reader.calls, 0, '未启动时 restart 必须完全不调度 tick')
    assert.equal(auto.running, false)
})
