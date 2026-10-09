// 目录浮层与书页点击的互斥验收：目录展开时落在书页上的那一次点击只收起浮层，不顺带翻页。
//
// 零依赖：直接驱动本机 Chrome 的 CDP（Node 18+ 自带 fetch/WebSocket），不需要 playwright。
// 运行：
//   python3 scripts/serve.py --port 8941 --no-open
//   node tests/toc-click-swallow-check.mjs
// 可选：CHROME_BIN=/绝对路径/Google\ Chrome  READER_URL=http://127.0.0.1:8941/
//
// 只允许 8941 这类测试地址：它会改写该实例的阅读进度，绝不碰日常使用的 8940。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const URL_TARGET = process.env.READER_URL || 'http://127.0.0.1:8941/'
const PORT = Number(process.env.CDP_PORT || 9344)
const WIN_W = Number(process.env.WIN_W || 900)
const WIN_H = Number(process.env.WIN_H || 700)

if (!/^http:\/\/127\.0\.0\.1:(?!8940)\d+\//.test(URL_TARGET)) {
    console.error(`拒绝运行：只允许非 8940 的本机测试地址，收到 ${URL_TARGET}`)
    process.exit(2)
}

const CANDIDATES = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
].filter(Boolean).filter(existsSync)
if (!CANDIDATES.length) { console.error('找不到 Chrome，请设置 CHROME_BIN'); process.exit(2) }

const proc = spawn(CANDIDATES[0], ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--window-size=${WIN_W},${WIN_H}`, `--remote-debugging-port=${PORT}`,
    `--user-data-dir=/tmp/reader-toc-swallow-${PORT}`, 'about:blank'], { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`) }

async function getWsUrl () {
    for (let i = 0; i < 60; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
            const page = list.find(t => t.type === 'page')
            if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
        } catch { /* 还没起来 */ }
        await sleep(500)
    }
    throw new Error('CDP 端口没有起来')
}

const ws = new WebSocket(await getWsUrl())
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
let nextId = 1
const pending = new Map()
ws.onmessage = m => {
    const msg = JSON.parse(m.data)
    if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id); pending.delete(msg.id)
        msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)
    }
}
const send = (method, params = {}) => new Promise((res, rej) => {
    const id = nextId++; pending.set(id, { res, rej })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(`${method} 超时`)) } }, 25000)
})
const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error('页面求值失败：' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
}
const mouseClick = async (x, y) => {
    const p = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1, buttons: 1 }
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 0 })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p })
    await sleep(40)
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, buttons: 0 })
    await sleep(350)
}

const state = () => evaluate(`(() => {
    const pop = document.querySelector('#reading-toc-popover')
    const text = document.querySelector('#reading-progress').textContent || ''
    const m = text.match(/(\\d+)\\s*\\/\\s*(\\d+)\\s*页/)
    return {
        progress: text,
        pagesInChapter: m ? Number(m[2]) : 0,
        tocOpen: pop ? pop.matches(':popover-open') : false,
        aria: document.querySelector('#reading-toc')?.getAttribute('aria-expanded'),
        visibility: document.visibilityState,
    }
})()`)

// paginator 是单个宽 iframe 横向平移，跨章后「书页左缘」会整体移出视口，
// 用真实屏幕坐标点它会得到「没翻页」的空证明。reader.js 的判定只读 e.clientX / e.target，
// 所以向内容文档派发带 iframe 内坐标的事件，才是等价且可控的路径。
const clickFraction = async frac => {
    // 跳章瞬间内容 iframe 正在重建，innerWidth 会是 0，先等它就绪
    await waitFor(`(() => {
        const frames = []
        const walk = r => { for (const e of r.querySelectorAll('*')) { if (e.tagName === 'IFRAME') frames.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }
        const v = document.querySelector('foliate-view'); if (v && v.shadowRoot) walk(v.shadowRoot)
        return frames.length > 0 && (frames[0].contentDocument?.defaultView?.innerWidth || 0) > 0
    })()`, '书页内容文档就绪')
    const info = await evaluate(`(() => {
        const frames = []
        const walk = r => { for (const e of r.querySelectorAll('*')) { if (e.tagName === 'IFRAME') frames.push(e); if (e.shadowRoot) walk(e.shadowRoot) } }
        const v = document.querySelector('foliate-view'); if (v && v.shadowRoot) walk(v.shadowRoot)
        if (!frames.length) return null
        const d = frames[0].contentDocument, iw = d.defaultView.innerWidth, ih = d.defaultView.innerHeight
        const opts = { bubbles: true, cancelable: true, clientX: Math.round(iw * ${frac}), clientY: Math.round(ih * 0.5) }
        d.body.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }))
        d.body.dispatchEvent(new MouseEvent('click', opts))
        return { clientX: opts.clientX, innerWidth: iw, fraction: (opts.clientX / iw).toFixed(3) }
    })()`)
    if (!info) throw new Error('找不到书页内容文档')
    await sleep(400)
    console.log(`  书页内坐标 clientX=${info.clientX} / ${info.innerWidth} = ${info.fraction}`)
    return await state()
}
const clickLeft = () => clickFraction(0.08)
const clickRight = () => clickFraction(0.92)

