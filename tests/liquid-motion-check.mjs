// 液态玻璃动效实页验收：用独立 Chrome（专属 profile + 专属 CDP 端口）真实点击，
// 逐帧采样 clip-path/类名，确认「展开从触点铺开」「连续快点不残留」「减少动态效果可用」。
//
//   python3 scripts/serve.py --port 19162 --no-open
//   node tests/liquid-motion-check.mjs
//
// 只允许访问隔离端口；8940（正式）与 19129（既有测试资料）直接拒绝。
import { mkdirSync, rmSync, writeFileSync, openSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'

const BASE = process.env.READER_URL || 'http://127.0.0.1:19162/'
const CDP_BASE_PORT = Number(process.env.CDP_PORT || 19188)
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = resolve('.preview/liquid-motion')
const PROFILE = resolve('.preview/chrome-liquid-profile')
const FIXTURE_BOOK = resolve('tests/fixtures/山中的信.txt')
const FIXTURE_BG = resolve('tests/fixtures/bright-meadow.png')
const FORBIDDEN = [8940, 19129]

// 别的 Agent 可能占用同一号段，逐端口试绑定，取第一个真正空闲的。
function portFree(port) {
    return new Promise(res => {
        const srv = createServer()
        srv.once('error', () => res(false))
        srv.once('listening', () => srv.close(() => res(true)))
        srv.listen(port, '127.0.0.1')
    })
}

const portOf = url => Number(new URL(url).port)
if (!/^http:\/\/127\.0\.0\.1:/.test(BASE) || FORBIDDEN.includes(portOf(BASE)) || portOf(BASE) < 1024) {
    console.error(`拒绝运行：只允许非正式的 127.0.0.1 隔离端口，收到 ${BASE}`)
    process.exit(2)
}
mkdirSync(OUT, { recursive: true })
// 不在这里删库：删掉正在被服务持有的 sqlite 文件会让服务端的 records 表消失。
// 需要全新资料时，先停服务、删 .preview/data-<port>、再重启。
rmSync(PROFILE, { recursive: true, force: true })

const pass = []
const fail = []
const notes = []
const check = (name, ok, detail = '') => (ok ? pass : fail).push(`${name}${detail ? ` → ${detail}` : ''}`)
const note = line => notes.push(line)
let aborted = null
const wait = ms => new Promise(r => setTimeout(r, ms))

function printResults() {
    const bad = eventQueue.filter(m => m.method === 'Log.entryAdded'
        && /uncaught|TypeError|ReferenceError|SyntaxError/i.test(m.params?.entry?.text || ''))
        .map(m => m.params.entry.text)
    const errs = eventQueue.filter(m => m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error'
        && !/favicon|net::ERR|404|Failed to load resource/i.test(m.params.entry.text || '')).map(m => m.params.entry.text)
    console.log(`\n通过 ${pass.length}`)
    pass.forEach(p => console.log('  ✔ ' + p))
    if (fail.length) {
        console.log(`\n失败 ${fail.length}`)
        fail.forEach(f => console.log('  ✘ ' + f))
    }
    if (notes.length) {
        console.log(`\n观察 ${notes.length}`)
        notes.forEach(n => console.log('  · ' + n))
    }
    const allErrs = [...new Set([...errs, ...bad])]
    if (allErrs.length) {
        console.log(`\n页面错误 ${allErrs.length}`)
        allErrs.forEach(e => console.log('  ! ' + e))
    }
    console.log(`\n截图：${OUT}`)
    const ok = fail.length === 0 && allErrs.length === 0 && !aborted
    console.log(aborted ? `\n结果：未完成 —— 场景中断于「${aborted}」，以上只覆盖已完成部分，不能当作整体通过`
        : ok ? '\n结果：全部通过' : '\n结果：存在失败项')
    return ok ? 0 : 1
}
process.on('uncaughtException', err => {
    console.error('\n运行中断：' + err.message)
    aborted = err.message
    try { child?.kill('SIGKILL') } catch { /* 已退出 */ }
    process.exit(printResults())
})
const shot = async name => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, session)
    const file = resolve(OUT, `${name}.png`)
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
}

// ---------- CDP 客户端 ----------
let child
let ws
let msgId = 0
const replies = new Map()
const eventQueue = []

function cdpSend(method, params = {}, sessionId) {
    const id = ++msgId
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }))
    return new Promise((res, rej) => replies.set(id, { res, rej }))
}

const cdp = { send: (method, params, sessionId) => cdpSend(method, params, sessionId) }
let session

async function evaluate(expression, { awaitPromise = false } = {}) {
    const res = await cdp.send('Runtime.evaluate', {
        expression, awaitPromise, returnByValue: true, userGesture: true,
    }, session)
    if (res.exceptionDetails) {
        throw new Error('页面异常：' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text))
    }
    return res.result?.value
}

async function pollUntil(fnBody, timeout = 40000, label = 'condition') {
    const t0 = Date.now()
    for (;;) {
        const ok = await evaluate(`(() => { ${fnBody} })()`)
        if (ok) return true
        if (Date.now() - t0 > timeout) throw new Error(`${label} 超时（${timeout}ms）`)
        await wait(150)
    }
}

