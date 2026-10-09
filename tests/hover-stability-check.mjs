// Browser regression for stationary edge hover, idle cursor, parallax and reveal observation.
// Use an isolated port and a new Chrome context; never open the formal 8940 library.
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.READER_URL || 'http://127.0.0.1:19170/'
const CORE = process.env.PLAYWRIGHT_CORE || 'playwright-core'
const parsed = new URL(BASE)
if (parsed.hostname !== '127.0.0.1' || !parsed.port || ['8940', '8765', '19129'].includes(parsed.port)) throw new Error('Only an isolated localhost port is allowed')
const { chromium } = await import(CORE)
const browser = await chromium.launch({ channel: 'chrome' })
const checks = [], errors = []
const check = (name, ok, detail) => checks.push({ name, ok, detail })
const wait = ms => new Promise(r => setTimeout(r, ms))
const out = resolve('.preview/hover-stability')
mkdirSync(out, { recursive: true })

async function openReader (reducedMotion = 'no-preference') {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', reducedMotion })
    await context.route('**/_reader/library', route => route.abort())
    await context.addInitScript(() => {
        localStorage.setItem('immersive-reader-settings-v1', JSON.stringify({ background: { mode: 'fixed', fixedId: 'builtin:fp-desk' }, atmosphere: { enabled: false, weather: 'clear', motion: true } }))
    })
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(BASE, { waitUntil: 'networkidle' })
    await page.waitForFunction(() => !document.querySelector('#top-settings').disabled)
    await page.locator('#welcome .books-fold > summary').click()
    await page.locator('#recent-list .book3d[data-id="sample-book"]').click()
    await page.waitForFunction(() => !document.querySelector('#reader-column').classList.contains('hidden'))
    await wait(700)
    return { context, page }
}

async function edgeTrace (page, selector) {
    await page.mouse.move(5, 450)
    await wait(300)
    const rect = await page.locator(selector).boundingBox()
    await page.evaluate(sel => {
        const element = document.querySelector(sel)
        window.hoverTrace = { selector: sel, enters: 0, leaves: 0, rows: [] }
        element.addEventListener('pointerenter', window.edgeEnter = () => window.hoverTrace.enters++)
        element.addEventListener('pointerleave', window.edgeLeave = () => window.hoverTrace.leaves++)
    }, selector)
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height - 1)
    const sampling = page.evaluate(async () => {
        const element = document.querySelector(window.hoverTrace.selector)
        for (let i = 0; i < 48; i++) {
            const r = element.getBoundingClientRect(), s = getComputedStyle(element)
            window.hoverTrace.rows.push({ y: r.y, hover: element.matches(':hover'), translate: s.translate, transform: s.transform })
            await new Promise(requestAnimationFrame)
        }
        element.removeEventListener('pointerenter', window.edgeEnter)
        element.removeEventListener('pointerleave', window.edgeLeave)
    })
    // Tiny real pointer movements keep hit testing active as a person slides
    // along the edge; a perfectly stationary Chrome pointer may retain hover.
    for (let i = 0; i < 20; i++) {
        await page.mouse.move(rect.x + rect.width / 2 + (i % 2) * .25, rect.y + rect.height - 1)
        await wait(30)
    }
    await sampling
    return page.evaluate(() => window.hoverTrace)
}

