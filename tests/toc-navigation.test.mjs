// 直接装载 Reader 类源码，使用可控 renderer 测导航队列与失效实例；不启动服务或访问书库。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../js/reader.js', import.meta.url), 'utf8')
const classSource = source.slice(source.indexOf('export class Reader')).replace('export class', 'class')
const timeoutSource = source.slice(source.indexOf('const timeout ='), source.indexOf("const JOURNAL ="))
const actualTimeout = new Function('setTimeout', 'clearTimeout', `${timeoutSource}; return timeout`)
const loadReader = new Function('PageTurn', 'DwellMeter', 'timeout', 'touchBook', `return ${classSource}`)
const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
}
const microtasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

function createReader(timeout = actualTimeout(setTimeout, clearTimeout), touchBook = async () => {}) {
    const Reader = loadReader(class { destroy() {} }, class { cancel() {} }, timeout, touchBook)
    const reader = new Reader({ dataset: {} })
    reader.records = 0
    reader.recordScreen = () => { reader.records++ }
    reader.settle = async () => {}
    reader.errors = []
    reader.report = (error, label) => reader.errors.push({ error, label })
    return reader
}

function createView({ count = 5, index = 0, pages = 10, onGo = async () => {} } = {}) {
    const state = { index, pages, calls: [], active: 0, maxActive: 0, removed: 0, closed: 0, destroyed: 0 }
    const renderer = {
        size: 600, scrolled: false,
        get pages() { return state.pages + 2 },
        getContents: () => [{ index: state.index }],
        async goTo(target) {
            state.calls.push(target)
            state.maxActive = Math.max(state.maxActive, ++state.active)
            try { await onGo(target); state.index = target.index }
            finally { state.active-- }
        },
    }
    const view = {
        renderer,
        book: { sections: Array.from({ length: count }, () => ({ size: 0 })), destroy: () => { state.destroyed++ } },
        resolveNavigation: index => ({ index }),
        remove: () => { state.removed++ },
        close: () => { state.closed++ },
    }
    return { view, state }
}

function controlledDeadline() {
    let expire
    const timeout = actualTimeout((fn, ms) => { assert.equal(ms, 15000); expire = fn; return 1 }, () => {})
    return { timeout, expire: () => { assert.ok(expire); expire() } }
}

test('同步连续目录点击只加载最后目标，废弃目标返回 false', async () => {
    const r = createReader(), { view, state } = createView()
    r.view = view
    const result = await Promise.all([r.goTo(1), r.goTo(2), r.goTo(3)])
    assert.deepEqual(result, [false, false, true])
    assert.deepEqual(state.calls.map(x => x.index), [3])
    assert.equal(r.records, 1)
    assert.equal(state.maxActive, 1)
})

test('已经加载的目标串行完成，期间 pending 只执行最近目标', async () => {
    const gate = deferred()
    const r = createReader(), { view, state } = createView({ onGo: target => target.index === 1 ? gate.promise : Promise.resolve() })
    r.view = view
    const first = r.goTo(1)
    await microtasks()
    assert.equal(state.active, 1)
    const second = r.goTo(2), third = r.goTo(3)
    gate.resolve()
    assert.deepEqual(await Promise.all([first, second, third]), [true, false, true])
    assert.deepEqual(state.calls.map(x => x.index), [1, 3])
    assert.equal(state.maxActive, 1)
})

test('无效 section 必须报错并返回 false，不能记录原位置当成功', async () => {
    const r = createReader(), { view, state } = createView()
    r.view = view
    for (const value of [-1, 5, 1.5, NaN, undefined, '2']) assert.equal(await r.goTo(value), false)
    assert.equal(r.errors.length, 6)
    assert.equal(state.calls.length, 0)
    assert.equal(r.records, 0)
})

test('renderer 失败返回 false，队列仍可继续处理下一次有效目标', async () => {
    const r = createReader(), { view, state } = createView({ onGo: target => {
        if (target.index === 1) throw new Error('模拟章节载入失败')
    } })
    r.view = view
    assert.equal(await r.goTo(1), false)
    assert.equal(await r.goTo(2), true)
    assert.equal(r.errors.length, 1)
    assert.equal(state.index, 2)
    assert.equal(r.records, 1)
})