// ---------- 浏览器启动 ----------
let CDP_PORT = null
for (let p = CDP_BASE_PORT; p < CDP_BASE_PORT + 12 && !CDP_PORT; p++) {
    if (await portFree(p)) CDP_PORT = p
}
if (!CDP_PORT) throw new Error(`19188 起连续 12 个端口都被占用，无法启动独立 Chrome 调试`)
rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })
const chromeLog = resolve(OUT, 'chrome.log')
child = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`,
    '--window-size=1440,900', '--no-first-run', '--no-default-browser-check',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--hide-scrollbars', '--remote-allow-origins=*', 'about:blank',
], { stdio: ['ignore', openSync(chromeLog, 'w'), 'ignore'] })

const browserWs = await (async () => {
    const t0 = Date.now()
    for (;;) {
        try {
            const info = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()
            // 只接受 Chrome 自己的调试端点，避免误连到同端口上的其它服务
            if (/Chrome|HeadlessChrome/.test(info.Browser || '') && info.webSocketDebuggerUrl) return info.webSocketDebuggerUrl
        } catch { /* 还在启动 */ }
        if (Date.now() - t0 > 30000) throw new Error(`Chrome 调试端口 ${CDP_PORT} 未就绪，详见 ${chromeLog}`)
        await wait(300)
    }
})()
note(`独立 Chrome：headless=new，CDP ${CDP_PORT}，专属 profile，未触碰用户已开的窗口`)
const killChild = () => { try { child?.kill('SIGKILL') } catch { /* 已退出 */ } }
process.on('exit', killChild)

await new Promise((res, rej) => {
    ws = new WebSocket(browserWs)
    ws.onerror = e => rej(new Error('CDP 连接失败：' + (e?.message || 'unknown')))
    ws.onopen = res
})
ws.onmessage = event => {
    const msg = JSON.parse(event.data)
    if (msg.id && replies.has(msg.id)) {
        const { res, rej } = replies.get(msg.id)
        replies.delete(msg.id)
        msg.error ? rej(new Error(`${msg.error.message} ${JSON.stringify(msg.error.data || '')}`)) : res(msg.result)
    } else if (msg.method) {
        eventQueue.push(msg)
    }
}

async function openPage(viewport, { reducedMotion = false, touch = false } = {}) {
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    session = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId
    pageTarget = targetId
    await cdp.send('Page.enable', {}, session)
    await cdp.send('Runtime.enable', {}, session)
    await cdp.send('DOM.enable', {}, session)
    await cdp.send('Log.enable', {}, session)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport[0], height: viewport[1], deviceScaleFactor: 1, mobile: touch,
    }, session)
    await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }],
    }, session)
    // 隔离服务已带 no-store，但仍要确保页面跑的是磁盘上的当前代码
    await cdp.send('Network.enable', {}, session)
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true }, session)
}

let pageTarget

// ---------- 输入 ----------
async function rectOf(selector) {
    return evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { left: r.left, top: r.top, width: r.width, height: r.height }
    })()`)
}

async function clickPoint(x, y) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 }, session)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 }, session)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 }, session)
}

async function clickAt(selector, { xRatio = 0.5, yRatio = 0.5 } = {}) {
    const r = await rectOf(selector)
    if (!r) return null
    await clickPoint(Math.round(r.left + r.width * xRatio), Math.round(r.top + r.height * yRatio))
    return r
}

// 采样器：从点击前起帧，记录每个表面的类名、clip-path、原点与遮挡情况
function samplerSource(selectors, ms) {
    return `(() => {
        const sel = ${JSON.stringify(selectors)}
        const state = { t0: performance.now(), rows: [], buttons: [] }
        window.__lm = state
        const seen = new Set()
        function tick() {
            const t = Math.round(performance.now() - state.t0)
            for (const s of sel) {
                const el = document.querySelector(s)
                if (!el) continue
                const enter = el.classList.contains('liquid-surface-enter')
                const cs = getComputedStyle(el)
                const r = el.getBoundingClientRect()
                const anims = el.getAnimations({ subtree: false })
                const open = el.matches(':popover-open') || (el.id === 'panel' ? !el.classList.contains('hidden') : null)
                if (!enter && open !== true && anims.length === 0) continue
                let occluded = null
                if (r.width > 0 && r.height > 0 && t % 3 === 0) {
                    const px = r.left + Math.min(6, r.width / 2)
                    const py = r.top + Math.min(6, r.height / 2)
                    if (px >= 0 && py >= 0 && px < innerWidth && py < innerHeight) {
                        const hit = document.elementFromPoint(px, py)
                        occluded = !(hit === el || el.contains(hit))
                    }
                }
                state.rows.push({
                    t, s, enter, open,
                    clip: cs.clipPath, display: cs.display, opacity: cs.opacity,
                    ox: el.style.getPropertyValue('--liquid-origin-x'),
                    oy: el.style.getPropertyValue('--liquid-origin-y'),
                    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
                    count: anims.length,
                    names: anims.map(a => a.animationName || a.constructor.name),
                    times: anims.map(a => Math.round(a.currentTime ?? -1)),
                    occluded,
                })
            }
            document.querySelectorAll('.liquid-press').forEach(b => {
                state.buttons.push({ t, tag: b.tagName.toLowerCase(), id: b.id || b.className,
                    anims: b.getAnimations({ subtree: false }).map(a => a.animationName || a.constructor.name) })
            })
            if (t < ${ms}) requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
        return true
    })()`
}

