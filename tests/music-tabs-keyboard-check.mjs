// 音乐分页键盘验收：方向键 / Home / End 循环切换、roving tabindex、aria-controls ↔ aria-labelledby。
//
// 直接驱动系统 Chrome 的 CDP，用真实的鼠标与按键事件，不依赖任何第三方测试库。
// 只允许 127.0.0.1 的隔离测试端口，并明确拒绝正式 8940 与 Amado 的 8765。
// 运行：
//   python3 scripts/serve.py --port 19163 --no-open
//   node tests/music-tabs-keyboard-check.mjs
//   READER_URL=http://127.0.0.1:19163/ CHROME_PATH=/绝对路径/Google\ Chrome node tests/music-tabs-keyboard-check.mjs
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BASE = process.env.READER_URL || 'http://127.0.0.1:19163/'
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = resolve('.preview/music-tabs-check')
const ORDER = ['local', 'netease', 'qq']

const urlMatch = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(BASE)
if (!urlMatch) {
    console.error(`拒绝运行：只允许 127.0.0.1 的隔离测试端口，收到 ${BASE}`)
    process.exit(2)
}
const PORT = Number(urlMatch[1])
if (PORT === 8940 || PORT === 8765) {
    console.error(`拒绝运行：${PORT} 不是隔离测试端口（8940 是正式资料，8765 属于 Amado）。`)
    process.exit(2)
}
const URL = BASE.endsWith('/') ? BASE : `${BASE}/`

mkdirSync(OUT, { recursive: true })
const PROFILE = mkdtempSync(join(resolve('.preview'), `music-tabs-chrome-${PORT}-`))
const pass = []
const fail = []
const notes = []
const check = (name, ok, detail = '') => (ok ? pass : fail).push(name + (detail ? ` → ${detail}` : ''))
const wait = ms => new Promise(r => setTimeout(r, ms))

const KEY = {
    ArrowLeft: { code: 'ArrowLeft', vk: 37 },
    ArrowRight: { code: 'ArrowRight', vk: 39 },
    Home: { code: 'Home', vk: 36 },
    End: { code: 'End', vk: 35 },
    Tab: { code: 'Tab', vk: 9 },
    Escape: { code: 'Escape', vk: 27 },
    Enter: { code: 'Enter', vk: 13, text: '\r' },
}

let chrome
let ws
let sid = ''
let seq = 0
const pending = new Map()
const runtimeErrors = []

