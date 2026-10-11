import test from 'node:test'
import assert from 'node:assert/strict'
import { installTocHover, animateTocPages } from '../js/toc-interaction.js'

class ElementStub {
    constructor (tag = 'div', classes = '') {
        this.tagName = tag.toUpperCase()
        this.classes = new Set(classes.split(' ').filter(Boolean))
        this.classList = {
            contains: value => this.classes.has(value),
            add: value => this.classes.add(value),
            remove: value => this.classes.delete(value),
        }
        this.dataset = {}
        this.children = []
        this.listeners = new Map()
        this.hidden = false
        this.hover = false
        this.focusVisible = false
    }
    append (...children) {
        for (const child of children) { child.parentElement = this; this.children.push(child) }
    }
    contains (node) {
        for (let current = node; current; current = current.parentElement) if (current === this) return true
        return false
    }
    matches (selector) {
        if (selector.includes(',')) return selector.split(',').some(value => this.matches(value.trim()))
        if (selector === ':hover') return this.hover
        if (selector === ':focus-visible') return this.focusVisible
        if (selector === 'li[data-plain]') return this.tagName === 'LI' && this.dataset.plain != null
        const row = selector.match(/^li\[data-plain="(.*)"\]$/)
        if (row) return this.tagName === 'LI' && this.dataset.plain === row[1]
        if (selector === '.toc-expand:hover') return this.classes.has('toc-expand') && this.hover
        if (selector.startsWith('.')) return this.classes.has(selector.slice(1))
        return this.tagName === selector.toUpperCase()
    }
    closest (selector) {
        for (let current = this; current; current = current.parentElement) if (current.matches(selector)) return current
        return null
    }
    querySelector (selector) {
        for (const child of this.children) {
            if (child.matches(selector)) return child
            const nested = child.querySelector(selector)
            if (nested) return nested
        }
        return null
    }
    addEventListener (type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, new Set())
        this.listeners.get(type).add(callback)
    }
    removeEventListener (type, callback) { this.listeners.get(type)?.delete(callback) }
    fire (type, fields = {}) {
        const event = { target: this, relatedTarget: null, pointerType: 'mouse', ...fields }
        for (const callback of this.listeners.get(type) || []) callback(event)
    }
}

function environment (t, { reduced = false } = {}) {
    const originals = Object.fromEntries(['document', 'window', 'matchMedia', 'getComputedStyle', 'setTimeout', 'clearTimeout']
        .map(key => [key, globalThis[key]]))
    const timers = new Map()
    let now = 0, nextId = 0
    globalThis.document = { activeElement: null }
    globalThis.window = new ElementStub()
    globalThis.matchMedia = query => ({ matches: query.includes('reduced-motion') ? reduced : true })
    globalThis.getComputedStyle = box => ({ opacity: String(box.currentOpacity ?? 1) })
    globalThis.setTimeout = (callback, delay) => {
        const id = ++nextId
        timers.set(id, { callback, at: now + delay })
        return id
    }
    globalThis.clearTimeout = id => timers.delete(id)
    t.after(() => {
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[key]
            else globalThis[key] = value
        }
    })
    const advance = delay => {
        const end = now + delay
        while (true) {
            const next = [...timers].filter(([, value]) => value.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
            if (!next) break
            const [id, { callback, at }] = next
            timers.delete(id); now = at; callback()
        }
        now = end
    }
    return { advance, timers }
}

function fixture (t, options) {
    const env = environment(t, options)
    const trigger = new ElementStub('button'), surface = new ElementStub()
    const row = new ElementStub('li'), chip = new ElementStub('button', 'toc-expand'), label = new ElementStub('span')
    const box = new ElementStub('div', 'toc-pages'), page = new ElementStub('button', 'toc-page')
    const input = new ElementStub('input')
    row.dataset.plain = '0'
    box.hidden = true
    chip.append(label); box.append(page); row.append(chip, box); surface.append(input, row)
    let opened = false, openCount = 0, closeCount = 0
    const api = installTocHover({ trigger, surface,
        open: () => { opened = true; openCount++ },
        close: () => { opened = false; closeCount++ },
        isOpen: () => opened,
        openRow: current => { current.classList.add('toc-expanded'); current.querySelector('.toc-pages').hidden = false },
        closeRow: current => { current.classList.remove('toc-expanded'); current.querySelector('.toc-pages').hidden = true },
    })
    t.after(() => api.dispose())
    const overChip = () => {
        row.hover = chip.hover = true
        surface.fire('pointerover', { target: label })
    }
    const leaveRow = () => {
        row.hover = chip.hover = false
        surface.fire('pointerout', { target: chip, relatedTarget: input })
    }
    return { ...env, trigger, surface, row, chip, box, page, input, api, overChip, leaveRow,
        get opened () { return opened }, get openCount () { return openCount }, get closeCount () { return closeCount } }
}