const startSampler = (selectors, ms = 1400) => evaluate(samplerSource(selectors, ms))
const readSampler = () => evaluate('window.__lm ? { rows: window.__lm.rows, buttons: window.__lm.buttons } : { rows: [], buttons: [] }')

function analyzeSpread(rows, selector, clickPointXY, label) {
    const mine = rows.filter(r => r.s === selector)
    const entered = mine.filter(r => r.enter)
    check(`${label}：出现 liquid-surface-enter`, entered.length > 0, JSON.stringify(mine.slice(0, 3)))
    if (!entered.length) return
    const first = entered[0]
    const radii = entered.map(r => {
        const m = /ellipse\(\s*([\d.]+)(%|px)/.exec(r.clip || '')
        return m ? Number(m[1]) : null
    }).filter(v => v !== null)
    // 采样帧之间有掉帧，用动画自身的 currentTime 判断是否从头播起，而不是只看第一帧半径
    const startedAt = Math.min(...entered.map(r => Math.min(...(r.times?.length ? r.times : [9999]))))
    check(`${label}：展开动画从头播起（非半路接手）`,
        startedAt <= 120 && Math.min(...(radii.length ? radii : [9999])) <= 35,
        `首见 currentTime=${startedAt}ms，最小半径 ${Math.min(...(radii.length ? radii : [NaN]))}`)
    const clips = [...new Set(entered.map(r => r.clip))]
    check(`${label}：clip-path 逐帧变化（真的在铺开）`, clips.length >= 3,
        `${clips.length} 段：${clips[0]} → ${clips[clips.length - 1]}`)
    check(`${label}：展开形状是以原点为圆心的 ellipse`, /ellipse\(.*\bat\b/.test(clips[0] || ''), clips[0])
    // 原点以 JS 写入的内联值为准（getComputedStyle 会把百分比折算，不宜直接比对）
    const [cx, cy] = [parseFloat(first.ox), parseFloat(first.oy)]
    const [, , w, h] = first.rect
    const wantX = Math.min(w, Math.max(0, clickPointXY[0] - first.rect[0]))
    const wantY = Math.min(h, Math.max(0, clickPointXY[1] - first.rect[1]))
    const dx = Math.abs(cx - wantX), dy = Math.abs(cy - wantY)
    note(`${label} 原点偏差：写入(${cx},${cy}) 期望(${wantX},${wantY}) dx=${dx} dy=${dy} rect=${first.rect} 触点=${clickPointXY}`)
    // 浮层在 showPopover 后还会被 layout()/定位脚本再挪 1~3px，容差取 6px
    check(`${label}：原点即触点（含边界钳制）`,
        Number.isFinite(cx) && Number.isFinite(cy) && dx <= 6 && dy <= 6,
        `写入(${cx},${cy}) 期望(${wantX},${wantY}) 表面rect=${first.rect} 触点=${clickPointXY}`)
    const counts = [...new Set(entered.map(r => r.count))]
    const names = [...new Set(entered.flatMap(r => r.names))]
    check(`${label}：同一时刻只挂一段动画`, counts.every(c => c <= 1), JSON.stringify({ counts, names }))
}

// 只移动鼠标唤醒阅读面控件，不产生额外的一次开合
async function wakeChrome() {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 700, y: 430, buttons: 0 }, session)
    await wait(450)
    return rectOf('#reading-toc')
}

// 面板栏目：scene/rain/music/log/fullscreen 藏在「更多」里，要先展开二级导航
async function openTab(cmd) {
    if (await evaluate(`document.querySelector('#panel').classList.contains('hidden')`)) {
        await clickAt('#top-settings')
        await wait(800)
    }
    if (await evaluate(`document.querySelector('#nav-secondary').hidden`)) {
        const more = await rectOf('#nav-more')
        if (more) {
            await clickPoint(Math.round(more.left + more.width / 2), Math.round(more.top + more.height / 2))
            await wait(700)
        }
    }
    const sel = `#toolbar button[data-cmd="${cmd}"]`
    const r = await rectOf(sel)
    if (!r || r.width <= 0) return false
    await clickPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    await wait(900)
    return (await evaluate(`document.querySelector('#toolbar button.active')?.dataset?.cmd || null`)) === cmd
}

async function residualCheck(label) {
    const left = await evaluate(`(() => {
        const enter = [...document.querySelectorAll('.liquid-surface-enter')].map(e => e.id || e.className)
        const press = [...document.querySelectorAll('.liquid-press')].map(e => e.id || e.className)
        return { enter, press }
    })()`)
    check(`${label}：无残留展开类`, left.enter.length === 0, JSON.stringify(left.enter))
    check(`${label}：无残留按压类`, left.press.length === 0, JSON.stringify(left.press))
}

