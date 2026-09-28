// 音乐面板验收：驱动完整应用，检查版式、内置音源、播放链路与分页切换动效。
//
// 只允许在 127.0.0.1:8941 测试地址运行：它会清空该地址的浏览器资料，绝不碰日常使用的 8940。
// 运行：
//   python3 scripts/serve.py --port 8941 --no-open
//   PLAYWRIGHT_CORE=/绝对路径/playwright-core/index.js node tests/music-panel-check.mjs
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const BASE = process.env.READER_URL || 'http://127.0.0.1:8941/'
const CORE = process.env.PLAYWRIGHT_CORE || 'playwright-core'
const OUT = resolve('.preview/music-check')

if (!/^http:\/\/127\.0\.0\.1:8941\//.test(BASE)) {
    console.error(`拒绝运行：只允许 127.0.0.1:8941 测试地址，收到 ${BASE}`)
    process.exit(2)
}

let chromium
try {
    const mod = await import(CORE)
    chromium = mod.chromium || mod.default?.chromium
} catch (e) {
    console.error(`无法加载 playwright-core（${CORE}）：${e.message}`)
    process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const pass = []
const fail = []
const check = (name, ok, detail = '') => (ok ? pass : fail).push(name + (detail ? ` → ${detail}` : ''))
const wait = ms => new Promise(r => setTimeout(r, ms))

const browser = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] })
const runtimeErrors = []
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', e => runtimeErrors.push('pageerror: ' + e.message))
page.on('console', m => {
    if (m.type() === 'error' && !/favicon|Content Security Policy|net::ERR/i.test(m.text())) {
        runtimeErrors.push('console: ' + m.text())
    }
})

const wake = async () => { await page.mouse.move(700, 460); await wait(420) }
const shot = async name => page.screenshot({ path: resolve(OUT, `${name}.png`) })

await page.goto(BASE, { waitUntil: 'networkidle' })
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'networkidle' })
await wait(1400)
// 用应用自己的 API 清空本地址的音频记录，曲目数才可预期（只影响 8941，不碰 8940）
await page.evaluate(async () => {
    const db = window.__readerDb
    for (const t of await db.listAudioTracks()) await db.deleteAudioTrack(t.id)
})
await page.reload({ waitUntil: 'networkidle' })
await wait(1600)
await page.setInputFiles('#file-book', 'tests/fixtures/山中的信.txt')
await page.waitForFunction(() => Boolean(document.querySelector('#reading-title')?.textContent), null, { timeout: 40000 })
await wait(2000)

await wake()
await page.click('#top-settings')
await wait(600)
await page.evaluate(() => document.querySelector('#nav-secondary').hidden && document.querySelector('#nav-more').click())
await wait(300)
await page.click('#toolbar button[data-cmd="music"]')
await wait(800)

// ---------- 版式 ----------
const layout = await page.evaluate(() => {
    const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
    const cs = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null }
    const tabs = [...document.querySelectorAll('.music-tabs button')].map(b => ({
        tab: b.dataset.tab, sel: b.getAttribute('aria-selected'), bg: getComputedStyle(b).backgroundColor,
    }))
    return {
        stage: r('.np-stage'), cover: r('.np-cover'), controls: r('.np-controls'),
        mainBtn: r('.np-controls button.main'), sideBtn: r('.np-controls button:not(.main)'), progress: r('.np-progress'),
        list: r('#track-list'), builtin: r('#builtin-grid'), drop: r('.audio-drop-zone'),
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        panelScrollH: document.querySelector('#music-panel-body')?.scrollHeight,
        panelH: document.querySelector('#music-panel-body')?.clientHeight,
        tabs,
        eqVisible: cs('.np-eq')?.visibility,
        coverRadius: cs('.np-cover')?.borderRadius,
    }
})
check('正在播放主视觉存在', layout.stage && layout.cover && layout.controls && layout.progress, JSON.stringify({ stage: layout.stage, cover: layout.cover }))
check('封面是正方形', layout.cover && Math.abs(layout.cover.w - layout.cover.h) <= 2, `${layout.cover?.w}×${layout.cover?.h}`)
check('播放键明显大于其它传输键', layout.mainBtn && layout.sideBtn && layout.mainBtn.w >= layout.sideBtn.w * 1.25, JSON.stringify({ main: layout.mainBtn, side: layout.sideBtn }))
check('传输行居中于面板', layout.controls && Math.abs((layout.controls.x + layout.controls.w / 2) - (layout.stage.x + layout.stage.w / 2)) < 6, JSON.stringify({ c: layout.controls.x + layout.controls.w / 2, s: layout.stage.x + layout.stage.w / 2 }))
check('自上而下顺序：封面→进度→传输→音量', layout.cover.y < layout.progress.y && layout.progress.y < layout.controls.y, JSON.stringify({ cover: layout.cover.y, prog: layout.progress.y, ctrl: layout.controls.y }))
check('未播放时律动指示不可见', layout.eqVisible === 'hidden', String(layout.eqVisible))
check('面板无横向溢出', !layout.overflowX)
const [localTab, neteaseTab] = layout.tabs
check('分页选中态与未选中态背景不同', localTab && neteaseTab && localTab.bg !== neteaseTab.bg, `${localTab?.bg} vs ${neteaseTab?.bg}`)

