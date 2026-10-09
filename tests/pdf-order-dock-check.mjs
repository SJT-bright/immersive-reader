// 双流 PDF 阅读顺序 + 字号与速度浮层的实页检查。
// 运行：先起隔离服务 `python3 scripts/serve.py --port 19153 --no-open`，然后
// PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/pdf-order-dock-check.mjs
// 结束后删除 .preview/data-19153。全程不触碰 8940 正式库。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rmSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.preview/data-19153')

// ── 手写最小 PDF（ASCII、Helvetica、无压缩），左列正文、右列编号标题同基线 ──
function buildTwoColumnPdf () {
    const left = [
        'Left column line one that will wrap around',
        'the narrow measure of the page here.',
        'Second item body also spans two lines and',
        'continues after the break point.',
        'Third item body keeps going across the',
        'wrap boundary without losing letters.',
        'Fourth item body is written to fill the',
        'whole line before it breaks as well.',
        'Fifth item body closes the page with a',
        'full width line and a short tail.',
    ]
    const right = { 0: '31. First question title', 2: '32. Second question title', 4: '33. Third question title', 6: '34. Fourth question title', 8: '35. Fifth question title' }
    let y = 700
    const parts = []
    left.forEach((line, i) => {
        parts.push(`BT /F1 12 Tf 50 ${y} Td (${line}) Tj ET`)
        if (right[i]) parts.push(`BT /F1 12 Tf 400 ${y} Td (${right[i]}) Tj ET`)
        y -= 24
    })
    const stream = parts.join('\n')
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ]
    let out = '%PDF-1.4\n'
    const offsets = []
    objects.forEach((body, i) => {
        offsets.push(out.length)
        out += `${i + 1} 0 obj\n${body}\nendobj\n`
    })
    const xref = out.length
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n'
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
    return Buffer.from(out, 'latin1')
}

const results = [], errors = []
const check = (name, detail) => { results.push(name); console.log('PASS', name, JSON.stringify(detail ?? '')) }
const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true, args: ['--use-angle=metal'],
})
try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' })
    await context.route('**/_reader/library', route => route.abort())
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.stack))

    // ── 1. 双流 PDF 导入：正文不再串行 ──
    await page.goto('http://127.0.0.1:19153/')
    await page.waitForFunction(() => window.__readerScene?.currentImage)
    await page.locator('#file-book').setInputFiles({ name: 'two-col.pdf', mimeType: 'application/pdf', buffer: buildTwoColumnPdf() })
    await page.waitForFunction(() => !document.querySelector('#reader-column')?.classList.contains('hidden') &&
        document.querySelector('foliate-view')?.renderer?.getContents().some(c => c.doc?.body?.textContent?.length > 40), null, { timeout: 30000 })
    const text = await page.evaluate(() => document.querySelector('foliate-view').renderer.getContents().map(c => c.doc.body.textContent).join(''))
    assert.ok(text.includes('the narrow measure of the page here.'), '左列第二行缺失')
    assert.ok(text.includes('continues after the break point.'), '左列第四行缺失')
    assert.ok(!/around\s*31\./.test(text), `串行仍存在：${text.slice(0, 200)}`)
    assert.ok(!/and\s*32\./.test(text), `串行仍存在：${text.slice(0, 200)}`)
    assert.ok(!/the\s*33\./.test(text), `串行仍存在：${text.slice(0, 200)}`)
    assert.ok(text.includes('31. First question title'), '右列标题缺失')
    assert.ok(text.includes('35. Fifth question title'), '右列标题缺失')
    check('双流 PDF 导入后左右两流各自完整，无串行')

    // ── 2. 字号与速度浮层：下滑速度旁展示每屏停留时间 ──
    await page.locator('#reading-speed-details summary').click()
    await page.waitForFunction(() => document.querySelector('#reading-speed-popover')?.matches(':popover-open'))
    const dwell = page.locator('#reading-speed-dwell')
    await page.waitForFunction(() => !document.querySelector('#reading-speed-dwell')?.hidden)
    const dwellText = await dwell.textContent()
    assert.match(dwellText, /^每屏约 \d+ 秒$/, `停留时间文案异常：${dwellText}`)
    check('下滑速度旁显示每屏停留时间', { dwellText })
    // 滑到最快：每屏秒数应变小（range 输入用 evaluate 置值并派发 input）
    await page.locator('#reading-speed').evaluate(el => { el.value = '80'; el.dispatchEvent(new Event('input', { bubbles: true })) })
    const fastText = await dwell.textContent()
    assert.match(fastText, /^每屏约 \d+ 秒$/)
    assert.ok(Number(fastText.replace(/\D+/g, '')) < Number(dwellText.replace(/\D+/g, '')), `调快后秒数未变小：${dwellText} → ${fastText}`)
    check('拖动下滑速度滑杆，每屏秒数联动', { dwellText, fastText })
    // 切到定时翻页：label 变「每页停留」，换算行隐藏，避免重复
    await page.locator('[data-action="auto-settings"]').click()
    await page.locator('#auto-mode').selectOption('page')
    await page.locator('#panel-close').click()
    await page.locator('#reading-speed-details summary').click()
    await page.waitForFunction(() => document.querySelector('#reading-speed-popover')?.matches(':popover-open'))
    assert.equal(await page.locator('#reading-speed-label').textContent(), '每页停留')
    assert.ok(await dwell.isHidden(), '定时翻页下换算行应隐藏')
    check('定时翻页模式下换算行隐藏，label 为每页停留')

    assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
    check('全程无页面错误')
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
}