async function clickableCheck(selectors, label) {
    const res = await evaluate(`(() => {
        const sel = ${JSON.stringify(selectors)}
        const out = {}
        for (const s of sel) {
            const el = document.querySelector(s)
            if (!el) { out[s] = 'missing'; continue }
            const r = el.getBoundingClientRect()
            if (r.width <= 0 || r.height <= 0) { out[s] = 'zero-size'; continue }
            const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
            out[s] = (hit === el || el.contains(hit) || (hit && hit.contains(el))) ? 'ok' : ('blocked-by:' + (hit ? (hit.id || hit.className || hit.tagName) : 'null'))
        }
        return out
    })()`)
    const bad = Object.entries(res).filter(([, v]) => v !== 'ok')
    check(`${label}：关键入口仍可点击`, bad.length === 0, JSON.stringify(res))
    if (bad.length) note(`${label} 遮挡明细：${JSON.stringify(res)}`)
    return res
}

// ---------- 打开书 ----------
async function openBook() {
    await cdp.send('Page.navigate', { url: BASE }, session)
    await pollUntil('return document.querySelector("#btn-welcome-open") && !document.querySelector("#btn-welcome-open").disabled', 30000, '初始化完成')
    const doc = await cdp.send('DOM.getDocument', { depth: -1 }, session)
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-book' }, session)
    if (!nodeId) throw new Error('找不到 #file-book')
    await cdp.send('DOM.setFileInputFiles', { files: [FIXTURE_BOOK], nodeId }, session)
    await pollUntil(`return (document.querySelector('#reading-title')?.textContent || '').includes('山中的信')
        && !document.querySelector('#reader-column').classList.contains('hidden')
        && Boolean(document.querySelector('foliate-view'))`, 60000, '打开书籍')
    await wait(1200)
}

const SURFACES = ['#reading-toc-popover', '#reading-speed-popover', '#panel', '#panel-body', '#nav-secondary', '.bg-edit', '.note-card textarea']

// ---------- 场景 A/B：桌面目录与速度 ----------
await openPage([1440, 900])
await openBook()
check('桌面：隔离资料成功打开《山中的信》', true)

// A1 目录：从按钮偏右下的触点铺开
await wakeChrome()
let tocRect = await rectOf('#reading-toc')
check('桌面：目录入口在页面上可见', Boolean(tocRect) && tocRect.width > 0 && tocRect.left >= 0, JSON.stringify(tocRect))
check('桌面：点击前目录浮层是收起的', await evaluate(`!document.querySelector('#reading-toc-popover').matches(':popover-open')`))
await startSampler(SURFACES)
const p1 = [Math.round(tocRect.left + tocRect.width * 0.72), Math.round(tocRect.top + tocRect.height * 0.6)]
await clickPoint(...p1)
await wait(160)
const midShot = await shot('01-desktop-toc-spreading')
await wait(900)
let s = await readSampler()
analyzeSpread(s.rows, '#reading-toc-popover', p1, '桌面·目录浮层')
check('桌面·目录浮层：确实打开', s.rows.some(r => r.s === '#reading-toc-popover' && r.open === true))
check('桌面·目录浮层：展开中途取样已截图', Boolean(midShot), midShot)
await residualCheck('桌面·目录一次展开后')

// A2 再点一次目录：收起
await clickAt('#reading-toc', { xRatio: 0.72, yRatio: 0.6 })
await wait(900)
await residualCheck('桌面·目录第二次点击')
const tocAfterClose = await evaluate(`(() => { const p = document.querySelector('#reading-toc-popover')
    return { open: p.matches(':popover-open'), display: getComputedStyle(p).display, cls: p.className } })()`)
check('桌面·目录第二次点击可收起', tocAfterClose.open === false, JSON.stringify(tocAfterClose))

// A3 速度与设置
const dockRect = await rectOf('#reading-speed-details > summary')
if (!dockRect) {
    note('速度入口在 1440x900 下取不到 rect，可能底栏处于隐藏态')
}
await startSampler(SURFACES)
const p2 = dockRect ? [Math.round(dockRect.left + dockRect.width * 0.6), Math.round(dockRect.top + dockRect.height * 0.5)] : null
if (p2) await clickPoint(...p2)
await wait(120)
await shot('02-desktop-speed-spreading')
await wait(1000)
s = await readSampler()
if (p2) analyzeSpread(s.rows, '#reading-speed-popover', p2, '桌面·速度浮层')
else note('桌面·速度浮层：未取到入口坐标，跳过')
await residualCheck('桌面·速度展开后')
if (p2) {
    await clickPoint(...p2)
    await wait(700)
    check('桌面·速度再次点击同一入口可收起',
        await evaluate(`!document.querySelector('#reading-speed-popover').matches(':popover-open') && !document.querySelector('#reading-speed-details').open`),
        JSON.stringify(await evaluate(`({ pop: document.querySelector('#reading-speed-popover').matches(':popover-open'), details: document.querySelector('#reading-speed-details').open })`)))
}
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }, session)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }, session)
await wait(600)
await residualCheck('桌面·速度一次开合后')

// ---------- 场景 C：快速连点不同入口 ----------
const SCRIM_PROBE = `(() => [...document.querySelectorAll('body > *')]
    .filter(e => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
        return r.width >= innerWidth - 2 && r.height >= innerHeight - 2 && cs.pointerEvents !== 'none'
            && !e.hidden && cs.display !== 'none' && cs.visibility !== 'hidden'; })
    .map(e => e.id || e.className))()`
