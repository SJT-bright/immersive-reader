// 翻页动效验收：驱动完整应用，检查「翻页真的在动」「连点不吞页」「跨章不空白」。
//
// 只允许在 8941 测试地址运行：它会清空该地址的浏览器资料，绝不碰日常使用的 8940。
// 运行：
//   python3 scripts/serve.py --port 8941 --no-open
//   PLAYWRIGHT_CORE=/绝对路径/playwright-core/index.js node tests/page-turn-check.mjs
const BASE = process.env.READER_URL || 'http://127.0.0.1:8941/'
const CORE = process.env.PLAYWRIGHT_CORE || 'playwright-core'

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

const pass = []
const fail = []
const check = (name, ok, detail = '') => (ok ? pass : fail).push(name + (detail ? ` → ${detail}` : ''))
const wait = ms => new Promise(r => setTimeout(r, ms))

const browser = await chromium.launch({ channel: 'chrome' })
const runtimeErrors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
page.on('pageerror', e => runtimeErrors.push('pageerror: ' + e.message))
page.on('console', m => {
    if (m.type() === 'error' && !/favicon|Content Security Policy|net::ERR/i.test(m.text())) {
        runtimeErrors.push('console: ' + m.text())
    }
})

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await wait(1400)
await page.setInputFiles('#file-book', 'tests/fixtures/山中的信.txt')
await page.waitForFunction(() => Boolean(document.querySelector('#reading-title')?.textContent), null, { timeout: 40000 })
await wait(3000)

// 一次翻页的逐帧轨迹：版面元素的 transform 位移、分支判定、耗时
const traceTurn = (selector, warmupClicks = 0) => page.evaluate(async ({ selector, warmupClicks }) => {
    for (let i = 0; i < warmupClicks; i++) {
        document.querySelector('#page-next').click()
        await new Promise(r => setTimeout(r, 1500))
    }
    const host = document.querySelector('#reader-host')
    const reader = window.__readerInstance
    const c = document.querySelector('foliate-view').renderer.__readerShadow.getElementById('container')
    const frames = []
    const t0 = performance.now()
    await new Promise(r => setTimeout(r, 30))
    document.querySelector(selector).click()
    await new Promise(resolve => {
        const step = () => {
            const leaf = c.firstElementChild
            const m = new DOMMatrixReadOnly(getComputedStyle(leaf).transform)
            frames.push([Math.round(performance.now() - t0), Math.round(m.m41 || 0)])
            if (performance.now() - t0 < 620) requestAnimationFrame(step)
            else resolve()
        }
        requestAnimationFrame(step)
    })
    await new Promise(r => setTimeout(r, 600))
    return { frames, decision: reader.turn.lastTurn, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches }
}, { selector, warmupClicks })

const summarize = trace => {
    const moved = trace.frames.filter(f => f[1] !== 0)
    const peak = moved.length ? Math.max(...moved.map(f => Math.abs(f[1]))) : 0
    return { frames: moved.length, peak, decision: trace.decision?.kind, boundary: trace.decision?.boundary }
}

// ---- 同章翻页：应走 slide，且至少 6 帧有位移 ----
{
    const trace = await traceTurn('#page-next', 2)
    const s = summarize(trace)
    check('同章下一页走纸面滑移（slide）', s.decision === 'slide', JSON.stringify(trace.decision))
    check('同章翻页有连续位移帧（≥6 帧）', s.frames >= 6, `${s.frames} 帧，峰值 ${s.peak}px`)
    check('位移量级合理（接近一栏宽）', s.peak > 200 && s.peak < 1400, `${s.peak}px`)
    const decay = trace.frames.filter(f => f[1] !== 0).map(f => Math.abs(f[1]))
    const monotonic = decay.every((v, i) => i === 0 || v <= decay[i - 1] + 2)
    check('位移单调收敛到 0（没有回弹或反向）', monotonic, decay.join(','))
}