const tocButtonPoint = () => evaluate(`(() => {
    const r = document.querySelector('#reading-toc').getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
})()`)

// 隔离资料库首次启动才会 seed 示例书，不能靠固定 sleep
const waitFor = async (expression, label, timeout = 60000) => {
    for (let i = 0; i < timeout / 500; i++) {
        if (await evaluate(expression)) return
        await sleep(500)
    }
    throw new Error(`超时等待：${label}`)
}

try {
    await send('Page.enable'); await send('Runtime.enable')
    await send('Page.navigate', { url: URL_TARGET })
    await waitFor(`!!document.querySelector('[data-action="open-book"][data-id="sample-book"]')`, '示例书出现在书架上')
    await evaluate(`(() => { document.querySelector('[data-action="open-book"][data-id="sample-book"]').click(); return 1 })()`)
    await waitFor(`!!(document.querySelector('#reading-progress')?.textContent || '').trim()`, '阅读进度条出现（书已打开）')
    await sleep(1500)

    let s = await state()
    check('测试页可见（退场动画不会被后台冻结）', s.visibility === 'visible', `visibilityState=${s.visibility}`)
    check('示例书已打开且当前章节多页（翻页断言可判定）', s.pagesInChapter > 1, `progress=${s.progress}`)

    // 先往右翻一页：章首没有可回退的位置，左侧点击不翻页属正常，基线会失去意义
    const base0 = s.progress
    await clickRight()
    s = await state()
    check('预热：右侧点击能翻页（当前位置有可回退的左页）', s.progress !== base0, `${base0} → ${s.progress}`)

    // 基线：目录关闭时点书页左侧会翻页。缺了它，下面的「不翻页」就没有意义。
    const base1 = s.progress
    s = await clickLeft()
    check('基线：目录关闭时点书页左侧会翻页', s.progress !== base1, `${base1} → ${s.progress}`)

    const btn = await tocButtonPoint()
    await mouseClick(btn.x, btn.y)
    s = await state()
    check('目录已展开', s.tocOpen && s.aria === 'true', `open=${s.tocOpen} aria=${s.aria}`)

    // 核心：同一坐标、同一事件，唯一变量是目录状态
    const held = s.progress
    s = await clickLeft()
    check('目录开着时点书页不翻页', s.progress === held, `${held} → ${s.progress}`)
    check('同一次点击收起了目录', !s.tocOpen && s.aria === 'false', `open=${s.tocOpen} aria=${s.aria}`)

    // 收起后必须立刻恢复翻页，证明吞击不是一次性开关卡死
    const afterClose = s.progress
    s = await clickLeft()
    check('目录关闭后点书页恢复翻页', s.progress !== afterClose, `${afterClose} → ${s.progress}`)

    // 上一轮的行为不回归：点章节跳转后浮层保持展开
    const btn2 = await tocButtonPoint()
    await mouseClick(btn2.x, btn2.y)
    s = await state()
    if (!s.tocOpen) throw new Error('目录没能再次展开，无法验证章节跳转')
    const target = await evaluate(`(() => {
        const pop = document.querySelector('#reading-toc-popover')
        const b = [...pop.querySelectorAll('[data-action="toc-go"]')][2]
        b.scrollIntoView({ block: 'center' })
        const r = b.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: b.textContent.trim(), insidePopover: pop.contains(hit) }
    })()`)
    await sleep(200)
    if (!target.insidePopover) throw new Error(`章节项「${target.label}」不在浮层可视区内，点击会落到浮层外`)
    await mouseClick(target.x, target.y)
    s = await state()
    check('点目录章节后浮层保持展开', s.tocOpen, `jumped to ${target.label}; open=${s.tocOpen}`)

    // 跳转后落在书页上的点击仍然只收浮层
    s = await clickLeft()
    check('跳转后点书页只收浮层', !s.tocOpen, `open=${s.tocOpen} progress=${s.progress}`)
} finally {
    console.log('\nSUMMARY ' + JSON.stringify({ pass: results.filter(r => r.ok).length, fail: results.filter(r => !r.ok).length }))
    ws.close(); proc.kill('SIGTERM')
}
process.exit(results.length && results.every(r => r.ok) ? 0 : 1)