const scrimBefore = await evaluate(SCRIM_PROBE)
const stateBefore = await evaluate(`(() => ({
    toc: document.querySelector('#reading-toc-popover').matches(':popover-open'),
    speed: document.querySelector('#reading-speed-popover').matches(':popover-open'),
    panel: !document.querySelector('#panel').classList.contains('hidden'),
}))()`)
const rapid = ['#reading-toc', '#reading-speed-details > summary', '#top-settings', '#reading-toc', '#panel-close', '#reading-speed-details > summary', '#top-settings', '#reading-toc']
await startSampler(SURFACES, 3200)
for (const sel of rapid) {
    const r = await rectOf(sel)
    if (!r || r.width <= 0) { note(`连点跳过 ${sel}（rect ${JSON.stringify(r)}）`); continue }
    await clickPoint(Math.round(r.left + r.width * 0.5), Math.round(r.top + r.height * 0.5))
    await wait(90)
}
await wait(300)
await shot('03-desktop-after-rapid-clicks')
s = await readSampler()
// 残留要等展开窗口（720ms）过去之后再判，否则只是动画正当时
await wait(1200)
await residualCheck('桌面·快速连点 8 次并静置后')
const openAfter = await evaluate(`(() => ({
    toc: document.querySelector('#reading-toc-popover').matches(':popover-open'),
    speed: document.querySelector('#reading-speed-popover').matches(':popover-open'),
    panel: !document.querySelector('#panel').classList.contains('hidden'),
    panelClip: getComputedStyle(document.querySelector('#panel')).clipPath,
    scrim: ${SCRIM_PROBE},
}))()`)
note(`连点前状态：${JSON.stringify(stateBefore)} 遮罩基线：${JSON.stringify(scrimBefore)}`)
note(`连点后状态：${JSON.stringify(openAfter)}`)
const newScrim = openAfter.scrim.filter(id => !scrimBefore.includes(id))
check('桌面·快速连点后没有新增全屏可点遮罩', newScrim.length === 0, JSON.stringify({ newScrim, before: scrimBefore }))
check('桌面·连点后面板不残留 clip 裁切', openAfter.panel === false || openAfter.panelClip === 'none', openAfter.panelClip)

// 关掉连点遗留的开放面，再验正文控件仍可点击
if (openAfter.panel) await clickAt('#panel-close')
await wait(400)
if (await evaluate(`document.querySelector('#reading-toc-popover').matches(':popover-open')`)) await clickAt('#reading-toc')
await wait(400)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }, session)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }, session)
await wait(600)
await clickableCheck(['#reading-toc', '#top-settings', '#page-next', '#page-prev', '#reading-speed-details > summary'], '桌面·连点收拢后')
await residualCheck('桌面·连点收拢后')
await shot('04-desktop-rapid-end-state')

// 收尾：确保目录关闭，不干扰后续
await evaluate(`(() => { document.querySelector('#reading-toc-popover').matches(':popover-open') && document.querySelector('#reading-toc-popover').hidePopover(); document.querySelector('#panel').classList.add('hidden'); return true })()`)
await wait(400)