test('引擎静默拒绝并保留旧 section 时返回 false', async () => {
    const r = createReader(), { view } = createView()
    view.renderer.goTo = async () => {}
    r.view = view
    assert.equal(await r.goTo(2), false)
    assert.equal(r.errors.length, 1)
    assert.equal(r.records, 0)
})

test('resolveNavigation 抛错也报告失败而非伪成功', async () => {
    const r = createReader(), { view } = createView()
    view.resolveNavigation = () => { throw new Error('无效 href') }
    r.view = view
    assert.equal(await r.goTo('bad.xhtml'), false)
    assert.equal(r.errors.length, 1)
})

test('指定 fragment 找不到时返回 false，合法章首零锚点可成功', async () => {
    const r = createReader(), { view } = createView({ onGo: target => target.anchor?.({}) })
    r.view = view
    view.resolveNavigation = () => ({ index: 1, anchor: () => null })
    assert.equal(await r.goTo('chapter.xhtml#missing'), false)
    assert.equal(r.errors.length, 1)
    assert.equal(r.records, 0)
    view.resolveNavigation = () => ({ index: 1, anchor: () => 0 })
    assert.equal(await r.goTo('chapter.xhtml'), true)
})

test('换书代际使活导航停止回写，也丢弃尚未开始的旧导航', async () => {
    const gate = deferred()
    const r = createReader(), { view, state } = createView({ onGo: () => gate.promise })
    r.view = view
    const first = r.goTo(1)
    await microtasks()
    const pending = r.goTo(2)
    r._generation++
    gate.resolve()
    assert.deepEqual(await Promise.all([first, pending]), [false, false])
    assert.equal(state.calls.length, 1)
    assert.equal(r.records, 0)
})

test('当前 section 精确页码直接导航，零字节权重不串章', async () => {
    const r = createReader(), { view, state } = createView({ index: 3, pages: 19 })
    r.view = view
    view.resolveNavigation = () => { throw new Error('精确页码不应通过全书 fraction') }
    assert.equal(await r.goToChapterPage(3, 9), true)
    assert.deepEqual(state.calls, [{ index: 3, anchor: 8.5 / 19 }])
    assert.equal(Math.round(state.calls[0].anchor * 18) + 1, 9)
})

test('未加载 section / 非法页码 / 无页数不会执行精确跳页', async () => {
    const r = createReader(), { view, state } = createView({ index: 2, pages: 10 })
    r.view = view
    for (const [index, page] of [[1, 1], [2, 0], [2, 11], [2, 1.5], [-1, 1]])
        assert.equal(await r.goToChapterPage(index, page), false)
    state.pages = 0
    assert.equal(await r.goToChapterPage(2, 1), false)
    assert.equal(state.calls.length, 0)
})

test('精确页码在队列等待期间遇到重排或换章必须失效', async () => {
    for (const change of ['pages', 'index']) {
        const gate = deferred()
        const r = createReader(), { view, state } = createView({ index: 2, pages: 10 })
        r.view = view
        r.enqueue(() => gate.promise)
        const jump = r.goToChapterPage(2, 4)
        if (change === 'pages') state.pages = 11
        else state.index = 1
        gate.resolve()
        assert.equal(await jump, false)
        assert.equal(state.calls.length, 0)
    }
})

test('15 秒 deadline 隔离失效 view，迟到完成只能清理旧对象', async () => {
    const deadline = controlledDeadline(), gate = deferred()
    const r = createReader(deadline.timeout), { view, state } = createView({ onGo: () => gate.promise })
    r.view = view
    r.bookId = 'old-book'
    const jump = r.goTo(1)
    await microtasks()
    deadline.expire()
    assert.equal(await jump, false)
    assert.equal(r.view, null)
    assert.equal(r.bookId, null)
    assert.equal(r._generation, 1)
    assert.equal(r.errors[0].error.code, 'READER_TIMEOUT')
    assert.equal(state.removed, 1)
    assert.equal(state.closed, 0)
    const next = createView({ index: 4 })
    r.view = next.view
    r.bookId = 'new-book'
    gate.resolve()
    await microtasks()
    assert.equal(state.closed, 1)
    assert.equal(state.destroyed, 1)
    assert.equal(r.view, next.view)
    assert.equal(r.bookId, 'new-book')
    assert.equal(r.records, 0)
})

