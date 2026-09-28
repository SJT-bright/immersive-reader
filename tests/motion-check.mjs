// 动效验收：驱动完整应用，逐个打开/关闭界面，确认每一处都是"缓慢渐显弹出"，
// 并且同一个元素不会有两段动画叠着放（那会看得到一次跳变）。
//
// 只允许在 127.0.0.1:8941 测试地址运行。
//   python3 scripts/serve.py --port 8941 --no-open
//   PLAYWRIGHT_CORE=/绝对路径/playwright-core/index.js node tests/motion-check.mjs
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.READER_URL || 'http://127.0.0.1:8941/'
const CORE = process.env.PLAYWRIGHT_CORE || 'playwright-core'
const OUT = resolve('.preview/motion-check')

if (!/^http:\/\/127\.0\.0\.1:8941\//.test(BASE)) {
    console.error(`拒绝运行：只允许 127.0.0.1:8941 测试地址，收到 ${BASE}`)
    process.exit(2)
}
let chromium
try {
    const mod = await import(CORE)
    chromium = mod.chromium || mod.default?.chromium
} catch (e) {
    console.error(`无法加载 playwright-core（${CORE}）：${e.message}`)
    process.exit(2)
}
mkdirSync(OUT, { recursive: true })

const pass = []
const fail = []
const check = (name, ok, detail = '') => (ok ? pass : fail).push(name + (detail ? ` → ${detail}` : ''))
const wait = ms => new Promise(r => setTimeout(r, ms))

const browser = await chromium.launch({ channel: 'chrome' })
const runtimeErrors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', e => runtimeErrors.push('pageerror: ' + e.message))
page.on('console', m => {
    if (m.type() === 'error' && !/favicon|Content Security Policy|net::ERR/i.test(m.text())) {
        runtimeErrors.push('console: ' + m.text())
    }
})

// 读取元素上此刻正在跑的动画（含 CSS animation 与 WAAPI）
const running = sel => page.evaluate(s => {
    const el = document.querySelector(s)
    if (!el) return { missing: true }
    const list = el.getAnimations({ subtree: false }) || []
    const names = list.map(a => a.animationName || a.effect?.getKeyframes?.()[0]?.animationName || a.constructor.name)
    const durations = list.map(a => Math.round((a.effect?.getTiming?.().duration || 0)))
    return {
        count: list.length,
        anyRunning: list.some(a => a.playState === 'running'),
        names, durations,
        opacity: getComputedStyle(el).opacity,
    }
}, sel)

const wake = async () => { await page.mouse.move(700, 460); await wait(420) }

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await wait(1400)
await page.setInputFiles('#file-book', 'tests/fixtures/山中的信.txt')
await page.waitForFunction(() => Boolean(document.querySelector('#reading-title')?.textContent), null, { timeout: 40000 })
await wait(2200)

// ---------- 1. 设置面板：开与关都要有动画 ----------
await wake()
await page.click('#top-settings')
let a = await running('#panel')
check('面板打开有渐显动画', a.anyRunning === true, JSON.stringify(a))
check('面板只挂一段动画（不重复播放）', a.count === 1, JSON.stringify(a))
await wait(500)

// ---------- 2. 面板内切换分页：正文重新入场 ----------
await page.click('#toolbar button[data-cmd="font"]')
await wait(60)
a = await running('#panel-body')
check('切换分页时面板正文重新入场', a.anyRunning === true, JSON.stringify(a))
await wait(500)

// ---------- 3. 次级导航展开 ----------
await page.evaluate(() => document.querySelector('#nav-secondary').hidden && document.querySelector('#nav-more').click())
await wait(50)
a = await running('#nav-secondary')
check('次级导航展开有动画', a.anyRunning === true, JSON.stringify(a))
await wait(500)

// ---------- 4. 音乐分页：外层与内层不能同时各放一段 ----------
await page.click('#toolbar button[data-cmd="music"]')
await wait(60)
const panelAnim = await running('#panel')
const bodyAnim = await running('#music-panel-body')
const paneAnim = await running('.music-pane:not([hidden])')
check('音乐分页有入场动画', paneAnim.anyRunning === true, JSON.stringify(paneAnim))
check('音乐面板外层不重复放动画', panelAnim.count <= 1 && bodyAnim.count === 0,
    JSON.stringify({ panel: panelAnim.count, body: bodyAnim.count, pane: paneAnim.count }))
await wait(600)