// ---------- 场景 D：背景改名折叠 ----------
const bgCount = async () => {
    try {
        const res = await (await fetch(`${BASE}_reader/library`)).json()
        return (res.records || []).filter(r => r.store === 'backgrounds').length
    } catch (e) {
        note(`读取隔离库背景计数失败（${e.message}），改用页面内条目数判断`)
        return null
    }
}
{
    const before = await bgCount()
    const doc = await cdp.send('DOM.getDocument', { depth: -1 }, session)
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#file-image' }, session)
    check('桌面·找到 #file-image 背景入口', Boolean(nodeId), String(nodeId))
    await cdp.send('DOM.setFileInputFiles', { files: [FIXTURE_BG], nodeId }, session)
    await wait(2500)
    const after = await bgCount()
    const toastText = await evaluate(`document.querySelector('#toast')?.textContent?.trim() || ''`)
    if (before === null || after === null) {
        note(`背景库计数不可用（${before} → ${after}），以场景分页里是否出现改名入口为准`)
    } else {
        check('桌面·自选背景已写入隔离库', after > before || after > 0, `${before} → ${after}；toast="${toastText}"`)
        if (after <= before && after === 0) note(`背景导入未成功；toast="${toastText}"`)
    }
}
{
    const switched = await openTab('scene')
    note(`桌面：切到「阅读环境」分页 ${switched ? '成功' : '失败'}`)
    const RENAME_PROBE = `(() => {
        const list = [...document.querySelectorAll('[data-action="rename-bg"]')]
        if (!list.length) return { count: 0 }
        const pick = list[0]
        pick.setAttribute('data-lm-target', '1')
        pick.scrollIntoView({ block: 'center' })
        const r = pick.getBoundingClientRect()
        const cs = getComputedStyle(pick)
        return { count: list.length, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
            css: cs.display + '/' + cs.visibility + '/' + cs.opacity, id: pick.dataset.id }
    })()`
    const hasRename = await pollUntil(`const p = ${RENAME_PROBE}; return p.count > 0 && p.rect && p.rect[2] > 0 && p.rect[3] > 0`, 8000, '背景改名入口')
        .then(() => evaluate(`${RENAME_PROBE}`))
        .then(p => ({ ...p, visible: p.rect?.[2] > 0 && p.rect?.[3] > 0 }))
        .catch(async () => evaluate(`(() => ({ rects: ${RENAME_PROBE}, thumbs: document.querySelectorAll('.bg-thumb').length,
            rename: document.querySelectorAll('[data-action="rename-bg"]').length,
            panelHidden: document.querySelector('#panel').classList.contains('hidden'),
            navHidden: document.querySelector('#nav-secondary').hidden,
            active: document.querySelector('#toolbar button.active')?.dataset?.cmd || null }))()`))
    check('桌面·场景分页存在背景改名入口', Boolean(hasRename?.visible), JSON.stringify(hasRename))
    if (hasRename?.visible) {
        await startSampler(SURFACES, 1400)
        const rb = await rectOf('[data-lm-target="1"]')
        const p3 = [Math.round(rb.left + rb.width * 0.7), Math.round(rb.top + rb.height * 0.5)]
        await clickPoint(...p3)
        await wait(120)
        await shot('05-desktop-bg-rename-spreading')
        await wait(1000)
        s = await readSampler()
        if (s.rows.some(r => r.s === '.bg-edit')) {
            analyzeSpread(s.rows, '.bg-edit', p3, '桌面·背景改名框')
        } else {
            const state = await evaluate(`(() => { const e = document.querySelector('.bg-edit'); if (!e) return null; const cs = getComputedStyle(e); return { hidden: e.hidden, display: cs.display, anims: e.getAnimations({ subtree: false }).map(a => a.animationName || a.constructor.name), clip: cs.clipPath } })()`)
            check('桌面·背景改名框从隐藏到显示', Boolean(state) && state.hidden !== true && state.display !== 'none', JSON.stringify(state))
            check('桌面·背景改名框挂上展开动画', Boolean(state) && /liquid-surface-spread|liquid-surface-fade/.test(state.anims.join(',')), JSON.stringify(state))
        }
        await clickAt('[data-action="rename-bg"]', { xRatio: 0.7 })
        await wait(500)
    }
    await clickAt('#panel-close')
    await wait(600)
    await residualCheck('桌面·背景改名开合后')
}

// ---------- 场景 E：笔记心得折叠 ----------
{
    // 先把连点遗留的开放面收干净，避免面板盖住正文
    await evaluate(`(() => { const p = document.querySelector('#reading-toc-popover'); if (p.matches(':popover-open')) p.hidePopover(); return true })()`)
    await wait(300)
    const box = await rectOf('foliate-view')
    check('阅读页存在正文视图可取样', Boolean(box), JSON.stringify(box))

    const findFrames = `(() => {
        const host = document.querySelector('foliate-view')
        const out = []
        const walk = (root, depth) => {
            if (!root || depth > 4) return
            for (const el of root.querySelectorAll ? [...root.querySelectorAll('*')] : []) {
                if (el.tagName === 'IFRAME') out.push(el)
                if (el.shadowRoot) walk(el.shadowRoot, depth + 1)
            }
        }
        walk(host?.shadowRoot || host, 0)
        return out
    })()`
    const trySelect = async (yRatio, mode) => {
        const y = Math.round(box.top + box.height * yRatio)
        const startX = Math.round(box.left + box.width * 0.22)
        const step = Math.max(5, Math.round(box.width * 0.025))
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX, y, buttons: 0 }, session)
        await wait(80)
        if (mode === 'dblclick') {
            for (let i = 0; i < 2; i++) {
                await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX + 60, y, button: 'left', clickCount: i + 1, buttons: 1 }, session)
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + 60, y, button: 'left', clickCount: i + 1, buttons: 0 }, session)
                await wait(60)
            }
        } else {
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y, button: 'left', clickCount: 1, buttons: 1 }, session)
            await wait(80)
            for (let i = 1; i <= 18; i++) {
                await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: startX + step * i, y, buttons: 1 }, session)
                await wait(45)
            }
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: startX + step * 18, y, button: 'left', clickCount: 1, buttons: 0 }, session)
        }
        await wait(800)
        return evaluate(`(() => {
            const frames = ${findFrames}
            let text = '', kind = frames.length ? 'frames:' + frames.length : 'no-iframe'
            for (const f of frames) {
                try { const s = f.contentDocument?.getSelection?.(); if (s && s.toString()) { text = s.toString(); break } }
                catch (e) { kind = 'unreadable: ' + e.message }
            }
            return { kind, len: text.length, sample: text.slice(0, 24),
                toolsHidden: document.querySelector('#selection-tools').hidden,
                mode: ${JSON.stringify(mode)}, yRatio: ${yRatio} }
        })()`)
    }

    let sel = null
    for (const [yRatio, mode] of [[0.45, 'dblclick'], [0.45, 'drag'], [0.34, 'drag'], [0.56, 'dblclick']]) {
        sel = await trySelect(yRatio, mode)
        if (sel.toolsHidden === false) break
    }
    const frameProbe = await evaluate(`(() => { const frames = ${findFrames}
        return { n: frames.length, src: frames.slice(0, 3).map(f => (f.src || '').slice(0, 40)) } })()`)
    note(`正文 iframe 探测：${JSON.stringify(frameProbe)}`)
    note(`划选诊断（最后一次）：${JSON.stringify(sel)}`)
    check('桌面·划选正文出现选字工具条', sel?.toolsHidden === false, JSON.stringify(sel))
    if (sel?.toolsHidden === false) {
        await clickAt('#save-quote')
        await wait(1400)
    }
    const switched = await openTab('notes')
    note(`桌面：切到「笔记」分页 ${switched ? '成功' : '失败'}`)
    const fold = await rectOf('.note-fold')
    check('桌面·笔记卡存在「心得」折叠入口', Boolean(fold), JSON.stringify(fold))
    if (fold) {
        await startSampler(SURFACES, 1200)
        const p4 = [Math.round(fold.left + fold.width * 0.75), Math.round(fold.top + fold.height * 0.5)]
        await clickPoint(...p4)
        await wait(120)
        await shot('06-desktop-note-fold-spreading')
        await wait(900)
        s = await readSampler()
        const card = await evaluate(`(() => { const t = document.querySelector('.note-card textarea'); const cs = getComputedStyle(t); return { hidden: t.hidden, display: cs.display, anims: t.getAnimations({ subtree: false }).map(a => a.animationName || a.constructor.name), clip: cs.clipPath } })()`)
        check('桌面·点心得后输入框展开', card.hidden === false && card.display !== 'none', JSON.stringify(card))
        if (s.rows.some(r => r.s === '.note-card textarea')) {
            analyzeSpread(s.rows, '.note-card textarea', p4, '桌面·心得输入框')
        } else {
            check('桌面·心得输入框挂上展开动画', /liquid-surface-spread|liquid-surface-fade/.test(card.anims.join(',')), JSON.stringify(card.anims))
        }
        await clickAt('.note-fold', { xRatio: 0.75 })
        await wait(700)
        await residualCheck('桌面·心得折叠开合后')
    }
    await clickAt('#panel-close')
    await wait(500)
}

