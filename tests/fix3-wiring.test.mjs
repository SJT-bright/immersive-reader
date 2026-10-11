// fix3 批次的静态接线断言。
//
// 这一批缺陷（Esc 守卫、焦点复原、下拉键盘路径、resize 通知、定时器句柄……）都是 DOM / 键盘行为，
// 本任务禁止跑浏览器夹具，所以这里只能证明「接线存在、顺序正确、旧写法已消失」，
// 不能证明「行为正确」。每条都注明它证明到哪一步，剩下的留给实页验收（见交付说明）。
//
// 运行：node --test tests/fix3-wiring.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(join(root, p), 'utf8')
const mainSrc = read('js/main.js')
const logUiSrc = read('js/reading-log-ui.js')
const settingsSrc = read('js/settings.js')
const htmlSrc = read('index.html')
const glassSrc = read('css/glass-ui.css')
const expSrc = read('css/experience.css')

// 顶层函数体：从 function 名开始，到第一个顶格的 } 结束（本项目顶层函数体一律缩进 4 空格）
function topFn (src, name) {
    const at = src.indexOf(`function ${name}`)
    assert.ok(at >= 0, `源码里找不到 function ${name}`)
    const end = src.indexOf('\n}', at)
    assert.ok(end > at, `function ${name} 的收尾大括号不在行首，取不到函数体`)
    return src.slice(at, end + 2)
}
// 两段锚点之间的片段（含起点，不含终点），用来截函数内部的处理块
function between (src, startNeedle, endNeedle, from = 0) {
    const a = src.indexOf(startNeedle, from)
    assert.ok(a >= 0, `找不到起点锚：${startNeedle}`)
    const b = src.indexOf(endNeedle, a + startNeedle.length)
    assert.ok(b > a, `找不到终点锚：${endNeedle}`)
    return src.slice(a, b)
}
const has = (t, src, needle, what) => assert.ok(src.includes(needle), `${t.name}：${what || '缺少'}「${needle}」`)
const lacks = (t, src, needle, what) => assert.ok(!src.includes(needle), `${t.name}：${what || '应已消失'}「${needle}」`)

// ---------- F3-1：Esc 的输入守卫 ----------

test('Esc 处理块带上了与全局快捷键同族的输入守卫（证明接线存在，不代表实页行为）', t => {
    const esc = between(mainSrc, "if (e.key !== 'Escape') return", "$('#top-settings')?.focus?.()")
    has(t, esc, 'input, select, textarea', '缺少文字输入守卫')
    has(t, esc, 'isContentEditable')
    has(t, esc, 'e.ctrlKey || e.metaKey || e.altKey', '缺少修饰键守卫')
    has(t, esc, 'isComposing', '缺少输入法组合守卫')
    // 守卫必须在关抽屉之前
    assert.ok(esc.indexOf('input, select, textarea') < esc.indexOf('closePanel()'), '守卫写在了 closePanel 之后，等于没有')
    // 那条没有守卫的一行式必须已经消失
    lacks(t, mainSrc, "if(e.key==='Escape'){closeReadingToc();closePanel()", '旧的一行式无守卫处理仍在')
    // 与 :2152 那一族共用的选择器仍然在原处（两份列表可比对）
    has(t, mainSrc, "e.target.matches('input, select, textarea, button')")
})

test('Esc 收起抽屉后把焦点交给 #top-settings 的时机改成了退场动画结束（不再对 visibility:hidden 的元素 focus）', t => {
    const esc = between(mainSrc, "if (e.key !== 'Escape') return", "$('#toolbar').addEventListener('click'")
    has(t, esc, 'panelMotion?.finished', '仍然在 closePanel() 之后立刻 focus()')
    has(t, esc, '.then(handBack')
})

// ---------- F3-6：空格豁免表 ----------

test('空格豁免表补齐 button / summary / a[href]（聚焦按钮能用空格激活）', t => {
    const space = between(mainSrc, "if(e.code!=='Space'&&e.key!==' ')return", 'if(!e.repeat)toggleControls()')
    for (const sel of ['input', 'textarea', 'select', 'button', 'summary', 'a[href]', '[contenteditable]:not([contenteditable="false"])']) {
        has(t, space, sel, `豁免表缺少 ${sel}`)
    }
    has(t, space, 'e.target?.closest?.(', 'closest 未做存在性保护')
})