test('超时不作废用户已经排队的新书代际，队列可继续', async () => {
    const deadline = controlledDeadline(), gate = deferred()
    const r = createReader(deadline.timeout), { view, state } = createView({ onGo: () => gate.promise })
    r.view = view
    const jump = r.goTo(1)
    await microtasks()
    r._generation++ // open/close 在请求到达时立即推进代际
    const generation = r._generation
    const next = createView()
    const opened = r.enqueue(() => { r.view = next.view; return true })
    deadline.expire()
    assert.equal(await jump, false)
    assert.equal(await opened, true)
    assert.equal(r._generation, generation)
    assert.equal(r.view, next.view)
    gate.reject(new Error('旧章节迟到失败'))
    await microtasks()
    assert.equal(state.closed, 1)
    assert.equal(r.errors.length, 1)
})

test('字体 settle 不结束也受 deadline 控制，迟到字体不能记录新书', async () => {
    const deadline = controlledDeadline(), fonts = deferred()
    const r = createReader(deadline.timeout), { view, state } = createView()
    r.view = view
    r.settle = () => fonts.promise
    const jump = r.goTo(1)
    await microtasks()
    deadline.expire()
    assert.equal(await jump, false)
    assert.equal(r.view, null)
    fonts.resolve()
    await microtasks()
    assert.equal(state.closed, 1)
    assert.equal(r.records, 0)
})


test('进入保存队列前冻结位置，后续重排修改同一progress对象不能篡改待写请求', async () => {
    const gate=deferred(), writes=[]
    const r=createReader(undefined,async(id,progress)=>writes.push({id,progress}))
    r._save=gate.promise
    const first={cfi:'first',percent:.1,readMap:{0:[[0,.1]]}}
    r.savePosition('book',first)
    first.cfi='later';first.percent=.9;first.readMap={0:[[0,.9]]}
    gate.resolve();await r._save
    assert.equal(writes[0].progress.cfi,'first')
    assert.equal(writes[0].progress.percent,.1)
    assert.deepEqual(writes[0].progress.readMap,{0:[[0,.1]]})
})


test('PDF原书一页拆成多个section时，数字跳页按原页号找到首段', () => {
    const r=createReader();r.bookFormat='pdf';r._pdfPages=[1,1,2];r._pdfPageCount=2
    assert.equal(r.sourcePageCount,2)
    assert.equal(r.pdfSectionForPage(1),0)
    assert.equal(r.pdfSectionForPage(2),2)
    assert.equal(r.pdfSectionForPage(3),-1)
    assert.equal(r.pdfSectionForPage(0),-1)
    r.bookFormat='epub';assert.equal(r.pdfSectionForPage(1),-1)
})


test('四次快速同向翻页在单一队列中准确消费四次，不丢掉累计次数', async () => {
    const gate=deferred(), r=createReader(), {view,state}=createView()
    r.view=view;r.turn.run=async(view,go)=>go()
    let turns=0
    view.next=async()=>{ turns++; if(turns===1) await gate.promise; state.index++ }
    r.next();await microtasks()
    r.next();r.next();r.next()
    assert.equal(turns,1)
    gate.resolve()
    for(let i=0;i<12 && r._turning;i++){ await r._queue;await microtasks() }
    assert.equal(turns,4)
    assert.equal(r._queuedTurn,0)
    assert.equal(r._turning,null)
})

test('进度归零只有实际载入书头才返回成功，失败仍清空已读且可重试', async () => {
    const r = createReader(), { view, state } = createView({ index: 3,
        onGo: () => { throw new Error('模拟书头载入失败') } })
    r.view = view; r._readMap = { 3: [[0, 1]] }
    assert.equal(await r.resetProgress(), false)
    assert.deepEqual(r._readMap, {})
    assert.equal(r.records, 0)
    assert.equal(r.errors.length, 1)
    view.renderer.goTo = async target => { state.index = target.index }
    assert.equal(await r.resetProgress(), true)
    assert.equal(state.index, 0)
    assert.equal(r.records, 1)
})

test('进度归零字体等待超时会隔离旧实例，迟到完成不能回写', async () => {
    const deadline = controlledDeadline(), gate = deferred()
    const r = createReader(deadline.timeout), { view, state } = createView()
    r.view = view; r.settle = () => gate.promise
    const reset = r.resetProgress()
    await microtasks()
    deadline.expire()
    assert.equal(await reset, false)
    assert.equal(r.view, null)
    assert.equal(r._layoutBusy, false)
    gate.resolve(); await microtasks()
    assert.equal(state.closed, 1)
    assert.equal(r.records, 0)
})