// ---------- 内置音源 ----------
const grid = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('.builtin-card')].map(c => ({
        title: c.querySelector('.bc-body strong')?.textContent,
        art: getComputedStyle(c.querySelector('.bc-art')).backgroundImage.slice(0, 24),
        disabled: c.querySelector('button')?.disabled,
    })),
})).catch(() => ({ cards: [] }))
check('内置音源卡片全部渲染', grid.cards.length === 6, `${grid.cards.length} 张`)
check('内置封面为程序生成的位图', grid.cards.every(c => c.art.startsWith('url(')), grid.cards[0]?.art)
await page.evaluate(() => document.querySelector('#builtin-grid')?.scrollIntoView({ block: 'center' }))
await wait(400)
await shot('01-builtin-grid')

await page.click('[data-action="builtin-all"]')
await wait(2500)
const importState = await page.evaluate(() => ({
    tracks: document.querySelectorAll('.track-item').length,
    count: document.querySelector('#track-count')?.textContent,
    empty: document.querySelector('#music-empty-cta')?.hidden,
    block: document.querySelector('#music-controls-block')?.hidden,
    playerTracks: window.__readerMusic?.player?.tracks?.length,
    toast: document.querySelector('#toast')?.textContent,
    toastHidden: document.querySelector('#toast')?.classList.contains('hidden'),
}))
console.log('导入后状态：', JSON.stringify(importState))
check('全部添加后播放列表有 6 首', importState.tracks === 6, JSON.stringify(importState))
await wait(1200)
const owned = await page.evaluate(() => ({
    tracks: document.querySelectorAll('.track-item').length,
    allOwned: [...document.querySelectorAll('.builtin-card')].every(c => c.classList.contains('owned')),
    disabled: [...document.querySelectorAll('.builtin-card button')].every(b => b.disabled),
}))

check('已添加的内置卡片变为不可重复添加', owned.allOwned && owned.disabled, JSON.stringify(owned))

// ---------- 播放链路 ----------
await page.evaluate(() => document.querySelector('.np-stage')?.scrollIntoView({ block: 'start' }))
await wait(300)
await page.locator('.track-item .tn').first().click()
await wait(2600)
const playing = await page.evaluate(() => {
    const cs = s => { const e = document.querySelector(s); return e ? getComputedStyle(e) : null }
    return {
        title: document.querySelector('#np-title')?.textContent,
        sub: document.querySelector('#np-sub')?.textContent,
        coverArt: (cs('.np-cover')?.backgroundImage || '').startsWith('url('),
        hasArt: document.querySelector('.np-cover')?.classList.contains('has-art'),
        eq: cs('.np-eq')?.visibility,
        playingClass: document.querySelector('.np-cover')?.classList.contains('playing'),
        mini: document.querySelector('#mini-player')?.classList.contains('is-playing'),
        seek: Number(document.querySelector('#np-seek')?.value),
    }
})
check('点曲目后标题与副信息更新', playing.title && playing.title !== '未在播放' && /正在播放/.test(playing.sub || ''), `${playing.title} · ${playing.sub}`)
check('播放时封面显示程序生成的封面图', playing.coverArt && playing.hasArt, JSON.stringify({ coverArt: playing.coverArt, hasArt: playing.hasArt }))
check('播放时律动指示可见', playing.eq === 'visible', String(playing.eq))
check('播放时迷你条同步在播', playing.mini === true)
await wait(1600)
const advanced = await page.evaluate(() => Number(document.querySelector('#np-seek')?.value))
check('播放进度在推进', advanced > playing.seek, `${playing.seek.toFixed(2)} → ${advanced.toFixed(2)}`)
await shot('02-now-playing')