// ---------- 场景 F：390x670 ----------
await cdp.send('Target.closeTarget', { targetId: pageTarget }, session)
await wait(300)
await openPage([390, 670])
await openBook()
check('390x670：隔离资料成功打开《山中的信》', true)
await wakeChrome()
{
    tocRect = await rectOf('#reading-toc')
    check('390：点击前目录浮层是收起的', await evaluate(`!document.querySelector('#reading-toc-popover').matches(':popover-open')`))
    await startSampler(SURFACES)
    const p5 = [Math.round(tocRect.left + tocRect.width * 0.3), Math.round(tocRect.top + tocRect.height * 0.7)]
    await clickPoint(...p5)
    await wait(120)
    await shot('07-390-toc-spreading')
    await wait(1000)
    s = await readSampler()
    analyzeSpread(s.rows, '#reading-toc-popover', p5, '390·目录浮层')
    await clickableCheck(['#reading-toc', '#top-settings', '#page-next', '#reading-speed-details > summary'], '390·目录展开后')
    await residualCheck('390·目录展开后')
    await clickPoint(...p5)
    await wait(700)
    check('390·目录再次点击可收起', await evaluate(`!document.querySelector('#reading-toc-popover').matches(':popover-open')`),
        JSON.stringify(await evaluate(`({ open: document.querySelector('#reading-toc-popover').matches(':popover-open'), cls: document.querySelector('#reading-toc-popover').className })`)))
    await residualCheck('390·目录一次开合后')
}
{
    const dock = await rectOf('#reading-speed-details > summary')
    if (dock) {
        await startSampler(SURFACES)
        const p6 = [Math.round(dock.left + dock.width * 0.55), Math.round(dock.top + dock.height * 0.6)]
        await clickPoint(...p6)
        await wait(120)
        await shot('08-390-speed-spreading')
        await wait(1000)
        s = await readSampler()
        analyzeSpread(s.rows, '#reading-speed-popover', p6, '390·速度浮层')
        await residualCheck('390·速度展开后')
        await clickPoint(...p6)
        await wait(700)
        await residualCheck('390·速度一次开合后')
    } else note('390：未取到速度入口坐标')
}
// 390 连点：交替点开不同入口，不逐个关闭
const scrimBefore390 = await evaluate(SCRIM_PROBE)
await startSampler(SURFACES, 2600)
for (const sel of ['#reading-toc', '#top-settings', '#reading-speed-details > summary', '#reading-toc', '#top-settings']) {
    const r = await rectOf(sel)
    if (!r || r.width <= 0) continue
    await clickPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
    await wait(80)
}
await wait(200)
await shot('09-390-after-rapid-clicks')
await wait(1400)
await residualCheck('390·快速连点后')
const scrimAfter390 = await evaluate(SCRIM_PROBE)
const newScrim390 = scrimAfter390.filter(id => !scrimBefore390.includes(id))
check('390·快速连点后没有新增全屏可点遮罩', newScrim390.length === 0, JSON.stringify({ newScrim390, before: scrimBefore390, after: scrimAfter390 }))
// 收拢后再验可点击
if (await evaluate(`!document.querySelector('#panel').classList.contains('hidden')`)) await clickAt('#panel-close')
await wait(400)
if (await evaluate(`document.querySelector('#reading-toc-popover').matches(':popover-open')`)) await clickAt('#reading-toc')
await wait(400)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }, session)
await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' }, session)
await wait(600)
await clickableCheck(['#reading-toc', '#top-settings', '#page-next', '#page-prev'], '390·连点收拢后')
await residualCheck('390·连点收拢后')