// ---------- 5. 更多设置折叠 ----------
await page.click('.np-more > summary')
await wait(60)
a = await running('.np-more > :not(summary)')
check('「更多设置」展开有动画', a.anyRunning === true || a.missing === true, JSON.stringify(a))
await page.click('.np-more > summary')
await wait(400)

// ---------- 6. 关闭面板：先退场再隐藏 ----------
await page.click('#panel-close')
await wait(70)
a = await running('#panel')
const stillShown = await page.evaluate(() => !document.querySelector('#panel').classList.contains('hidden'))
check('面板关闭有退场动画', a.anyRunning === true, JSON.stringify(a))
check('退场期间面板还没被立刻藏掉', stillShown === true)
await wait(500)
const hiddenNow = await page.evaluate(() => document.querySelector('#panel').classList.contains('hidden'))
check('退场结束后面板才隐藏', hiddenNow === true)

// ---------- 7. 目录浮层（popover="manual"，开关与退场都由 JS 统一负责） ----------
await wake()
await page.click('#reading-toc')
await wait(60)
a = await running('#reading-toc-popover')
check('目录浮层有渐显动画', a.anyRunning === true, JSON.stringify(a))
await page.screenshot({ path: resolve(OUT, '01-toc.png') })
await wait(500)
await page.click('#reading-toc')
await wait(70)
a = await running('#reading-toc-popover')
const popOpen = await page.evaluate(() => document.querySelector('#reading-toc-popover').matches(':popover-open'))
check('目录浮层有退场动画', a.anyRunning === true, JSON.stringify(a))
check('目录浮层退场后才收起', popOpen === true)
await wait(500)
check('目录浮层最终收起', await page.evaluate(() =>
    !document.querySelector('#reading-toc-popover').matches(':popover-open')))
// 回归：真实鼠标点第二次必须能关掉（auto popover 的 light dismiss 会让它"点了没反应"）
await page.click('#reading-toc')
await wait(600)
check('再点一次目录可以打开', await page.evaluate(() =>
    document.querySelector('#reading-toc-popover').matches(':popover-open')))
await page.click('#reading-toc')
await wait(600)
check('再点一次目录可以关闭', await page.evaluate(() =>
    !document.querySelector('#reading-toc-popover').matches(':popover-open')))
await page.click('#reading-toc')
await wait(600)
await page.mouse.click(200, 500)
await wait(600)
check('点浮层外面也能关掉', await page.evaluate(() =>
    !document.querySelector('#reading-toc-popover').matches(':popover-open')))

// ---------- 8. 速度浮层（details + popover） ----------
await wake()
await page.click('#reading-speed-details > summary')
await wait(60)
a = await running('#reading-speed-popover')
check('速度浮层有渐显动画', a.anyRunning === true, JSON.stringify(a))
check('速度浮层只挂一段动画', a.count === 1, JSON.stringify(a))
await page.screenshot({ path: resolve(OUT, '02-speed.png') })
await page.keyboard.press('Escape')
await wait(400)

// ---------- 9. toast：走真实入口（目录页的「整体进度归零」会弹提示） ----------
await wake()
await page.click('#top-settings')
await wait(500)
await page.evaluate(() => document.querySelector('#toolbar button[data-cmd="toc"]').click())
await wait(600)
// 「整体进度归零」先要过 confirm()，所以先在页面里起一个轮询，再点按钮
page.once('dialog', d => d.accept())
const toastPoll = page.evaluate(async () => {
    const el = document.querySelector('#toast')
    const sample = () => ({
        hidden: el.classList.contains('hidden'),
        opacity: Number(getComputedStyle(el).opacity),
        running: el.getAnimations({ subtree: false }).some(x => x.playState === 'running'),
        count: el.getAnimations({ subtree: false }).length,
    })
    const t0 = performance.now()
    while (performance.now() - t0 < 6000) {
        if (el.getAnimations({ subtree: false }).some(a => a.playState === 'running')) break
        await new Promise(r => setTimeout(r, 16))
    }
    const appeared = { ...sample(), text: el.textContent, at: performance.now() }
    // 默认 3800ms 后开始淡出：在计时器刚过、动画还在播的瞬间取样
    while (performance.now() - appeared.at < 3810) await new Promise(r => setTimeout(r, 16))
    const mid = sample()
    await new Promise(r => setTimeout(r, 400))
    return { appeared, mid, gone: sample() }
})
await wait(60)
const toastBtn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('#panel-body button')].find(x => /整体进度归零/.test(x.textContent))
    if (!b) return null
    b.click()
    return b.textContent.trim()
})
check('目录页找到「整体进度归零」按钮', Boolean(toastBtn), String(toastBtn))
const toastTrace = await toastPoll
check('toast 弹出有渐显动画（不再被 display:none 打断）',
    toastTrace.appeared.hidden === false && toastTrace.appeared.count === 1,
    JSON.stringify(toastTrace.appeared))