// ---- 上一页 ----
{
    const trace = await traceTurn('#page-prev', 0)
    const s = summarize(trace)
    check('上一页同样有位移帧', s.frames >= 6 || s.decision === 'section', `${s.frames} 帧 · ${s.decision}`)
    check('上一页方向为 prev', trace.decision?.dir === -1, JSON.stringify(trace.decision))
}

// ---- 跨章翻页：走 section，不出现空白栏 ----
{
    // 先翻到本章最后一张正文页，下一翻必然跨章
    await page.evaluate(async () => {
        for (let i = 0; i < 14; i++) {
            const r = document.querySelector('foliate-view').renderer
            if (r.page >= Math.max(1, r.pages - 2)) break
            document.querySelector('#page-next').click()
            await new Promise(res => setTimeout(res, 1500))
        }
    })
    await wait(600)
    const label = await page.textContent('#reading-title')
    const trace = await traceTurn('#page-next', 0)
    const s = summarize(trace)
    check('跨章翻页被识别为边界', s.boundary === true, `${label} · ` + JSON.stringify(trace.decision))
    check('跨章翻页走新版面推入（section）', s.decision === 'section', s.decision)
}

// ---- 连点三下：必须翻三页，不能吞 ----
{
    const before = await page.evaluate(() => window.__readerInstance.lastProgress.cfi)
    await page.evaluate(async () => {
        for (let i = 0; i < 3; i++) { document.querySelector('#page-next').click(); await new Promise(r => setTimeout(r, 40)) }
    })
    await wait(2600)
    const after = await page.evaluate(() => ({
        cfi: window.__readerInstance.lastProgress.cfi,
        queue: window.__readerInstance._queuedTurn,
        turning: Boolean(window.__readerInstance._turning),
    }))
    check('连点三下后已停止翻页', !after.turning && after.queue === 0, JSON.stringify({ queue: after.queue, turning: after.turning }))
    check('连点三下确实换了页', after.cfi !== before, `${before} → ${after.cfi}`)
}

// ---- 动画结束后不留残余 transform ----
{
    const residue = await page.evaluate(async () => {
        await new Promise(r => setTimeout(r, 400))
        const c = document.querySelector('foliate-view').renderer.__readerShadow.getElementById('container')
        const veil = document.querySelector('#reader-host .turn-veil')
        return {
            transform: getComputedStyle(c.firstElementChild).transform,
            inline: c.firstElementChild.getAttribute('style') || '',
            veilOpacity: veil ? getComputedStyle(veil).opacity : 'none',
            turning: document.querySelector('#reader-host').dataset.turning || '',
        }
    })
    check('翻页后版面元素无残留 transform', residue.transform === 'none', residue.transform)
    check('翻页中状态已清除', residue.turning === '', residue.turning)
}

// ---- 减少动态效果：直接跳过动画 ----
{
    const rm = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
    rm.on('pageerror', e => runtimeErrors.push('reduced pageerror: ' + e.message))
    await rm.goto(BASE, { waitUntil: 'networkidle' })
    await wait(1500)
    await rm.setInputFiles('#file-book', 'tests/fixtures/山中的信.txt')
    await rm.waitForFunction(() => Boolean(window.__readerInstance?.lastProgress), null, { timeout: 40000 })
    await wait(2500)
    const ok = await rm.evaluate(async () => {
        const reader = window.__readerInstance
        if (!reader) return 'no-reader'
        const before = reader.lastProgress.cfi
        await reader.next()
        await new Promise(r => setTimeout(r, 400))
        const c = document.querySelector('foliate-view').renderer.__readerShadow.getElementById('container')
        return {
            moved: reader.lastProgress.cfi !== before,
            transform: getComputedStyle(c.firstElementChild).transform,
            veil: Boolean(document.querySelector('#reader-host .turn-veil')),
        }
    })
    check('减少动态效果：仍能翻页', ok.moved === true, JSON.stringify(ok))
    check('减少动态效果：不做位移动画', ok.transform === 'none' && ok.veil === false, JSON.stringify(ok))
    await rm.close()
}

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
process.exit(ok ? 0 : 1)
