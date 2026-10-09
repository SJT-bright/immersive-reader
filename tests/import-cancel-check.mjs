// 导入取消的实页检查：大 TXT 导入途中点提示上的「取消」→ 中止、无残留、队列不坏。
// 运行：先起隔离服务 `python3 scripts/serve.py --port 19159 --no-open`，然后
// PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/import-cancel-check.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.preview/data-19159')

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
    await page.goto('http://127.0.0.1:19159/')
    await page.waitForFunction(() => window.__readerScene?.currentImage)

    // 1. 大 TXT 导入途中点「取消」（250 万行 ≈ 46MB：转换窗口足够宽，点击必落在检查点上；
    //    Playwright 内联 buffer 上限 50MB，所以写到磁盘传路径，夹具跨运行复用）
    const bigPath = path.resolve('.preview/big-cancel-fixture.txt')
    if (!existsSync(bigPath)) {
        const LINE = '这是一行二十个字左右的中文文本内容测试。'
        const chunks = []
        for (let i = 0; i < 2500000; i++) {
            chunks.push(i > 0 && i % 100000 === 0 ? `第${i / 100000 + 1}章 分界 ${i}` : LINE)
            if (i % 3 === 2) chunks.push('')
        }
        writeFileSync(bigPath, chunks.join('\n'), 'utf8')
    }
    await page.locator('#file-book').setInputFiles(bigPath)
    // 时间线 instrumentation：每次 toast 变化都记时间戳
    await page.evaluate(() => {
        window.__tl = []
        new MutationObserver(() => {
            const t = document.querySelector('#toast')
            if (t) window.__tl.push({ t: Math.round(performance.now()), text: t.textContent?.slice(0, 40), hasBtn: !!t.querySelector('.toast-undo') })
        }).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true })
    })
    // 转换很快而 detect 段是同步的：Playwright 输入派发的时机不可控，
    // 改为在第一个进度出现后（切分循环已在跑），用页面内 .click() 直接触发
    // 真实按钮的 onclick——派发时机可控，且走的仍是 UI 的取消路径。
    await page.waitForFunction(() => /已读入 \d+%/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 20000 })
    await page.evaluate(() => document.querySelector('#toast .toast-undo')?.click())
    try {
        await page.waitForFunction(() => /已取消导入/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 })
    } catch (e) {
        const dump = await page.evaluate(() => ({ tl: window.__tl, toast: document.querySelector('#toast')?.textContent }))
        throw new Error(`取消后未出现确认。现场：${JSON.stringify(dump)}；原错误：${e.message}`)
    }
    check('导入途中点取消，出现「已取消导入」确认')

    const afterCancel = await page.evaluate(async () => {
        const db = await import('/js/db.js')
        return (await db.listBooks()).map(b => b.title)
    })
    assert.deepEqual(afterCancel, ['山居小记（示例书）'], `取消后书库应只有示例书，实际 ${JSON.stringify(afterCancel)}`)
    check('取消的书没有半本入库')

    // 2. 取消后再正常导入小文件：队列没有被破坏
    await page.locator('#file-book').setInputFiles(fileURLToPath(new URL('./fixtures/山中的信.txt', import.meta.url)))
    await page.waitForFunction(() => /已导入「/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 30000 })
    const afterNormal = await page.evaluate(async () => {
        const db = await import('/js/db.js')
        return (await db.listBooks()).length
    })
    assert.equal(afterNormal, 2, '取消后的下一次导入应正常完成')
    check('取消不打坏后续导入')

    // 3. 没有误报的错误卡片
    const hasErrorCard = await page.evaluate(() => document.querySelector('#panel')?.textContent?.includes('导入 / 打开失败') || false)
    assert.equal(hasErrorCard, false, '取消不应作为失败进错误卡片')
    check('取消不进错误卡片')

    assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
    check('全程无页面错误')
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
    rmSync(path.resolve('.preview/big-cancel-fixture.txt'), { force: true })
}