test('快速划过不展开；纯悬停离开后仍能收起', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.advance(80); f.trigger.fire('pointerleave'); f.advance(500)
    assert.equal(f.opened, false)
    f.trigger.fire('pointerenter'); f.advance(199); assert.equal(f.opened, false)
    f.advance(1); assert.equal(f.opened, true)
    f.trigger.fire('pointerleave'); f.advance(220); assert.equal(f.opened, false)
})

test('悬停展开后第一次点击固定目录，第二次点击关闭', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.advance(200)
    assert.equal(f.api.activateTrigger(), true)
    f.trigger.fire('pointerleave'); f.advance(1000)
    assert.equal(f.opened, true, '主动点击不得被离开计时器反悔')
    f.api.activateTrigger()
    assert.equal(f.opened, false)
    assert.equal(f.closeCount, 1)
})

test('悬停计时器未到时点击立即展开，计时器不会重新打开已关闭目录', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.advance(100)
    f.api.activateTrigger(); assert.equal(f.opened, true)
    f.api.activateTrigger(); f.advance(1000)
    assert.equal(f.opened, false)
    assert.equal(f.openCount, 1)
})

test('点击展开页码后离开行仍保留，再点芯片才关闭', t => {
    const f = fixture(t)
    f.api.activateTrigger(); f.api.activateRow(f.row)
    f.leaveRow(); f.surface.fire('pointerleave'); f.advance(1000)
    assert.equal(f.box.hidden, false)
    assert.equal(f.opened, true)
    f.api.activateRow(f.row)
    assert.equal(f.box.hidden, true)
})

test('纯悬停页码可自动收回，点击确认已展开预览则不会立即折叠', t => {
    const f = fixture(t)
    f.api.activateTrigger(); f.overChip(); f.advance(200)
    assert.equal(f.box.hidden, false)
    f.leaveRow(); f.advance(220); assert.equal(f.box.hidden, true)
    f.overChip(); f.advance(200); f.api.activateRow(f.row)
    f.leaveRow(); f.advance(220)
    assert.equal(f.box.hidden, false)
    f.api.activateRow(f.row); assert.equal(f.box.hidden, true)
})

test('点击收起会取消待执行悬停，保持鼠标原位也不会被重新展开', t => {
    const f = fixture(t)
    f.api.activateTrigger(); f.overChip(); f.advance(50)
    f.api.activateRow(f.row); f.api.activateRow(f.row); f.advance(1000)
    assert.equal(f.box.hidden, true)
})

test('点击悬停预览中的页码会固定这一行，离开后页码不消失', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.advance(200); f.overChip(); f.advance(200)
    f.surface.fire('pointerdown', { target: f.page })
    f.leaveRow(); f.surface.fire('pointerleave'); f.advance(300)
    assert.equal(f.box.hidden, false, '按住页码时不得收回而吞掉后续click')
    f.surface.fire('click', { target: f.page }); f.advance(1000)
    assert.equal(f.box.hidden, false); assert.equal(f.opened, true)
})

test('从芯片移入页码与返回芯片都不丢失预览', t => {
    const f = fixture(t)
    f.api.activateTrigger(); f.overChip(); f.advance(200)
    f.chip.hover = false
    f.surface.fire('pointerout', { target: f.chip, relatedTarget: f.page })
    f.advance(1000); assert.equal(f.box.hidden, false)
    f.leaveRow(); f.advance(100)
    f.overChip(); f.advance(300); assert.equal(f.box.hidden, false)
})

test('键盘焦点进入页码取消收回，输入过滤时浮层不误收', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.advance(200)
    f.overChip(); f.advance(200); f.leaveRow()
    document.activeElement = f.page; f.page.focusVisible = true
    f.surface.fire('focusin', { target: f.page }); f.advance(1000)
    assert.equal(f.box.hidden, false)
    document.activeElement = f.input
    f.surface.fire('pointerleave'); f.advance(1000)
    assert.equal(f.opened, true)
})