check('toast 到点先播退场动画（此刻仍未隐藏）',
    toastTrace.mid.hidden === false && toastTrace.mid.running === true, JSON.stringify(toastTrace.mid))
check('toast 退场播完才收起', toastTrace.gone.hidden === true, JSON.stringify(toastTrace.gone))
await page.screenshot({ path: resolve(OUT, '03-toast.png') })
await page.click('#panel-close')
await wait(600)

// ---------- 10. 快捷键速查 ----------
await wait(3600)
await wake()
await page.keyboard.press('?')
await wait(70)
a = await running('#shortcut-help')
check('快捷键速查有渐显动画', a.anyRunning === true, JSON.stringify(a))
await page.screenshot({ path: resolve(OUT, '04-help.png') })
await page.keyboard.press('?')
await wait(70)
a = await running('#shortcut-help')
check('快捷键速查有退场动画', a.anyRunning === true, JSON.stringify(a))
await wait(400)
check('快捷键速查退场后隐藏', await page.evaluate(() =>
    document.querySelector('#shortcut-help').hidden === true))

// ---------- 11. 选字工具条 ----------
await wake()
const box = await page.evaluate(() => {
    const b = document.querySelector('foliate-view').getBoundingClientRect()
    return { x: b.x + b.width * 0.3, y: b.y + b.height * 0.45, w: b.width }
})
await page.mouse.move(box.x, box.y)
await page.mouse.down()
await page.mouse.move(box.x + 180, box.y + 4, { steps: 12 })
await page.mouse.up()
await wait(250)
a = await running('#selection-tools')
const toolsShown = await page.evaluate(() => !document.querySelector('#selection-tools').hidden)
check('选字后工具条出现', toolsShown === true)
check('选字工具条有渐显动画', a.anyRunning === true, JSON.stringify(a))
await page.screenshot({ path: resolve(OUT, '05-selection.png') })
await page.keyboard.press('Escape')
await wait(300)

// ---------- 12. 阅读环境（rain 分页）不重复放动画 ----------
await wake()
await page.click('#top-settings')
await wait(500)
await page.evaluate(() => document.querySelector('#nav-secondary').hidden && document.querySelector('#nav-more').click())
await page.click('#toolbar button[data-cmd="rain"]')
await wait(70)
const atmo = await running('#atmosphere-panel')
check('环境高级设置面板有动画且只一段', atmo.anyRunning === true && atmo.count === 1, JSON.stringify(atmo))
await page.screenshot({ path: resolve(OUT, '06-rain.png') })
await page.click('#panel-close')
await wait(500)

// ---------- 13. 减少动态效果：一切照常可用，只是不动 ----------
const rm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
rm.on('pageerror', e => runtimeErrors.push('reduced pageerror: ' + e.message))
await rm.goto(BASE, { waitUntil: 'networkidle' })
await wait(1600)
await rm.click('#top-settings')
await wait(200)
const rmState = await rm.evaluate(() => ({
    anims: document.querySelector('#panel').getAnimations({ subtree: false }).length,
    hidden: document.querySelector('#panel').classList.contains('hidden'),
    opacity: getComputedStyle(document.querySelector('#panel')).opacity,
}))
check('减少动态效果：面板直接显示且不放动画',
    rmState.hidden === false && rmState.anims === 0 && Number(rmState.opacity) === 1, JSON.stringify(rmState))
await rm.click('#panel-close')
await wait(200)
check('减少动态效果：面板立即隐藏（不等动画）', await rm.evaluate(() =>
    document.querySelector('#panel').classList.contains('hidden')))
await rm.close()

await page.close()
await browser.close()

console.log(`\n通过 ${pass.length}`)
pass.forEach(p => console.log('  ✔ ' + p))
if (fail.length) {
    console.log(`\n失败 ${fail.length}`)
    fail.forEach(f => console.log('  ✘ ' + f))
}
if (runtimeErrors.length) {
    console.log(`\n运行期错误 ${runtimeErrors.length}`)
    runtimeErrors.forEach(e => console.log('  ! ' + e))
}
const ok = fail.length === 0 && runtimeErrors.length === 0
console.log(ok ? '\n结果：全部通过' : '\n结果：存在失败项')
console.log(`截图：${OUT}`)
process.exit(ok ? 0 : 1)
