// 走查修复的实页检查：浮层快捷入口、计时器左键、示例书标注、音乐空状态引导。
// 运行：先起隔离服务 `python3 scripts/serve.py --port 19158 --no-open`，然后
// PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/ux-fixes-check.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rmSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.preview/data-19158')

const results = []
const check = (name, detail) => { results.push(name); console.log('PASS', name, JSON.stringify(detail ?? '')) }
const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--use-angle=metal'],
})
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
    await context.route('**/_reader/library', route => route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.stack))
    await page.goto('http://127.0.0.1:19158/')
    await page.waitForFunction(() => window.__readerScene?.currentImage)

    // 1. 示例书标题带标注（全新库直接建出新标题）
    const sampleTitle = await page.evaluate(async () => {
        const db = await import('/js/db.js')
        return (await db.getBook('sample-book'))?.title
    })
    assert.equal(sampleTitle, '山居小记（示例书）', `示例书标题=${sampleTitle}`)
    check('示例书标题带「示例书」标注')

    // 2. 打开书与浮层
    await page.click('text=最近书籍')
    await page.waitForTimeout(1000)
    await page.getByText('山居小记', { exact: false }).first().click()
    await page.waitForFunction(() => !document.querySelector('#reader-column')?.classList.contains('hidden'), null, { timeout: 30000 })
    await page.click('#reading-speed-details > summary')
    await page.waitForFunction(() => document.querySelector('#reading-speed-popover')?.matches(':popover-open'))
    for (const label of ['书架', '音乐', '环境']) {
        assert.ok(await page.locator(`#reading-speed-popover [data-action="quick-shelf"], #reading-speed-popover [data-action="quick-music"], #reading-speed-popover [data-action="quick-scene"]`).count() === 3, '三个快捷入口应齐备')
        break
    }
    check('浮层「常用」区新增 书架/音乐/环境 三个快捷入口')
    await page.click('#reading-speed-popover [data-action="quick-music"]')
    await page.waitForFunction(() => document.querySelector('#panel-title')?.textContent === '音乐', null, { timeout: 8000 })
    check('快捷入口：音乐一步直达')
    await page.click('#panel-close')
    await page.click('#reading-speed-details > summary')
    await page.waitForFunction(() => document.querySelector('#reading-speed-popover')?.matches(':popover-open'))
    await page.click('#reading-speed-popover [data-action="quick-scene"]')
    await page.waitForFunction(() => document.querySelector('#panel-title')?.textContent === '阅读环境', null, { timeout: 8000 })
    check('快捷入口：阅读环境一步直达')
    await page.click('#panel-close')

    // 3. 计时器左键打开阅读记录
    await page.locator('#reading-timer').click({ position: { x: 8, y: 30 } })
    await page.waitForFunction(() => document.querySelector('#panel-title')?.textContent === '阅读记录', null, { timeout: 8000 })
    check('计时器左键直接打开阅读记录')
    await page.click('#panel-close')

    // 4. 音乐空状态：引导按钮可见，点击后滚动到内置音源
    await page.click('#reading-speed-details > summary')
    await page.waitForFunction(() => document.querySelector('#reading-speed-popover')?.matches(':popover-open'))
    await page.click('#reading-speed-popover [data-action="quick-music"]')
    await page.waitForFunction(() => document.querySelector('#panel-title')?.textContent === '音乐', null, { timeout: 8000 })
    const cta = page.locator('#music-empty-cta')
    await cta.scrollIntoViewIfNeeded()
    assert.ok(await cta.isVisible(), '空状态引导块应可见')
    const before = await page.evaluate(() => document.querySelector('.music-scroll')?.scrollTop || 0)
    await page.click('#music-empty-cta [data-action="goto-builtin"]')
    await page.waitForTimeout(900)
    const after = await page.evaluate(() => document.querySelector('.music-scroll')?.scrollTop || 0)
    assert.ok(after > before, `点引导后应滚向内置音源（scrollTop ${before} → ${after}）`)
    check('音乐空状态引导一键滚到内置音源', { scrollTop: `${Math.round(before)}→${Math.round(after)}` })

    assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
    check('全程无页面错误')
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
}