test('触屏没有悬停计时器，显式点击仍立即开合', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter', { pointerType: 'touch' }); f.advance(1000)
    assert.equal(f.opened, false)
    assert.equal(f.timers.size, 0)
    f.api.activateTrigger(); f.api.activateRow(f.row)
    assert.equal(f.opened, true); assert.equal(f.box.hidden, false)
    f.api.activateRow(f.row); assert.equal(f.box.hidden, true)
})

test('点击目录内其他控件也保持浮层，关闭重开后不保留旧固定状态', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.advance(200)
    f.surface.fire('click', { target: f.input }); f.surface.fire('pointerleave'); f.advance(1000)
    assert.equal(f.opened, true)
    f.api.activateTrigger(); assert.equal(f.opened, false)
    f.surface.fire('toggle', { newState: 'closed' })
    f.trigger.fire('pointerenter'); f.advance(200); f.trigger.fire('pointerleave'); f.advance(220)
    assert.equal(f.opened, false)
})

test('dispose取消计时器并移除监听；缺失DOM安全降级', t => {
    const f = fixture(t)
    f.trigger.fire('pointerenter'); f.api.dispose(); f.advance(1000)
    assert.equal(f.opened, false); assert.equal(f.timers.size, 0)
    f.trigger.fire('pointerenter'); f.advance(1000); assert.equal(f.opened, false)
    assert.equal(f.api.activateTrigger(), false)
    assert.equal(installTocHover({}).activateTrigger(), false)
})

function animationBox () {
    const box = { hidden: false, naturalHeight: 180, reads: 0, animations: [] }
    box.getBoundingClientRect = () => { box.reads++; return { height: box.currentHeight ?? box.naturalHeight } }
    box.animate = (frames, options) => {
        let finish
        const motion = { frames, options, canceled: false,
            finished: new Promise(resolve => { finish = resolve }),
            cancel () { this.canceled = true; this.hiddenWhenCanceled = box.hidden; if (box.active === this) { box.active = null; delete box.currentHeight } },
            finish () { box.currentHeight = parseFloat(frames.at(-1).height); finish() },
        }
        box.active = motion; box.animations.push(motion)
        return motion
    }
    return box
}

test('折叠保留0高度终点直到hidden生效，再释放动画避免高度回跳', async t => {
    environment(t)
    const box = animationBox(), motion = animateTocPages(box, false)
    assert.equal(motion.options.fill, 'both')
    assert.equal(box.hidden, false)
    motion.finish(); await Promise.resolve()
    assert.equal(box.hidden, true)
    assert.equal(motion.hiddenWhenCanceled, true)
})

test('动画中途反转使用当前高度，旧完成回调不能隐藏新展开', async t => {
    environment(t)
    const box = animationBox(), closing = animateTocPages(box, false)
    box.currentHeight = 72; box.currentOpacity = .4
    const opening = animateTocPages(box, true)
    assert.equal(closing.canceled, true)
    assert.deepEqual(opening.frames[0], { height: '72px', opacity: .4 })
    assert.equal(opening.frames[1].height, '180px')
    closing.finish(); await Promise.resolve(); assert.equal(box.hidden, false)
    opening.finish(); await Promise.resolve()
    assert.equal(box.hidden, false); assert.equal(opening.canceled, true)
})

test('减少动态直接改可见性，不测量目录高度或读取样式', t => {
    environment(t, { reduced: true })
    const box = animationBox()
    globalThis.getComputedStyle = () => { throw Error('无需样式测量') }
    assert.equal(animateTocPages(box, false), null)
    assert.equal(box.hidden, true)
    animateTocPages(box, true)
    assert.equal(box.hidden, false); assert.equal(box.reads, 0); assert.equal(box.animations.length, 0)
})

test('关闭动画选项或不支持Web Animations时仍能正常开合', t => {
    environment(t)
    const box = animationBox()
    const running = animateTocPages(box, false)
    animateTocPages(box, true, { animate: false })
    assert.equal(running.canceled, true); assert.equal(box.hidden, false)
    delete box.animate
    animateTocPages(box, false); assert.equal(box.hidden, true)
    animateTocPages(box, true); assert.equal(box.hidden, false)
})
