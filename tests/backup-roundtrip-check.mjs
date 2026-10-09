// 备份导出 → 恢复 的全链路实页检查（含进度提示与覆盖恢复后的重启回读）。
// 运行：先起隔离服务 `python3 scripts/serve.py --port 19155 --no-open`，然后
// PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/backup-roundtrip-check.mjs
// 全程 19155 隔离数据，用后即删；不触碰 8940 正式库。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rmSync, readFileSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.preview/data-19155')

const results = []
const check = (name, detail) => { results.push(name); console.log('PASS', name, JSON.stringify(detail ?? '')) }
const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--use-angle=metal'],
})
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block', acceptDownloads: true })
    await context.route('**/_reader/library', route => route.abort())
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.stack))
    await page.goto('http://127.0.0.1:19155/')
    await page.waitForFunction(() => window.__readerScene?.currentImage)
    await page.evaluate(() => {
        window.__toasts = []
        new MutationObserver(() => {
            const t = document.querySelector('#toast')?.textContent
            if (t) window.__toasts.push(t)
        }).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true })
    })

    // 1. 导入一本测试书
    await page.locator('#file-book').setInputFiles(fileURLToPath(new URL('./fixtures/山中的信.txt', import.meta.url)))
    await page.waitForFunction(() => /已导入「/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 30000 })

    // 2. 导出备份（下载文件），进度提示可见
    await page.locator('#top-settings').click()
    await page.waitForFunction(() => document.querySelector('#panel')?.classList.contains('hidden') === false)
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 })
    await page.locator('[data-action="backup-export"]').click()
    const download = await downloadPromise
    const backupPath = path.resolve('.preview/backup-roundtrip.json')
    await download.saveAs(backupPath)
    const payload = JSON.parse(readFileSync(backupPath, 'utf8'))
    assert.equal(payload.app, 'immersive-reader')
    // 隔离库启动自带内置示例书，备份 = 示例书 + 刚导入的测试书
    assert.ok(payload.data.books.length >= 2, `备份里应至少有 2 本书，实际 ${payload.data.books.length}`)
    assert.ok(payload.data.books.some(b => b.title.includes('山中的信')), '刚导入的书没进备份')
    const backupCount = payload.data.books.length
    const { exportToasts } = await page.evaluate(() => ({ exportToasts: window.__toasts.filter(t => /正在导出备份/.test(t)) }))
    assert.ok(exportToasts.length >= 1, '导出期间没有出现进度提示')
    check('备份导出落盘且带进度提示', { books: payload.data.books.length, bytes: payload.exportedAt })

    // 3. 刷新后用备份做覆盖恢复
    await page.reload()
    await page.waitForFunction(() => window.__readerScene?.currentImage, null, { timeout: 30000 })
    await page.locator('#file-backup').setInputFiles(backupPath)
    await page.waitForFunction(() => document.querySelector('[data-action="backup-overwrite"]'), null, { timeout: 30000 })
    await page.locator('[data-action="backup-overwrite"]').click()
    await page.waitForFunction(() => window.__readerScene?.currentImage, null, { timeout: 30000 })
    const restoreToasts = await page.evaluate(() => window.__toasts)
    const books = await page.evaluate(async () => {
        const db = await import('/js/db.js')
        return (await db.listBooks()).map(b => ({ title: b.title, format: b.format }))
    })
    assert.equal(books.length, backupCount, `覆盖恢复是整库替换：应为备份里的 ${backupCount} 本，实际 ${JSON.stringify(books)}；toast 时间线：${JSON.stringify(restoreToasts)}`)
    assert.ok(books.some(b => b.title.includes('山中的信')), '恢复后找不到测试书')
    check('备份覆盖恢复后书库回读一致', books[0])

    assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
    check('全程无页面错误')
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
    rmSync(path.resolve('.preview/backup-roundtrip.json'), { force: true })
}