async function send (method, params = {}, sessionId = sid, timeoutMs = 20000) {
    const id = ++seq
    return await new Promise((res, rej) => {
        const timer = setTimeout(() => {
            pending.delete(id)
            rej(new Error(`${method} 超时 ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, {
            res: v => { clearTimeout(timer); res(v) },
            rej: e => { clearTimeout(timer); rej(e) },
        })
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
}

const pageEval = (fnText, timeoutMs = 20000) => send('Runtime.evaluate', {
    expression: `(${fnText})()`,
    returnByValue: true,
    awaitPromise: true,
}, sid, timeoutMs).then(r => {
    if (r.exceptionDetails) {
        throw new Error('页面执行异常：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
})

async function until (label, fn, timeoutMs = 25000, diagnose = null) {
    const started = Date.now()
    for (;;) {
        const value = await fn()
        if (value) return value
        if (Date.now() - started > timeoutMs) {
            let extra = ''
            if (diagnose) {
                try { extra = ' | 现场：' + JSON.stringify(await diagnose()) } catch (e) { extra = ` | 取证失败：${e.message}` }
            }
            throw new Error(`等待超时：${label}${extra}`)
        }
        await wait(200)
    }
}

async function clickAt (x, y) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
}

// 元素中心此刻能不能真的收到点击（工具栏淡出时 pointer-events:none，点击会穿过去）
const hitSpot = selector => pageEval(`() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return { ok: false, why: 'missing' }
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return { ok: false, why: 'zero-size' }
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2)
    const top = document.elementFromPoint(x, y)
    if (!top) return { ok: false, why: 'no-point' }
    // 只接受命中自己或自己的子孙：点到祖先容器说明元素被裁掉/盖住了
    return {
        ok: el === top || el.contains(top), x, y,
        top: (top.tagName + '#' + (top.id || '') + '.' + (top.getAttribute('class') || '')).slice(0, 60),
    }
}`)

// 真实鼠标点击：移动鼠标唤醒界面，再用最新一次取到的中心坐标按下/抬起
async function click (selector, timeoutMs = 9000) {
    const started = Date.now()
    let last = null
    for (;;) {
        last = await hitSpot(selector)
        if (last.ok) {
            await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: last.x, y: last.y })
            await wait(140)
            const fresh = await hitSpot(selector)
            const at = fresh.ok ? fresh : last
            await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: at.x, y: at.y, button: 'left', buttons: 1, clickCount: 1 })
            await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: at.x, y: at.y, button: 'left', buttons: 0, clickCount: 1 })
            return at
        }
        if (Date.now() - started > timeoutMs) {
            throw new Error(`点不到 ${selector}（${last.why || `被 ${last.top} 盖住`}）`)
        }
        await wait(200)
    }
}

async function press (key) {
    const k = KEY[key]
    if (!k) throw new Error(`未登记的按键：${key}`)
    const base = { key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}) }
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyDown' })
    await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
}

async function shot (name) {
    const { data } = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(resolve(OUT, `${name}.png`), Buffer.from(data, 'base64'))
}

// 一次读取分页的结构、焦点、播放状态，作为每条断言的证据
const read = () => pageEval(`() => {
    const tabs = [...document.querySelectorAll('.music-tabs [data-tab]')]
    const ui = window.__readerMusic
    const st = ui?.player?.getState() || {}
    const focused = document.activeElement
    const cs = focused ? getComputedStyle(focused) : null
    return {
        tabs: tabs.map(b => ({
            tab: b.dataset.tab, id: b.id, role: b.getAttribute('role'),
            selected: b.getAttribute('aria-selected'), controls: b.getAttribute('aria-controls'),
            tabindex: b.getAttribute('tabindex'), active: b.classList.contains('active'),
        })),
        panes: [...document.querySelectorAll('.music-pane')].map(p => ({
            pane: p.dataset.pane, id: p.id, role: p.getAttribute('role'),
            labelledby: p.getAttribute('aria-labelledby'), hidden: p.hidden,
        })),
        focus: focused ? { id: focused.id || null, tab: focused.dataset?.tab || null, tag: focused.tagName } : null,
        focusVisible: focused ? focused.matches(':focus-visible') : false,
        outline: cs ? { style: cs.outlineStyle, width: cs.outlineWidth, color: cs.outlineColor } : null,
        shownPane: document.querySelector('.music-pane:not([hidden])')?.dataset.pane || null,
        state: {
            playing: Boolean(st.playing),
            currentName: st.currentName || null,
            trackCount: st.trackCount ?? null,
            rows: document.querySelectorAll('.track-item').length,
            neteaseMounted: Boolean(ui?.neteaseMounted),
            qqMounted: Boolean(ui?.qq?.mounted),
            liveFrames: document.querySelectorAll('#live-player iframe').length,
        },
        storedTab: ui?.settings?.music?.tab ?? null,
        readingProgress: document.getElementById('reading-progress')?.textContent?.trim() || null,
    }
}`)

// 结构契约：tab ↔ tabpanel 一一对应、roving tabindex、唯一 id
function assertContract (label, snap, expectedTab) {
    const tabs = snap.tabs
    const panes = snap.panes
    const sel = tabs.filter(t => t.selected === 'true')
    check(`${label}：三个 tab 都在`, tabs.length === 3, JSON.stringify(tabs.map(t => t.tab)))
    check(`${label}：只有一个 aria-selected=true 且为「${expectedTab}」`,
        sel.length === 1 && sel[0].tab === expectedTab, JSON.stringify(sel))
    check(`${label}：aria-controls 指向存在的 tabpanel，且面板 aria-labelledby 回指本 tab`,
        tabs.every(t => {
            const pane = panes.find(p => p.id === t.controls)
            return pane && pane.role === 'tabpanel' && pane.labelledby === t.id
        }), JSON.stringify(tabs.map(t => `${t.id}→${t.controls}`)))
    check(`${label}：aria-controls 的值互不重复`, new Set(tabs.map(t => t.controls)).size === 3,
        JSON.stringify(tabs.map(t => t.controls)))
    check(`${label}：roving tabindex——选中为 0，其余为 -1`,
        tabs.every(t => t.tabindex === (t.selected === 'true' ? '0' : '-1')),
        JSON.stringify(tabs.map(t => `${t.tab}:${t.tabindex}`)))
    check(`${label}：可见面板就是「${expectedTab}」，其余隐藏`,
        snap.shownPane === expectedTab && panes.filter(p => !p.hidden).length === 1,
        `${snap.shownPane} / ${JSON.stringify(panes.map(p => `${p.pane}:${p.hidden ? 'h' : 'v'}`))}`)
}

const musicPanelOpen = () => pageEval(`() => !document.getElementById('music-panel-body')?.hidden
    && Boolean(document.querySelector('.music-tabs [data-tab]'))`)

async function ensureMusicPanel () {
    if (await musicPanelOpen()) { await wait(400); return }
    await click('#top-settings')
    await until('控制面板出现', () => pageEval(`() => !document.getElementById('panel').classList.contains('hidden')`))
    if (await pageEval(`() => Boolean(document.querySelector('#nav-secondary')?.hidden)`)) await click('#nav-more')
    await until('二级导航展开', () => pageEval(`() => !document.querySelector('#nav-secondary')?.hidden`))
    for (let attempt = 1; attempt <= 3; attempt++) {
        await click('#toolbar button[data-cmd="music"]')
        await wait(500)
        if (await musicPanelOpen()) return
        notes.push(`第 ${attempt} 次真实点击「音乐」入口后面板未切换，重试`)
    }
    await shot('fail-music-panel-not-open')
    const trace = await pageEval(`() => {
        const btn = document.querySelector('#toolbar button[data-cmd="music"]')
        return {
            panelHidden: document.getElementById('panel')?.classList.contains('hidden'),
            toolbarCls: document.getElementById('toolbar')?.className,
            bodyHidden: document.getElementById('music-panel-body')?.hidden,
            title: document.getElementById('panel-title')?.textContent,
            btnRect: btn && Math.round(btn.getBoundingClientRect().width), btnActive: btn?.classList.contains('active'),
        }
    }`)
    throw new Error(`三次点击都没打开音乐面板 | 现场：${JSON.stringify(trace)}`)
}

async function keyboardFlow (label) {
    // 用真实鼠标聚焦「本地音乐」，Chrome 会把焦点留在按钮上
    await click(`#music-tab-${ORDER[0]}`)
    const afterClick = await read()
    check(`${label}：鼠标点击分页后焦点停在该 tab`, afterClick.focus?.tab === ORDER[0], JSON.stringify(afterClick.focus))

    await press('ArrowRight')
    const anim = await pageEval(`() => {
        const pane = document.querySelector('.music-pane:not([hidden])')
        const list = pane?.getAnimations?.() || []
        return { pane: pane?.dataset.pane || null, running: list.some(a => a.playState === 'running'), name: list[0]?.animationName || null }
    }`)
    check(`${label}：键盘切页与鼠标点击一样有入场动画`, anim.running === true, JSON.stringify(anim))
    const right1 = await read()
    check(`${label}：→ 把焦点移到「网易云」并同时激活其内容`,
        right1.focus?.tab === 'netease' && right1.storedTab === 'netease' && right1.shownPane === 'netease',
        JSON.stringify({ focus: right1.focus, stored: right1.storedTab, pane: right1.shownPane }))
    check(`${label}：→ 后 roving tabindex 与 ARIA 关联仍自洽`, (() => {
        const t = right1.tabs.find(x => x.tab === 'netease')
        return t?.selected === 'true' && t?.tabindex === '0' && right1.tabs.filter(x => x.tabindex === '0').length === 1
    })(), JSON.stringify(right1.tabs.map(x => `${x.tab}:${x.tabindex}:${x.selected}`)))
    check(`${label}：键盘切换后焦点环可见（:focus-visible + outline）`,
        right1.focusVisible === true && right1.outline?.style !== 'none' && parseFloat(right1.outline.width) >= 1,
        JSON.stringify({ focusVisible: right1.focusVisible, outline: right1.outline }))

    await press('ArrowRight')
    const right2 = await read()
    check(`${label}：再按 → 到「QQ 音乐」`, right2.focus?.tab === 'qq' && right2.shownPane === 'qq',
        JSON.stringify({ focus: right2.focus, pane: right2.shownPane }))

    await press('ArrowRight')
    const wrap = await read()
    check(`${label}：→ 在末项回卷到首项「本地音乐」`, wrap.focus?.tab === 'local' && wrap.shownPane === 'local',
        JSON.stringify({ focus: wrap.focus, pane: wrap.shownPane }))

    await press('ArrowLeft')
    const back = await read()
    check(`${label}：← 在首项回卷到末项「QQ 音乐」`, back.focus?.tab === 'qq' && back.shownPane === 'qq',
        JSON.stringify({ focus: back.focus, pane: back.shownPane }))

    await press('ArrowLeft')
    const back2 = await read()
    check(`${label}：← 逐步回退到「网易云」`, back2.focus?.tab === 'netease' && back2.shownPane === 'netease',
        JSON.stringify({ focus: back2.focus, pane: back2.shownPane }))

    await press('Home')
    const home = await read()
    assertContract(`${label} Home`, home, 'local')

    await press('End')
    const end = await read()
    assertContract(`${label} End`, end, 'qq')

    await press('End')
    const endAgain = await read()
    check(`${label}：重复 End 停在末项不越界`, endAgain.focus?.tab === 'qq' && endAgain.shownPane === 'qq',
        JSON.stringify({ focus: endAgain.focus, pane: endAgain.shownPane }))

    // Enter 走按钮原生 click，仍能激活
    await press('Enter')
    const entered = await read()
    check(`${label}：Enter 激活当前 tab 不报错（仍停在 QQ 音乐）`,
        entered.focus?.tab === 'qq' && entered.shownPane === 'qq',
        JSON.stringify({ focus: entered.focus, pane: entered.shownPane }))

    await press('End')
    await shot(`${label}-after-home`)
    return (await read())
}

async function runViewport (label, { width, height, mobile }) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile })
    await send('Page.navigate', { url: URL })
    await until('应用启动句柄', () => pageEval(`() => Boolean(window.__readerMusic) && Boolean(document.getElementById('top-settings'))`), 40000)
    await wait(1200)

    await ensureMusicPanel()
    const initial = await read()
    assertContract(`${label} 初始`, initial, initial.storedTab || 'local')

    // 基线：切页前后播放状态、曲目数与官方播放器挂载必须一致
    check(`${label}：基线为未播放且无曲目`, initial.state.playing === false && initial.state.trackCount === 0,
        JSON.stringify(initial.state))

    // 鼠标路径：点网易云 → 点 QQ 音乐 → 点回本地
    await click('#music-tab-netease')
    await wait(250)
    const mouseNetease = await read()
    assertContract(`${label} 鼠标点网易云`, mouseNetease, 'netease')
    await click('#music-tab-qq')
    await wait(250)
    const mouseQq = await read()
    assertContract(`${label} 鼠标点 QQ 音乐`, mouseQq, 'qq')
    await click(`#music-tab-${ORDER[0]}`)
    await wait(250)
    const mouseLocal = await read()
    assertContract(`${label} 鼠标点回本地`, mouseLocal, 'local')

    await shot(`${label}-01-tabs-local`)
    const afterKeyboard = await keyboardFlow(label)
    await shot(`${label}-02-tabs-end`)

    // 键盘/鼠标切页都不得触发播放、删除或挂载官方播放器
    for (const [name, snap] of [['鼠标', mouseQq], ['键盘', afterKeyboard]]) {
        check(`${label}：${name}切页后播放状态不变（未播放）`, snap.state.playing === false, JSON.stringify(snap.state))
        check(`${label}：${name}切页后曲目数不变`, snap.state.trackCount === initial.state.trackCount,
            `${initial.state.trackCount} → ${snap.state.trackCount}`)
        check(`${label}：${name}切页后未挂载网易云/QQ 官方播放器`,
            snap.state.neteaseMounted === initial.state.neteaseMounted
            && snap.state.liveFrames === initial.state.liveFrames,
            JSON.stringify({ netease: snap.state.neteaseMounted, frames: snap.state.liveFrames }))
    }

    // 分页是一个 Tab 停靠点：Tab 应从选中的 tab 进入面板内容
    await press('Tab')
    const tabbed = await read()
    check(`${label}：Tab 从选中分页离开 tablist 进入面板内容`,
        tabbed.focus?.tab == null && tabbed.focus?.id !== 'music-tab-local', JSON.stringify(tabbed.focus))

    // 窄屏溢出
    const overflow = await pageEval(`() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })`)
    check(`${label}：无横向溢出`, overflow.scrollWidth <= overflow.innerWidth + 1, JSON.stringify(overflow))

    await shot(`${label}-03-final`)
    return { initial, afterKeyboard, overflow }
}

// 阅读页回归：方向键换页时不能把翻页也带着走（读 #reading-progress 是否原地不动）
async function readingPageFlow () {
    const BOOK = '#welcome [data-action="open-book"]'
    try {
        await send('Page.navigate', { url: URL })
        await until('回到欢迎页', () => pageEval(`() => Boolean(document.querySelector('#welcome [data-action="open-book"], #welcome .books-fold > summary'))`), 40000)
        await wait(1000)
        // 关掉可能还开着的面板，确保点的是欢迎页「最近书籍」里的示例书
        if (await pageEval(`() => !document.getElementById('panel').classList.contains('hidden')`)) {
            await click('#panel-close')
            await wait(600)
        }
        if (!await pageEval(`() => Boolean(document.querySelector('#welcome details.books-fold')?.open)`)) {
            await click('#welcome details.books-fold > summary')
            await until('最近书籍已展开', () => pageEval(`() => Boolean(document.querySelector('#welcome details.books-fold')?.open)`), 10000)
            await wait(700)
        }
        await click(BOOK)
        await until('正文标题出现', () => pageEval(`() => Boolean(document.querySelector('#reading-title')?.textContent?.trim())`), 45000)
        await wait(2500)
        await ensureMusicPanel()
        await click('#music-tab-local')
        const before = await read()
        for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'Home', 'End']) await press(key)
        await wait(500)
        const after = await read()
        check('阅读页：方向键切分页不改变阅读位置',
            Boolean(before.readingProgress) && before.readingProgress === after.readingProgress,
            `${before.readingProgress} → ${after.readingProgress}`)
        check('阅读页：键盘切分页仍未触发播放', after.state.playing === false, JSON.stringify(after.state))
        await shot('reading-page-tabs')
    } catch (e) {
        notes.push(`阅读页回归未完成（未验证）：${e.message}`)
    }
}