// ---------- 传输与音量 ----------
await page.click('#btn-mode')
await wait(400)
const mode = await page.evaluate(() => document.querySelector('#btn-mode')?.title)
check('播放模式可循环切换', /单曲循环/.test(mode || ''), mode)
await page.evaluate(() => {
    const el = document.querySelector('#vol-range')
    el.value = '0.42'
    el.dispatchEvent(new Event('input', { bubbles: true }))
})
await wait(300)
check('音量滑杆生效', (await page.textContent('#v-vol')).trim() === '42%')
await page.click('#btn-mute')
await wait(300)
check('静音按钮生效', await page.evaluate(() => document.querySelector('#btn-mute').getAttribute('aria-pressed')) === 'true')
await page.click('#btn-mute')
await wait(300)

// ---------- 分页切换都有动效 ----------
for (const tab of ['netease', 'qq', 'local']) {
    await page.click(`.music-tabs [data-tab="${tab}"]`)
    await wait(90)
    const anim = await page.evaluate(() => {
        const pane = document.querySelector('.music-pane:not([hidden])')
        const list = pane?.getAnimations?.({ subtree: false }) || []
        return { running: list.some(a => a.playState === 'running'), name: list[0]?.animationName || list[0]?.effect?.keyframes?.[0]?.animationName }
    })
    check(`切到「${tab}」分页有入场动画`, anim.running === true, JSON.stringify(anim))
    await wait(420)
    await shot(`03-tab-${tab}`)
}

// ---------- 曲目行操作只在悬停时出现 ----------
await page.click('.music-tabs [data-tab="local"]')
await wait(500)
const rowActions = await page.evaluate(async () => {
    const li = document.querySelector('.track-item')
    const btn = li.querySelector('[data-action="delete-track"]')
    return { hidden: getComputedStyle(btn).opacity }
})
await page.hover('.track-item')
await wait(400)
const hoverOpacity = await page.evaluate(() => getComputedStyle(document.querySelector('.track-item [data-action="delete-track"]')).opacity)
check('曲目行操作按钮默认隐藏、悬停出现', Number(rowActions.hidden) === 0 && Number(hoverOpacity) > 0.5, `静 ${rowActions.hidden} → 悬停 ${hoverOpacity}`)
await shot('04-track-list')

// ---------- 布局不压到阅读区 ----------
const avoid = await page.evaluate(() => {
    const r = s => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    const overlap = (a, b) => a && b && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
    const panel = r('#panel'), mini = r('#mini-player'), dock = r('#reading-dock'), host = r('#reader-host')
    return { panelMini: overlap(panel, mini), panelDock: overlap(panel, dock), hostPanel: overlap(host, panel) }
})
check('面板不与迷你条/底栏重叠', !avoid.panelMini && !avoid.panelDock, JSON.stringify(avoid))

await page.close()

// ---------- 窄屏 ----------
const m = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
m.on('pageerror', e => runtimeErrors.push('mobile pageerror: ' + e.message))
await m.goto(BASE, { waitUntil: 'networkidle' })
await wait(1400)
await m.click('#top-settings')
await wait(500)
await m.evaluate(() => document.querySelector('#nav-secondary').hidden && document.querySelector('#nav-more').click())
await m.click('#toolbar button[data-cmd="music"]')
await wait(700)
const narrow = await m.evaluate(() => {
    const cover = document.querySelector('.np-cover')?.getBoundingClientRect()
    const panel = document.querySelector('#panel')?.getBoundingClientRect()
    return {
        overflowX: document.documentElement.scrollWidth > window.innerWidth,
        coverW: cover && Math.round(cover.width), panelW: panel && Math.round(panel.width),
        controlsFit: (() => {
            const c = document.querySelector('.np-controls')?.getBoundingClientRect()
            return c ? c.right <= panel.right + 1 && c.left >= panel.left - 1 : null
        })(),
    }
})
check('390px 无横向溢出', !narrow.overflowX)
check('390px 封面按面板宽度收敛', narrow.coverW && narrow.coverW < narrow.panelW * 0.7, JSON.stringify(narrow))
check('390px 传输行不越界', narrow.controlsFit === true, JSON.stringify(narrow))
await m.screenshot({ path: resolve(OUT, '05-mobile.png') })
await m.close()

await browser.close()

console.log(`\n通过 ${pass.length}`)
pass.forEach(p => console.log('  ✔ ' + p))
if (fail.length) {
    console.log(`\n失败 ${fail.length}`)
    fail.forEach(f => console.log('  ✘ ' + f))
}
if (runtimeErrors.length) {
    console.log(`\n运行期错误 ${runtimeErrors.length}`)
    runtimeErrors.forEach(e => console.log('  ! ' + e))
}
const ok = fail.length === 0 && runtimeErrors.length === 0
console.log(ok ? '\n结果：全部通过' : '\n结果：存在失败项')
console.log(`截图：${OUT}`)
process.exit(ok ? 0 : 1)