try {
    const { page, context } = await openReader()
    // Reproduce the prior rule in the same real control without changing the source.
    const prior = await page.addStyleTag({ content: 'body button:hover:not(:disabled):not(.book3d):not(.book-del){translate:0 -3px!important;transition:translate .22s cubic-bezier(.2,.8,.3,1)!important}' })
    const originalTrace = await edgeTrace(page, '#top-settings')
    check('原悬停规则可复现按钮底边命中状态往复', originalTrace.leaves > 1 || originalTrace.rows.some(r => !r.hover), { enters: originalTrace.enters, leaves: originalTrace.leaves, hoverFrames: originalTrace.rows.filter(r => r.hover).length, frames: originalTrace.rows.length })
    await prior.evaluate(el => el.remove())
    for (const selector of ['#top-settings', '#reading-toc', '#reading-speed-details > summary', '#page-next']) {
        const trace = await edgeTrace(page, selector)
        const ys = trace.rows.map(r => r.y)
        const spread = Math.max(...ys) - Math.min(...ys)
        check(`${selector} 底边悬停保持命中框和状态稳定`, trace.enters === 1 && trace.leaves === 0 && trace.rows.every(r => r.hover) && spread < .2, { enters: trace.enters, leaves: trace.leaves, ySpread: spread })
    }
    await page.locator('#reading-speed-details > summary').hover()
    await wait(3800)
    const stationary = await page.evaluate(() => ({ idle: document.body.classList.contains('cursor-idle'), faded: document.querySelector('#reader-chrome').classList.contains('faded'), cursor: getComputedStyle(document.querySelector('#reading-speed-details > summary')).cursor }))
    check('字号与速度入口静止 3.8 秒仍保留鼠标与控件', !stationary.idle && !stationary.faded && stationary.cursor !== 'none', stationary)
    await page.locator('#reading-speed-details > summary').click()
    await wait(500)
    await page.locator('#reading-speed-popover [data-action="font-plus"]').hover()
    await wait(3300)
    const popup = await page.evaluate(() => ({ open: document.querySelector('#reading-speed-popover').matches(':popover-open'), idle: document.body.classList.contains('cursor-idle'), cursor: getComputedStyle(document.querySelector('#reading-speed-popover button')).cursor }))
    check('字号与速度浮层静止时不隐藏鼠标', popup.open && !popup.idle && popup.cursor !== 'none', popup)
    await page.keyboard.press('Escape')
    await wait(400)

    await page.evaluate(() => {
        window.pointerProbe = { rootMutations: 0, controlMutations: 0, longTasks: [] }
        const observer = new MutationObserver(rows => rows.forEach(r => {
            if (r.target === document.documentElement) window.pointerProbe.rootMutations++
            if (r.target.id === 'toolbar' || r.target.id === 'reader-chrome') window.pointerProbe.controlMutations++
        }))
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
        observer.observe(document.querySelector('#toolbar'), { attributes: true, attributeFilter: ['class'] })
        observer.observe(document.querySelector('#reader-chrome'), { attributes: true, attributeFilter: ['class'] })
        window.pointerObserver = observer
        window.longTaskObserver = new PerformanceObserver(list => window.pointerProbe.longTasks.push(...list.getEntries().map(e => e.duration)))
        window.longTaskObserver.observe({ type: 'longtask', buffered: false })
    })
    await page.mouse.move(4, 400)
    await page.mouse.move(120, 720, { steps: 100 })
    await wait(200)
    const pointer = await page.evaluate(() => ({ ...window.pointerProbe, rootX: document.documentElement.style.getPropertyValue('--fp-x'), bgX: document.querySelector('#bg-root').style.getPropertyValue('--fp-x'), readerX: document.querySelector('#reader-column').style.getPropertyValue('--fp-x') }))
    check('视差变量只落在背景与正文，扫动不写全页根节点', pointer.rootMutations === 0 && !pointer.rootX && pointer.bgX && pointer.bgX === pointer.readerX, pointer)
    check('移动鼠标不重复修改已显示工具栏 class', pointer.controlMutations === 0, pointer.controlMutations)
    check('隔离书桌场景 100 步鼠标扫动未出现 50ms 长任务', pointer.longTasks.length === 0, pointer.longTasks)
    const beforeControl = await page.evaluate(() => document.querySelector('#bg-root').style.getPropertyValue('--fp-x'))
    await page.locator('#top-settings').hover()
    const controlRect = await page.locator('#top-settings').boundingBox()
    await page.mouse.move(controlRect.x + controlRect.width * .7, controlRect.y + controlRect.height * .6, { steps: 12 })
    await wait(100)
    const afterControl = await page.evaluate(() => document.querySelector('#bg-root').style.getPropertyValue('--fp-x'))
    check('控件内移动鼠标冻结视差', beforeControl === afterControl, { beforeControl, afterControl })
    await page.mouse.move(8, 440)
    await wait(3300)
    check('离开控件后正文空闲仍可隐藏光标', await page.evaluate(() => document.body.classList.contains('cursor-idle')))
    await page.mouse.move(9, 441)
    check('再次移动立即唤回光标', await page.evaluate(() => !document.body.classList.contains('cursor-idle')))

    const staticControl = await page.evaluate(() => {
        const button = document.createElement('button'); button.setAttribute('data-reader-static-control', '')
        document.body.append(button); button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); button.click()
        const result = { pulse: button.classList.contains('is-clicked'), press: button.classList.contains('liquid-press'), style: button.style.cssText }
        button.remove(); return result
    })
    check('每日热力格不触发通用点击脉冲/按压坐标', !staticControl.pulse && !staticControl.press && !staticControl.style, staticControl)

    // A delayed reveal must not scan because unrelated document/background styles change.
    const observer = await page.evaluate(async () => {
        const { installLiquidMotion } = await import('./js/liquid-motion.js')
        const trigger = document.createElement('button'), surface = document.createElement('aside')
        trigger.id = 'hover-probe-trigger'; surface.id = 'hover-probe-surface'
        surface.style.cssText = 'display:none;position:fixed;left:10px;top:100px;width:100px;height:100px'
        document.body.append(trigger, surface)
        let reads = 0
        const nativeStyle = window.getComputedStyle
        window.getComputedStyle = (element, ...rest) => { if (element === surface) reads++; return nativeStyle.call(window, element, ...rest) }
        const dispose = installLiquidMotion({ bindings: [{ trigger: '#hover-probe-trigger', surface: '#hover-probe-surface' }] })
        trigger.click()
        await new Promise(requestAnimationFrame)
        const before = reads
        for (let i = 0; i < 12; i++) {
            document.documentElement.style.setProperty('--hover-probe', String(i))
            document.querySelector('#bg-root').style.setProperty('--hover-probe', String(i))
            await new Promise(requestAnimationFrame)
        }
        const after = reads
        const replacement = surface.cloneNode()
        replacement.style.display = 'block'
        surface.replaceWith(replacement)
        await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame)
        const revealed = replacement.classList.contains('liquid-surface-enter')
        window.getComputedStyle = nativeStyle
        dispose(); trigger.remove(); replacement.remove()
        document.documentElement.style.removeProperty('--hover-probe')
        document.querySelector('#bg-root').style.removeProperty('--hover-probe')
        return { before, after, revealed }
    })
    check('等待浮层期间忽略根节点/背景 style 更新，重建后仍能展开', observer.before === observer.after && observer.revealed, observer)
    await context.close()

    const rm = await openReader('reduce')
    await rm.page.mouse.move(5, 400)
    await rm.page.mouse.move(110, 710, { steps: 20 })
    await rm.page.locator('#top-settings').click()
    await wait(100)
    const reduced = await rm.page.evaluate(() => ({ bgX: document.querySelector('#bg-root').style.getPropertyValue('--fp-x'), readerX: document.querySelector('#reader-column').style.getPropertyValue('--fp-x'), animations: document.querySelector('#panel').getAnimations().length, shown: !document.querySelector('#panel').classList.contains('hidden') }))
    check('减少动态偏好下停用视差与面板动画，入口照常可用', !reduced.bgX && !reduced.readerX && reduced.animations === 0 && reduced.shown, reduced)
    await rm.context.close()
} finally {
    await browser.close()
}
check('页面无 JavaScript 异常', errors.length === 0, errors)
const result = { url: BASE, testedAt: new Date().toISOString(), passed: checks.filter(c => c.ok).length, failed: checks.filter(c => !c.ok).length, checks }
writeFileSync(resolve(out, 'result.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
process.exit(result.failed ? 1 : 0)
