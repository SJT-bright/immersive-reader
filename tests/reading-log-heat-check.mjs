// 每日记录浏览器验收。运行前启动隔离测试服务（禁止使用正式 8940）：
// READER_URL=http://127.0.0.1:19170/ PLAYWRIGHT_CORE=/absolute/path/index.mjs node tests/reading-log-heat-check.mjs
// 固定 fixture 只存在当前测试页面内，不写入书库或设置数据库。
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const target = process.env.READER_URL || 'http://127.0.0.1:19170/'
if (!/^http:\/\/127\.0\.0\.1:(?!8940(?:\/|$))\d+\//.test(target)) throw new Error('只允许非 8940 的 localhost 测试地址')
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
})
const results = []
const evidence = new URL('../.preview/daily-heatmap-20261008/', import.meta.url)
mkdirSync(evidence, { recursive: true })
const check = name => { results.push(name); console.log('PASS', name) }
const setup = async page => {
    await page.goto(target)
    await page.waitForSelector('#top-settings:not([disabled])')
    await page.evaluate(async () => {
        const log = await import('/js/reading-log.js')
        const ui = await import('/js/reading-log-ui.js')
        const now = new Date(2026, 9, 8, 12).getTime()
        const source = log.emptyLog()
        source.days = { '2026-10-07': { ms: 71 * 60000 }, '2026-10-05': { ms: 42000 } }
        log.startSession(source, now - 59000)
        log.tickLog(source, now - 1000)
        // todayMs=59s，days=58s；今天不得把 current.elapsedMs 再加一次。
        window.heatFixture = { source, now, body: document.querySelector('#panel-body'), log, ui }
        document.querySelector('#panel').classList.remove('hidden')
        document.querySelector('#panel-title').textContent = '阅读记录'
        ui.renderLogPanel(heatFixture.body, log.summarize(source, now))
        document.querySelector('.log-heat-wrap').scrollIntoView({ block: 'center' })
    })
}
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 850 }, serviceWorkers: 'block' })
    await context.route('**/_reader/library', route => route.abort())
    const page = await context.newPage()
    await setup(page)
    assert.ok(await page.locator('.log-heat-scroll').evaluate(el => el.scrollWidth <= el.clientWidth), '常规桌面面板应完整显示 16 周，无需水平滚动')
    const day = key => page.locator(`[data-heat-day="${key}"]`)
    const tip = page.locator('.log-heat-tooltip')
    await day('2026-10-07').hover()
    assert.equal(await tip.locator('.log-heat-tooltip-date').textContent(), '2026年10月7日')
    assert.equal(await tip.locator('.log-heat-tooltip-duration').textContent(), '阅读 71 分钟')
    assert.equal(await day('2026-10-07').getAttribute('title'), null, '不等待原生 title 的长延迟')
    check('即时显示完整日期与 71 分钟，超过一小时仍保留分钟精度')
    await day('2026-10-06').hover()
    assert.equal(await tip.locator('.log-heat-tooltip-duration').textContent(), '阅读 0 分钟')
    await day('2026-10-05').hover()
    assert.equal(await tip.locator('.log-heat-tooltip-duration').textContent(), '阅读 0 分钟（不足 1 分钟）')
    assert.notEqual(await day('2026-10-05').evaluate(cell => getComputedStyle(cell).backgroundColor), await day('2026-10-06').evaluate(cell => getComputedStyle(cell).backgroundColor), '有少量阅读的日期也应区别于未阅读')
    check('0 分钟与不足 1 分钟可以逐日查看')

    await day('2026-10-08').hover()
    assert.equal(await day('2026-10-08').getAttribute('data-heat-ms'), '59000')
    await page.evaluate(() => {
        window.originalHeatCell = document.querySelector('[data-heat-day="2026-10-08"]')
        window.originalHeatTooltip = document.querySelector('.log-heat-tooltip')
        originalHeatCell.focus({ preventScroll: true })
        heatFixture.now += 1000
        heatFixture.log.tickLog(heatFixture.source, heatFixture.now)
        heatFixture.ui.patchLogPanel(heatFixture.body, heatFixture.log.summarize(heatFixture.source, heatFixture.now))
    })
    assert.equal(await tip.locator('.log-heat-tooltip-duration').textContent(), '阅读 1 分钟')
    const preserved = await page.evaluate(() => ({
        cell: originalHeatCell === document.querySelector('[data-heat-day="2026-10-08"]'),
        tooltip: originalHeatTooltip === document.querySelector('.log-heat-tooltip'),
        focus: document.activeElement === originalHeatCell,
    }))
    assert.deepEqual(preserved, { cell: true, tooltip: true, focus: true })
    const mutations = await page.evaluate(async () => {
        let count = 0
        const observer = new MutationObserver(changes => { count += changes.length })
        observer.observe(originalHeatTooltip, { childList: true, subtree: true, characterData: true })
        heatFixture.now += 1000
        heatFixture.log.tickLog(heatFixture.source, heatFixture.now)
        heatFixture.ui.patchLogPanel(heatFixture.body, heatFixture.log.summarize(heatFixture.source, heatFixture.now))
        await Promise.resolve()
        observer.disconnect()
        return count
    })
    assert.equal(mutations, 0, '同一分钟的每秒 tick 不重新写 tooltip 文字')
    check('今天含活跃尾差，跨分钟实时更新且格子、tooltip、焦点均保留')
    await day('2026-10-07').hover()
    await page.locator('.log-heat-wrap').screenshot({ path: fileURLToPath(new URL('desktop.png', evidence)) })

    await day('2026-10-08').hover()
    await day('2026-10-08').focus()
    await page.keyboard.press('ArrowUp')
    assert.equal(await page.evaluate(() => document.activeElement.dataset.heatDay), '2026-10-07')
    assert.equal(await tip.locator('.log-heat-tooltip-duration').textContent(), '阅读 71 分钟')
    await page.evaluate(() => {
        heatFixture.now += 1000
        heatFixture.log.tickLog(heatFixture.source, heatFixture.now)
        heatFixture.ui.patchLogPanel(heatFixture.body, heatFixture.log.summarize(heatFixture.source, heatFixture.now))
    })
    assert.equal(await tip.locator('.log-heat-tooltip-duration').textContent(), '阅读 71 分钟', '鼠标仍停在今天，秒级更新也不得抢走键盘所查看的日期')
    await page.keyboard.press('ArrowLeft')
    assert.equal(await page.evaluate(() => document.activeElement.dataset.heatDay), '2026-09-30')
    await page.keyboard.press('Escape')
    assert.equal(await tip.isVisible(), false)
    assert.equal(await page.locator('[data-heat-day][tabindex="0"]').count(), 1)
    check('键盘按天/周查看，Esc 收起，宫格只占一个 Tab 停靠点')

    // 午夜与周一边界：保留仍在范围内的目标，只新增新日/淘汰旧周。
    const retained = await page.evaluate(() => {
        const key = '2026-10-07'
        const cell = document.querySelector(`[data-heat-day="${key}"]`)
        const snap = heatFixture.log.summarize(heatFixture.source, heatFixture.now)
        snap.current = null
        snap.now = new Date(2026, 9, 12, 12).getTime()
        snap.todayMs = 0
        heatFixture.ui.patchLogPanel(heatFixture.body, snap)
        return { preserved: cell === document.querySelector(`[data-heat-day="${key}"]`), today: document.querySelector('.log-heat-cell.today').dataset.heatDay }
    })
    assert.deepEqual(retained, { preserved: true, today: '2026-10-12' })
    check('自然日与周边界正确刷新日期，保留仍在范围内的原格子')

    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' })
    await touch.route('**/_reader/library', route => route.abort())
    const mobile = await touch.newPage()
    await setup(mobile)
    await mobile.locator('[data-heat-day="2026-10-07"]').tap()
    assert.equal(await mobile.locator('.log-heat-tooltip-duration').textContent(), '阅读 71 分钟')
    const bounds = await mobile.evaluate(() => {
        const tip = document.querySelector('.log-heat-tooltip').getBoundingClientRect()
        const root = document.querySelector('.log-heat-wrap').getBoundingClientRect()
        return { fitsViewport: tip.left >= 0 && tip.right <= innerWidth, fitsRoot: tip.left >= root.left && tip.right <= root.right, months: document.querySelector('.log-heat-months').textContent, bodyOverflow: document.documentElement.scrollWidth > innerWidth }
    })
    assert.ok(bounds.fitsViewport && bounds.fitsRoot)
    assert.ok(bounds.months.includes('9月') && bounds.months.includes('10月'))
    assert.equal(bounds.bodyOverflow, false)
    check('390px 触屏点按可见日期与分钟，tooltip 在屏内，月份明确且页面不横向溢出')
    await mobile.locator('.log-heat-wrap').screenshot({ path: fileURLToPath(new URL('touch-390.png', evidence)) })
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
}