// ---------- F3-2：目录浮层重建保住焦点 ----------

test('目录更新保留节点：只有换书构建结构，relocate经单次rAF更新（行为由浏览器验收）', t => {
    const fn = topFn(mainSrc, 'renderReadingToc')
    has(t, fn, 'if (readingTocBook !== book)')
    const updates = fn.slice(fn.indexOf('const stats = reader.readStats'))
    lacks(t, updates, 'pop.innerHTML', '同书进度更新不能重建搜索框和目录行')
    has(t, fn, 'readingTocRows')
    const schedule = topFn(mainSrc, 'scheduleReadingToc')
    has(t, schedule, 'if (readingTocFrame != null) return')
    has(t, schedule, 'requestAnimationFrame')
    has(t, schedule, 'renderReadingToc()')
    lacks(t, schedule.slice(schedule.indexOf('requestAnimationFrame')), 'scheduleReadingToc()', '回调不能自排每帧空循环')
})

// ---------- F3-3：计时 tick 句柄 + renderTimer patch 路径 ----------

test('init 的每秒 tick 已存句柄、后台与关页会清理、且只在签名变化时重画', t => {
    has(t, mainSrc, 'let logTimer = null')
    has(t, mainSrc, 'function startLogTick')
    has(t, mainSrc, 'function stopLogTick')
    const tick = topFn(mainSrc, 'startLogTick')
    has(t, tick, 'logTimer = setInterval(')
    has(t, tick, 'if (document.hidden) return')
    has(t, tick, 'if (changed) paintTimer()', '仍然每秒无条件重画')
    has(t, tick, 'if (settings.readingLog.current?.running && changed) persistLog(false)', 'persistLog 没有跟在"运行且变化"之后')
    // 可见性/关页清理
    const init = between(mainSrc, 'async function init', 'init().catch')
    assert.equal((init.match(/setInterval\(/g) || []).length, 0, 'init() 里仍有不存句柄的 setInterval')
    has(t, init, 'startLogTick()')
    has(t, init, 'lastTickSig = timerSignature()')
    has(t, mainSrc, "window.addEventListener('pagehide', stopLogTick", 'pagehide 未清理计时 tick')
    const vis = between(mainSrc, 'document.addEventListener(\'visibilitychange\'', "window.addEventListener('resize'")
    has(t, vis, 'stopLogTick()', '切后台仍在跑每秒 tick')
    has(t, vis, 'startLogTick()', '回前台没有重新起 tick')
    assert.ok(vis.indexOf('stopLogTick()') < vis.indexOf('startLogTick()'), '可见性处理里停/起顺序颠倒')
})

test('renderTimer 走 patch 路径：结构不变时不整块 innerHTML 重建按钮', t => {
    const rt = topFn(logUiSrc, 'renderTimer')
    has(t, rt, "el.querySelector('.timer-toggle')", '没有先判定按钮是否已存在')
    assert.ok(rt.indexOf("querySelector('.timer-toggle')") < rt.indexOf('el.innerHTML'), 'patch 判定必须在 innerHTML 之前')
    const patchPart = rt.slice(0, rt.indexOf('el.innerHTML'))
    has(t, patchPart, "toggle.setAttribute('aria-label'")
    has(t, patchPart, 'toggle.innerHTML = icon(want)', '切换播放/暂停图标要写在按钮内部，不能换按钮节点')
    has(t, patchPart, 'return')
    lacks(t, patchPart, 'el.innerHTML', 'patch 分支里仍在整块重建')
    lacks(t, patchPart, 'outerHTML')
    lacks(t, patchPart, 'replaceChildren')
})

// ---------- F3-4：系统音量快照持久化 ----------

test('系统音量快照落盘、启动复原，恢复动作明确发 muted:false', t => {
    has(t, settingsSrc, 'systemMute: null', 'DEFAULT_SETTINGS.music 缺 systemMute')
    has(t, settingsSrc, 'out.music.systemMute =', 'normalizeSettings 未处理 systemMute')
    const mute = between(mainSrc, "case 'global-mute'", "case 'delete-track'")
    has(t, mute, 'settings.music.systemMute = snap.sys', '静音时没落盘快照')
    has(t, mute, 'muted: false }', '恢复时没有明确写 muted:false')
    has(t, mute, 'byUs', '没有记录"系统静音是不是我们按的"')
    lacks(t, mute, 'muted: snap.sys.muted }', '仍在回放捕获到的静音标志位')
    has(t, mute, 'settings.music.systemMute = null', '恢复后没清掉快照')
    const init = between(mainSrc, 'async function init', 'init().catch')
    has(t, init, 'globalMuteSnapshot = {', '启动时没按 settings.music.muted 复原快照')
    has(t, init, 'sys: settings.music.systemMute || null')
    has(t, mainSrc, 'function syncGlobalMuteButton', '按钮文案仍只由内存态推导')
    has(t, mainSrc, 'syncGlobalMuteButton()', '渲染后没同步按钮')
    // 复原出来的静音状态要连环境声一起成立，否则「环境声：已全局静音」又是一句谎
    has(t, mainSrc, 'const ambiencePlayVolume = () => globalMuteSnapshot ? 0 : settings.ambience.volume')
    assert.equal((mainSrc.match(/ambience\.setVolume\(ambiencePlayVolume\(\)\)/g) || []).length, 3,
        '环境声的三处音量下发（快选滑杆 / 组合预设 / 单种环境声）都应走 ambiencePlayVolume()')
})

// ---------- F3-5：换书前停自动阅读 ----------

test('openBookRecord 在 reader.open 之前显式停自动阅读', t => {
    const fn = topFn(mainSrc, 'openBookRecord')
    has(t, fn, 'autoReading?.stop()', '换书没停自动阅读')
    assert.ok(fn.indexOf('autoReading?.stop()') < fn.indexOf('await reader.open('), 'stop() 写在 open() 之后就晚了')
    // 对照路径：回书架本来就是先 stop 的
    has(t, mainSrc, "case 'return-home'")
})

// ---------- F3-7：目录两套 id 与浮层键盘收起 ----------

test('抽屉与浮层的目录控件 id 分开，bindTocFilter 接受选择器参数', t => {
    const fn = topFn(mainSrc, 'renderReadingToc')
    has(t, fn, 'id="reading-toc-filter"')
    has(t, fn, 'id="reading-toc-list"')
    has(t, fn, 'id="reading-toc-filter-hint"')
    lacks(t, fn, 'id="toc-filter"', '浮层仍在生成与抽屉同名的 id')
    lacks(t, fn, 'id="toc-list"')
    const bind = topFn(mainSrc, 'bindTocFilter')
    has(t, bind, 'sel = TOC_FILTER_PANEL', 'bindTocFilter 还没有接受选择器参数')
    has(t, mainSrc, 'TOC_FILTER_POPOVER')
    has(t, fn, 'TOC_FILTER_POPOVER)')
    // 文档里同名的目录 id 只出现在抽屉那套模板里
    assert.equal((mainSrc.match(/id="toc-filter"/g) || []).length, 2, '抽屉版目录 id 数量变了，请复核是否又造出重复 id')
    // 开抽屉先收浮层
    has(t, topFn(mainSrc, 'openPanel'), 'closeReadingToc()')
    // 键盘收起路径
    const esc = between(mainSrc, "if (e.key !== 'Escape') return", "$('#toolbar').addEventListener('click'")
    has(t, esc, "closest?.('#reading-toc-popover')", '浮层没有键盘收起路径')
    has(t, esc, 'e.stopPropagation()')
    has(t, esc, "$('#reading-toc')?.focus()")
    // CSS 跟着改名（浮层样式不能再挂在不存在的 id 上）
    has(t, expSrc, '#reading-toc-popover #reading-toc-filter')
    has(t, expSrc, '#reading-toc-popover #reading-toc-list')
    lacks(t, expSrc, '#reading-toc-popover #toc-filter', 'CSS 还在挂旧 id')
})

// ---------- F3-8：选书下拉的 Esc 与方向键 ----------

test('笔记选书下拉补上 Esc（含 stopPropagation）与 ↑↓/Home/End', t => {
    const fn = topFn(mainSrc, 'renderNotesPanel')
    has(t, fn, "bookBtn.addEventListener('keydown'")
    has(t, fn, "bookList.addEventListener('keydown'")
    const kb = between(fn, "bookBtn.addEventListener('keydown'", 'bookList.addEventListener(\'click\'')
    has(t, kb, "'Escape'")
    has(t, kb, 'e.stopPropagation()', 'Esc 会继续冒泡把整个抽屉关掉')
    has(t, fn, "setAttribute('aria-expanded'", '按钮 aria-expanded 未维护')
    has(t, fn, "closeBookList({ backToButton: true })", '收起后没把焦点交还按钮')
    has(t, kb, 'ArrowDown')
    has(t, kb, 'ArrowUp')
    has(t, kb, 'e.preventDefault()')
    has(t, between(fn, "bookList.addEventListener('keydown'", "bookList.addEventListener('click'"), 'Home')
    has(t, between(fn, "bookList.addEventListener('keydown'", "bookList.addEventListener('click'"), 'End')
})

// ---------- F3-9：笔记面板的代次 token ----------

test('renderNotesPanel 有 notesRenderToken，await 之后先验代次再 append', t => {
    has(t, mainSrc, 'let notesRenderToken = 0')
    const fn = topFn(mainSrc, 'renderNotesPanel')
    has(t, fn, 'const token = ++notesRenderToken')
    const awaited = fn.indexOf('await db.listBooks()')
    const checked = fn.indexOf('token !== notesRenderToken')
    assert.ok(awaited > 0 && checked > awaited, 'await 之后没有先验代次（旧请求仍会把列表叠加进来）')
})

// ---------- F3-10：无锚点时不再静默悬挂 anchorSuspended ----------

test('showBackToReading 无锚点返回 false，tempJump 据此复位 anchorSuspended', t => {
    const show = topFn(mainSrc, 'showBackToReading')
    has(t, show, 'if (!el || !readingAnchor) return false')
    has(t, show, 'return true')
    const jump = topFn(mainSrc, 'tempJump')
    has(t, jump, 'if (!showBackToReading()) anchorSuspended = false')
})

// ---------- F3-11：兜底值口径（纯函数另有单测，这里守住写法不回退） ----------

test('normalizeSettings 的 atmosphere 兜底改为引用 DEFAULT_SETTINGS', t => {
    const n = topFn(settingsSrc, 'normalizeSettings')
    has(t, n, 'rain: number(a.rain, 0, 1, out.atmosphere.rain)')
    has(t, n, 'fog: number(a.fog, 0, 1, out.atmosphere.fog)')
    lacks(t, n, 'rain: number(a.rain, 0, 1, 0.58)', 'rain 兜底又写回第二套真值')
    lacks(t, n, 'fog: number(a.fog, 0, 1, 0.32)', 'fog 兜底又写回第二套真值')
    // 整套 atmosphere 兜底都不该再出现字面量（注释里提到旧数值不算）
    const code = n.replace(/\/\/[^\n]*/g, '')
    assert.equal(/rain: number\(a\.rain, 0, 1, (?!out\.atmosphere)/.test(code), false, 'rain 兜底不再是 DEFAULT 口径')
})

// ---------- F3-12：专注位退休（选了「删写入路径」这条） ----------

test('hideReadingTools 的写入路径与死代码已删除，DOM 与 CSS 里的入口一并移除', t => {
    lacks(t, mainSrc, 'settings.misc.hideReadingTools=', '仍在写这个退休位')
    lacks(t, mainSrc, "$('#reading-focus-toggle')", 'main.js 还在引用已删除的按钮')
    lacks(t, htmlSrc, 'id="reading-focus-toggle"', 'index.html 里还留着永久隐藏的按钮')
    lacks(t, glassSrc, '#reading-focus-toggle', 'glass-ui.css 里还留着它的隐藏规则')
    // applyReadingFocus 仍负责清 body class（存量用户的残留态要被抹掉）
    has(t, topFn(mainSrc, 'applyReadingFocus'), "classList.toggle('reading-focus'")
    has(t, settingsSrc, 'out.misc.hideReadingTools = false')
})

// ---------- F3-13：切回雪景时的雪量兜底 ----------

test('case env-weather 恢复了雪量兜底，且写在 persist 之前', t => {
    const kase = between(mainSrc, "case 'env-weather'", "case 'env-ambience'")
    has(t, kase, "w === 'snow'", '兜底没绑定在"切到雪"上')
    has(t, kase, '< .08')
    has(t, kase, 'DEFAULT_SETTINGS.atmosphere.snow', '兜底值又写成字面量了')
    assert.ok(kase.indexOf('settings.atmosphere.snow = DEFAULT_SETTINGS') < kase.indexOf('persist()'), '兜底必须落在 persist() 之前')
})

// ---------- F3-14：场景亮度采样只跟动态源 ----------

test('sceneLum 定时器按 /VIDEO|CANVAS/ 门控，静态源只在 scenechange 后采样', t => {
    const wire = between(mainSrc, 'const isDynamicScene', "window.addEventListener('resize'")
    has(t, wire, '/VIDEO|CANVAS/.test(scene.currentImage?.tagName')
    has(t, wire, 'setInterval(() => { if (isDynamicScene()) sampleSceneLuminance() }, 2000)', '定时器没被门控')
    has(t, wire, "scene.addEventListener('scenechange'")
    has(t, wire, 'sampleSceneLuminance()')
    has(t, wire, 'clearInterval(sceneLumTimer)')
    // 门控口径与 js/background.js 的动态 watcher 同源（那边按 currentImage 的 tagName 判定，
    // 具体写法由氛围代理维护，这里只要求它仍在按 tagName 门控，别哪天改成无条件采样却没人同步这边）
    assert.match(read('js/background.js'), /this\.currentImage\.tagName/, 'background.js 的 tagName 门控口径变了，请同步 isDynamicScene')
})

// ---------- F3-15：resize 无条件把布局变化报给 Reader ----------

test('resize 不再只在双页态通知 Reader，640px 档位能跟着窗口宽度刷新', t => {
    const resize = between(mainSrc, "window.addEventListener('resize', () => {", "document.addEventListener('fullscreenchange'")
    has(t, resize, 'reader?.view?.renderer', '还在用 bookSpread 当条件')
    lacks(t, resize, 'reader?.bookSpread', '只在双页态通知，单页态跨过 640px 不刷新')
    has(t, resize, 'reader.beginViewportResize()')
    has(t, resize, 'setTimeout(() => reader.setLayout({}), 160)')
    has(t, resize, 'syncTimerSpan()')
})

// ---------- F3-16：天气面板入口决策（CSS 侧） ----------

test('抽屉里的天气标题与引导语放开显示，× 与右上按钮仍隐藏（入口收敛到抽屉）', t => {
    lacks(t, glassSrc, 'body #panel #atmosphere-panel header {display:none', 'header 又被藏掉了')
    has(t, glassSrc, 'body #panel #atmosphere-panel header {display:flex')
    has(t, glassSrc, 'body #panel #atmosphere-panel header .atmo-close {display:none;}')
    // 入口决策：右上角雨滴按钮保持隐藏（唯一的天气入口是抽屉里的「阅读环境 / 环境高级设置」）
    has(t, glassSrc, 'body #atmosphere-toggle {display:none!important;}')
    // main.js 侧不再声称存在一个"右上角雨滴按钮"入口
    lacks(t, mainSrc, '右上角雨滴按钮直达')
})

// ---------- F3-17：预设快照判定与无快照提示 ----------

test('切预设的快照判定改为字段比较，自定义入口无快照时给出明确提示', t => {
    const kase = between(mainSrc, "case 'reading-preset'", "case 'env-preset'")
    has(t, kase, '!settingsMatchPreset(settings, key)', '还在按 misc.readingPreset 标签比较')
    lacks(t, kase, "settings.misc.readingPreset !== key", '标签比较的写法仍在')
    has(t, kase, '没有可恢复的快照', '无快照时仍然静默 break')
    // 恢复自定义的芯片在"已是 custom"时也要出现，让用户看得见当前档位
    has(t, mainSrc, "presetSnapshot || settings.misc.readingPreset === 'custom'")
    // 判定函数本身在 reading-preset.js 里导出
    has(t, read('js/reading-preset.js'), 'export function settingsMatchPreset')
    has(t, mainSrc, 'settingsMatchPreset } from')
})