// ---------- 场景 G：减少动态效果 ----------
await cdp.send('Target.closeTarget', { targetId: pageTarget }, session)
await wait(300)
await openPage([1440, 900], { reducedMotion: true })
await openBook()
check('减少动态：隔离资料成功打开《山中的信》', true)
{
    await wakeChrome()
    check('减少动态：点击前目录浮层是收起的', await evaluate(`!document.querySelector('#reading-toc-popover').matches(':popover-open')`))
    await startSampler(SURFACES, 900)
    await clickAt('#reading-toc', { xRatio: 0.7, yRatio: 0.5 })
    await wait(500)
    s = await readSampler()
    const rm = await evaluate(`(() => {
        const p = document.querySelector('#reading-toc-popover')
        const b = document.querySelector('#reading-toc')
        return {
            open: p.matches(':popover-open'),
            display: getComputedStyle(p).display,
            opacity: Number(getComputedStyle(p).opacity),
            clip: getComputedStyle(p).clipPath,
            enterCls: p.classList.contains('liquid-surface-enter'),
            surfaceAnims: p.getAnimations({ subtree: false }).map(a => a.animationName || a.constructor.name),
            pressCls: b.classList.contains('liquid-press'),
            pressGlint: b.getAnimations({ subtree: false }).map(a => a.animationName).filter(n => n === 'liquid-press-glint').length,
            touchX: p.style.getPropertyValue('--liquid-origin-x'),
        }
    })()`)
    const anyEnter = s.rows.filter(r => r.enter).length
    check('减少动态：目录仍能打开且无展开动画',
        rm.open === true && rm.enterCls === false && rm.clip === 'none' && anyEnter === 0 && !rm.touchX, JSON.stringify({ rm, anyEnter }))
    check('减少动态：按钮不挂 liquid-press-glint 动画', rm.pressGlint === 0, JSON.stringify(rm))
    await shot('10-reduced-motion-toc-open')
    await clickAt('#reading-toc', { xRatio: 0.7, yRatio: 0.5 })
    await wait(400)
    check('减少动态：第二次点击仍能收起', await evaluate(`!document.querySelector('#reading-toc-popover').matches(':popover-open')`))
    await residualCheck('减少动态·目录开合后')
    const dockRm = await rectOf('#reading-speed-details > summary')
    if (dockRm) {
        await clickPoint(Math.round(dockRm.left + dockRm.width / 2), Math.round(dockRm.top + dockRm.height / 2))
        await wait(400)
        const rmSpeed = await evaluate(`(() => { const p = document.querySelector('#reading-speed-popover')
            return { open: p.matches(':popover-open'), enter: p.classList.contains('liquid-surface-enter'), clip: getComputedStyle(p).clipPath, display: getComputedStyle(p).display } })()`)
        check('减少动态：速度浮层仍能打开且无裁切', rmSpeed.open === true && rmSpeed.enter === false && rmSpeed.clip === 'none', JSON.stringify(rmSpeed))
        await clickPoint(Math.round(dockRm.left + dockRm.width / 2), Math.round(dockRm.top + dockRm.height / 2))
        await wait(400)
        check('减少动态：速度浮层仍能收起', await evaluate(`!document.querySelector('#reading-speed-popover').matches(':popover-open')`))
    } else note('减少动态：未取到速度入口坐标')
    await clickAt('#top-settings')
    await wait(250)
    const rmPanel = await evaluate(`(() => { const p = document.querySelector('#panel'); return { hidden: p.classList.contains('hidden'), anims: p.getAnimations({ subtree: false }).length, clip: getComputedStyle(p).clipPath, opacity: Number(getComputedStyle(p).opacity) } })()`)
    check('减少动态：控制面板直接显示且无动画', rmPanel.hidden === false && rmPanel.anims === 0 && rmPanel.clip === 'none' && rmPanel.opacity === 1, JSON.stringify(rmPanel))
    await clickAt('#panel-close')
    await wait(300)
    check('减少动态：面板立即隐藏（不等动画）', await evaluate(`document.querySelector('#panel').classList.contains('hidden')`))
    await shot('11-reduced-motion-state')
}

const pageErrors = eventQueue.filter(m => m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error'
    && !/favicon|net::ERR|404|Failed to load resource/i.test(m.params.entry.text || '')).map(m => m.params.entry.text)
const disc = eventQueue.filter(m => m.method === 'Log.entryAdded' && /uncaught|TypeError|ReferenceError/i.test(m.params?.entry?.text || '')).map(m => m.params.entry.text)

try { await cdp.send('Target.closeTarget', { targetId: pageTarget }, session) } catch { /* 已经关掉 */ }
try { ws.close() } catch { /* 已断开 */ }
note(`页面错误日志：${pageErrors.length} 条，异常堆栈：${disc.length} 条`)
process.exit(printResults())
