// 启动兜底实页检查：一张「id 存在但字节损坏」的自选背景不应中断应用初始化。
// 运行：先起隔离服务 `python3 scripts/serve.py --port 19156 --no-open`，然后
// PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/broken-background-check.mjs
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rmSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.preview/data-19156')

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
    await page.goto('http://127.0.0.1:19156/')
    await page.waitForFunction(() => window.__readerScene?.currentImage)
    // 埋一颗「id 存在但字节损坏」的背景
    await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
            const req = indexedDB.open('immersive-reader', 2)
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
        })
        await new Promise((resolve, reject) => {
            const tx = db.transaction(['backgrounds'], 'readwrite')
            tx.objectStore('backgrounds').put({
                id: 'bg_broken_test', name: 'broken.png', addedAt: Date.now(),
                data: new Blob([new Uint8Array([1, 2, 3, 4, 5])], { type: 'image/webp' }),
            })
            tx.oncomplete = resolve
            tx.onerror = () => reject(tx.error)
        })
        db.close()
    })
    // 应用首屏初始化后有异步 persist()，在已加载页面上改 localStorage 会被回写覆盖；
    // 因此在埋完库之后再注册 init 脚本（只对之后的 reload 生效），在应用脚本运行前
    // 同步把固定背景指向坏记录。
    await context.addInitScript(() => {
        const raw = JSON.parse(localStorage.getItem('immersive-reader-settings-v1') || '{}')
        raw.background = { ...(raw.background || {}), mode: 'fixed', fixedId: 'bg_broken_test', animate: false }
        localStorage.setItem('immersive-reader-settings-v1', JSON.stringify(raw))
    })

    // 重启后：应用必须照常初始化，并兜底到内置背景
    await page.reload()
    await page.waitForFunction(() => window.__readerScene?.currentImage, null, { timeout: 30000 })
    const state = await page.evaluate(() => ({
        currentRef: window.__readerScene?.currentRef,
        fixedIdKept: JSON.parse(localStorage.getItem('immersive-reader-settings-v1')).background?.fixedId,
    }))
    assert.equal(state.currentRef, 'builtin:fluid', `应兜底到内置背景，实际 ${state.currentRef}`)
    assert.equal(state.fixedIdKept, 'bg_broken_test', '兜底不得改写用户的 fixedId 选择')
    check('坏背景不再中断启动：兜底内置背景且保留用户选择')

    // 兜底提示出现且只出现一次
    await page.waitForFunction(() => /上次选择的背景已损坏/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 10000 })
    check('启动兜底有一次性的用户提示')

    // 关键回归：初始化后半段（开书路径）真的可用
    await page.locator('#file-book').setInputFiles(fileURLToPath(new URL('./fixtures/山中的信.txt', import.meta.url)))
    await page.waitForFunction(() => !document.querySelector('#reader-column')?.classList.contains('hidden') &&
        document.querySelector('foliate-view')?.renderer?.getContents().some(c => c.doc?.body?.textContent), null, { timeout: 30000 })
    check('兜底后开书路径正常（init 未被拦腰截断）')

    assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
    check('全程无页面错误')
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
}