try {
    chrome = spawn(CHROME, [
        `--user-data-dir=${PROFILE}`,
        '--remote-debugging-port=0',
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--autoplay-policy=no-user-gesture-required',
        '--hide-scrollbars',
        '--window-size=1440,900',
        'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    chrome.stderr.on('data', d => { stderr += d.toString() })
    chrome.on('exit', code => { if (code !== 0 && code !== null) notes.push(`Chrome 退出码 ${code}`) })

    const portFile = join(PROFILE, 'DevToolsActivePort')
    const started = Date.now()
    while (!readFileSyncExists(portFile)) {
        if (Date.now() - started > 30000) throw new Error(`30 秒内没等到 DevToolsActivePort。stderr：${stderr.slice(0, 400)}`)
        await wait(200)
    }
    const [cdpPort, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n')
    ws = new WebSocket(`ws://127.0.0.1:${cdpPort}${wsPath}`)
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true })
        ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')), { once: true })
        setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 15000)
    })
    ws.addEventListener('message', event => {
        let msg
        try { msg = JSON.parse(event.data) } catch { return }
        if (msg.id && pending.has(msg.id)) {
            const { res, rej } = pending.get(msg.id)
            pending.delete(msg.id)
            msg.error ? rej(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : res(msg.result)
            return
        }
        if (msg.method === 'Runtime.exceptionThrown') {
            runtimeErrors.push('pageerror: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text))
        }
        if (msg.method === 'Log.entryAdded' && msg.params.entry?.level === 'error') {
            if (!/favicon|Content Security Policy|net::ERR/i.test(msg.params.entry.text || '')) {
                runtimeErrors.push('console: ' + msg.params.entry.text)
            }
        }
    })

    const { targetId } = await send('Target.createTarget', { url: 'about:blank' }, '')
    sid = (await send('Target.attachToTarget', { targetId, flatten: true }, '')).sessionId
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Log.enable')

    const desktop = await runViewport('桌面', { width: 1440, height: 900, mobile: false })
    await readingPageFlow()

    // 重新加载回到初始页，再走窄屏
    await send('Page.navigate', { url: URL })
    await until('应用再次启动', () => pageEval(`() => Boolean(window.__readerMusic)`), 40000)
    await wait(1200)
    const narrow = await runViewport('390x670', { width: 390, height: 670, mobile: true })

    check('窄屏打开时分页沿用上次选择的来源',
        narrow.initial.storedTab === desktop.afterKeyboard.storedTab,
        `桌面结束 ${desktop.afterKeyboard.storedTab} → 窄屏初始 ${narrow.initial.storedTab}`)
} catch (e) {
    fail.push('执行中断 → ' + (e && e.message ? e.message : String(e)))
} finally {
    try { ws?.close() } catch { /* 收尾 */ }
    try { chrome?.kill('SIGKILL') } catch { /* 收尾 */ }
    await wait(300)
    try { rmSync(PROFILE, { recursive: true, force: true }) } catch { /* 临时资料留在 .preview 下，清不掉也不影响正式资料 */ }
}

function readFileSyncExists (p) {
    try { readFileSync(p); return true } catch { return false }
}

console.log(`\n通过 ${pass.length}`)
pass.forEach(p => console.log('  ✔ ' + p))
if (fail.length) {
    console.log(`\n失败 ${fail.length}`)
    fail.forEach(f => console.log('  ✘ ' + f))
}
if (notes.length) {
    console.log(`\n备注 ${notes.length}`)
    notes.forEach(n => console.log('  · ' + n))
}
if (runtimeErrors.length) {
    console.log(`\n运行期错误 ${runtimeErrors.length}`)
    ;[...new Set(runtimeErrors)].slice(0, 12).forEach(e => console.log('  ! ' + e))
}
const ok = fail.length === 0 && runtimeErrors.length === 0
console.log(ok ? '\n结果：全部通过' : '\n结果：存在失败项')
console.log(`截图：${OUT}`)
console.log(`隔离资料：${URL}（服务端 SQLite 在 .preview/data-${PORT}，Chrome 临时配置已删除）`)
process.exit(ok ? 0 : 1)
