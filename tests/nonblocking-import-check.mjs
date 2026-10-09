// 非阻塞导入 + 空白章计数 + 坏章拒收的实页检查。
// 运行：先起隔离服务 `python3 scripts/serve.py --port 19154 --no-open`，然后
// PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs node tests/nonblocking-import-check.mjs
// 全程 19154 隔离数据，用后即删；不触碰 8940 正式库。
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rmSync } from 'node:fs'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE || 'playwright-core')
const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.preview/data-19154')

// ── 最小 STORED zip 构造器（与 js/txt2epub.js 同规则：mimetype 第一、无压缩）──
const CRC_TABLE = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
        t[n] = c >>> 0
    }
    return t
})()
function crc32 (bytes) {
    let c = 0xFFFFFFFF
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
    return (c ^ 0xFFFFFFFF) >>> 0
}
function buildZip (files) {
    const enc = s => Buffer.from(s, 'utf8')
    const parts = [], central = []
    let offset = 0
    for (const f of files) {
        const name = enc(f.name), data = enc(f.data), crc = crc32(data)
        const local = Buffer.alloc(30)
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(f.storeFirst ? 0 : 0x0800, 6)
        local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22)
        local.writeUInt16LE(name.length, 26)
        parts.push(local, name, data)
        const cd = Buffer.alloc(46)
        cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6)
        cd.writeUInt16LE(f.storeFirst ? 0 : 0x0800, 8)
        cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24)
        cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(offset, 42)
        central.push(cd, name)
        offset += 30 + name.length + data.length
    }
    const centralSize = central.reduce((s, p) => s + p.length, 0)
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10)
    eocd.writeUInt32LE(centralSize, 12); eocd.writeUInt32LE(offset, 16)
    return Buffer.concat([...parts, ...central, eocd])
}
const XHTML = body => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN"><head><meta charset="utf-8"/></head><body>${body}</body></html>`
function buildEpub (chapters) {
    // chapters: [{ name, body }]
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:check-fixture</dc:identifier><dc:title>夹具书</dc:title><dc:language>zh-CN</dc:language><meta property="dcterms:modified">2026-10-07T00:00:00Z</meta></metadata>
 <manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${chapters.map((c, i) => `<item id="c${i}" href="${c.name}" media-type="application/xhtml+xml"/>`).join('')}</manifest>
 <spine toc="ncx">${chapters.map((c, i) => `<itemref idref="c${i}"/>`).join('')}</spine>
</package>`
    const nav = `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><meta charset="utf-8"/></head><body><nav epub:type="toc"><ol>${chapters.map(c => `<li><a href="${c.name}">${c.name}</a></li>`).join('')}</ol></nav></body></html>`
    const ncx = `<?xml version="1.0" encoding="utf-8"?><ncx xmlns="http://www.daisy.org/z3986/2005/ncx" version="2005-1"><head/><docTitle><text>夹具书</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${c.name}</text></navLabel><content src="${c.name}"/></navPoint>`).join('')}</navMap></ncx>`
    return buildZip([
        { name: 'mimetype', data: 'application/epub+zip', storeFirst: true },
        { name: 'META-INF/container.xml', data: `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
        { name: 'OEBPS/content.opf', data: opf },
        { name: 'OEBPS/nav.xhtml', data: nav },
        { name: 'OEBPS/toc.ncx', data: ncx },
        ...chapters.map(c => ({ name: `OEBPS/${c.name}`, data: XHTML(c.body) })),
    ])
}

// ── 生成 ~13MB TXT（60 万行：段落以空行分隔、每 10 万行一个章标题）──
function buildBigTxt () {
    const LINE = '这是一行二十个字左右的中文文本内容测试。'
    const lines = []
    for (let i = 0; i < 600000; i++) {
        if (i > 0 && i % 100000 === 0) lines.push(`第${i / 100000 + 1}章 分界 ${i}`)
        else {
            lines.push(LINE)
            if (i % 3 === 2) lines.push('') // 段落间空行，真实 TXT 的段落结构
        }
    }
    return Buffer.from(lines.join('\n'), 'utf8')
}

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
    await page.goto('http://127.0.0.1:19154/')
    await page.waitForFunction(() => window.__readerScene?.currentImage)
    // 记录 toast 全部文本，供进度断言；应用开始处理（「正在导入」出现）时清零卡顿
    // 记录——setInputFiles 经 CDP 注入大文件本身会占用主线程，那是测试通道的成本，
    // 不是应用代码（真实用户走系统文件选择器），不计入。
    await page.evaluate(() => {
        window.__toasts = []
        window.__gaps = []
        let started = false
        new MutationObserver(() => {
            const t = document.querySelector('#toast')?.textContent
            if (!t) return
            if (!started && /正在导入/.test(t)) { started = true; window.__resetGaps?.() }
            window.__toasts.push({ t: Math.round(performance.now()), text: t.slice(0, 46) })
        }).observe(document.querySelector('#toast'), { childList: true, characterData: true, subtree: true })
    })

    // ── A. 大 TXT：导入期间主线程保持可响应，进度可见 ──
    await page.evaluate(() => {
        window.__gaps = []
        window.__stopJitter = false
        let last = performance.now()
        window.__resetGaps = () => { window.__gaps = []; last = performance.now() }
        const loop = () => {
            const now = performance.now()
            if (now - last > 100) window.__gaps.push({ d: Math.round(now - last), t: Math.round(now) })
            last = now
            if (!window.__stopJitter) setTimeout(loop, 0)
        }
        setTimeout(loop, 0)
    })
    await page.locator('#file-book').setInputFiles({ name: 'big.txt', mimeType: 'text/plain', buffer: buildBigTxt() })
    // 成功提示用的是书名（文件名去扩展名），不是原始文件名
    await page.waitForFunction(() => /已导入「big/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 120000 })
    await page.evaluate(() => { window.__stopJitter = true })
    const { maxGap, maxAt, sawProgress, timeline } = await page.evaluate(() => ({
        maxGap: Math.max(...window.__gaps.map(g => g.d)),
        maxAt: window.__gaps.find(g => g.d === Math.max(...window.__gaps.map(g => g.d)))?.t,
        sawProgress: window.__toasts.some(t => /正在导入「big\.txt」·\s*\S+/.test(t.text)),
        timeline: window.__toasts,
    }))
    assert.ok(maxGap < 1500, `导入期间主线程卡了 ${Math.round(maxGap)}ms（阈值 1500ms，卡顿窗口结束于 t=${maxAt}；toast 时间线：${JSON.stringify(timeline)}）`)
    assert.ok(sawProgress, '导入期间没有出现带进度的提示')
    check('13MB TXT 导入不冻结界面且有进度提示', { maxGapMs: Math.round(maxGap) })

    // ── B. 空白章计数：跳到空白章后整章计入 readMap ──
    const blankEpub = buildEpub([
        { name: 'chapter0001.xhtml', body: '<h2>第一章</h2><p>有内容的章节，用来证明前一章正常。</p>' },
        { name: 'chapter0002.xhtml', body: '' },
        { name: 'chapter0003.xhtml', body: '<h2>第三章</h2><p>空白章之后的正常章节。</p>' },
    ])
    await page.locator('#file-book').setInputFiles({ name: 'blank.epub', mimeType: 'application/epub+zip', buffer: blankEpub })
    // 大书还开着时 reader 本来就可见：等新书的 3 个章节挂载且完成首次定位
    await page.waitForFunction(() => {
        const inst = window.__readerInstance
        return inst?._sizes?.length === 3 && !!inst.view?.lastLocation?.cfi &&
            document.querySelector('foliate-view')?.renderer?.getContents().some(c => c.doc?.body?.textContent)
    }, null, { timeout: 30000 })
    // 走生产同一条路径：reader.goTo（内部 navigate → settle → recordScreen），
    // 旧守卫正是在这条路径上把空白章计数吞掉的；索引 1 = chapter0002
    await page.evaluate(() => window.__readerInstance.goTo(1))
    await page.waitForFunction(() => {
        const map = window.__readerInstance?.lastProgress?.readMap
        return !!map && JSON.stringify(map['1']) === '[[0,1]]'
    }, null, { timeout: 15000 })
    check('空白章跳到即整章计入进度', { readMap1: '[[0,1]]' })

    // ── C. 损坏章拒收：标题提示 + 卡片说明里报出章号 ──
    const badEpub = buildEpub([
        { name: 'chapter0001.xhtml', body: '<h2>第一章</h2><p>正常章。</p>' },
        { name: 'chapter0002.xhtml', body: '<p><b>未闭合的标记' },
    ])
    await page.locator('#file-book').setInputFiles({ name: 'bad.epub', mimeType: 'application/epub+zip', buffer: badEpub })
    await page.waitForFunction(() => /有损坏的章节/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 20000 })
    // addImportError 会自动打开「书籍与备份」面板，错误卡片说明里带章号
    await page.waitForFunction(() => document.querySelector('#panel')?.textContent?.includes('第 2 章内容损坏'), null, { timeout: 10000 })
    check('损坏章在导入时拒收并在错误卡片报出章号')

    assert.deepEqual(errors, [], `页面报错：${errors.join('\n')}`)
    check('全程无页面错误')
    console.log('RESULT', JSON.stringify({ pass: results.length, fail: 0 }))
} finally {
    await browser.close()
    rmSync(DATA_DIR, { recursive: true, force: true })
}
